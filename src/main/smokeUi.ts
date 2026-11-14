import type { BrowserWindow } from 'electron'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { AppState } from './ipc'
import { setLlmQueuePaused } from './jobs/store'
import { DETAIL_PROMPT } from './llm/prompts'
import { indexFullTextFts } from './db/fulltextFts'

/**
 * UI 冒烟（M1 第三批评审「真实 UI 冒烟」）：`--smoke-ui <结果.json>` 触发。
 *
 * 与「仅启动成功」不同，这里在真实 renderer 窗口里走完整链路：
 *   首页 → 新建图谱（UI 弹窗）→ 添加论文（弹窗勾选）→ 真实鼠标拖拽节点（sendInputEvent
 *   可信输入，走 React Flow onNodeDragStop → setNodePosition IPC）→ 再加一篇验证旧节点
 *   坐标不被覆盖（终审建议修 1：增量定位）→ 拖手柄连边（onConnect → ConnectDialog →
 *   createRelation IPC）→ webContents.reload() 验证坐标（基准 = 拖拽后坐标）与关系仍在
 *   → 03d：侧栏失败红点 → 点开「处理状态」面板，断言失败步骤/原因/重试按钮
 *   → 设置页「PDF 解析」：MinerU 状态卡片 + 解析队列区渲染。
 *
 * 数据：GRAPHICTERO_DATA_ROOT 指向临时目录（调用方负责），seedSyntheticPapers
 * 塞 3 篇合成论文（标题带 Smoke 前缀，绝不碰真实 Zotero 库 / 真实数据目录），
 * 并给 Alpha 塞一条 MinerU 解析失败的终态任务做 03d 数据源。
 * 每步记录 ok/detail，整体 ok = 全部步骤 ok。
 */

export interface SmokeStep {
  step: string
  ok: boolean
  detail?: string
}

export interface SmokeResult {
  ok: boolean
  dataDir: string
  steps: SmokeStep[]
}

/** 3 篇合成论文进论文库（不进任何图谱），供 UI 添加；第 4 篇带程序化生成的
 * 最小 PDF（可读可划选），做阅读器（D27）冒烟数据源。绝不碰真实 Zotero 库。 */
export function seedSyntheticPapers(db: Database.Database, dataDir?: string): void {
  const now = new Date().toISOString()
  const ins = db.prepare(
    `INSERT INTO papers (title, source, has_pdf, first_author, year, created_at, updated_at)
     VALUES (?, 'zotero', 0, ?, ?, ?, ?)` // source 列 CHECK 只允许 zotero/agent，冒烟合成数据用 zotero
  )
  const insAuthor = db.prepare(
    'INSERT INTO paper_authors (paper_id, position, family, given, normalized) VALUES (?, 0, ?, ?, ?)'
  )
  const seed: Array<[string, string, number]> = [
    ['Smoke Paper Alpha', 'Wei Zhang', 2021],
    ['Smoke Paper Beta', 'Li Wang', 2022],
    ['Smoke Paper Gamma', 'Na Liu', 2023]
  ]
  const tx = db.transaction(() => {
    for (const [title, author, year] of seed) {
      const r = ins.run(title, author, year, now, now)
      const [family, given] = author.split(' ')
      insAuthor.run(Number(r.lastInsertRowid), family, given, `${given} ${family}`.toLowerCase())
    }
  })
  tx()
  // 03d 冒烟数据源：Alpha 带一条 MinerU 解析失败的终态任务（侧栏红点 → 处理状态面板）
  const alpha = db.prepare("SELECT id FROM papers WHERE title = 'Smoke Paper Alpha'").get() as { id: number }
  db.prepare(
    `INSERT INTO jobs (kind, paper_id, status, failed_step, error, payload, created_at, updated_at)
     VALUES ('process_paper', ?, 'failed_action', 'parse', 'MinerU 进程意外退出（code 1）', '{}', ?, ?)`
  ).run(alpha.id, now, now)
  // 阅读器冒烟数据源：Delta 带程序化生成的最小 PDF（两页：首页两行文本划选高亮，
  // 第二页一个标记文本做缩略图跳页断言）
  if (dataDir) {
    const r = ins.run('Smoke Paper Delta', 'Reader Smoke', 2024, now, now)
    const deltaId = Number(r.lastInsertRowid)
    insAuthor.run(deltaId, 'Reader', 'Smoke', 'smoke reader')
    mkdirSync(join(dataDir, 'papers', String(deltaId)), { recursive: true })
    writeFileSync(join(dataDir, 'papers', String(deltaId), 'paper.pdf'), smokeFixturePdf())
    // 「按 bbox 跳到图」（D27）冒烟数据源：合成 structured_content（一页一个图块，
    // 归一化坐标），不来自任何真实 MinerU 输出
    mkdirSync(join(dataDir, 'papers', String(deltaId), 'mineru'), { recursive: true })
    writeFileSync(
      join(dataDir, 'papers', String(deltaId), 'mineru', 'structured_content.json'),
      JSON.stringify({
        pages: [
          {
            page_idx: 0,
            blocks: [
              { type: 'image', bbox: [0.1, 0.08, 0.6, 0.13], captions: [{ content: 'Figure 1 冒烟合成图注' }], image_source: 'images/page_0_image_1.jpg' }
            ]
          }
        ]
      })
    )
    db.prepare('UPDATE papers SET has_pdf = 1 WHERE id = ?').run(deltaId)
  }
}

/** 程序化生成的最小两页 PDF（Helvetica 文本书写对象，标准 xref）。
 *  冒烟专用：不入库、不来自任何真实论文。 */
export function smokeFixturePdf(): Buffer {
  const stream1 =
    'BT /F1 20 Tf 72 700 Td (Smoke Reader Fixture Line One) Tj 0 -32 Td (Smoke Reader Fixture Line Two) Tj ET'
  const stream2 = 'BT /F1 20 Tf 72 700 Td (Second Page Marker) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream1.length} >>\nstream\n${stream1}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
    `<< /Length ${stream2.length} >>\nstream\n${stream2}\nendstream`
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefPos = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`
  return Buffer.from(out, 'latin1')
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 页面里复用的小工具（注入一次，后续 evaluate 直接调） */
const PAGE_HELPERS = `
window.__gtErrors = window.__gtErrors || []
window.addEventListener('error', (e) => window.__gtErrors.push(String(e.message) + ' @@ ' + (e.error && e.error.stack ? String(e.error.stack).slice(0, 900) : 'no-stack')))
window.addEventListener('unhandledrejection', (e) => window.__gtErrors.push('rejection: ' + String(e.reason && e.reason.stack ? e.reason.stack.slice(0, 900) : e.reason)))
window.__gt = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  clickText(sel, text) {
    const el = [...document.querySelectorAll(sel)].find((e) => (e.textContent ?? '').includes(text))
    if (!el) return false
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return true
  },
  setInput(sel, value) {
    const el = document.querySelector(sel)
    if (!el) return false
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  },
  nodeRect(substr) {
    const n = [...document.querySelectorAll('.react-flow__node')].find((e) => (e.textContent ?? '').includes(substr))
    if (!n) return null
    const r = n.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  },
  // 包围盒中心可能被后插入的节点盖住。只点 elementFromPoint 真正落在该节点上的位置，
  // 避开上下边缘的连接点（点到手柄会走连线而不是单击/双击）。
  nodeClickPoint(substr) {
    const nodes = [...document.querySelectorAll('.react-flow__node')].filter((e) => (e.textContent ?? '').includes(substr))
    for (const n of nodes) {
      const r = n.getBoundingClientRect()
      if (r.width < 8 || r.height < 8) continue
      for (let iy = 0; iy < 3; iy++) {
        for (let ix = 1; ix <= 7; ix++) {
          const x = r.left + (r.width * ix) / 8
          const y = r.top + r.height * (0.35 + 0.15 * iy)
          const hit = document.elementFromPoint(x, y)
          if (hit && (hit === n || n.contains(hit))) return { x, y }
        }
      }
    }
    return null
  },
  // 评审建 1：节点「可见且静止」判定——都在视口内，且间隔 150ms 连续两次采样
  // rect 完全一致（fitView 动画在负载下会被拉长，只等「可见」会把拖拽起点落在
  // 动画移动中的旧位置上）
  inView(r) {
    return r && r.left >= 0 && r.top >= 0 && r.left + r.width <= window.innerWidth && r.top + r.height <= window.innerHeight
  },
  async stillNodeRects(...substrings) {
    const key = (s) => {
      const r = window.__gt.nodeRect(s)
      if (!window.__gt.inView(r)) return null
      return [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 100) / 100).join(',')
    }
    const a = substrings.map(key)
    if (a.some((x) => x === null)) return false
    await window.__gt.sleep(150)
    const b = substrings.map(key)
    return b.every((x, i) => x !== null && x === a[i])
  },
  nodeCount: () => document.querySelectorAll('.react-flow__node').length,
  edgeLabel: () => [...document.querySelectorAll('.react-flow__edge-text')].map((e) => e.textContent).join('|'),
  // ?smoke=1 当前 AgentApi（useAgentSession 显式暴露的同一内存 mock）
  smokeAgent() { return window.__gtSmokeAgent ?? null }
}
true // executeJavaScript 要结构化克隆返回值，不能返回含函数的 __gt 对象
`

export async function runUiSmoke(win: BrowserWindow, state: AppState, _outPath: string): Promise<SmokeResult> {
  const steps: SmokeStep[] = []
  const rendererErrors: string[] = []
  const record = (step: string, ok: boolean, detail?: string): void => {
    steps.push(detail ? { step, ok, detail } : { step, ok })
    console.log(`[smoke] ${ok ? '✓' : '✗'} ${step}${detail ? ` — ${detail}` : ''}`)
  }

  const evalJs = async <T>(code: string): Promise<T> => (await win.webContents.executeJavaScript(code, true)) as T
  // uat7b 排障：渲染进程崩溃 / 渲染 console 错误转发到主进程日志（瞬断即谁的锅可见）。
  win.webContents.on('render-process-gone', (_e, details) => {
    record('渲染进程退出', false, `${details.reason} ${details.exitCode}`)
  })
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) {
      rendererErrors.push(message)
      console.log(`[renderer:error] ${message}`)
    }
  })
  const waitFor = async (code: string, timeoutMs = 10000): Promise<boolean> => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      try {
        if (await evalJs<boolean>(code)) return true
      } catch {
        // 页面正在 reload，忽略瞬时报错
      }
      await sleep(150)
    }
    return false
  }
  /** 可信鼠标事件（React Flow 拖拽/连边只认真实输入） */
  type SmokeModifier = 'shift' | 'meta'
  const mouse = (type: 'mouseDown' | 'mouseMove' | 'mouseUp', x: number, y: number, modifiers: SmokeModifier[] = []): void => {
    win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: type === 'mouseMove' ? 0 : 1, modifiers })
  }
  // xyflow 的多选 / 框选看的是按键是否按住（useKeyPress），不是鼠标事件上的 modifier 标志。
  const modifierKeyCode = (m: SmokeModifier): string => (m === 'meta' ? 'Meta' : 'Shift')
  const holdModifiers = (modifiers: SmokeModifier[]): void => {
    for (const m of modifiers) win.webContents.sendInputEvent({ type: 'rawKeyDown', keyCode: modifierKeyCode(m) })
  }
  const releaseModifiers = (modifiers: SmokeModifier[]): void => {
    for (const m of [...modifiers].reverse()) win.webContents.sendInputEvent({ type: 'keyUp', keyCode: modifierKeyCode(m) })
  }
  /** 可信键盘事件（Esc 关弹层等） */
  const key = (keyCode: string, modifiers: SmokeModifier[] = []): void => {
    win.webContents.sendInputEvent({ type: 'rawKeyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }

  /** 可信拖拽的坐标基准：目标 span 「在视口内且连续两次采样 rect 一致」才返回
   * （评审建 1 同款口径：fit-width 重排/滚动动画期间坐标在漂，量完就拖会落空） */
  const stableSpanRect = async (substr: string, timeoutMs = 10000): Promise<{ left: number; top: number; width: number; height: number } | null> => {
    const t0 = Date.now()
    let last: string | null = null
    while (Date.now() - t0 < timeoutMs) {
      const r = await evalJs<{ left: number; top: number; width: number; height: number } | null>(`
        (() => {
          const s = [...document.querySelectorAll('.gt-textlayer span')]
            .find((x) => (x.textContent ?? '').includes(${JSON.stringify(substr)}))
          if (!s) return null
          const r = s.getBoundingClientRect()
          if (!(r.top >= 0 && r.top + r.height <= window.innerHeight && r.left >= 0 && r.left + r.width <= window.innerWidth)) return null
          return { left: r.left, top: r.top, width: r.width, height: r.height }
        })()
      `)
      const key = r ? [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 50) / 50).join(',') : null
      if (r && key === last) return r
      last = key
      await sleep(150)
    }
    return null
  }

  /** 同 stableSpanRect，用于页面高亮块（点高亮进编辑的坐标基准） */
  const stableHlRect = async (timeoutMs = 8000): Promise<{ left: number; top: number; width: number; height: number } | null> => {
    const t0 = Date.now()
    let last: string | null = null
    while (Date.now() - t0 < timeoutMs) {
      const r = await evalJs<{ left: number; top: number; width: number; height: number } | null>(`
        (() => {
          const el = document.querySelector('.gt-hl')
          if (!el) return null
          const r = el.getBoundingClientRect()
          if (!(r.top >= 0 && r.top + r.height <= window.innerHeight)) return null
          return { left: r.left, top: r.top, width: r.width, height: r.height }
        })()
      `)
      const key = r ? [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 50) / 50).join(',') : null
      if (r && key === last) return r
      last = key
      await sleep(150)
    }
    return null
  }

  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }, stepsN = 8, modifiers: SmokeModifier[] = []): Promise<void> => {
    if (modifiers.length > 0) {
      holdModifiers(modifiers)
      await sleep(120)
    }
    try {
      mouse('mouseDown', from.x, from.y, modifiers)
      await sleep(60)
      for (let i = 1; i <= stepsN; i++) {
        mouse('mouseMove', from.x + ((to.x - from.x) * i) / stepsN, from.y + ((to.y - from.y) * i) / stepsN, modifiers)
        await sleep(35)
      }
      await sleep(60)
      mouse('mouseUp', to.x, to.y, modifiers)
    } finally {
      if (modifiers.length > 0) releaseModifiers(modifiers)
    }
  }

  type SmokeRect = { left: number; top: number; width: number; height: number }
  const stableNodeRect = async (substr: string, timeoutMs = 10000): Promise<SmokeRect | null> => {
    if (!(await waitFor(`__gt.stillNodeRects(${JSON.stringify(substr)})`, timeoutMs))) return null
    return evalJs<SmokeRect | null>(`__gt.nodeRect(${JSON.stringify(substr)})`)
  }
  const pointOnNode = async (substr: string): Promise<{ x: number; y: number } | null> => {
    if (!(await stableNodeRect(substr))) return null
    return evalJs<{ x: number; y: number } | null>(`__gt.nodeClickPoint(${JSON.stringify(substr)})`)
  }
  const singleClickNode = async (substr: string, modifiers: SmokeModifier[] = []): Promise<boolean> => {
    const p = await pointOnNode(substr)
    if (!p) return false
    if (modifiers.length > 0) {
      holdModifiers(modifiers)
      await sleep(120)
    }
    try {
      mouse('mouseDown', p.x, p.y, modifiers)
      mouse('mouseUp', p.x, p.y, modifiers)
    } finally {
      if (modifiers.length > 0) releaseModifiers(modifiers)
    }
    return true
  }
  const doubleClickNode = async (substr: string): Promise<boolean> => {
    const p = await pointOnNode(substr)
    if (!p) return false
    const x = Math.round(p.x)
    const y = Math.round(p.y)
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    await sleep(45)
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 2 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 2 })
    return true
  }
  const contextClickNode = async (substr: string): Promise<boolean> => {
    const p = await pointOnNode(substr)
    if (!p) return false
    const x = Math.round(p.x)
    const y = Math.round(p.y)
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 })
    return true
  }

  try {
    // 0. 页面就绪
    const loaded = await waitFor(
      `document.body.innerText.includes('我的图谱') && document.documentElement.dataset.motion === 'off' && [...document.querySelectorAll('button')].some(b => (b.textContent ?? '').includes('新建图谱'))`
    )
    if (!loaded) {
      record('首页加载', false, '等待首页超时')
      return finish(false)
    }
    record('首页加载', true)
    await evalJs<void>(PAGE_HELPERS)

    // 1. 新建图谱（UI 弹窗）
    await evalJs<boolean>(`__gt.clickText('button', '新建图谱')`)
    if (!(await waitFor(`!!document.querySelector('.tin')`))) {
      record('新建图谱', false, '名称输入框未出现')
      return finish(false)
    }
    await evalJs<boolean>(`__gt.setInput('.tin', '冒烟图谱')`)
    await sleep(120)
    await evalJs<boolean>(`__gt.clickText('button', '创建')`)
    if (!(await waitFor(`(document.querySelector('.ttl')?.textContent ?? '').includes('冒烟图谱')`))) {
      record('新建图谱', false, '创建后画布未打开')
      return finish(false)
    }
    const graphId = await evalJs<number>(`
      window.graphictero.listGraphs().then((gs) => gs.find((g) => g.name === '冒烟图谱').id)
    `)
    record('新建图谱', true, `graphId=${graphId}`)

    // 必 1：GraphPage 顶栏必须渲染全局状态点（任务失败/排队在图谱页也要能看到）
    const dotOk = await waitFor(`!!document.querySelector('.maincol .toolbar .stdot')`)
    record('图谱页状态点', dotOk, dotOk ? 'GraphPage 顶栏已渲染 StatusDot' : 'GraphPage 顶栏没有状态点')
    if (!dotOk) return finish(false)

    // uat6c M2 / D183：「需要你处理」分组（failed_action = 需要你处理但可手动重试）
    // 列出标题 + 失败步骤 + 失败原因并带「重试」按钮（只断言存在，不点击——点击会重排任务）
    await evalJs<void>(`document.querySelector('.maincol .toolbar .stdot button[title="任务状态"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const d183Ok = await waitFor(`(() => {
      const row = document.querySelector('[data-testid="stpop-actionable"]')
      if (!row) return false
      const t = row.textContent ?? ''
      return t.includes('Smoke Paper Alpha') && t.includes('解析') && t.includes('MinerU 进程意外退出') &&
        !!row.querySelector('[data-testid="stpop-retry-actionable"]')
    })()`, 10000)
    record('D183失败可重试入口', d183Ok, d183Ok ? '「需要你处理」分组：标题+失败步骤+失败原因+「重试」按钮（failed_action 可手动重试）' : '需要你处理分组缺重试入口')
    if (!d183Ok) return finish(false)

    // uat6c-fix1 M1：补一条 relation_gen 真实形状的 failed_action（paper_id 为 NULL，
    // 论文只在 payload.paperIds）——「需要你处理」应显示「2 篇论文」+ 中文步骤 + 重试按钮
    const relNow = new Date().toISOString()
    const relPaperIds = (
      state.db.prepare("SELECT id FROM papers WHERE title IN ('Smoke Paper Alpha', 'Smoke Paper Gamma') ORDER BY id").all() as Array<{ id: number }>
    ).map((r) => r.id)
    state.db
      .prepare(
        `INSERT INTO jobs (kind, graph_id, status, failed_step, error, payload, created_at, updated_at)
         VALUES ('relation_gen', ?, 'failed_action', 'generate', 'OpenAlex 过滤器 400', ?, ?, ?)`
      )
      .run(graphId, JSON.stringify({ paperIds: relPaperIds }), relNow, relNow)
    const d183RelOk = await waitFor(`(() => {
      const rows = [...document.querySelectorAll('[data-testid="stpop-actionable"]')]
      const rel = rows.find((r) => (r.textContent ?? '').includes('篇论文'))
      if (!rel) return false
      const t = rel.textContent ?? ''
      return t.includes('2 篇论文') && t.includes('生成关系') && !t.includes('generate') &&
        // uat10 评审建议 2：「OpenAlex …400」短中文也归一成人话（详情仍在 title tooltip）
        t.includes('请求参数被服务拒绝') && !!rel.querySelector('[data-testid="stpop-retry-actionable"]')
    })()`, 12000)
    record('D183关系任务标题', d183RelOk, d183RelOk ? 'relation_gen（paper_id=NULL）失败行：「2 篇论文」+ 生成关系 + 重试按钮（标题来自 payload.paperIds）' : '关系任务失败行标题/步骤/按钮不符')
    if (!d183RelOk) return finish(false)
    await evalJs<void>(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
    await sleep(200)

    // uat8a D188：侧栏搜索合并正文命中。Beta 的标题不含 uat8abodytoken，只在 full.md 里。
    // 此时三篇都还在「论文库 · 其他」。查完必须清空输入，否则后面的侧栏步骤被过滤。
    {
      const betaBody = state.db.prepare("SELECT id FROM papers WHERE title = 'Smoke Paper Beta'").get() as { id: number }
      mkdirSync(join(state.dataDir, 'papers', String(betaBody.id), 'mineru'), { recursive: true })
      const bodyMd = '冒烟正文。这里只出现一次 uat8abodytoken ，标题里没有。\n'
      writeFileSync(join(state.dataDir, 'papers', String(betaBody.id), 'mineru', 'full.md'), bodyMd)
      indexFullTextFts(state.db, betaBody.id, bodyMd)
      await evalJs<boolean>(`__gt.setInput('[data-testid="sidebar-search"]', 'uat8abodytoken')`)
      const bodyHit = await waitFor(`(() => {
        const rows = [...document.querySelectorAll('[data-testid="side-library-row"]')]
        const beta = rows.find((r) => (r.textContent ?? '').includes('Smoke Paper Beta'))
        if (!beta) return false
        const tag = beta.querySelector('[data-testid="side-body-tag"]')
        if (!tag || !(tag.textContent ?? '').includes('正文')) return false
        const alpha = rows.find((r) => (r.textContent ?? '').includes('Smoke Paper Alpha'))
        return !alpha
      })()`)
      record('D188侧栏正文命中', bodyHit, bodyHit ? '只在正文出现的词命中 Beta，并带灰阶「正文」标签' : '正文命中未出现或带错标签')
      if (!bodyHit) return finish(false)
      await evalJs<boolean>(`__gt.setInput('[data-testid="sidebar-search"]', 'Alpha')`)
      const titleHit = await waitFor(`(() => {
        const rows = [...document.querySelectorAll('[data-testid="side-library-row"]')]
        const alpha = rows.find((r) => (r.textContent ?? '').includes('Smoke Paper Alpha'))
        if (!alpha) return false
        if (alpha.querySelector('[data-testid="side-body-tag"]')) return false
        const beta = rows.find((r) => (r.textContent ?? '').includes('Smoke Paper Beta'))
        return !beta
      })()`)
      record('D188侧栏标题命中无标签', titleHit, titleHit ? '标题词命中 Alpha，不带「正文」标签' : '标题命中缺失或误带正文标签')
      if (!titleHit) return finish(false)
      await evalJs<boolean>(`__gt.setInput('[data-testid="sidebar-search"]', '')`)
      const cleared = await waitFor(`(() => {
        const rows = [...document.querySelectorAll('[data-testid="side-library-row"]')]
        return rows.some((r) => (r.textContent ?? '').includes('Smoke Paper Beta')) &&
          rows.some((r) => (r.textContent ?? '').includes('Smoke Paper Alpha')) &&
          !document.querySelector('[data-testid="side-body-tag"]')
      })()`)
      record('D188侧栏搜索清空', cleared, cleared ? '清空后论文库恢复全列、无正文标签' : '清空后侧栏仍被过滤')
      if (!cleared) return finish(false)
    }

    // uat2-fix1 建议修 1：重新生成确认框 portal 到 body——位于视口内（中央）、D164 文案、可取消。
    // 放在添加论文之前：加论文会自动排关系生成，生成中（waiting_key 也算）入口禁用点不出确认框。
    await evalJs<void>(`document.querySelector('.toolbar button[title="更多"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    if (!(await waitFor(`!!document.querySelector('.menu')`))) {
      record('重新生成确认框位置与文案', false, '更多菜单未打开')
      return finish(false)
    }
    await evalJs<void>(`document.querySelector('[data-testid="menu-regen-relations"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const regenDlgOk = await waitFor(`(() => {
      const m = document.querySelector('.ov .modal.cfm')
      if (!m) return false
      const r = m.getBoundingClientRect()
      const inView = r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight
      const nearCenter = Math.abs((r.left + r.right) / 2 - window.innerWidth / 2) < window.innerWidth * 0.2
      const t = m.textContent ?? ''
      return inView && nearCenter && t.includes('手动创建的关系始终保留') && t.includes('即使你编辑过')
    })()`)
    const regenDlgInfo = await evalJs<string>(`(() => {
      const m = document.querySelector('.ov .modal.cfm')
      if (!m) return 'no-dialog'
      const r = m.getBoundingClientRect()
      return JSON.stringify({ rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)], vw: window.innerWidth, vh: window.innerHeight, text: (m.textContent ?? '').slice(0, 150) })
    })()`)
    record('重新生成确认框位置与文案', regenDlgOk, regenDlgOk ? '确认框 portal 到 body：视口内近中央 + D164 文案（手动保留/AI 编辑过也替换）' : `对话框位置或文案不符：${regenDlgInfo}`)
    if (!regenDlgOk) return finish(false)
    const cancelClicked = await evalJs<boolean>(`__gt.clickText('.modal.cfm button', '取消')`)
    // 取消只要求对话框关闭；更多菜单是否同关不作要求（点画布关闭已有专项步骤锁定）
    const regenCancelled = await waitFor(`!document.querySelector('.ov .modal.cfm')`)
    const cancelState = await evalJs<string>(`JSON.stringify({ clicked: ${cancelClicked}, dlg: !!document.querySelector('.ov .modal.cfm'), menu: !!document.querySelector('.menu') })`)
    record('重新生成确认可取消', regenCancelled, regenCancelled ? '取消后对话框关闭' : `取消未关闭：${cancelState}`)
    if (!regenCancelled) return finish(false)
    await evalJs<void>(`document.querySelector('.react-flow__pane').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    await waitFor(`!document.querySelector('.menu')`)

    // 2. 添加论文（弹窗勾选第 1 篇）
    const added1 = await addViaModal('Alpha')
    if (!added1) return finish(false)

    // 3. 真实鼠标拖拽节点 → 坐标经 onNodeDragStop 落库
    // 评审建 1：先等节点「可见且静止」（加论文后 placeNew 有 fitView 动画），
    // 再取拖拽起点，避免 mouseDown 落在动画移动中的旧位置
    const alphaStill = await waitFor(`__gt.stillNodeRects('Alpha')`)
    if (!alphaStill) {
      record('拖拽节点', false, '等待 Alpha 节点可见且静止超时')
      return finish(false)
    }
    const before = await evalJs<{ x: number; y: number }>(`
      window.graphictero.getGraph(${graphId}).then((d) => ({ x: d.members[0].x, y: d.members[0].y }))
    `)
    // 加论文后 papersStatus 会重拉并整批重建节点，偶发把进行中的拖拽坐标打回库内旧值。
    // 几何中心也可能落在侧栏上。中心能点中就用中心，否则用 nodeClickPoint；最多试 3 次。
    let after = before
    let moved = false
    for (let attempt = 0; attempt < 3 && !moved; attempt++) {
      if (attempt > 0 && !(await waitFor(`__gt.stillNodeRects('Alpha')`, 4000))) break
      const from = await evalJs<{ x: number; y: number } | null>(`(() => {
        const r = __gt.nodeRect('Alpha')
        if (!r) return null
        const cx = r.left + r.width / 2
        const cy = r.top + r.height / 2
        const nodes = [...document.querySelectorAll('.react-flow__node')].filter((e) => (e.textContent ?? '').includes('Alpha'))
        const hit = document.elementFromPoint(cx, cy)
        if (nodes.some((n) => hit && (hit === n || n.contains(hit)))) return { x: cx, y: cy }
        return __gt.nodeClickPoint('Alpha')
      })()`)
      if (!from) break
      await drag(from, { x: from.x + 240, y: from.y + 40 })
      await sleep(500) // 等 onNodeDragStop → IPC 落库
      after = await evalJs<{ x: number; y: number }>(`
        window.graphictero.getGraph(${graphId}).then((d) => ({ x: d.members[0].x, y: d.members[0].y }))
      `)
      moved = Math.abs(after.x - before.x) > 30 || Math.abs(after.y - before.y) > 30
    }
    record('拖拽节点', moved, `(${before.x.toFixed(1)},${before.y.toFixed(1)}) → (${after.x.toFixed(1)},${after.y.toFixed(1)})`)
    if (!moved) return finish(false)

    // 4. 再添加第 2 篇，拖手柄连边（Alpha 底部 → Beta 顶部）
    if (!(await addViaModal('Beta'))) return finish(false)
    // 评审建 1：等 placeNew 后的 fitView 动画真正结束（两节点可见且静止，
    // 间隔 150ms 两次采样 rect 一致）才发拖拽——只等「可见」在负载下会假失败
    const bothStill = await waitFor(`__gt.stillNodeRects('Alpha', 'Beta')`)
    if (!bothStill) {
      record('手工连边', false, 'fitView 后节点未在视口内静止')
      return finish(false)
    }
    // 终审建议修 1：加论文只做增量定位，Alpha 的手工拖拽坐标不能被覆盖；
    // 持久化基准回到「拖拽后坐标」（旧行为全图重排时被迫取连边后最终坐标）
    const alphaAfterAdd = await evalJs<{ x: number; y: number }>(`
      window.graphictero.getGraph(${graphId}).then((d) => {
        const m = d.members.find((mm) => mm.paper.title.includes('Alpha'))
        return { x: m.x, y: m.y }
      })
    `)
    const kept = Math.abs(alphaAfterAdd.x - after.x) < 1 && Math.abs(alphaAfterAdd.y - after.y) < 1
    record('加论文不动旧节点', kept, kept
      ? 'Alpha 坐标保持拖拽后的位置'
      : `Alpha 被移动到 (${alphaAfterAdd.x.toFixed(1)},${alphaAfterAdd.y.toFixed(1)})`)
    if (!kept) return finish(false)
    const final = after
    const ra = await evalJs<{ left: number; top: number; width: number; height: number } | null>(`__gt.nodeRect('Alpha')`)
    const rb = await evalJs<{ left: number; top: number; width: number; height: number } | null>(`__gt.nodeRect('Beta')`)
    if (!ra || !rb) {
      record('手工连边', false, '找不到两个节点')
      return finish(false)
    }
    // 手柄在节点上/下边缘正中（Position.Bottom/Top），取边缘点本身
    await drag({ x: ra.left + ra.width / 2, y: ra.top + ra.height }, { x: rb.left + rb.width / 2, y: rb.top })
    if (!(await waitFor(`document.body.innerText.includes('创建关系')`))) {
      record('手工连边', false, 'ConnectDialog 未弹出')
      return finish(false)
    }
    await sleep(200)
    await evalJs<boolean>(`__gt.clickText('.tag', '基于/改进')`)
    await sleep(120)
    await evalJs<boolean>(`__gt.clickText('button', '保存')`)
    const relOk = await waitFor(`window.graphictero.getGraph(${graphId}).then((d) => d.relations.length === 1)`)
    record('手工连边', relOk, relOk ? '关系已落库' : '关系未落库')
    if (!relOk) return finish(false)

    // 4b. REL 车道 IPC：排队关系生成（无 Key → waiting_key，不断网不花钱）+ 详情/快照恢复
    const relGenJob = await evalJs<number>(`window.graphictero.generateRelations(${graphId})`)
    const genQueued = await waitFor(
      `window.graphictero.relationsStatus(${graphId}).then((s) => s.activeJob != null && ['queued','running','waiting_key','waiting_network'].includes(s.activeJob.status))`
    )
    record('关系生成排队', typeof relGenJob === 'number' && genQueued, `job=${relGenJob} queued=${genQueued}`)
    if (!(typeof relGenJob === 'number' && genQueued)) return finish(false)
    const relDetail = await evalJs<{ sourceType: string }>(`
      window.graphictero.getGraph(${graphId}).then((d) => window.graphictero.relationDetail(d.relations[0].id))
    `)
    const relRestored = await evalJs<number>(`
      window.graphictero.getGraph(${graphId}).then((d) => {
        const r = d.relations[0]
        return window.graphictero.restoreRelation({
          graphId: ${graphId},
          srcPaperId: r.srcPaper,
          dstPaperId: r.srcPaper === r.paperLow ? r.paperHigh : r.paperLow,
          statement: r.statement,
          llmTypes: r.llmTypes
        })
      })
    `)
    const relStillOne = await evalJs<boolean>(`window.graphictero.getGraph(${graphId}).then((d) => d.relations.length === 1)`)
    const detailOk = relDetail.sourceType === 'session' && typeof relRestored === 'number' && relStillOne
    record('关系详情/快照恢复', detailOk, `sourceType=${relDetail.sourceType} restored=${relRestored} rels仍=1:${relStillOne}`)
    if (!detailOk) return finish(false)

    // uat2b：菜单冒泡修复锁定——「筛选」「更多」点一次打开且保持打开，点画布（外部）才关闭。
    // 回归场景：打开点击冒泡到 window 被刚挂的关闭监听吃掉，弹层「打开即关」。
    await evalJs<void>(`[...document.querySelectorAll('.toolbar button')].find((b) => (b.textContent ?? '').includes('筛选')).dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const filterOpened = await waitFor(`!!document.querySelector('.fpop')`)
    await sleep(400)
    const filterStayed = await evalJs<boolean>(`!!document.querySelector('.fpop')`)
    record('筛选弹层打开保持', filterOpened && filterStayed, filterOpened && filterStayed ? '点一次打开，400ms 后仍开着（未被同一次点击关掉）' : `打开=${filterOpened} 保持=${filterStayed}`)
    await evalJs<void>(`document.querySelector('.react-flow__pane').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const filterClosed = await waitFor(`!document.querySelector('.fpop')`)
    record('筛选弹层点外部关闭', filterClosed, filterClosed ? '点画布后关闭' : '点画布后仍开着')

    await evalJs<void>(`document.querySelector('.toolbar button[title="更多"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const moreOpened = await waitFor(`!!document.querySelector('.menu')`)
    await sleep(400)
    const moreStayed = await evalJs<boolean>(`!!document.querySelector('.menu')`)
    record('更多菜单打开保持', moreOpened && moreStayed, moreOpened && moreStayed ? '点一次打开，400ms 后仍开着' : `打开=${moreOpened} 保持=${moreStayed}`)
    await evalJs<void>(`document.querySelector('.react-flow__pane').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const moreClosed = await waitFor(`!document.querySelector('.menu')`)
    record('更多菜单点外部关闭', moreClosed, moreClosed ? '点画布后关闭' : '点画布后仍开着')

    // D148：「从图谱移除」不弹确认但可 ⌘Z——节点（原坐标）+ 连带边（含手工边、原 id）一起恢复
    const relIdBefore = await evalJs<number>(`window.graphictero.getGraph(${graphId}).then((d) => d.relations[0].id)`)
    // D179 起节点右键只有「从图谱移除」（从库删除仅在侧栏）；沿用可信右键，
    // 并精确点 paper-menu 的 menu-remove-graph，防止误走旧的库删除路径。
    const alphaContext = await contextClickNode('Alpha')
    const ctxOpened = alphaContext && (await waitFor(`!!document.querySelector('[data-testid="paper-menu"] [data-testid="menu-remove-graph"]')`))
    const clickedRemove = await evalJs<boolean>(`__gt.clickText('[data-testid="paper-menu"] [data-testid="menu-remove-graph"]', '从图谱移除')`)
    // 成员数会在撤销入栈之前就变。等 toast 再 ⌘Z，避免撤销打在空栈上。
    const removedNoConfirm = await waitFor(
      `!document.querySelector('.ov') && (document.querySelector('.toasts')?.textContent ?? '').includes('已从图谱移除') && window.graphictero.getGraph(${graphId}).then((d) => d.members.length === 1 && d.relations.length === 0)`
    )
    let removeDetail = '右键移除不弹确认，节点与连带边一并移除'
    if (!(ctxOpened && removedNoConfirm)) {
      const snap = await evalJs<string>(`JSON.stringify({
        click: ${clickedRemove},
        ov: !!document.querySelector('.ov'),
        toast: (document.querySelector('.toasts')?.textContent ?? '').slice(0, 160),
        pane: !!document.querySelector('.react-flow__pane'),
        nodes: document.querySelectorAll('.react-flow__node').length,
        root: document.getElementById('root')?.childElementCount ?? -1,
        menu: (document.querySelector('[data-testid="paper-menu"]')?.textContent ?? '').slice(0, 80)
      })`).catch((e: unknown) => `eval失败:${e instanceof Error ? e.message : String(e)}`)
      const graphSnap = await evalJs<string>(`window.graphictero.getGraph(${graphId}).then((d) => JSON.stringify({ members: d.members.length, rels: d.relations.length }))`).catch((e: unknown) => `graph失败:${e instanceof Error ? e.message : String(e)}`)
      removeDetail = `菜单=${ctxOpened} 移除=${removedNoConfirm} 点击=${clickedRemove} ${snap} ${graphSnap}`
    }
    record('D148移除无确认', ctxOpened && removedNoConfirm, removeDetail)
    await evalJs<void>(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }))`).catch(() => undefined)
    const undone = await waitFor(
      `window.graphictero.getGraph(${graphId}).then((d) => d.members.length === 2 && d.relations.length === 1 && d.relations[0].id === ${relIdBefore})`,
      8000
    )
    const alphaBack = await waitFor(`[...document.querySelectorAll('.react-flow__node')].some((n) => (n.textContent ?? '').includes('Alpha'))`)
    let undoDetail = '⌘Z 后节点回图、关系按原 id 复活'
    if (!(undone && alphaBack)) {
      const undoSnap = await evalJs<string>(`JSON.stringify({
        toast: (document.querySelector('.toasts')?.textContent ?? '').slice(0, 160),
        pane: !!document.querySelector('.react-flow__pane'),
        nodes: [...document.querySelectorAll('.react-flow__node')].map((n) => (n.textContent ?? '').slice(0, 24)),
        root: document.getElementById('root')?.childElementCount ?? -1
      })`).catch((e: unknown) => `eval失败:${e instanceof Error ? e.message : String(e)}`)
      undoDetail = `数据=${undone} 画布=${alphaBack} ${undoSnap}`
    }
    record('D148移除可撤销', undone && alphaBack, undoDetail)

    // uat2b d)：右键菜单靠近右下边缘自动上/左翻，菜单矩形完整留在视口内
    await evalJs<boolean>(`(() => { const n = [...document.querySelectorAll('.react-flow__node')].find((el) => (el.textContent ?? '').includes('Beta')); if (!n) return false; n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: window.innerWidth - 12, clientY: window.innerHeight - 12 })); return true })()`)
    const menuInViewport = await waitFor(`(() => {
      const m = document.querySelector('.menu')
      if (!m) return false
      const r = m.getBoundingClientRect()
      return r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight
    })()`)
    record('右键菜单视口内翻转', menuInViewport, menuInViewport ? '右下角触发：菜单完整在视口内（自动上/左翻）' : '菜单出屏')
    await evalJs<void>(`document.querySelector('.react-flow__pane')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    await waitFor(`!document.querySelector('.menu')`)

    // 5. 重启（reload）验证位置与关系仍在。reload 后路由回首页（M1 不恢复路由），
    //    像真实用户一样从侧栏重新打开图谱，再断言持久化数据
    win.webContents.reload()
    const homeAgain = await waitFor(`document.body.innerText.includes('我的图谱')`)
    if (!homeAgain) {
      record('重启验证', false, 'reload 后首页未恢复')
      return finish(false)
    }
    await evalJs<void>(PAGE_HELPERS) // reload 后需重新注入
    if (!(await waitFor(`[...document.querySelectorAll('.sitem')].some((e) => (e.textContent ?? '').includes('冒烟图谱'))`))) {
      record('重启验证', false, '首页侧栏没有出现图谱入口')
      return finish(false)
    }
    await evalJs<boolean>(`__gt.clickText('.sitem', '冒烟图谱')`)
    const reloaded = await waitFor(`(document.querySelector('.ttl')?.textContent ?? '').includes('冒烟图谱')`)
    if (!reloaded) {
      record('重启验证', false, '重新打开图谱后画布未恢复')
      return finish(false)
    }
    const two = await waitFor(`__gt.nodeCount() === 2`)
    if (!two) {
      record('重启验证', false, 'reload 后节点数不为 2')
      return finish(false)
    }
    const persisted = await evalJs<{ x: number; y: number; rels: number; label: string }>(`
      Promise.all([window.graphictero.getGraph(${graphId})]).then(([d]) => ({
        x: d.members.find((m) => m.paper.title.includes('Alpha')).x,
        y: d.members.find((m) => m.paper.title.includes('Alpha')).y,
        rels: d.relations.length,
        label: __gt.edgeLabel()
      }))
    `)
    const posOk = Math.abs(persisted.x - final.x) < 1 && Math.abs(persisted.y - final.y) < 1
    const relOk2 = persisted.rels === 1 && persisted.label.includes('基于')
    record('重启验证', posOk && relOk2,
      `Alpha=(${persisted.x.toFixed(1)},${persisted.y.toFixed(1)}) 关系=${persisted.rels} 边标签=${persisted.label || '(无)'}`)
    let ok = posOk && relOk2

    // 6. 03d 处理失败界面：seed 的 Alpha 解析失败任务 → 侧栏红点 → 点开处理状态面板，
    //    应标明失败步骤（MinerU 解析）、原因与「重试」按钮（D85）
    const dotVisible = await waitFor(`!!document.querySelector('.sidebar .faildot')`)
    record('03d失败标记', dotVisible, dotVisible ? '侧栏出现失败红点' : '侧栏没有失败红点')
    if (!dotVisible) return finish(false)
    await evalJs<void>(`document.querySelector('.sidebar .faildot').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const panelUp = await waitFor(`!!document.querySelector('[data-testid="paper-process-panel"]')`)
    const panelText = await evalJs<string>(`document.querySelector('[data-testid="paper-process-panel"]')?.textContent ?? ''`)
    const hasRetry = await evalJs<boolean>(
      `[...document.querySelectorAll('[data-testid="paper-process-panel"] button')].some((b) => (b.textContent ?? '').includes('重试'))`
    )
    const p03d = panelUp && panelText.includes('MinerU 解析失败') && panelText.includes('MinerU 进程意外退出') && hasRetry
    record('03d处理失败面板', p03d, p03d ? '失败步骤/原因/重试按钮齐全' : '面板内容缺失')
    ok = ok && p03d
    await evalJs<void>(`document.querySelector('[data-testid="paper-process-panel"] .ph button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    await sleep(200)

    // 7. 设置页「PDF 解析」：MinerU 状态卡片 + 解析队列区渲染（冒烟模式 sidecar 未接入）
    await evalJs<boolean>(`__gt.clickText('button', '我的图谱')`)
    if (!(await waitFor(`document.body.innerText.includes('我的图谱') && [...document.querySelectorAll('button')].some((b) => (b.textContent ?? '').includes('新建图谱'))`))) {
      record('设置页PDF解析区', false, '返回首页失败')
      return finish(false)
    }
    await evalJs<boolean>(`__gt.clickText('.sitem', '设置')`)
    if (!(await waitFor(`document.body.innerText.includes('数据与备份')`))) {
      record('设置页PDF解析区', false, '设置页未打开')
      return finish(false)
    }
    await evalJs<boolean>(`__gt.clickText('.sitem', 'PDF 解析')`)
    const parseSec = await waitFor(
      `document.body.innerText.includes('当前环境未接入 MinerU') && document.body.innerText.includes('解析队列') &&
       // D137：环境路径行仍叫「解析环境」。uat8c 另加「模型文件」行显示目录大小，「最近一次解析」取代旧「上次解析」。
       document.body.innerText.includes('解析环境') && document.body.innerText.includes('最近一次解析') &&
       document.body.innerText.includes('模型文件')`
    )
    record('设置页PDF解析区', parseSec, parseSec ? 'MinerU 状态/解析环境（D137）/模型文件/最近一次解析/解析队列已渲染' : 'PDF 解析区未渲染')
    ok = ok && parseSec

    // 8–12. EmbedPDF 阅读器（D27 + D105 原型 07）：左栏三 tab → 缩略图跳页 → 目录空态
    //   → 划选四按钮弹层建高亮 → 加笔记 → 重开仍在 → 点页面高亮进编辑 → 独立笔记 → 跳图
    await evalJs<boolean>(`__gt.clickText('.sitem', '返回')`) // 设置页返回首页
    if (!(await waitFor(`document.body.innerText.includes('我的图谱') && [...document.querySelectorAll('button')].some((b) => (b.textContent ?? '').includes('新建图谱'))`))) {
      record('阅读器打开', false, '返回首页失败')
      return finish(false)
    }
    // D113（lane/detail 批 2）：库行「阅读」入口已移除，改经详情页「打开 PDF」进入阅读器
    // （段外最小改动；阅读器内断言不变）
    if (!(await waitFor(`[...document.querySelectorAll('.prow')].some((r) => (r.textContent ?? '').includes('Smoke Paper Delta'))`))) {
      record('阅读器打开', false, '首页论文库没有 Delta 行')
      return finish(false)
    }
    await evalJs<boolean>(`
      [...document.querySelectorAll('.prow')].find((r) => (r.textContent ?? '').includes('Smoke Paper Delta'))
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    `)
    if (!(await waitFor(`!!document.querySelector('[data-testid="paper-detail-page"]')`))) {
      record('阅读器打开', false, '库行点击未打开详情页')
      return finish(false)
    }
    await evalJs<boolean>(`__gt.clickText('.gt-pd-bar button', '打开 PDF')`)
    const readerUp = await waitFor(
      `!!document.querySelector('[data-testid="pdf-reader"]') &&
       [...document.querySelectorAll('.gt-textlayer span')].some((s) => (s.textContent ?? '').includes('Smoke Reader Fixture Line One'))`,
      20000
    )
    if (!readerUp) {
      const readerState = await evalJs<string>(`document.querySelector('[data-testid="pdf-reader"]')?.textContent ?? '(阅读器未挂载)'`)
      record('阅读器打开', false, `未就绪，阅读器状态：${readerState.slice(0, 120)}`)
      return finish(false)
    }
    record('阅读器打开', true, 'PDF 渲染 + 文本层就绪')

    // D105③：左侧栏分段控件顺序 缩略图/目录/标注/图，默认选中缩略图且缩略图渲染
    const tabOrder = await evalJs<string[]>(
      `[...document.querySelectorAll('.gt-tab')].map((t) => (t.textContent ?? '').replace(/\\s+/g, '').replace(/·.*$/, ''))`
    )
    const tabSingleLine = await evalJs<boolean>(`(() => {
      const tabs = [...document.querySelectorAll('.gt-tabs .gt-tab')]
      const rects = tabs.map((t) => t.getBoundingClientRect())
      return tabs.length === 4 && tabs.every((t) => getComputedStyle(t).whiteSpace === 'nowrap') &&
        rects.every((r) => r.top === rects[0].top && r.height === rects[0].height)
    })()`)
    const tabOk =
      JSON.stringify(tabOrder) === JSON.stringify(['缩略图', '目录', '标注', '图']) && tabSingleLine &&
      (await waitFor(`(document.querySelector('.gt-tab.on')?.textContent ?? '').startsWith('缩略图') && !!document.querySelector('[data-testid="thumb-1"]')`)) &&
      // 页面位图真正加载（RenderLayer 是 blob: URL；CSP 缺 blob: 时 naturalWidth=0 整页白屏）
      (await waitFor(`(() => { const img = document.querySelector('.gt-thumbimg img'); return !!img && img.naturalWidth > 0 })()`, 15000))
    record('左栏分段控件', tabOk, `tab 顺序=${tabOrder.join('/')}，单行不换行=${tabSingleLine}`)
    if (!tabOk) return finish(false)

    // D105③：缩略图点击跳页（点到第 2 页 → 页码变化 + 第二页文本「可见」；再点回第 1 页）
    // 等待条件用「可见」而非「存在」：虚拟化滚动会把离屏页留着，存在不等于在视口内
    const page2Visible = `(() => {
      const s = [...document.querySelectorAll('.gt-textlayer span')].find((x) => (x.textContent ?? '').includes('Second Page Marker'))
      if (!s) return false
      const r = s.getBoundingClientRect()
      return __gt.inView({ left: r.left, top: r.top, width: r.width, height: r.height })
    })()`
    const lineOneVisible = `(() => {
      const s = [...document.querySelectorAll('.gt-textlayer span')].find((x) => (x.textContent ?? '').includes('Smoke Reader Fixture Line One'))
      if (!s) return false
      const r = s.getBoundingClientRect()
      return __gt.inView({ left: r.left, top: r.top, width: r.width, height: r.height })
    })()`
    await evalJs<void>(`document.querySelector('[data-testid="thumb-2"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    // uat3 建议修 1：页码改为输入框（值在 input.value，不在 textContent）
    const jumped = await waitFor(
      `(document.querySelector('[data-testid="page-input"]')?.value ?? '') === '2' && (${page2Visible})`,
      15000
    )
    if (!jumped) {
      record('缩略图跳页', false, '点击第 2 页缩略图后页码/正文未变化')
      return finish(false)
    }
    await evalJs<void>(`document.querySelector('[data-testid="thumb-1"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const backOne = await waitFor(
      `(document.querySelector('[data-testid="page-input"]')?.value ?? '') === '1' && (${lineOneVisible})`,
      15000
    )
    record('缩略图跳页', backOne, backOne ? '缩略图点击可往返跳页' : '跳回第 1 页失败')
    if (!backOne) return finish(false)

    // D105③：目录 tab（合成 PDF 无 outline → 空态文案）
    await evalJs<void>(`document.querySelector('[data-testid="tab-toc"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const tocEmpty = await waitFor(`document.querySelector('[data-testid="toclist"]').innerText.includes('这份 PDF 没有目录')`)
    record('目录空态', tocEmpty, tocEmpty ? '无 outline 时显示空态' : '目录空态缺失')
    if (!tocEmpty) return finish(false)

    // D105①：划选第一行文本 → 四按钮弹层（高亮/笔记/复制/发给 agent）。
    // 坐标基准等「可见且静止」（stableSpanRect）：fit-width 重排/滚动动画期间量坐标会漂。
    // 「发给 agent」禁用断言已随 D105-① 解禁改为存在性断言（M5 lane/chat 批 2 随 8a52cb3
    // 合并入 main；chat→main 合并批清单② 正式收编为维护者变更——re-verify：存在性断言
    // 与 lane/chat 段「阅读器发给agent解禁」步骤互补，无遗漏）
    // uat3 必须修 2：弹层四按钮（高亮/笔记/复制/发给 agent）
    const selpopThreeButtons = `(() => {
      const btns = [...document.querySelectorAll('[data-testid="selpop"] button')]
      return btns.length === 4 &&
        (btns[0].textContent ?? '').includes('高亮') &&
        (btns[1].textContent ?? '').includes('笔记') &&
        (btns[2].textContent ?? '').includes('复制') &&
        (btns[3].textContent ?? '').includes('发给 agent')
    })()`
    const spanRect = await stableSpanRect('Smoke Reader Fixture Line One')
    if (!spanRect) {
      record('选区四按钮弹层', false, '第 1 页文本不可见或一直在动')
      return finish(false)
    }
    const sy = spanRect.top + spanRect.height / 2
    await drag({ x: spanRect.left + 2, y: sy }, { x: spanRect.left + spanRect.width - 2, y: sy })
    const popOk = await waitFor(selpopThreeButtons)
    if (!popOk) {
      try {
        writeFileSync('/tmp/gt-selpop-fail.png', (await win.webContents.capturePage()).toPNG())
      } catch {
        /* 失败截图尽力而为 */
      }
      record('选区四按钮弹层', false, '划选后四按钮弹层未出现或按钮不符')
      return finish(false)
    }
    record('选区四按钮弹层', true, '高亮/笔记/复制/发给 agent 四按钮（发给 agent 启用态见 M5 lane/chat 段）')

    // 评审建 2：Esc 先关弹层（阅读器不关）→ 再重新划选、点「高亮」建标注
    key('Escape')
    await sleep(250)
    const escOk = await waitFor(
      `!document.querySelector('[data-testid="selpop"]') && !!document.querySelector('[data-testid="pdf-reader"]')`
    )
    record('Esc关弹层', escOk, escOk ? 'Esc 关闭弹层、阅读器仍开着' : 'Esc 未按预期关闭弹层')
    if (!escOk) return finish(false)
    const spanRect2 = await stableSpanRect('Smoke Reader Fixture Line One')
    if (!spanRect2) {
      record('创建高亮', false, 'Esc 后重划选找不到稳定文本')
      return finish(false)
    }
    const sy2 = spanRect2.top + spanRect2.height / 2
    await drag({ x: spanRect2.left + 2, y: sy2 }, { x: spanRect2.left + spanRect2.width - 2, y: sy2 })
    if (!(await waitFor(selpopThreeButtons))) {
      record('创建高亮', false, 'Esc 后重新划选未弹出四按钮')
      return finish(false)
    }
    await evalJs<void>(`document.querySelector('[data-testid="sel-highlight"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const hlOk = await waitFor(`document.querySelectorAll('.gt-hl').length > 0`)
    record('创建高亮', hlOk, hlOk ? '高亮已落库并渲染在页面上' : '页面没有新高亮')
    if (!hlOk) return finish(false)

    // 加笔记：切「标注」tab → 点列表项进编辑 → 填笔记 → 保存
    await evalJs<void>(`document.querySelector('[data-testid="tab-ann"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    await sleep(200)
    await evalJs<void>(`document.querySelector('[data-testid="annlist"] .gt-annitem .hd').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    if (!(await waitFor(`!!document.querySelector('[data-testid="annlist"] textarea')`))) {
      record('高亮加笔记', false, '编辑框未出现')
      return finish(false)
    }
    await evalJs<boolean>(`__gt.setInput('[data-testid="annlist"] textarea', '冒烟笔记：tau 是手动的吗？')`)
    await sleep(120)
    await evalJs<boolean>(`__gt.clickText('[data-testid="annlist"] button', '保存')`)
    const noteOk = await waitFor(
      `[...document.querySelectorAll('[data-testid="annlist"] .gt-annitem .nt')].some((e) => (e.textContent ?? '').includes('冒烟笔记'))`
    )
    record('高亮加笔记', noteOk, noteOk ? '笔记已保存展示' : '笔记未保存')
    if (!noteOk) return finish(false)

    // 关闭重开：高亮层 + 笔记仍从 SQLite 回来（重开后默认缩略图 tab，切回标注断言）
    await evalJs<void>(`document.querySelector('.gt-reader-toolbar button[title="关闭"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    await sleep(400)
    // D113（lane/detail 批 2）：详情页仍开在 Delta，直接再点「打开 PDF」重开阅读器
    // （段外最小改动，见 Q-M4-D2-1；断言不变）
    if (!(await waitFor(`!!document.querySelector('[data-testid="paper-detail-page"]')`))) {
      record('重开标注仍在', false, '详情页不在')
      return finish(false)
    }
    await evalJs<boolean>(`__gt.clickText('.gt-pd-bar button', '打开 PDF')`)
    const stillHl = await waitFor(`!!document.querySelector('[data-testid="pdf-reader"]') && document.querySelectorAll('.gt-hl').length > 0`, 20000)
    if (!stillHl) {
      record('重开标注仍在', false, '重开后高亮层丢失')
      return finish(false)
    }
    await evalJs<void>(`document.querySelector('[data-testid="tab-ann"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const stillNote = await waitFor(
      `[...document.querySelectorAll('[data-testid="annlist"] .gt-annitem .nt')].some((e) => (e.textContent ?? '').includes('冒烟笔记'))`
    )
    record('重开标注仍在', stillNote, stillNote ? '高亮层与笔记重开后仍在（SQLite 持久化）' : '重开后笔记丢失')
    if (!stillNote) return finish(false)

    // 评审建 2：点页面上的高亮块进编辑（textlayer 层序盖住高亮层，单击走命中路径）
    const hlRect = await stableHlRect()
    if (!hlRect) {
      record('点页面高亮进编辑', false, '页面上没有稳定可见的高亮块')
      return finish(false)
    }
    const hx = hlRect.left + hlRect.width / 2
    const hy = hlRect.top + hlRect.height / 2
    mouse('mouseDown', hx, hy)
    await sleep(80)
    mouse('mouseUp', hx, hy)
    const editUp = await waitFor(
      `!!document.querySelector('[data-testid="annlist"] .gt-annitem.on textarea')`
    )
    record('点页面高亮进编辑', editUp, editUp ? '单击高亮区域命中并进入笔记编辑' : '单击未进入编辑')
    ok = ok && editUp
    // 收起编辑（点列表项头切回非编辑态），避免残留编辑态影响后续步骤
    await evalJs<void>(`document.querySelector('[data-testid="annlist"] .gt-annitem.on .hd')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    await sleep(200)

    // D105②：笔记工具模式 → 点页面空白处建独立笔记锚点 + 页边笔记卡 → 填内容保存
    await evalJs<void>(`document.querySelector('[data-testid="tool-note"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const pageRect2 = await evalJs<{ left: number; top: number; width: number; height: number } | null>(`
      (() => {
        const el = document.querySelector('.gt-page')
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { left: r.left, top: r.top, width: r.width, height: r.height }
      })()
    `)
    if (!pageRect2) {
      record('独立笔记锚点', false, '找不到页面')
      return finish(false)
    }
    // 页面比视口高（fit-width），底部在视口外；取页面中下部、避开顶部高亮文本的可见点
    const nx = pageRect2.left + pageRect2.width * 0.5
    const ny = Math.min(pageRect2.top + pageRect2.height * 0.55, 800)
    mouse('mouseDown', nx, ny)
    await sleep(80)
    mouse('mouseUp', nx, ny)
    const noteCard = await waitFor(
      `document.querySelectorAll('.gt-nmark').length === 1 && !!document.querySelector('[data-testid="notecard"] textarea')`
    )
    if (!noteCard) {
      const diag = await evalJs<string>(`
        JSON.stringify({
          toolNoteOn: document.querySelector('[data-testid="tool-note"]')?.className ?? null,
          nmarks: document.querySelectorAll('.gt-nmark').length,
          card: !!document.querySelector('[data-testid="notecard"]'),
          annitems: document.querySelectorAll('[data-testid="annlist"] .gt-annitem').length,
          atClick: (() => {
            const el = document.elementFromPoint(${JSON.stringify(nx)}, ${JSON.stringify(ny)})
            return el ? (el.className.toString() || el.tagName).slice(0, 40) : null
          })()
        })
      `)
      record('独立笔记锚点', false, `锚点或笔记卡未出现：${diag}`)
      return finish(false)
    }
    await evalJs<boolean>(`__gt.setInput('[data-testid="notecard"] textarea', '独立冒烟笔记')`)
    await sleep(120)
    await evalJs<boolean>(`__gt.clickText('[data-testid="notecard"] button', '保存')`)
    const noteSaved = await waitFor(
      `document.querySelectorAll('.gt-nmark').length === 1 && !document.querySelector('[data-testid="notecard"]')`
    )
    record('独立笔记锚点', noteSaved, noteSaved ? '笔记模式点页面建锚点 + 笔记卡可保存' : '笔记保存失败')
    ok = ok && noteSaved

    // 「按 bbox 跳到图」（D27）：切到「图」标签 → 点图块 → 页面闪烁高亮区域
    await evalJs<void>(`document.querySelector('[data-testid="tab-fig"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const figListed = await waitFor(
      `[...document.querySelectorAll('[data-testid="figlist"] .gt-annitem')].some((e) => (e.textContent ?? '').includes('图 1'))`
    )
    if (!figListed) {
      record('按bbox跳到图', false, '图列表没有图块')
      return finish(false)
    }
    await evalJs<void>(`document.querySelector('[data-testid="figlist"] .gt-annitem').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const figJump = await waitFor(`!!document.querySelector('[data-testid="fig-flash"]')`)
    record('按bbox跳到图', figJump, figJump ? '跳图后目标区域闪烁高亮' : '没有出现闪烁高亮')
    ok = ok && figJump

    // ===== M4 lane/render steps =====（lane/render 只在本段内追加步骤）
    // M4 lane/render：在真实 renderer 里挂载 PartsView 冒烟（经 window.__gtSmokeParts——
    // 入口由 lane/render 的 richtext/smokeEntry.ts 在 ?smoke=1 时暴露，不经详情页/路由）。
    // 假 parts + Delta 论文的真实解析缓存图（段内写一个程序生成的 1x1 PNG，非真实论文输出）。
    const deltaRow = state.db.prepare("SELECT id FROM papers WHERE title = 'Smoke Paper Delta'").get() as { id: number }
    const deltaId = deltaRow.id
    const deltaImgDir = join(state.dataDir, 'papers', String(deltaId), 'mineru', 'images')
    mkdirSync(deltaImgDir, { recursive: true })
    // 1x1 PNG（冒烟合成，仅用于验证本地缓存图渲染通道）
    writeFileSync(
      join(deltaImgDir, 'page_0_image_1.jpg'),
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    )
    // D115：data-image 的 localPath 是数据目录内相对路径（经 gt-asset:// 加载）
    const localCacheImg = `papers/${deltaId}/mineru/images/page_0_image_1.jpg`
    const SMOKE_SIX_PARTS = [
      { type: 'text', text: '行内公式 $e^{i\\pi}+1=0$ 与表格\\n\\n| 指标 | 值 |\\n|---|---|\\n| F1 | 0.91 |\\n\\n详见 [arXiv 原文](https://arxiv.org/abs/0000.00000)' },
      { type: 'source', section: '3.2 方法', quote: '冒烟引用原文' },
      { type: 'data-figure', id: 'sf1', status: 'done', figureNo: 1, caption: '冒烟合成图注' },
      {
        type: 'data-image',
        id: 'si1',
        status: 'done',
        url: 'https://example.com/never-fetched.png',
        localPath: localCacheImg,
        alt: '本地缓存示意图',
        sourceUrl: 'https://example.com/source-page',
        sourceTitle: '冒烟来源'
      },
      {
        type: 'data-chart',
        id: 'sc1',
        status: 'done',
        title: '冒烟图表',
        option: { xAxis: { type: 'category', data: ['a', 'b'] }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: [1, 2] }] },
        dataSource: '表 1（冒烟合成）'
      },
      { type: 'data-mermaid', id: 'sm1', status: 'done', title: '冒烟流程', code: 'graph TD; A-->B' }
    ]
    const renderSmokeParts = async (parts: unknown[]): Promise<boolean> =>
      evalJs<boolean>(`(() => {
        if (!window.__gtSmokeParts) return false
        window.__gtSmokeParts.render(${JSON.stringify(parts)}, { host: { paperId: ${deltaId} } })
        return true
      })()`)

    const smokeEntryUp = await waitFor(`!!window.__gtSmokeParts`)
    if (!smokeEntryUp) {
      record('渲染六种 part', false, 'smoke 挂载入口 __gtSmokeParts 未暴露')
      return finish(false)
    }
    if (!(await renderSmokeParts(SMOKE_SIX_PARTS))) {
      record('渲染六种 part', false, '挂载调用失败')
      return finish(false)
    }
    const sixOk = await waitFor(
      `!!document.querySelector('[data-testid="part-text"]') &&
       !!document.querySelector('[data-testid="part-source"]') &&
       !!document.querySelector('[data-testid="part-figure"]') &&
       !!document.querySelector('[data-testid="part-image"]') &&
       !!document.querySelector('[data-testid="part-chart"]') &&
       !!document.querySelector('[data-testid="part-mermaid"]')`,
      20000
    )
    record('渲染六种 part', sixOk, sixOk ? 'text/source/figure/image/chart/mermaid 各渲染一步' : '六种 part 未全部渲染')
    if (!sixOk) return finish(false)

    // KaTeX 节点：公式必须渲染成 .katex（不是裸 $ 文本）
    const katexOk = await waitFor(`!!document.querySelector('[data-testid="part-text"] .katex')`)
    record('KaTeX 公式节点', katexOk, katexOk ? '行内公式已渲染为 .katex' : '没有出现 .katex 节点')
    if (!katexOk) return finish(false)

    // data-chart 用 SVG 渲染器（评审建 1：注册与 init 口径一致，断言无 canvas）
    const chartSvgOk = await waitFor(
      `!!document.querySelector('[data-testid="chart-box"] svg') && !document.querySelector('[data-testid="chart-box"] canvas')`,
      15000
    )
    record('图表SVG渲染', chartSvgOk, chartSvgOk ? 'chart-box 内为 svg 元素、无 canvas' : '图表未走 SVG 渲染')
    if (!chartSvgOk) return finish(false)

    // 评审必 1：正文链接点击不导航（preventDefault），React 应用不被卸载
    const hrefBefore = await evalJs<string>(`window.location.href`)
    await evalJs<void>(`document.querySelector('[data-testid="part-text"] a')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))`)
    await sleep(400)
    const linkNavOk = await evalJs<boolean>(`window.location.href === ${JSON.stringify(hrefBefore)} && !!document.querySelector('[data-testid="parts-view"]')`)
    record('正文链接不导航', linkNavOk, linkNavOk ? '点击 http 链接后地址不变、应用仍在' : '链接发生了站内导航')
    ok = ok && linkNavOk

    // data-image 只走本地缓存：src 必须是 gt-asset://（D115）且绝不出现 http(s)（D109，无网络请求），
    // 且图片真实加载成功（主进程协议 realpath 校验通过、CSP img-src 放行 gt-asset:）
    const imgLoaded = await waitFor(`(() => { const img = document.querySelector('[data-testid="part-image"] img'); return !!img && img.complete && img.naturalWidth > 0 })()`, 10000)
    const imgLocal = await evalJs<{ src: string; natural: number } | null>(`
      (() => {
        const img = document.querySelector('[data-testid="part-image"] img')
        return img ? { src: img.getAttribute('src') ?? '', natural: img.naturalWidth } : null
      })()
    `)
    const imgOk =
      imgLoaded && !!imgLocal && imgLocal.src.startsWith('gt-asset://data/') && !/^https?:/.test(imgLocal.src) && !imgLocal.src.includes(state.dataDir)
    record('图片仅本地缓存', imgOk, imgOk ? `src=${imgLocal!.src.slice(0, 60)}… 经 gt-asset 加载成功（${imgLocal!.natural}px）` : `图片未经 gt-asset 加载：${JSON.stringify(imgLocal)}`)
    ok = ok && imgOk

    // D115：gt-asset 拒绝穿越与指向数据目录外的 symlink（主进程 realpath 校验），合法路径照常加载
    const outsideDir = mkdtempSync(join(tmpdir(), 'gt-smoke-outside-'))
    const evilLink = join(state.dataDir, 'papers', String(deltaId), 'evil.png')
    let assetGuard: boolean[]
    try {
      writeFileSync(join(outsideDir, 'secret.png'), readFileSync(join(deltaImgDir, 'page_0_image_1.jpg')))
      try {
        rmSync(evilLink, { force: true })
      } catch {
        /* ignore */
      }
      symlinkSync(join(outsideDir, 'secret.png'), evilLink)
      const probe = (u: string): string =>
        `new Promise((res) => { const i = new Image(); i.onload = () => res(i.naturalWidth > 0); i.onerror = () => res(false); i.src = ${JSON.stringify(u)} })`
      assetGuard = await evalJs<boolean[]>(`Promise.all([
        ${probe(`gt-asset://data/papers/${deltaId}/mineru/images/page_0_image_1.jpg`)},
        ${probe(`gt-asset://data/papers/${deltaId}/evil.png`)},
        ${probe(`gt-asset://data/papers/${deltaId}/%2E%2E/%2E%2E/%2E%2E/${encodeURIComponent(outsideDir.replace(/^\//, ''))}/secret.png`)},
        ${probe(`file://${join(deltaImgDir, 'page_0_image_1.jpg')}`)}
      ])`)
    } finally {
      rmSync(evilLink, { force: true })
      rmSync(outsideDir, { recursive: true, force: true })
    }
    const [legit, viaSymlink, viaDotdot] = assetGuard
    const guardOk = legit === true && viaSymlink === false && viaDotdot === false
    record('gt-asset 防穿越', guardOk, guardOk ? `合法图加载；symlink 外指与 .. 穿越均被拒（file:// 直读=${assetGuard[3] ? '仍可' : '不可'}）` : `结果异常：${JSON.stringify(assetGuard)}`)
    ok = ok && guardOk

    // 图块：解析缓存图渲染 + 点击触发 onOpenFigure(1)
    const figClickOk = await waitFor(`(() => {
      const card = document.querySelector('[data-testid="part-figure"] .gt-figure-card')
      if (!card) return false
      card.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return window.__gtSmokeParts.lastFigureNo() === 1
    })()`)
    record('图块点击onOpenFigure', figClickOk, figClickOk ? '点击图块回调 figureNo=1' : '回调未触发')
    if (!figClickOk) return finish(false)

    // 未知类型 → 灰色降级块「不支持的块类型」（data-paper-card 属 M5，不在白名单）
    if (!(await renderSmokeParts([{ type: 'data-paper-card', title: 'M5 候选卡' }]))) {
      record('未知类型降级块', false, '挂载调用失败')
      return finish(false)
    }
    const fallbackOk = await waitFor(
      `!!document.querySelector('[data-testid="part-fallback"]') && document.querySelector('[data-testid="part-fallback"]').textContent.includes('不支持的块类型')`
    )
    record('未知类型降级块', fallbackOk, fallbackOk ? 'data-paper-card 渲染灰色降级块' : '降级块未出现')
    ok = ok && fallbackOk
    await evalJs<void>(`window.__gtSmokeParts.unmount()`)
    // ===== M4 lane/render steps end =====

    // ===== M4 lane/detail steps =====（lane/detail 只在本段内追加步骤）
    // 数据准备（main 侧直写测试库，绝不触真实数据）：Beta 塞缓存详情（旧 prompt_version
    // → 过期条数据源）+ AI 摘要标记；Beta/Delta 各补一条 succeeded 任务（papersStatus 数据源）；
    // Delta 加入冒烟图谱做「打开 PDF ↔ 返回详情」数据源（Alpha 失败任务为 seed 既有）。
    const detailNow = new Date().toISOString()
    const betaRow = state.db.prepare("SELECT id FROM papers WHERE title = 'Smoke Paper Beta'").get() as { id: number }
    const detailDeltaRow = state.db.prepare("SELECT id FROM papers WHERE title = 'Smoke Paper Delta'").get() as { id: number }
    const gammaRow = state.db.prepare("SELECT id FROM papers WHERE title = 'Smoke Paper Gamma'").get() as { id: number }
    state.db
      .prepare(
        "UPDATE papers SET has_pdf = 1, pdf_hash = 'smoke-v1', abstract = '冒烟摘要：验证检索增强智能体的停止决策（AI 生成标记数据源）。', abstract_source = 'ai' WHERE id = ?"
      )
      .run(betaRow.id)
    state.db
      .prepare(
        `INSERT INTO paper_details (paper_id, parts, model, prompt_version, pdf_hash, generated_at, created_at, updated_at)
         VALUES (?, ?, 'deepseek-flash', 'detail-v0', 'smoke-v1', ?, ?, ?)`
      )
      .run(betaRow.id, JSON.stringify([{ type: 'text', text: '冒烟缓存详情正文：问题、方法、结论占位。' }]), detailNow, detailNow, detailNow)
    const insSucceededJob = state.db.prepare(
      "INSERT INTO jobs (kind, paper_id, status, payload, created_at, updated_at) VALUES ('process_paper', ?, 'succeeded', '{}', ?, ?)"
    )
    insSucceededJob.run(betaRow.id, detailNow, detailNow)
    insSucceededJob.run(detailDeltaRow.id, detailNow, detailNow)
    state.db
      .prepare('INSERT OR IGNORE INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 280, 80, ?)')
      .run(graphId, detailDeltaRow.id, detailNow)
    state.db
      .prepare('INSERT OR IGNORE INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, -80, 200, ?)')
      .run(graphId, gammaRow.id, detailNow)

    const clickNode = async (substr: string): Promise<boolean> => {
      // D176：单击只选择；旧步骤的「点节点进详情」统一改为可信双击。
      // 标题必须对上：任一详情页残留或点到重叠节点都不能算打开了目标论文。
      if (!(await doubleClickNode(substr))) return false
      const needle = JSON.stringify(substr)
      return waitFor(`(() => {
        const page = document.querySelector('[data-testid="paper-detail-page"]')
        if (!page) return false
        return (page.querySelector('.ttl')?.textContent ?? '').includes(${needle})
      })()`)
    }
    const backToGraph = async (): Promise<boolean> => {
      await evalJs<boolean>(`__gt.clickText('.toolbar button', '返回')`)
      return waitFor(`!!document.querySelector('.react-flow__node')`)
    }

    // 关闭上一段遗留的阅读器（底下是 Delta 详情页，D113 后入口只剩详情页一路）→
    // 详情页「返回」回冒烟图谱（Delta 已进图，应 4 个节点）
    await evalJs<void>(`document.querySelector('.gt-reader-toolbar button[title="关闭"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    await sleep(400)
    await evalJs<boolean>(`__gt.clickText('[data-testid="paper-detail-page"] .toolbar button', '返回')`)
    const graphReady = await waitFor(`(document.querySelector('.ttl')?.textContent ?? '').includes('冒烟图谱') && __gt.nodeCount() === 4`)
    record('详情页进图', graphReady, graphReady ? '画布 4 节点就绪' : '画布未就绪或节点数不为 4')
    if (!graphReady) return finish(false)

    // 03e（D111，M6 lane/ui 批 1 实装）：Gamma 无 PDF → 元数据 + 拖入区/再试一次/尝试过的来源
    if (!(await clickNode('Gamma'))) {
      record('03e无PDF简版', false, '点击 Gamma 节点未进详情页')
      return finish(false)
    }
    const noPdfOk = await waitFor(
      `(() => {
        const page = document.querySelector('[data-testid="paper-detail-page"]')
        if (!page) return false
        const t = page.innerText
        // lane/ui M6 批 1：03e 占位已实装（D111 落地），「M6 接入」角标移除——
        // 改断言为实装后的「再试一次查找」按钮（本行属 M4 lane/detail 段，维护者请复核）
        return t.includes('无 PDF') && t.includes('尝试过的来源') &&
          !!page.querySelector('[data-testid="nopdf-drop"]') &&
          !!page.querySelector('[data-testid="nopdf-retry"]') &&
          // D112 于 M5 lane/chat 批 2 解禁：对话入口不再是 disabled 占位（随 8a52cb3 合并入
          // main；chat→main 合并批清单② 正式收编为维护者变更——re-verify：断言与解禁后
          // PaperDetailPage 渲染一致，属 D112 必然连带）
          !!page.querySelector('[data-testid="pd-chat"]:not([disabled])')
      })()`
    )
    record('03e无PDF简版', noPdfOk, noPdfOk ? '实装：拖入区/再试一次/来源行 + 对话入口（D112 已解禁）齐全' : '03e 内容缺失')
    if (!noPdfOk) return finish(false)
    if (!(await backToGraph())) {
      record('03e无PDF简版', false, '返回图谱失败')
      return finish(false)
    }

    // 03d 失败态（D48）：Alpha 节点 → 详情页失败视图，含失败步骤/原因/重试按钮（D85 口径文案）
    if (!(await clickNode('Alpha'))) {
      record('03d节点失败态', false, '点击 Alpha 节点未进详情页')
      return finish(false)
    }
    const failedOk = await waitFor(
      `document.body.innerText.includes('处理失败') && document.body.innerText.includes('MinerU 解析') &&
       document.body.innerText.includes('MinerU 进程意外退出') &&
       [...document.querySelectorAll('[data-testid="paper-detail-page"] button')].some((b) => (b.textContent ?? '').includes('重试'))`
    )
    record('03d节点失败态', failedOk, failedOk ? '失败步骤/原因/重试按钮齐全' : '失败态内容缺失')
    if (!failedOk) return finish(false)
    if (!(await backToGraph())) {
      record('03d节点失败态', false, '返回图谱失败')
      return finish(false)
    }

    // 03d2（评审建 1）：失败在「生成详情」步 → 前序步骤（解析/名片）显示「完成」，
    // 提示「已自动重试 3 次仍未成功」（与 D85 重试口径一致）。Gamma 无 PDF 也进失败态（失败优先于 03e）。
    const d2Job = state.db
      .prepare(
        "INSERT INTO jobs (kind, paper_id, status, current_step, failed_step, error, payload, created_at, updated_at) VALUES ('process_paper', ?, 'failed_retryable', NULL, 'detail', '模型返回的内容不完整（示例）', '{}', ?, ?)"
      )
      .run(gammaRow.id, detailNow, detailNow).lastInsertRowid as number
    if (!(await clickNode('Gamma'))) {
      record('03d2详情步失败', false, '点击 Gamma 节点未进详情页')
      return finish(false)
    }
    const d2Ok = await waitFor(
      `(() => {
        const page = document.querySelector('[data-testid="paper-detail-page"]')
        if (!page) return false
        const t = page.innerText
        return t.includes('处理失败') && t.includes('生成详情') && t.includes('模型返回的内容不完整') &&
          t.includes('已自动重试 3 次仍未成功') && (t.match(/完成/g) ?? []).length >= 2 && t.includes('失败')
      })()`
    )
    record('03d2详情步失败', d2Ok, d2Ok ? '失败在详情步：前序步骤显示完成' : '03d2 内容缺失')
    if (!d2Ok) return finish(false)
    state.db.prepare('DELETE FROM job_steps WHERE job_id = ?').run(Number(d2Job))
    state.db.prepare('DELETE FROM jobs WHERE id = ?').run(Number(d2Job)) // 还原 Gamma 为未处理
    if (!(await backToGraph())) {
      record('03d2详情步失败', false, '返回图谱失败')
      return finish(false)
    }

    // 03 缓存详情：Beta 节点 → 缓存正文 + 「生成于」+ AI 摘要标记（03g）+ 过期条（旧 prompt_version）。
    // 断言只依赖页面文本，不引用 lane/render 的 PartsView 内部 testid/类名（评审建 4）。
    if (!(await clickNode('Beta'))) {
      record('03缓存详情', false, '点击 Beta 节点未进详情页')
      return finish(false)
    }
    const cachedOk = await waitFor(
      `(() => {
        const page = document.querySelector('[data-testid="paper-detail-page"]')
        if (!page) return false
        const t = page.innerText
        return t.includes('冒烟缓存详情正文') && t.includes('生成于') && t.includes('deepseek-flash') &&
          t.includes('AI 生成') && !!page.querySelector('[data-testid="stale-bar"]') &&
          (page.querySelector('[data-testid="stale-bar"]')?.textContent ?? '').includes('不会自动更新')
      })()`
    )
    record('03缓存详情', cachedOk, cachedOk ? '缓存正文/生成于/AI 标记/过期条齐全' : '缓存详情内容缺失')
    if (!cachedOk) return finish(false)

    // 03c（D42）：重新生成二次确认（覆盖、不保留旧版）→ detail:regenerate 入队 detail_regen（D108）
    await evalJs<boolean>(`__gt.clickText('.gt-pd-bar button', '重新生成')`)
    const confirmUp = await waitFor(
      `(() => { const m = document.querySelector('.ov .modal.cfm'); const t = m?.textContent ?? ''; return t.includes('重新生成详情') && t.includes('覆盖现在的详情') && t.includes('不能用 ⌘Z 撤销') })()`
    )
    if (!confirmUp) {
      record('03c重新生成确认', false, '确认框未弹出或文案不符')
      return finish(false)
    }
    await evalJs<boolean>(`__gt.clickText('.modal.cfm button', '重新生成')`)
    // main 侧轮询 detail_regen 入队（冒烟模式无 Key，任务会很快转 waiting_key，存在即算入队成功）
    const regenJobId = await (async (): Promise<number | null> => {
      const t0 = Date.now()
      while (Date.now() - t0 < 8000) {
        const row = state.db
          .prepare("SELECT id FROM jobs WHERE kind = 'detail_regen' AND paper_id = ? ORDER BY id DESC LIMIT 1")
          .get(betaRow.id) as { id: number } | undefined
        if (row) return row.id
        await sleep(150)
      }
      return null
    })()
    const regenOk = regenJobId != null
    record('03c重新生成确认', regenOk, regenOk ? `确认后 detail_regen 已入队（job=${regenJobId}）` : '确认后任务未入队')
    if (!regenOk) return finish(false)

    // D50：重新生成不进撤销历史——回图谱按 ⌘Z，应提示「没有可撤销的操作」
    if (!(await backToGraph())) {
      record('D50重新生成不进撤销', false, '返回图谱失败')
      return finish(false)
    }
    win.webContents.sendInputEvent({ type: 'rawKeyDown', keyCode: 'z', modifiers: ['meta'] })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'z', modifiers: ['meta'] })
    const noUndo = await waitFor(`document.body.innerText.includes('没有可撤销的操作')`)
    record('D50重新生成不进撤销', noUndo, noUndo ? '⌘Z 提示无可撤销（撤销栈未被重新生成写入）' : '⌘Z 出现了非预期行为')
    ok = ok && noUndo

    // 03b 排队中（评审建 5）：queued 任务 → 三步骤全「等待」+「打开 PDF」可用。
    // 竞态加固（批 3，评审建议修 3）：直写 queued 任务与 2s runner drain 定时器有抢跑窗口
    // （任务被捞走跑 parse → Beta 无 PDF 文件 → 页面瞬间从「排队中」翻成失败态）。
    // 双闸：① setLlmQueuePaused 暂停 LLM 队列（任务书指定，含 finally 恢复）；
    // ② 任务 next_retry_at 推到 1 小时后——drain 的 runnable 查询只捞到期的 queued 任务，
    //    这才是真正挡住抢跑的闸（pause 不拦 parse 步）；finally 清理含失败路径。
    setLlmQueuePaused(state.db, '冒烟：03b 排队视图断言')
    const queuedRetryAt = new Date(Date.now() + 3600_000).toISOString()
    let queuedJob = 0
    try {
      queuedJob = Number(
        state.db
          .prepare(
            "INSERT INTO jobs (kind, paper_id, status, payload, next_retry_at, created_at, updated_at) VALUES ('process_paper', ?, 'queued', '{}', ?, ?, ?)"
          )
          .run(betaRow.id, queuedRetryAt, detailNow, detailNow).lastInsertRowid
      )
      if (!(await clickNode('Beta'))) {
        record('03b排队中', false, '点击 Beta 节点未进详情页')
        return finish(false)
      }
      const queuedOk = await waitFor(
        `(() => {
          const page = document.querySelector('[data-testid="paper-detail-page"]')
          if (!page) return false
          const t = page.innerText
          const openBtn = [...page.querySelectorAll('.gt-pd-bar button')].find((b) => (b.textContent ?? '').includes('打开 PDF'))
          return t.includes('排队中') && (t.match(/等待/g) ?? []).length >= 3 && !!openBtn && !openBtn.disabled
        })()`
      )
      record('03b排队中', queuedOk, queuedOk ? 'queued：步骤全等待，打开 PDF 可用' : 'queued 视图缺失')
      if (!queuedOk) return finish(false)
    } finally {
      setLlmQueuePaused(state.db, null)
      if (queuedJob > 0) {
        state.db.prepare('DELETE FROM job_steps WHERE job_id = ?').run(queuedJob)
        state.db.prepare('DELETE FROM jobs WHERE id = ?').run(queuedJob) // 还原 Beta 为 succeeded
      }
    }
    if (!(await backToGraph())) {
      record('03b排队中', false, '返回图谱失败')
      return finish(false)
    }

    // 03h + D105 ①②：Delta 详情生成中（running/current_step=detail）→ 打开 PDF 可用（评审建 2）
    // → PdfReader → 「论文详情」返回；任务标成功后页面自动刷新为详情视图
    const runningJob = state.db
      .prepare(
        "INSERT INTO jobs (kind, paper_id, status, current_step, payload, created_at, updated_at) VALUES ('process_paper', ?, 'running', 'detail', '{}', ?, ?)"
      )
      .run(detailDeltaRow.id, detailNow, detailNow).lastInsertRowid as number
    if (!(await clickNode('Delta'))) {
      record('03h生成中可开PDF', false, '点击 Delta 节点未进详情页')
      return finish(false)
    }
    const runningOk = await waitFor(
      `(() => {
        const page = document.querySelector('[data-testid="paper-detail-page"]')
        if (!page) return false
        const t = page.innerText
        const openBtn = [...page.querySelectorAll('.gt-pd-bar button')].find((b) => (b.textContent ?? '').includes('打开 PDF'))
        return t.includes('正在生成详情') && !!openBtn && !openBtn.disabled
      })()`
    )
    record('03h生成中可开PDF', runningOk, runningOk ? '03h：详情步生成中，打开 PDF 可用' : '03h 视图或打开 PDF 状态不对')
    if (!runningOk) return finish(false)
    await evalJs<boolean>(`__gt.clickText('.gt-pd-bar button', '打开 PDF')`)
    const readerOpen = await waitFor(
      `!!document.querySelector('[data-testid="pdf-reader"]') &&
       [...document.querySelectorAll('.gt-textlayer span')].some((s) => (s.textContent ?? '').includes('Smoke Reader Fixture Line One'))`,
      20000
    )
    if (!readerOpen) {
      record('D105打开PDF返回详情', false, '详情页打开 PDF 后阅读器未就绪')
      return finish(false)
    }
    await evalJs<void>(`document.querySelector('.gt-reader-toolbar button[title="返回论文详情"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const backDetail = await waitFor(`!!document.querySelector('[data-testid="paper-detail-page"]')`)
    if (!backDetail) {
      record('D105打开PDF返回详情', false, '阅读器返回位未回详情页')
      return finish(false)
    }
    // 任务成功 → 详情页自动从 03h 切到详情视图（usePapersStatus 事件/轮询驱动重拉）
    state.db.prepare("UPDATE jobs SET status = 'succeeded', current_step = NULL WHERE id = ?").run(Number(runningJob))
    const flipped = await waitFor(
      `(() => { const page = document.querySelector('[data-testid="paper-detail-page"]'); return !!page && page.innerText.includes('还没有详情') })()`,
      12000
    )
    record('03h任务成功自动刷新', flipped, flipped ? '任务成功后 03h 自动切到详情视图' : '成功后页面未刷新')
    ok = ok && flipped

    // 回归（B9）：详情往返后图谱状态不变——仍是冒烟图谱、节点数 4、Alpha 坐标 = 拖拽后的持久化坐标
    if (!(await backToGraph())) {
      record('图谱上下文回归', false, '返回图谱失败')
      return finish(false)
    }
    const graphCtx = await evalJs<{ name: string; count: number; x: number; y: number }>(`
      window.graphictero.getGraph(${graphId}).then((d) => ({
        name: d.graph.name,
        count: d.members.length,
        x: d.members.find((m) => m.paper.title.includes('Alpha')).x,
        y: d.members.find((m) => m.paper.title.includes('Alpha')).y
      }))
    `)
    const nodeCountNow = await evalJs<number>(`__gt.nodeCount()`)
    const ctxOk =
      graphCtx.name === '冒烟图谱' &&
      nodeCountNow === 4 &&
      Math.abs(graphCtx.x - final.x) < 1 &&
      Math.abs(graphCtx.y - final.y) < 1
    record('图谱上下文回归', ctxOk, `图=${graphCtx.name} 节点=${nodeCountNow} Alpha=(${graphCtx.x.toFixed(1)},${graphCtx.y.toFixed(1)})`)
    ok = ok && ctxOk

    // 详情图块跳 PDF（评审 review_lane_detail2 §6-2，onOpenFigure 接线）：
    // 段内 seed 一篇带 PDF fixture + MinerU 图块缓存 + 含 data-figure(figureNo:1) 缓存详情的
    // 合成论文（变量名 detailFig 前缀，避开 render 段的 deltaRow/deltaId）。
    const detailFigNow = new Date().toISOString()
    const detailFigId = Number(
      state.db
        .prepare("INSERT INTO papers (title, source, has_pdf, pdf_hash, created_at, updated_at) VALUES ('Smoke Paper FigJump', 'zotero', 1, 'fig-smoke-v1', ?, ?)")
        .run(detailFigNow, detailFigNow).lastInsertRowid
    )
    state.db
      .prepare('INSERT INTO paper_authors (paper_id, position, family, given, normalized) VALUES (?, 0, \'Fig\', \'Jump\', \'jump fig\')')
      .run(detailFigId)
    mkdirSync(join(state.dataDir, 'papers', String(detailFigId)), { recursive: true })
    writeFileSync(join(state.dataDir, 'papers', String(detailFigId), 'paper.pdf'), smokeFixturePdf())
    mkdirSync(join(state.dataDir, 'papers', String(detailFigId), 'mineru'), { recursive: true })
    writeFileSync(
      join(state.dataDir, 'papers', String(detailFigId), 'mineru', 'structured_content.json'),
      JSON.stringify({
        pages: [
          {
            page_idx: 0,
            blocks: [
              { type: 'image', bbox: [0.1, 0.08, 0.6, 0.13], captions: [{ content: '图 1 冒烟方法总览图' }], image_source: 'images/page_0_image_1.jpg' }
            ]
          }
        ]
      })
    )
    state.db
      .prepare("INSERT INTO jobs (kind, paper_id, status, payload, created_at, updated_at) VALUES ('process_paper', ?, 'succeeded', '{}', ?, ?)")
      .run(detailFigId, detailFigNow, detailFigNow)
    state.db
      .prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 120, -60, ?)')
      .run(graphId, detailFigId, detailFigNow)
    state.db
      .prepare(
        `INSERT INTO paper_details (paper_id, parts, model, prompt_version, pdf_hash, generated_at, created_at, updated_at)
         VALUES (?, ?, 'deepseek-flash', ?, 'fig-smoke-v1', ?, ?, ?)`
      )
      .run(
        detailFigId,
        JSON.stringify([
          { type: 'text', text: '冒烟图块详情正文。' },
          { type: 'data-figure', id: 'fig-overview', status: 'done', figureNo: 1, caption: '冒烟方法总览图' }
        ]),
        DETAIL_PROMPT.version,
        detailFigNow,
        detailFigNow,
        detailFigNow
      )

    // 画布在当前图谱页打开期间不会自动重载——回首页再重开图谱，让 FigJump 节点上画布
    await evalJs<boolean>(`__gt.clickText('.toolbar button', '我的图谱')`)
    if (!(await waitFor(`document.body.innerText.includes('我的图谱') && [...document.querySelectorAll('button')].some((b) => (b.textContent ?? '').includes('新建图谱'))`))) {
      record('详情图块跳PDF', false, '返回首页失败')
      return finish(false)
    }
    await evalJs<boolean>(`__gt.clickText('.sitem', '冒烟图谱')`)
    if (!(await waitFor(`(document.querySelector('.ttl')?.textContent ?? '').includes('冒烟图谱') && __gt.nodeCount() === 5`))) {
      record('详情图块跳PDF', false, '重开图谱后节点数不为 5')
      return finish(false)
    }
    if (!(await clickNode('FigJump'))) {
      record('详情图块跳PDF', false, '点击 FigJump 节点未进详情页')
      return finish(false)
    }
    const figBlockUp = await waitFor(
      `(() => {
        const page = document.querySelector('[data-testid="paper-detail-page"]')
        return !!page && page.innerText.includes('冒烟图块详情正文') && !!page.querySelector('[data-testid="part-figure"]')
      })()`
    )
    if (!figBlockUp) {
      record('详情图块跳PDF', false, 'data-figure 图块未渲染')
      return finish(false)
    }
    // 等图块从 loading 解析到 found（button 就绪、可点）再点
    const figBtnReady = await waitFor(
      `!!document.querySelector('[data-testid="part-figure"] button.gt-figure-card:not([disabled])')`
    )
    if (!figBtnReady) {
      record('详情图块跳PDF', false, '图块未在超时内解析为可点状态')
      return finish(false)
    }
    await evalJs<void>(`document.querySelector('[data-testid="part-figure"] button.gt-figure-card').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    // 阅读器打开 + 自动跳到图所在页（p.1）+ bbox 闪烁高亮；闪烁只 1.5s，waitFor 轮询能接住。
    // uat3 必须修 1：闪烁高亮必须在视口内（到达目标页才起算闪烁时长）
    const figJumpOk = await waitFor(
      `!!document.querySelector('[data-testid="pdf-reader"]') &&
       !!document.querySelector('[data-testid="fig-flash"]') &&
       (() => { const f = document.querySelector('[data-testid="fig-flash"]'); if (!f) return false; const r = f.getBoundingClientRect(); return __gt.inView({ left: r.left, top: r.top, width: r.width, height: r.height }) })() &&
       (document.querySelector('[data-testid="page-input"]')?.value ?? '') === '1'`,
      20000
    )
    if (!figJumpOk) {
      const diag = await evalJs<string>(`JSON.stringify({
        fig: (document.querySelector('[data-testid="part-figure"]')?.textContent ?? '').slice(0, 120),
        reader: !!document.querySelector('[data-testid="pdf-reader"]'),
        readerTxt: (document.querySelector('[data-testid="pdf-reader"]')?.textContent ?? '').slice(0, 120),
        pageno: document.querySelector('[data-testid="pageno"]')?.textContent ?? null,
        flash: !!document.querySelector('[data-testid="fig-flash"]')
      })`)
      record('详情图块跳PDF', false, `点击图块后阅读器未打开或未跳到图：${diag}`)
      return finish(false)
    }
    await evalJs<void>(`document.querySelector('.gt-reader-toolbar button[title="返回论文详情"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const figBackOk = await waitFor(`!!document.querySelector('[data-testid="paper-detail-page"]')`)
    record('详情图块跳PDF', figBackOk, figBackOk ? '图块点击→阅读器跳图(p.1+闪烁)→返回详情页' : '返回位未回详情页')
    ok = ok && figBackOk

    // 详情顶栏避让红绿灯（批 5，用户报的必修 bug）：占位元素存在 + 「返回」按钮 left ≥ 76
    // （红绿灯区 x18–70）；正常态（FigJump 详情页）与 03e 无 PDF 态（Gamma）各查一遍。
    const tlCheckCode = `
      (() => {
        const page = document.querySelector('[data-testid="paper-detail-page"]')
        if (!page) return false
        const inset = page.querySelector('.tlinset')
        const back = [...page.querySelectorAll('.toolbar button')].find((b) => (b.textContent ?? '').includes('返回'))
        if (!inset || !back) return false
        return back.getBoundingClientRect().left >= 76
      })()`
    const tlOk = await waitFor(tlCheckCode)
    record('详情顶栏避让红绿灯', tlOk, tlOk ? '占位存在，返回按钮 left≥76（正常态）' : '正常态顶栏仍压在红绿灯区')
    ok = ok && tlOk
    if (!(await backToGraph())) {
      record('详情顶栏避让红绿灯03e', false, '返回图谱失败')
      return finish(false)
    }
    if (!(await clickNode('Gamma'))) {
      record('详情顶栏避让红绿灯03e', false, '点击 Gamma 未进 03e 详情页')
      return finish(false)
    }
    const tl03eOk = await waitFor(tlCheckCode)
    record('详情顶栏避让红绿灯03e', tl03eOk, tl03eOk ? '03e 态：占位存在，返回按钮 left≥76' : '03e 态顶栏仍压在红绿灯区')
    ok = ok && tl03eOk
    if (!(await backToGraph())) {
      record('详情顶栏避让红绿灯03e', false, '返回图谱失败')
      return finish(false)
    }

    // uat8a D189：FigJump 增加图 2（子图注块 + 编号块，并集大于自身 bbox）。
    // 图 1 保持单面板，上面的「详情图块跳PDF」不受影响。断言图 2 的 img 来自裁图缓存。
    {
      writeFileSync(
        join(state.dataDir, 'papers', String(detailFigId), 'mineru', 'structured_content.json'),
        JSON.stringify({
          pages: [
            {
              page_idx: 0,
              blocks: [
                { type: 'image', bbox: [0.1, 0.08, 0.6, 0.13], captions: [{ content: '图 1 冒烟方法总览图' }], image_source: 'images/page_0_image_1.jpg' },
                { type: 'image', bbox: [0.05, 0.2, 0.48, 0.55], captions: [{ content: '(a) 左面板' }] },
                { type: 'image', bbox: [0.5, 0.2, 0.95, 0.7], captions: [{ content: '图 2 冒烟组合图' }], image_source: 'images/page_0_image_2.jpg' }
              ]
            }
          ]
        })
      )
      state.db.prepare('UPDATE paper_details SET parts = ? WHERE paper_id = ?').run(
        JSON.stringify([
          { type: 'text', text: '冒烟图块详情正文。' },
          { type: 'data-figure', id: 'fig-overview', status: 'done', figureNo: 1, caption: '冒烟方法总览图' },
          { type: 'data-figure', id: 'fig-union', status: 'done', figureNo: 2, caption: '冒烟组合图' }
        ]),
        detailFigId
      )
      if (!(await clickNode('FigJump'))) {
        record('D189多面板裁图', false, '点击 FigJump 未进详情页')
        return finish(false)
      }
      const cropOk = await waitFor(
        `(() => {
          const cards = [...document.querySelectorAll('[data-testid="part-figure"]')]
          const card = cards.find((c) => (c.textContent ?? '').includes('图 2'))
          if (!card) return false
          const img = card.querySelector('[data-testid="figure-card-img"]')
          if (!img || !img.src.includes('cache/figure-crops')) return false
          return img.complete && img.naturalWidth > 0
        })()`,
        25000
      )
      const cropDiag = cropOk
        ? ''
        : await evalJs<string>(`(() => {
            const cards = [...document.querySelectorAll('[data-testid="part-figure"]')].map((c) => ({
              t: (c.textContent ?? '').slice(0, 40),
              src: c.querySelector('img')?.getAttribute('src') ?? null,
              w: c.querySelector('img')?.naturalWidth ?? null
            }))
            return JSON.stringify(cards)
          })()`)
      record(
        'D189多面板裁图',
        cropOk,
        cropOk ? '图 2 图片来自 cache/figure-crops，且已解码出像素' : `图卡未走裁图缓存：${cropDiag}`
      )
      if (!cropOk) return finish(false)
      if (!(await backToGraph())) {
        record('D189多面板裁图', false, '返回图谱失败')
        return finish(false)
      }
    }
    // ===== M4 lane/detail steps end =====

    // ===== M5 prereq steps =====（维护者 M5 前置小项；M5 车道段另设锚点，不在本段）
    // 2b（D116）：整页经 gt-app:// 加载（不再是 file://）——协议断言 + file:// 图片
    // 被 CSP 拒的回归锚（file 页面下 'self' 曾覆盖本地 file:// 资源，D116 后 origin
    // 是 gt-app，file:// 不再同源）。探针图是程序生成的 1x1 PNG（非真实论文产物）。
    const proto = await evalJs<string>('location.protocol')
    const protoOk = proto === 'gt-app:'
    record('gt-app协议加载', protoOk, protoOk ? `location.protocol=${proto}` : `页面不是 gt-app://（实际 ${proto}）`)
    ok = ok && protoOk

    writeFileSync(
      join(state.dataDir, 'csp-file-probe.png'),
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    )
    const fileImgLoaded = await evalJs<boolean>(`new Promise((res) => {
      const i = new Image()
      i.onload = () => res(i.naturalWidth > 0)
      i.onerror = () => res(false)
      i.src = ${JSON.stringify(encodeURI(`file://${join(state.dataDir, 'csp-file-probe.png')}`))}
    })`)
    record(
      'file图片被CSP拒',
      fileImgLoaded === false,
      fileImgLoaded === false ? 'file:// 图片 naturalWidth=0（不再被 CSP self 覆盖）' : 'file:// 图片加载成功——D115 残留回归'
    )
    ok = ok && fileImgLoaded === false

    // 2a：detail_regen 进行中——Beta 有缓存详情 + process succeeded，直写一条 running
    // 的 detail_regen（先暂停 LLM 队列防 2s drain 干扰，finally 恢复并清理任务）。
    // 详情页顶栏应出现「重新生成中…」转圈，正文仍是缓存详情（不切 03h 三步骤视图）。
    setLlmQueuePaused(state.db, '冒烟：detail_regen 生成中指示器断言')
    let regenIndJob = 0
    try {
      regenIndJob = Number(
        state.db
          .prepare(
            "INSERT INTO jobs (kind, paper_id, status, current_step, payload, created_at, updated_at) VALUES ('detail_regen', ?, 'running', 'detail', '{}', ?, ?)"
          )
          .run(betaRow.id, new Date().toISOString(), new Date().toISOString()).lastInsertRowid
      )
      if (!(await clickNode('Beta'))) {
        record('重新生成中指示器', false, '点击 Beta 节点未进详情页')
        return finish(false)
      }
      const regenIndOk = await waitFor(
        `(() => {
          const page = document.querySelector('[data-testid="paper-detail-page"]')
          if (!page) return false
          const t = page.innerText
          return !!page.querySelector('[data-testid="regen-indicator"]') &&
            t.includes('重新生成中') && t.includes('冒烟缓存详情正文') && !t.includes('正在生成详情')
        })()`
      )
      record('重新生成中指示器', regenIndOk, regenIndOk ? '顶栏「重新生成中…」转圈 + 缓存详情仍在（未切 03h）' : '指示器未出现或视图被切走')
      ok = ok && regenIndOk
    } finally {
      setLlmQueuePaused(state.db, null)
      if (regenIndJob > 0) {
        state.db.prepare('DELETE FROM job_steps WHERE job_id = ?').run(regenIndJob)
        state.db.prepare('DELETE FROM jobs WHERE id = ?').run(regenIndJob)
      }
    }
    if (!(await backToGraph())) {
      record('重新生成中指示器', false, '返回图谱失败')
      return finish(false)
    }
    // ===== M5 prereq steps end =====

    // ===== M5 lane/agent steps =====（lane/agent 只在本段内追加步骤）
    {
      // 主进程断言：会话/trace/用量/候选链路（纯 DB 层，不经 LLM，不调任何外部 API）
      try {
        const agentMod = await import('./agent/sessionStore')
        const candMod = await import('./agent/candidates')
        const usageMod = await import('./llm/usage')
        const sid = agentMod.createSession(state.db, { graphId: 1, entryType: 'graph', entryId: null }).id
        agentMod.appendMessage(state.db, sid, 'user', [{ type: 'text', text: '冒烟问题' }])
        agentMod.addTrace(state.db, sid, { toolName: 'getPapers', summary: '冒烟读取' })
        usageMod.recordUsage(state.db, { category: 'chat', model: 'smoke', sessionId: sid, usage: { inputTokens: 10, cacheHitTokens: 0, outputTokens: 5 } })
        const cand = await candMod.proposeCandidate(state.db, {
          graphId: 1,
          sessionId: sid,
          title: '冒烟候选',
          authors: ['A'],
          doi: null,
          arxivId: null,
          reason: '冒烟理由'
        })
        // M6 lane/fetch 批 1（D124）：库外确认已改为真入库。为不动图谱 1 的节点数
        // （后续 chat 段按 5 节点断言），入库验证放到一次性图谱 99，候选故意不带
        // DOI/arXiv：后续 candidate_pdf 查找全来源 not_found、零网络请求
        const g99 = state.db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('冒烟导入验证', new Date().toISOString(), new Date().toISOString()).lastInsertRowid
        const cand99 = await candMod.proposeCandidate(state.db, { graphId: Number(g99), sessionId: sid, title: '冒烟入库候选', authors: ['A'], doi: null, arxivId: null, reason: '入库验证' })
        const confirmed = candMod.confirmCandidate(state.db, cand99.id)
        const imported = state.db.prepare("SELECT id, source FROM papers WHERE id = ? AND deleted_at IS NULL").get(confirmed.addedPaperId) as { id: number; source: string } | undefined
        const memberUp = state.db.prepare('SELECT 1 FROM graph_members WHERE graph_id = ? AND paper_id = ?').get(Number(g99), confirmed.addedPaperId) != null
        const jobUp = state.db.prepare("SELECT 1 FROM jobs WHERE kind = 'candidate_pdf' AND paper_id = ?").get(confirmed.addedPaperId) != null
        const importOk = confirmed.candidate.status === 'confirmed' && imported?.source === 'agent' && memberUp && jobUp && cand.status === 'pending'
        const sidRow = state.db.prepare("SELECT id FROM sessions WHERE graph_id = 1 AND name LIKE '图谱对话%' ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined
        const traceN = sidRow ? (state.db.prepare('SELECT COUNT(*) AS n FROM session_traces WHERE session_id = ?').get(sidRow.id) as { n: number }).n : 0
        const usageN = sidRow ? (state.db.prepare("SELECT COUNT(*) AS n FROM usage_records WHERE session_id = ? AND category = 'chat'").get(sidRow.id) as { n: number }).n : 0
        const candN = (state.db.prepare('SELECT COUNT(*) AS n FROM graph_candidates WHERE graph_id = 1').get() as { n: number }).n
        record('M5 agent 主进程断言', importOk && traceN === 1 && usageN === 1 && candN === 1, `入库=${importOk} trace=${traceN} usage=${usageN} candidates=${candN}`)
      } catch (e) {
        record('M5 agent 主进程断言', false, e instanceof Error ? e.message : String(e))
      }
    }
    // ===== M5 lane/agent steps end =====

    // ===== M5 lane/chat steps =====（lane/chat 只在本段内追加步骤）
    // 批 1：抽屉骨架 + 画布入口 + 流式显示。渲染层冒烟开关（?smoke=1）用内存 mock 接管
    // AgentApi（components/chat/smokeAgentMock.ts）：假流式 text 增量 → data-trace 行 →
    // 续写 → turn-end（带费用）；停止保留已生成内容。主进程 agent IPC 骨架（「未实现」）
    // 与本段无关，冻结文件零改动。

    // 02 入口：顶栏「对话」按钮开抽屉（入口对象行 = 当前图谱名）
    await evalJs<void>(`document.querySelector('[data-testid="chat-toggle"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const drawerUp = await waitFor(`(() => {
      const d = document.querySelector('[data-testid="chat-drawer"]')
      return !!d && !!d.querySelector('[data-testid="chat-entry"]') && (d.textContent ?? '').includes('冒烟图谱')
    })()`)
    record('对话抽屉打开', drawerUp, drawerUp ? '顶栏「对话」→ 抽屉出现，入口对象行 = 冒烟图谱' : '抽屉未出现或入口对象行缺失')
    ok = ok && drawerUp
    if (!drawerUp) return finish(false)

    // 新建会话：mock 内存态（真实实现由 lane/agent 落库），新建后自动选中
    await evalJs<void>(`document.querySelector('[data-testid="chat-new-session"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const sessOk = await waitFor(`(document.querySelector('[data-testid="session-picker"]')?.textContent ?? '').includes('新会话') && !!document.querySelector('[data-testid="chat-input"]:not([disabled])')`)
    record('对话抽屉新建会话', sessOk, sessOk ? '新会话选中、输入框可用' : '新建会话后未选中')
    ok = ok && sessOk
    if (!sessOk) return finish(false)
    const smokeGraphSessionId = await evalJs<number | null>(`(async () => {
      const a = __gt.smokeAgent()
      if (!a) return null
      const ss = await a.listSessions(${graphId}, 'graph', null)
      return ss.length ? Math.max(...ss.map((s) => s.id)) : null
    })()`)

    // 发消息：流式回答 + data-trace 灰色读取记录行（mock 脚本：增量 → trace → 续写 → 定稿）
    await evalJs<boolean>(`__gt.setInput('[data-testid="chat-input"]', '这张图谱有几篇论文？')`)
    await evalJs<void>(`document.querySelector('[data-testid="chat-send"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const streamOk = await waitFor(`(() => {
      const msgs = document.querySelector('[data-testid="chat-messages"]')
      if (!msgs) return false
      const t = msgs.textContent ?? ''
      return msgs.querySelectorAll('[data-testid="chat-msg-user"]').length === 1 &&
        msgs.querySelectorAll('[data-testid="chat-msg-ai"]').length === 1 &&
        !!msgs.querySelector('[data-testid="part-trace"]') && t.includes('5 篇论文')
    })()`, 15000)
    record('对话流式回答与读取记录', streamOk, streamOk ? '用户消息 + 流式助手回答 + data-trace 灰色行' : '流式回答或 trace 行未出现')
    ok = ok && streamOk

    // trace 行点击展开原文（D8 可展开 excerpt）
    await evalJs<void>(`document.querySelector('[data-testid="part-trace"] .gt-trace-head')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const traceOpen = await waitFor(`!!document.querySelector('[data-testid="part-trace"] .gt-trace-excerpt')`)
    record('读取记录展开原文', traceOpen, traceOpen ? 'trace 行点击展开 excerpt' : 'excerpt 未展开')
    ok = ok && traceOpen

    // D178：对话区只保留模型名、不显示金额；费用数据仍由同一 smoke AgentApi 提供。
    const costOk = await waitFor(`(async () => {
      const drawer = document.querySelector('[data-testid="chat-drawer"]')
      const a = __gt.smokeAgent()
      if (!drawer || !a || ${smokeGraphSessionId} == null) return false
      const [total, split] = await Promise.all([a.sessionCost(${smokeGraphSessionId}), a.sessionCostBreakdown(${smokeGraphSessionId})])
      return !(drawer.textContent ?? '').includes('¥') &&
        (document.querySelector('[data-testid="chat-cost"]')?.textContent ?? '').includes('deepseek-flash') &&
        Math.abs(total - 0.06) < 1e-9 && Math.abs(split.total - 0.06) < 1e-9 &&
        Math.abs(split.chat - 0.06) < 1e-9 && split.background === 0
    })()`)
    record('会话费用行', costOk, costOk ? '对话 DOM 无金额、保留模型名；smoke sessionCost/Breakdown 仍为 0.06' : '对话金额隐藏或 smoke 费用 API 原值不对')
    ok = ok && costOk

    // 停止：保留已生成内容（D53），回合标记 stopped 非错误，回到发送态
    await evalJs<boolean>(`__gt.setInput('[data-testid="chat-input"]', '再介绍一下')`)
    await evalJs<void>(`document.querySelector('[data-testid="chat-send"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    await sleep(260) // 等前几个 text 增量到达（mock 首个增量在 ~180ms）再停止
    await evalJs<void>(`document.querySelector('[data-testid="chat-stop"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const stopOk = await waitFor(`(() => {
      if (document.querySelector('[data-testid="chat-stop"]')) return false
      const ai = [...document.querySelectorAll('[data-testid="chat-msg-ai"]')]
      if (ai.length !== 2) return false
      const t = ai[1].textContent ?? ''
      return t.trim().length > 0 && !t.includes('已生成详情')
    })()`, 15000)
    record('对话停止保留内容', stopOk, stopOk ? '停止后保留部分回答、无错误、回到发送态' : '停止后内容丢失或仍运行中')
    ok = ok && stopOk

    // 累计仍在 API 数据面：完整回合 0.06 + 停止回合 0.01；DOM 始终无金额。
    const costSumOk = await waitFor(`(async () => {
      const drawer = document.querySelector('[data-testid="chat-drawer"]')
      const a = __gt.smokeAgent()
      if (!drawer || !a || ${smokeGraphSessionId} == null) return false
      const [total, split] = await Promise.all([a.sessionCost(${smokeGraphSessionId}), a.sessionCostBreakdown(${smokeGraphSessionId})])
      return !(drawer.textContent ?? '').includes('¥') &&
        Math.abs(total - 0.07) < 1e-9 && Math.abs(split.total - 0.07) < 1e-9 &&
        Math.abs(split.chat - 0.07) < 1e-9 && split.background === 0
    })()`)
    record('会话费用累计', costSumOk, costSumOk ? '对话 DOM 无金额；smoke 两回合累计与分项仍为 0.07' : '金额隐藏或 smoke 累计费用 API 原值不对')
    ok = ok && costSumOk

    // 收起按钮
    await evalJs<void>(`document.querySelector('[data-testid="chat-collapse"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const collapsed = await waitFor(`!document.querySelector('[data-testid="chat-drawer"]')`)
    record('对话抽屉收起', collapsed, collapsed ? '收起按钮 → 抽屉关闭' : '抽屉未收起')
    ok = ok && collapsed

    // ── 批 2：四入口 + quote chip + 03f 出错重试 + 切图谱不残留（渲染层 mock 同批 1）──

    // 03 入口（D112 解禁）：详情页顶栏「对话」→ paper 入口抽屉（入口对象行 = 论文标题）
    if (!(await clickNode('Beta'))) {
      record('详情页对话入口', false, '点击 Beta 节点未进详情页')
      return finish(false)
    }
    await evalJs<void>(`document.querySelector('[data-testid="pd-chat"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    if (!(await waitFor(`(() => {
      const d = document.querySelector('[data-testid="chat-drawer"]')
      return !!d && (d.textContent ?? '').includes('Smoke Paper Beta')
    })()`))) {
      record('详情页对话入口', false, 'paper 入口抽屉未出现或入口行不是论文标题')
      return finish(false)
    }
    // paper 入口首次无会话：新建后会话自动选中、输入框可用
    await evalJs<void>(`document.querySelector('[data-testid="chat-new-session"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const pdChatOk = await waitFor(`(document.querySelector('[data-testid="session-picker"]').textContent ?? '').includes('新会话') && !!document.querySelector('[data-testid="chat-input"]:not([disabled])')`)
    record('详情页对话入口', pdChatOk, pdChatOk ? 'D112 解禁：paper 入口抽屉 + 论文标题入口行' : '详情页对话入口未开抽屉')
    ok = ok && pdChatOk
    if (!pdChatOk) return finish(false)

    // 07 入口（D105-① 解禁）：阅读器选区「发给 agent」→ 抽屉（阅读器 modal 之上）+ quote chip
    if (!(await backToGraph())) {
      record('阅读器quote上下文', false, '返回图谱失败')
      return finish(false)
    }
    if (!(await clickNode('Delta'))) {
      record('阅读器quote上下文', false, '点击 Delta 节点未进详情页')
      return finish(false)
    }
    await evalJs<boolean>(`__gt.clickText('button', '打开 PDF')`)
    if (!(await waitFor(`!!document.querySelector('[data-testid="pdf-reader"]')`, 15000))) {
      record('阅读器quote上下文', false, '阅读器未打开')
      return finish(false)
    }
    const quoteSpan = await stableSpanRect('Smoke Reader Fixture Line One')
    if (!quoteSpan) {
      record('阅读器quote上下文', false, '第 1 页文本不可见或一直在动')
      return finish(false)
    }
    const quoteSy = quoteSpan.top + quoteSpan.height / 2
    await drag({ x: quoteSpan.left + 2, y: quoteSy }, { x: quoteSpan.left + quoteSpan.width - 2, y: quoteSy })
    const agentBtnEnabled = await waitFor(`(() => {
      const b = document.querySelector('[data-testid="sel-agent"]')
      return !!b && !b.disabled
    })()`)
    if (!agentBtnEnabled) {
      const diag = await evalJs<string>(`(() => {
        const pop = document.querySelector('[data-testid="selpop"]')
        const b = document.querySelector('[data-testid="sel-agent"]')
        return JSON.stringify({ pop: !!pop, btn: !!b, disabled: b ? b.disabled : null, title: b ? b.getAttribute('title') : null, reader: !!document.querySelector('[data-testid="pdf-reader"]') })
      })()`)
      record('阅读器发给agent解禁', false, `发给 agent 未启用：${diag}`)
      return finish(false)
    }
    record('阅读器发给agent解禁', true, 'D105-①：选区「发给 agent」按钮启用')
    ok = ok && true
    await evalJs<void>(`document.querySelector('[data-testid="sel-agent"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const quoteOk = await waitFor(`(() => {
      const d = document.querySelector('[data-testid="chat-drawer"]')
      if (!d || !(d.textContent ?? '').includes('Smoke Paper Delta')) return false
      const chips = d.querySelector('[data-testid="chat-chips"]')
      return !!chips && (chips.textContent ?? '').includes('Smoke Reader Fixture')
    })()`, 15000)
    record('阅读器quote上下文', quoteOk, quoteOk ? '发给 agent → paper 入口抽屉（阅读器之上）+ quote chip' : 'quote chip 未出现')
    ok = ok && quoteOk
    if (!quoteOk) return finish(false)

    // quote chip 随 send 的 contextRefs 发出（mock 回显「收到 N 个上下文标签」）；
    // 该 paper 入口同样先新建会话（首次无会话，输入框禁用）
    await evalJs<void>(`document.querySelector('[data-testid="chat-new-session"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    if (!(await waitFor(`!!document.querySelector('[data-testid="chat-input"]:not([disabled])')`, 4000))) {
      // 换了 paper 入口（Gamma）——该入口下可能还没有会话：⌘N 新建（与 M6 prereq 段同法）
      await evalJs<void>(`document.querySelector('[data-testid="chat-new-session"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    }
    if (!(await waitFor(`!!document.querySelector('[data-testid="chat-input"]:not([disabled])')`))) {
      record('quote上下文随消息发出', false, '新建会话后输入框仍不可用')
      return finish(false)
    }
    await evalJs<boolean>(`__gt.setInput('[data-testid="chat-input"]', '这段引用讲了什么？')`)
    await evalJs<void>(`document.querySelector('[data-testid="chat-send"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const quoteSendOk = await waitFor(`(document.querySelector('[data-testid="chat-messages"]')?.textContent ?? '').includes('收到 1 个上下文标签')`, 15000)
    record('quote上下文随消息发出', quoteSendOk, quoteSendOk ? '回答回显「收到 1 个上下文标签」（contextRefs 已到 mock）' : 'contextRefs 未随消息发出')
    ok = ok && quoteSendOk

    // 03f：回合中途失败（mock「冒烟失败」触发）→ 保留已生成内容 + 错误行 + 重试按钮。
    // 先等上一回合完全收尾（回显断言在流式中即可满足，此时还是「停止」按钮，chat-send 未渲染）
    if (!(await waitFor(`!!document.querySelector('[data-testid="chat-send"]')`, 15000))) {
      record('对话出错保留内容', false, '上一回合未收尾，发送按钮不可用')
      return finish(false)
    }
    await evalJs<boolean>(`__gt.setInput('[data-testid="chat-input"]', '冒烟失败')`)
    await evalJs<void>(`document.querySelector('[data-testid="chat-send"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const errOk = await waitFor(`(() => {
      const msgs = document.querySelector('[data-testid="chat-messages"]')
      if (!msgs) return false
      const err = msgs.querySelector('[data-testid="chat-msg-error"]')
      return !!err && (err.textContent ?? '').includes('冒烟构造的回合失败') &&
        !!msgs.querySelector('[data-testid="chat-retry"]') &&
        (msgs.textContent ?? '').includes('失败前已生成的部分回答')
    })()`, 15000)
    record('对话出错保留内容', errOk, errOk ? '03f：错误行 + 重试按钮 + 已生成内容保留' : '错误态不完整')
    ok = ok && errOk

    // 03f 重试：retryMessage 接线 → mock 清错并给新回答
    await evalJs<void>(`document.querySelector('[data-testid="chat-retry"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const retryOk = await waitFor(`(() => {
      const msgs = document.querySelector('[data-testid="chat-messages"]')
      if (!msgs) return false
      const t = msgs.textContent ?? ''
      return t.includes('重试成功') && !msgs.querySelector('[data-testid="chat-msg-error"]')
    })()`, 15000)
    record('对话出错重试', retryOk, retryOk ? '重试成功：错误清除、新回答落库回源' : '重试未生效')
    ok = ok && retryOk

    // 切页/切图谱抽屉不残留（评审必须修 #2）：关阅读器 → 回首页（抽屉隐藏）→ 新建第二张图谱（旧宿主不残留）
    await evalJs<void>(`document.querySelector('.gt-reader-toolbar button[title="关闭"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    if (!(await waitFor(`!document.querySelector('[data-testid="pdf-reader"]')`))) {
      record('抽屉首页不显示', false, '阅读器未关闭')
      return finish(false)
    }
    await evalJs<boolean>(`__gt.clickText('[data-testid="paper-detail-page"] .toolbar button', '返回')`)
    // 详情页「返回」回到图谱页；再点顶栏「我的图谱」回首页（图谱页也有「我的图谱」返回钮，
    // 必须真正到 Home——那里有「新建图谱」按钮）
    if (!(await waitFor(`!!document.querySelector('.react-flow__node')`))) {
      record('抽屉首页不显示', false, '返回后未回到图谱页')
      return finish(false)
    }
    await evalJs<boolean>(`__gt.clickText('.toolbar button', '我的图谱')`)
    const homeNoDrawer = await waitFor(`[...document.querySelectorAll('button')].some((b) => (b.textContent ?? '').includes('新建图谱')) && !document.querySelector('[data-testid="chat-drawer"]')`)
    record('抽屉首页不显示', homeNoDrawer, homeNoDrawer ? 'Home 页不显示抽屉（paper 入口不外溢到 02 以外）' : '首页仍有抽屉残留')
    ok = ok && homeNoDrawer
    await evalJs<boolean>(`__gt.clickText('button', '新建图谱')`)
    if (!(await waitFor(`!!document.querySelector('.tin')`))) {
      record('切图谱抽屉不残留', false, '新建图谱弹窗未出现')
      return finish(false)
    }
    await evalJs<boolean>(`__gt.setInput('.tin', '冒烟图谱二')`)
    await sleep(120)
    await evalJs<boolean>(`__gt.clickText('button', '创建')`)
    if (!(await waitFor(`(document.querySelector('.ttl')?.textContent ?? '').includes('冒烟图谱二')`))) {
      record('切图谱抽屉不残留', false, '第二张图谱未打开')
      return finish(false)
    }
    const noResidue = await waitFor(`!document.querySelector('[data-testid="chat-drawer"]')`)
    record('切图谱抽屉不残留', noResidue, noResidue ? '新图谱页无旧抽屉（旧宿主 graphId=1 的会话不残留）' : '旧抽屉在新图谱页残留')
    ok = ok && noResidue

    // ── 批 3：候选链路 / 定位 flash / 撤销组 / 运行中禁 ⌘Z / 隐藏回来运行态 ──

    // 回到冒烟图谱（graphId=1，有 4 节点 + 1 条关系，供候选/改图断言）
    await evalJs<boolean>(`__gt.clickText('.toolbar button', '我的图谱')`)
    if (!(await waitFor(`[...document.querySelectorAll('button')].some((b) => (b.textContent ?? '').includes('新建图谱'))`))) {
      record('候选卡片与虚线节点', false, '回首页失败')
      return finish(false)
    }
    // 精确匹配图谱名（「冒烟图谱二」也含该前缀，不能用 includes）
    await evalJs<boolean>(`[...document.querySelectorAll('.gcard')].find((g) => ((g.querySelector('.nm')?.textContent ?? '').trim() === '冒烟图谱')).dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    if (!(await waitFor(`(document.querySelector('.ttl')?.textContent ?? '').includes('冒烟图谱') && __gt.nodeCount() === 5`))) {
      const diag = await evalJs<string>(`JSON.stringify({ ttl: document.querySelector('.ttl')?.textContent ?? null, nodes: __gt.nodeCount(), cards: [...document.querySelectorAll('.gcard .nm')].map((n) => n.textContent) })`)
      record('候选卡片与虚线节点', false, `重开冒烟图谱失败：${diag}`)
      return finish(false)
    }
    await evalJs<void>(`document.querySelector('[data-testid="chat-toggle"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    await evalJs<void>(`document.querySelector('[data-testid="chat-new-session"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    if (!(await waitFor(`!!document.querySelector('[data-testid="chat-input"]:not([disabled])')`))) {
      record('候选卡片与虚线节点', false, '抽屉/会话未就绪')
      return finish(false)
    }

    // 候选：「冒烟候选」→ 两张卡片 + 两个虚线节点 + 图例项；D117 按钮口径
    await evalJs<boolean>(`__gt.setInput('[data-testid="chat-input"]', '冒烟候选')`)
    await evalJs<void>(`document.querySelector('[data-testid="chat-send"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const candOk = await waitFor(`(() => {
      const cards = [...document.querySelectorAll('[data-testid="part-paper-card"]')]
      if (cards.length !== 2) return false
      const existing = cards.find((c) => (c.textContent ?? '').includes('Smoke Candidate Existing'))
      const external = cards.find((c) => (c.textContent ?? '').includes('Smoke Candidate External'))
      if (!existing || !external) return false
      const exConfirm = existing.querySelector('[data-testid="card-confirm"]')
      const outConfirm = external.querySelector('[data-testid="card-confirm"]')
      const legend = document.querySelector('.legend')
      return document.querySelectorAll('[data-testid="cand-node"]').length === 2 &&
        !!legend && (legend.textContent ?? '').includes('候选') &&
        exConfirm && !exConfirm.disabled &&
        // lane/ui M6 批 1：库外确认实装（D124），由禁用占位变可用（本行属 M5 lane/chat 段，维护者请复核）
        outConfirm && !outConfirm.disabled && (outConfirm.getAttribute('title') ?? '').includes('入库')
    })()`, 15000)
    if (!candOk) {
      const diag = await evalJs<string>(`JSON.stringify({
        cards: document.querySelectorAll('[data-testid="part-paper-card"]').length,
        candNodes: document.querySelectorAll('[data-testid="cand-node"]').length,
        legend: (document.querySelector('.legend')?.textContent ?? '').slice(0, 40),
        msgs: (document.querySelector('[data-testid="chat-messages"]')?.textContent ?? '').slice(0, 120)
      })`)
      record('候选卡片与虚线节点', false, `候选链路不完整：${diag}`)
    } else {
      record('候选卡片与虚线节点', true, '2 卡片 + 2 虚线节点 + 图例；库外「确认入库」可用（D124）、库内「加入图谱」可用')
    }
    ok = ok && candOk
    if (!candOk) return finish(false)

    // 两处一致①：卡片「加入图谱」→ 画布虚线节点同步消失、卡片按 D199 显示「已在本图谱中」顶部药丸
    await evalJs<void>(`[...document.querySelectorAll('[data-testid="part-paper-card"]')].find((c) => (c.textContent ?? '').includes('Smoke Candidate Existing')).querySelector('[data-testid="card-confirm"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const confirmOk = await waitFor(`(() => {
      const cards = [...document.querySelectorAll('[data-testid="part-paper-card"]')]
      const existing = cards.find((c) => (c.textContent ?? '').includes('Smoke Candidate Existing'))
      const nodes = [...document.querySelectorAll('[data-testid="cand-node"]')]
      return !!existing && (existing.textContent ?? '').includes('已在本图谱中') &&
        nodes.length === 1 && (nodes[0].textContent ?? '').includes('Smoke Candidate External')
    })()`, 15000)
    if (!confirmOk) {
      const diag = await evalJs<string>(`JSON.stringify({
        cards: [...document.querySelectorAll('[data-testid="part-paper-card"]')].map((c) => (c.textContent ?? '').slice(0, 120)),
        badges: [...document.querySelectorAll('[data-testid="part-paper-card"] .gt-card-intag')].map((b) => b.textContent),
        lives: [...document.querySelectorAll('[data-testid="part-paper-card"]')].map((c) => c.getAttribute('data-live')),
        nodes: document.querySelectorAll('[data-testid="cand-node"]').length
      })`).catch((e: unknown) => `诊断eval失败:${e instanceof Error ? e.message : String(e)}`)
      record('候选确认两处一致', false, `卡片与画布状态不一致：${diag}`)
    } else {
      record('候选确认两处一致', true, '卡片加入图谱 → 画布虚线节点同步移除')
    }
    ok = ok && confirmOk

    // 两处一致②：画布节点「忽略」→ 卡片同步变「已忽略」、节点消失
    await evalJs<void>(`document.querySelector('[data-testid="cand-node"] [data-testid="cand-ignore"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const ignoreOk = await waitFor(`(() => {
      const cards = [...document.querySelectorAll('[data-testid="part-paper-card"]')]
      const external = cards.find((c) => (c.textContent ?? '').includes('Smoke Candidate External'))
      return !!external && (external.textContent ?? '').includes('已忽略') &&
        document.querySelectorAll('[data-testid="cand-node"]').length === 0
    })()`, 15000)
    record('候选忽略两处一致', ignoreOk, ignoreOk ? '画布忽略 → 卡片同步已忽略、虚线节点移除' : '画布与卡片状态不一致')
    ok = ok && ignoreOk

    // 改图小结：「冒烟改图」→ data-graph-change 行（定位 + 撤销本轮改动）
    if (!(await waitFor(`!!document.querySelector('[data-testid="chat-send"]')`, 15000))) {
      record('改图小结定位flash', false, '上一回合未收尾')
      return finish(false)
    }
    await evalJs<boolean>(`__gt.setInput('[data-testid="chat-input"]', '冒烟改图')`)
    await evalJs<void>(`document.querySelector('[data-testid="chat-send"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const gcOk = await waitFor(`(() => {
      const gc = document.querySelector('[data-testid="part-graph-change"]')
      return !!gc && (gc.textContent ?? '').includes('新增 1 条关系') &&
        !!gc.querySelector('[data-testid="gchange-locate"]') && !!gc.querySelector('[data-testid="gchange-undo"]')
    })()`, 15000)
    record('改图小结行', gcOk, gcOk ? 'data-graph-change 小结行 + 定位/撤销按钮' : '小结行缺失')
    ok = ok && gcOk

    // 定位 → 画布 flash 高亮（关系边 gt-flash 类）
    await evalJs<void>(`document.querySelector('[data-testid="gchange-locate"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const flashOk = await waitFor(`!!document.querySelector('.react-flow__edge.gt-flash')`, 15000)
    record('改图小结定位flash', flashOk, flashOk ? '「定位」→ 画布关系边 flash 高亮' : 'flash 高亮未出现')
    ok = ok && flashOk

    // ⌘Z 撤销组：点「撤销本轮改动」。mock 推的 relationIds:[1] 是本回合前就存在的边
    // （D104 守卫，必须修 1）→ 正确行为是**不删**并诚实提示需改动前快照；新建边的删除路径由
    // 单测覆盖（graphChangeUndo D104 守卫用例）。
    await evalJs<void>(`document.querySelector('[data-testid="gchange-undo"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const undoOk = await waitFor(`document.querySelectorAll('.react-flow__edge').length === 1 && (document.querySelector('.toasts')?.textContent ?? '').includes('本回合前已存在')`, 15000)
    record('改图撤销组', undoOk, undoOk ? 'D104 守卫生效：既有边不被误删、如实提示；新建边删除路径见单测' : '组撤销行为不对（应守卫拒删而非误删）')
    ok = ok && undoOk

    // 必须修 1（批 3）：回合在跑 → 切页（抽屉隐藏）→ 回来 running 仍真、停止按钮在、流式继续
    if (!(await waitFor(`!!document.querySelector('[data-testid="chat-send"]')`, 15000))) {
      record('隐藏回来运行态', false, '上一回合未收尾')
      return finish(false)
    }
    await evalJs<boolean>(`__gt.setInput('[data-testid="chat-input"]', '跑一个长回合')`)
    await evalJs<void>(`document.querySelector('[data-testid="chat-send"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    if (!(await waitFor(`!!document.querySelector('[data-testid="chat-stop"]')`, 15000))) {
      record('隐藏回来运行态', false, '回合未进入运行态')
      return finish(false)
    }
    if (!(await clickNode('Alpha'))) {
      record('隐藏回来运行态', false, '切到详情页失败')
      return finish(false)
    }
    if (!(await backToGraph())) {
      record('隐藏回来运行态', false, '返回图谱失败')
      return finish(false)
    }
    const stillRunning = await waitFor(`(() => {
      const d = document.querySelector('[data-testid="chat-drawer"]')
      return !!d && !!d.querySelector('[data-testid="chat-stop"]')
    })()`, 15000)
    record('隐藏回来运行态', stillRunning, stillRunning ? '切页隐藏抽屉后回来：running 仍真、停止按钮在（App 级常驻数据面）' : '回来 running 丢失')
    ok = ok && stillRunning
    if (!(await waitFor(`!!document.querySelector('[data-testid="chat-send"]')`, 15000))) {
      record('运行中禁撤销快捷键', false, '回合未收尾')
      return finish(false)
    }

    // D77/D88：Agent 运行中 ⌘Z 禁用（画布页键盘入口）
    await evalJs<boolean>(`__gt.setInput('[data-testid="chat-input"]', '再跑一轮')`)
    await evalJs<void>(`document.querySelector('[data-testid="chat-send"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    if (!(await waitFor(`!!document.querySelector('[data-testid="chat-stop"]')`, 15000))) {
      record('运行中禁撤销快捷键', false, '回合未进入运行态')
      return finish(false)
    }
    await evalJs<void>(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }))`)
    const zBlocked = await waitFor(`(document.querySelector('.toasts')?.textContent ?? '').includes('Agent 运行中')`, 15000)
    record('运行中禁撤销快捷键', zBlocked, zBlocked ? '运行中 ⌘Z → 提示「Agent 运行中，暂不能撤销」' : '运行中 ⌘Z 未被拦截')
    ok = ok && zBlocked
    if (!(await waitFor(`!!document.querySelector('[data-testid="chat-send"]')`, 15000))) {
      record('运行中禁撤销快捷键', false, '回合未收尾')
      return finish(false)
    }

    // 建议修 5（原型 07）：阅读器工具栏「对话」→ paper 入口抽屉（入口行带「论文 · 」前缀）
    if (!(await clickNode('Delta'))) {
      record('阅读器对话入口', false, '点击 Delta 未进详情页')
      return finish(false)
    }
    await evalJs<boolean>(`__gt.clickText('button', '打开 PDF')`)
    // 等引擎与文档就绪（reader-chat 按钮随正文渲染，pdf-reader mask 会先出现）
    if (!(await waitFor(`!!document.querySelector('[data-testid="reader-chat"]')`, 20000))) {
      record('阅读器对话入口', false, '阅读器未就绪（reader-chat 未渲染）')
      return finish(false)
    }
    await evalJs<void>(`document.querySelector('[data-testid="reader-chat"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const readerChatOk = await waitFor(`(() => {
      const d = document.querySelector('[data-testid="chat-drawer"]')
      return !!d && (d.textContent ?? '').includes('论文 · Smoke Paper Delta')
    })()`, 15000)
    record('阅读器对话入口', readerChatOk, readerChatOk ? '阅读器「对话」→ paper 入口抽屉（论文 · 前缀）' : '阅读器对话入口未开抽屉')
    ok = ok && readerChatOk
    await evalJs<void>(`document.querySelector('.gt-reader-toolbar button[title="关闭"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    await waitFor(`!document.querySelector('[data-testid="pdf-reader"]')`)
    // ===== M5 lane/chat steps end =====

    // ===== M6 prereq steps =====（维护者第 0 批：2a 快照撤销 + B2 修改小结 + B6 每回合 ¥；只在本段内追加）
    // 数据预置（主进程，临时库）：图 1 上一条真实关系（当前已是「修改后」状态）+
    // 一条 update 快照（临时库 relation_snapshots 为空 → id=1，mock part 引用它）。
    // 撤销走真实 rel:restoreSnapshot IPC（smoke 只 mock 会话 API，rel:* 是真桥）。
    let smokeSnapId = 0
    let smokeRelId = 0
    try {
      const members = state.db.prepare('SELECT paper_id FROM graph_members WHERE graph_id = 1 ORDER BY paper_id').all() as Array<{ paper_id: number }>
      // 找一对还没有关系的成员（冒烟前面步骤已连过边，不能假设任意两两无边）
      let pair: [number, number] | null = null
      for (let i = 0; i < members.length && !pair; i++) {
        for (let j = i + 1; j < members.length && !pair; j++) {
          const low = Math.min(members[i].paper_id, members[j].paper_id)
          const high = Math.max(members[i].paper_id, members[j].paper_id)
          const exists = state.db
            .prepare('SELECT 1 FROM relations WHERE graph_id = 1 AND paper_low = ? AND paper_high = ? AND deleted_at IS NULL')
            .get(low, high)
          if (!exists) pair = [members[i].paper_id, members[j].paper_id]
        }
      }
      if (pair) {
        const [a, b] = pair
        const t = new Date().toISOString()
        smokeRelId = Number(
          state.db
            .prepare(
              `INSERT INTO relations (graph_id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types,
                 source_type, model, prompt_version, created_at, updated_at)
               VALUES (1, ?, ?, ?, '冒烟修改后的陈述', '["compares"]', '[]', 'session', 'deepseek-flash', 'agent-v7', ?, ?)`
            )
            .run(Math.min(a, b), Math.max(a, b), a, t, t).lastInsertRowid
        )
        const sessId = Number(
          state.db.prepare("INSERT INTO sessions (graph_id, entry_type, entry_id, name, created_at, updated_at) VALUES (1, 'graph', NULL, '冒烟快照会话', ?, ?)").run(t, t).lastInsertRowid
        )
        smokeSnapId = Number(
          state.db
            .prepare(
              `INSERT INTO relation_snapshots (session_id, turn_id, relation_id, op, before_json, created_at)
               VALUES (?, 'smoke-ow-turn', ?, 'update', ?, ?)`
            )
            .run(
              sessId,
              smokeRelId,
              JSON.stringify({
                graphId: 1,
                srcPaperId: a,
                dstPaperId: b,
                statement: '冒烟原关系',
                llmTypes: ['compares'],
                autoTypes: [],
                sourceType: 'session',
                sourceJobId: null,
                model: 'deepseek-flash',
                promptVersion: 'rel-v1'
              }),
              t
            ).lastInsertRowid
        )
      }
      record('M6 快照数据预置', smokeSnapId === 1 && smokeRelId > 0, `关系 #${smokeRelId} + 快照 #${smokeSnapId}（update）`)
    } catch (e) {
      record('M6 快照数据预置', false, e instanceof Error ? e.message : String(e))
      return finish(false)
    }
    ok = ok && smokeSnapId === 1

    // 抽屉已在（阅读器入口会话）；新建会话隔离后发「冒烟修改」（D143 起触发词改）
    await evalJs<void>(`document.querySelector('[data-testid="chat-new-session"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    if (!(await waitFor(`!!document.querySelector('[data-testid="chat-input"]:not([disabled])')`))) {
      record('修改小结显示「修改」', false, '新建会话后输入框不可用')
      return finish(false)
    }
    await evalJs<boolean>(`__gt.setInput('[data-testid="chat-input"]', '冒烟修改')`)
    await evalJs<void>(`document.querySelector('[data-testid="chat-send"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    // B2（D143 口径）：updateRelation 小结 + 「修改关系 #N（原：…）」+ 标签「修改关系」
    const owOk = await waitFor(`(() => {
      const gc = document.querySelector('[data-testid="part-graph-change"][data-change="updateRelation"]')
      return !!gc && (gc.textContent ?? '').includes('修改关系') && (gc.textContent ?? '').includes('冒烟原关系') &&
        !!gc.querySelector('.gt-gchange-tag') && (gc.querySelector('.gt-gchange-tag')?.textContent ?? '') === '修改关系'
    })()`, 15000)
    record('修改小结显示「修改」', owOk, owOk ? 'data-change=updateRelation 小结写「修改关系 #N（原：…）」+ 标签「修改关系」（B2/D143）' : '修改小结未出现')
    ok = ok && owOk
    if (!owOk) return finish(false)

    // 2a：点「撤销本轮改动」→ 真实 rel:restoreSnapshot → 原陈述还原
    await evalJs<void>(`document.querySelector('[data-testid="part-graph-change"][data-change="updateRelation"] [data-testid="gchange-undo"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    let restored = false
    for (let i = 0; i < 50 && !restored; i++) {
      await sleep(120)
      const row = state.db.prepare('SELECT statement_text AS s FROM relations WHERE id = ?').get(smokeRelId) as { s: string } | undefined
      restored = row?.s === '冒烟原关系'
    }
    const undoToast = await waitFor(`(document.querySelector('.toasts')?.textContent ?? '').includes('已撤销本轮全部 1 条改动')`)
    record('修改后撤销还原', restored && undoToast, restored && undoToast ? '快照撤销：陈述还原为「冒烟原关系」（D129）+ toast 确认' : `DB 还原=${restored} toast=${undoToast}`)
    ok = ok && restored && undoToast

    // D178：助手消息不渲染每回合金额；mock 消息费用仍经 API 对账（当前 Delta paper 会话 0.06）。
    const costTailOk = await waitFor(`(async () => {
      const drawer = document.querySelector('[data-testid="chat-drawer"]')
      const a = __gt.smokeAgent()
      if (!drawer || !a || document.querySelector('[data-testid="msg-cost"]')) return false
      const ss = await a.listSessions(${graphId}, 'paper', ${detailDeltaRow.id})
      if (!ss.length) return false
      const sid = Math.max(...ss.map((s) => s.id))
      const [total, split] = await Promise.all([a.sessionCost(sid), a.sessionCostBreakdown(sid)])
      return !(drawer.textContent ?? '').includes('¥') && Math.abs(total - 0.06) < 1e-9 &&
        Math.abs(split.total - 0.06) < 1e-9 && Math.abs(split.chat - 0.06) < 1e-9 && split.background === 0
    })()`, 15000)
    record('助手消息每回合费用', costTailOk, costTailOk ? '助手消息无金额/无 msg-cost；smoke 当前回合费用 API 仍为 0.06' : '消息金额未隐藏或 smoke 回合费用 API 原值不对')
    ok = ok && costTailOk
    // ===== M6 prereq steps end =====

    // ===== M6 lane/fetch steps =====（lane/fetch 只在本段内追加步骤）
    // 本段步骤的联网全部指向 fixtureHttp：GRAPHICTERO_OPENALEX_BASE_URL /
    // GRAPHICTERO_WEB_BASE_URL / GRAPHICTERO_PDFSRC_BASE_URL（m6_plan §3.4，与
    // GRAPHICTERO_LLM_BASE_URL 同样只在测试/冒烟进程设置，默认官方地址）。
    {
      // fixture 假服务器（OpenAlex/Unpaywall/PDF/网页工具）+ 候选入库全链路
      // （importConfirm → candidate_pdf）+ 03e 拖入 + web 记账 + Markdown 预览。
      // 入库用本段新建的图谱，不写图谱 1。出网以 installFetchGuard 记录为准。
      const fx = await import('./testing/fixtureHttp')
      const fixture = await fx.startFixtureHttp({
        works: [
          { wid: 'WS1', doi: '10.8/smokeoa', title: 'Smoke OA Paper', year: 2026, authors: ['Smoke A'], oaUrl: '{{BASE}}/pdf/smokehtml' },
          { wid: 'WS2', doi: '10.8/smokenone', title: 'Smoke No OA', year: 2026 }
        ],
        unpaywall: { '10.8/smokeoa': { pdfUrl: '{{BASE}}/pdf/smokegood' } },
        pdfRoutes: { smokegood: 'good', smokehtml: 'html' },
        web: { search: 'ok', fetch: 'empty' }
      })
      process.env.GRAPHICTERO_OPENALEX_BASE_URL = fixture.baseUrl
      process.env.GRAPHICTERO_PDFSRC_BASE_URL = fixture.baseUrl
      process.env.GRAPHICTERO_WEB_BASE_URL = fixture.baseUrl
      const guard = fx.installFetchGuard()
      try {
        const mainMod = {
          cand: await import('./agent/candidates'),
          session: await import('./agent/sessionStore'),
          search: await import('./openalex/search'),
          oaClient: await import('./openalex/client')
        }
        /** 主进程侧轮询任务状态（2s 定时器会 drain，最多等 12s） */
        const waitJobStatus = async (jobId: number, want: string): Promise<string> => {
          for (let i = 0; i < 60; i++) {
            const row = state.db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as { status: string } | undefined
            if (row?.status === want || row?.status.startsWith('failed')) return row?.status ?? 'missing'
            await sleep(200)
          }
          return 'timeout'
        }
        // Unpaywall 邮箱走设置（D131 默认取 .env，冒烟进程没有 .env，经 IPC 设置）
        await evalJs<void>(`window.graphictero.setPdfSources({ sources: [{ kind: 'open_access', enabled: true }], unpaywallEmail: 'smoke@example.com' })`)

        // ① 库外候选确认入库（D124）：importConfirm 走真实 IPC → importer → 排 candidate_pdf
        const graphId = Number(
          state.db.prepare("INSERT INTO graphs (name, created_at, updated_at) VALUES ('M6 fetch 冒烟', ?, ?)").run(new Date().toISOString(), new Date().toISOString()).lastInsertRowid
        )
        const sid = mainMod.session.createSession(state.db, { graphId, entryType: 'graph', entryId: null }).id
        const cand = await mainMod.cand.proposeCandidate(state.db, {
          graphId,
          sessionId: sid,
          title: 'Smoke 入库候选',
          authors: ['Smoke A'],
          year: 2026,
          doi: '10.8/smokeoa',
          arxivId: null,
          reason: '冒烟入库'
        })
        const imported = await evalJs<{ paperId: number; jobId: number }>(
          `window.graphictero.importConfirm({ candidateId: ${cand.id} })`
        )
        const jobStatus = await waitJobStatus(imported.jobId, 'succeeded')
        const paperRow = state.db.prepare('SELECT has_pdf, pdf_source FROM papers WHERE id = ?').get(imported.paperId) as { has_pdf: number; pdf_source: string | null } | undefined
        const pdfOk = jobStatus === 'succeeded' && paperRow?.has_pdf === 1 && paperRow?.pdf_source === 'open_access'
        record('M6 fetch 候选入库+PDF下载', pdfOk, `job=${jobStatus} has_pdf=${paperRow?.has_pdf} source=${paperRow?.pdf_source}`)
        ok = ok && pdfOk

        // ①b 真实 IPC 下虚线→实线的数据半边：listCandidates 离开 pending，getGraph 已有成员。
        // 画布在 ?smoke=1 用 agentApi() 内存 mock 列候选，不会把这条真实候选画成虚线再抹掉。
        // 界面半边（done + candidateId → gt:graph-changed → 实线成员）在 ui 段「画布done触发重拉」。
        const listed = await evalJs<Array<{ id: number; status: string; paperId?: number }>>(
          `window.graphictero.listCandidates(${graphId})`
        )
        const listedRow = listed.find((c) => c.id === cand.id)
        const graphView = await evalJs<{ members: Array<{ paper: { id: number } }> }>(`window.graphictero.getGraph(${graphId})`)
        const solidMember = graphView.members.some((m) => m.paper.id === imported.paperId)
        const leftPending = listedRow?.status === 'confirmed' && listedRow.paperId === imported.paperId
        const dashedSolidOk = leftPending && solidMember
        record(
          'M6 fetch 虚线转实线',
          dashedSolidOk,
          dashedSolidOk
            ? `listCandidates status=confirmed paperId=${imported.paperId}；getGraph 含该成员。画布 mock 不订阅这条真实候选`
            : `listed=${JSON.stringify(listedRow ?? null)} solid=${solidMember}`
        )
        ok = ok && dashedSolidOk

        // ② 尝试记录（D65(6)）：openalex 命中 html 链接被拒 → unpaywall 成功
        const attempts = await evalJs<Array<{ source: string; result: string }>>(
          `window.graphictero.pdfAttempts({ paperId: ${imported.paperId} })`
        )
        const attOk =
          attempts.some((a) => a.source === 'openalex' && a.result === 'error') &&
          attempts.some((a) => a.source === 'unpaywall' && a.result === 'ok')
        record('M6 fetch pdfAttempts', attOk, JSON.stringify(attempts.map((a) => [a.source, a.result])))
        ok = ok && attOk

        // ③ searchPapers 库内去重（D82）：刚入库的 DOI 命中标 inLibraryPaperId
        const client = mainMod.oaClient.createOpenAlexClient({ baseUrl: fixture.baseUrl, minIntervalMs: 0 })
        const hits = await mainMod.search.searchPapersService(state.db, client, 'smoke', 10)
        const hit = hits.find((h) => h.doi === '10.8/smokeoa')
        const dedupOk = hit?.inLibraryPaperId === imported.paperId
        record('M6 fetch searchPapers 去重', dedupOk, `hits=${hits.length} inLibrary=${hit?.inLibraryPaperId}`)
        ok = ok && dedupOk

        // ④ 无 PDF 路径（D54/D62）：全来源未命中 → 任务 succeeded + has_pdf 保持 0
        const pid2 = Number(
          state.db.prepare("INSERT INTO papers (title, source, doi, has_pdf, created_at, updated_at) VALUES ('无PDF冒烟', 'zotero', '10.8/smokenone', 0, ?, ?)")
            .run(new Date().toISOString(), new Date().toISOString()).lastInsertRowid
        )
        await evalJs<void>(`window.graphictero.retryFindPdf({ paperId: ${pid2} })`)
        const noPdfJobs = state.db.prepare("SELECT id FROM jobs WHERE kind = 'candidate_pdf' AND paper_id = ? ORDER BY id DESC").all(pid2) as Array<{ id: number }>
        const noPdfStatus = noPdfJobs.length > 0 ? await waitJobStatus(noPdfJobs[0].id, 'succeeded') : 'no-job'
        const p2 = state.db.prepare('SELECT has_pdf FROM papers WHERE id = ?').get(pid2) as { has_pdf: number }
        const noPdfOk = noPdfStatus === 'succeeded' && p2.has_pdf === 0
        record('M6 fetch 无PDF路径', noPdfOk, `job=${noPdfStatus} has_pdf=${p2.has_pdf}`)
        ok = ok && noPdfOk

        // ⑤ 03e 拖入（D111/D133）：attachPdf 复制进数据目录（fixture 最小 PDF 字节）
        const { writeFileSync } = await import('node:fs')
        const dropPath = join(state.dataDir, 'smoke-drop.pdf')
        writeFileSync(dropPath, fx.minimalPdfBytes())
        await evalJs<void>(`window.graphictero.attachPdf({ paperId: ${pid2}, filePath: ${JSON.stringify(dropPath)} })`)
        const p2After = state.db.prepare('SELECT has_pdf, pdf_source FROM papers WHERE id = ?').get(pid2) as { has_pdf: number; pdf_source: string }
        const { existsSync } = await import('node:fs')
        const dropOk = p2After.has_pdf === 1 && p2After.pdf_source === 'user_drop' && existsSync(join(state.dataDir, 'papers', String(pid2), 'paper.pdf'))
        record('M6 fetch 拖入PDF', dropOk, `has_pdf=${p2After.has_pdf} source=${p2After.pdf_source}`)
        ok = ok && dropOk

        // ⑤b 已入库论文再拖入：真实 event:cand:progress 带 candidateId，解析器不可用时相位是 done。
        // GraphPage 只在 candidateId 非空且 phase 为 done / no_pdf 时派发 gt:graph-changed。
        // ?smoke=1 的画布经 candApi() 内存 mock 订阅，听不到 window.graphictero 的广播。
        // 不把这条事件灌进 mock，避免后面的 ui 段被真实进度污染。
        await evalJs<void>(`(() => {
          window.__gtAttachEvents = []
          if (window.__gtAttachUnsub) window.__gtAttachUnsub()
          window.__gtAttachUnsub = window.graphictero.onCandProgress((e) => { window.__gtAttachEvents.push(e) })
        })()`)
        await evalJs<void>(`window.graphictero.attachPdf({ paperId: ${imported.paperId}, filePath: ${JSON.stringify(dropPath)} })`)
        const attachEvtOk = await waitFor(
          `(() => {
            const e = (window.__gtAttachEvents ?? []).find((x) => x.paperId === ${imported.paperId} && (x.message ?? '').includes('已复制'))
            return !!e && e.candidateId === ${cand.id} && e.phase === 'done'
          })()`,
          8000
        )
        await evalJs<void>(`(() => { if (window.__gtAttachUnsub) { window.__gtAttachUnsub(); window.__gtAttachUnsub = null } })()`)
        record(
          'M6 fetch 拖入进度带候选',
          attachEvtOk,
          attachEvtOk
            ? `attachPdf 事件 candidateId=${cand.id} phase=done。画布重拉由 ui 段「画布done触发重拉」覆盖`
            : '真实进度没有 candidateId，或相位不是 done'
        )
        ok = ok && attachEvtOk

        // ⑥ webSearch / webFetch：非空成功记一笔 web，空正文不记。Key 只在本次调用里传，不写数据目录。
        const webMod = await import('./web/client')
        const usageMod = await import('./llm/usage')
        const webBefore = (state.db.prepare("SELECT COUNT(*) AS n FROM usage_records WHERE category = 'web'").get() as { n: number }).n
        const found = await webMod.webSearch({ apiKey: 'smoke-key', baseUrl: fixture.baseUrl }, 'smoke')
        if (found.billable) usageMod.recordWebCall(state.db)
        const emptyPage = await webMod.webFetchPage({ apiKey: 'smoke-key', baseUrl: fixture.baseUrl }, 'https://example.com/a')
        const webAfter = (state.db.prepare("SELECT COUNT(*) AS n FROM usage_records WHERE category = 'web'").get() as { n: number }).n
        const webOk = found.billable && found.results.length === 1 && emptyPage.billable === false && webAfter === webBefore + 1
        record('M6 fetch webSearch 记账', webOk, `before=${webBefore} after=${webAfter}`)
        ok = ok && webOk

        // ⑥b 联网工具写入调用记录（D142）。只打本地 fixture，不读 Key。
        const agentTools = await import('./agent/tools')
        const webTraces: Array<{ toolName: string; summary: string }> = []
        const traced = agentTools.createAgentTools({
          db: state.db,
          dataDir: state.dataDir,
          sessionId: 1,
          graphId,
          turnId: 'smoke-web-trace',
          model: 'deepseek-flash',
          promptVersion: 'agent-v4',
          emitTrace: (t) => webTraces.push({ toolName: t.toolName, summary: t.summary }),
          onGraphChange: () => {},
          onPaperCard: () => {},
          web: { apiKey: 'smoke-key', baseUrl: fixture.baseUrl }
        })
        await traced.webSearch.execute!({ query: 'smoke' } as never, {} as never)
        // D178：trace 仍记这次搜索，summary 不再带金额。
        const traceOk = webTraces.some((t) => t.toolName === 'webSearch' && t.summary.includes('联网搜索') && !t.summary.includes('¥') && !t.summary.includes('费用'))
        record('M6 fetch 联网搜索 trace', traceOk, webTraces.map((t) => t.summary).join(' | ') || '无 trace')
        ok = ok && traceOk

        // ⑦ 导出预览：新图谱，有 DOI 才带链接。不调概览模型。
        const noDoiId = Number(
          state.db.prepare("INSERT INTO papers (title, source, created_at, updated_at) VALUES ('无DOI冒烟', 'zotero', ?, ?)").run(new Date().toISOString(), new Date().toISOString()).lastInsertRowid
        )
        state.db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 4, ?)').run(graphId, noDoiId, new Date().toISOString())
        const md = await evalJs<string>(
          `window.graphictero.preview(${JSON.stringify({ graphId, overview: false, details: false, relationTypes: [], references: true })})`
        )
        const noDoiLine = md.split('\n').find((line) => line.includes('无DOI冒烟') && line.startsWith('- '))
        const exportOk = md.includes('# M6 fetch 冒烟') && md.includes('https://doi.org/10.8/smokeoa') && !!noDoiLine && !noDoiLine.includes('http')
        record('M6 fetch Markdown 导出', exportOk, noDoiLine ?? '无参考文献行')
        ok = ok && exportOk

        // ⑧ 出网守卫：本段 global fetch 记录的 URL 必须全是 127.0.0.1（不用 fixture.requests 自证）
        const hostOk = guard.urls.length > 0 && guard.urls.every((url) => {
          try {
            return new URL(url).hostname === '127.0.0.1'
          } catch {
            return false
          }
        })
        record('M6 fetch 零真实网络', hostOk, `guard=${guard.urls.length}`)
        ok = ok && hostOk
      } finally {
        guard.restore()
        delete process.env.GRAPHICTERO_OPENALEX_BASE_URL
        delete process.env.GRAPHICTERO_PDFSRC_BASE_URL
        delete process.env.GRAPHICTERO_WEB_BASE_URL
        await fixture.close()
      }
    }
    // ===== M6 lane/fetch steps end =====

    // ===== M6 lane/ui steps =====（lane/ui 只在本段内追加步骤）
    // cand: 通道在主进程还是「未实现」桩（归 lane/fetch 批 1）——本段全部经渲染层接缝
    // candApi() 的内存 mock（window.__gtSmokeCand）驱动：cand: 调用入参与
    // event:cand:progress 都在渲染层内断言/触发，不触主进程桩、零真实网络。
    const uiMockReady = await waitFor(`!!window.__gtSmokeCand`, 10000)
    record('M6 UI cand mock 就绪', uiMockReady, uiMockReady ? 'window.__gtSmokeCand 可用（candApi 渲染层接缝）' : 'cand mock 未建立')
    ok = ok && uiMockReady
    if (!uiMockReady) return finish(false)

    // 数据源：Gamma（03e 无 PDF 页）+ Delta（已入库卡片的跳转目标，库内真实论文）
    const uiGamma = state.db.prepare("SELECT id FROM papers WHERE title = 'Smoke Paper Gamma'").get() as { id: number }
    const uiDelta = state.db.prepare("SELECT id FROM papers WHERE title = 'Smoke Paper Delta'").get() as { id: number }

    // 03e「尝试过的来源」数据源（PdfAttemptView 口径：来源 + 结果 + 时间，D65(6)）
    await evalJs<void>(`window.__gtSmokeCand.attempts = [
      { source: 'arxiv', result: 'not_found', at: new Date(Date.now() - 3600e3).toISOString() },
      { source: 'openalex', url: 'https://oa.smoke.example/x.pdf', result: 'error', at: new Date().toISOString() }
    ]`)

    // ── 1. 设置「PDF 来源」组（原型 05）：渲染 + 添加自定义模板（校验）+ 拖动排序 + 开关 + 保存 ──
    // （设置入口在画布工具栏——先返回图谱）
    if (!(await backToGraph())) {
      record('设置PDF来源组启用', false, '返回画布失败')
      return finish(false)
    }
    await evalJs<void>(`document.querySelector('.toolbar button[title="设置"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const settingsOpen = await waitFor(`[...document.querySelectorAll('.sitem')].some((e) => (e.textContent ?? '').includes('PDF 来源'))`)
    record('设置PDF来源组启用', settingsOpen, settingsOpen ? '侧栏「PDF 来源」组可点（M6 lane/ui 批 1 启用）' : 'PDF 来源组未启用')
    ok = ok && settingsOpen
    if (!settingsOpen) return finish(false)
    await evalJs<boolean>(`__gt.clickText('.sitem', 'PDF 来源')`)
    const pdfSrcRendered = await waitFor(`(() => {
      const rows = [...document.querySelectorAll('[data-testid="pdf-src-row"]')]
      const email = document.querySelector('[data-testid="pdf-src-email"]')
      return rows.length === 1 && rows[0].getAttribute('data-kind') === 'open_access' &&
        !!email && (email.value ?? '').includes('@') &&
        (document.body.innerText ?? '').includes('机构代理 · 后续版本')
    })()`, 10000)
    record('设置PDF来源组渲染', pdfSrcRendered, pdfSrcRendered ? '开放获取行 + Unpaywall 邮箱 + 机构代理「后续版本」灰行（D64）' : 'PDF 来源组渲染不全')
    ok = ok && pdfSrcRendered

    // 自定义模板校验：非 https 拒收（内联错误，对齐共享契约 zod 口径）
    await evalJs<void>(`document.querySelector('[data-testid="pdf-src-add"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    await evalJs<boolean>(`__gt.setInput('[data-testid="pdf-src-template"]', 'ftp://bad.example/{doi}')`)
    await evalJs<void>(`document.querySelector('[data-testid="pdf-src-add-ok"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const tplReject = await waitFor(`(() => {
      const err = document.querySelector('[data-testid="pdf-src-error"]')
      return !!err && (err.textContent ?? '').includes('https') && document.querySelectorAll('[data-testid="pdf-src-row"]').length === 1
    })()`)
    record('自定义模板校验', tplReject, tplReject ? '非 https 模板拒收并内联报错（含 https 提示），行数不变' : '非法模板被接受或报错缺失')
    ok = ok && tplReject
    await evalJs<void>(`document.querySelector('[data-testid="pdf-src-add-cancel"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)

    // 合法模板入列 + 拖到第 1 位 + 停用「开放获取」+ 保存（保存后立即生效，D133 数据源）
    await evalJs<void>(`document.querySelector('[data-testid="pdf-src-add"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    await evalJs<boolean>(`__gt.setInput('[data-testid="pdf-src-template"]', 'https://oa.smoke.example/{doi}')`)
    await evalJs<void>(`document.querySelector('[data-testid="pdf-src-add-ok"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    await evalJs<void>(`(() => {
      const dt = new DataTransfer()
      const rows = [...document.querySelectorAll('[data-testid="pdf-src-row"]')]
      rows[1].querySelector('[data-testid="pdf-src-handle"]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
      rows[0].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
      rows[0].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    })()`)
    const reordered = await waitFor(`(() => {
      const rows = [...document.querySelectorAll('[data-testid="pdf-src-row"]')]
      return rows.length === 2 && rows[0].getAttribute('data-kind') === 'custom'
    })()`, 5000)
    if (!reordered) {
      const diag = await evalJs<string>(`JSON.stringify({
        dragfrom: document.querySelector('[data-dragfrom]')?.getAttribute('data-dragfrom') ?? null,
        order: [...document.querySelectorAll('[data-testid="pdf-src-row"]')].map((r) => r.getAttribute('data-kind'))
      })`)
      record('来源排序开关保存', false, `拖动排序未生效: ${diag}`)
      return finish(false)
    }
    await evalJs<void>(`(() => {
      const rows = [...document.querySelectorAll('[data-testid="pdf-src-row"]')]
      rows[1].querySelector('[data-testid="pdf-src-toggle"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })()`)
    await evalJs<void>(`document.querySelector('[data-testid="pdf-src-save"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const srcSaved = await waitFor(`(() => {
      const saved = window.__gtSmokeCand.calls.saved
      if (saved.length === 0) return false
      const s = saved[saved.length - 1]
      return s.sources.length === 2 && s.sources[0].kind === 'custom' &&
        s.sources[0].template === 'https://oa.smoke.example/{doi}' &&
        s.sources[1].kind === 'open_access' && s.sources[1].enabled === false
    })()`)
    const savedDetail = await evalJs<string>(`JSON.stringify(window.__gtSmokeCand.calls.saved)`)
    record('来源排序开关保存', srcSaved, srcSaved ? 'cand:setPdfSources 收到新顺序 [自定义, 开放获取(停用)]（保存后立即生效）' : `保存的 sources 顺序/开关不对: ${savedDetail}`)
    ok = ok && srcSaved

    // ── 2. 03e：尝试过的来源 + 再试一次（按新顺序）+ 拖入 + 进度 → 解析完成 ──
    await evalJs<boolean>(`__gt.clickText('.sitem', '返回')`)
    if (!(await waitFor(`!!document.querySelector('.react-flow__node')`))) {
      record('03e尝试过的来源', false, '返回画布失败')
      return finish(false)
    }
    if (!(await clickNode('Gamma'))) {
      record('03e尝试过的来源', false, '点击 Gamma 未进 03e')
      return finish(false)
    }
    const triedOk = await waitFor(`(() => {
      const t = document.querySelector('[data-testid="nopdf-tried"]')
      return !!t && (t.textContent ?? '').includes('arxiv') && (t.textContent ?? '').includes('未找到') &&
        (t.textContent ?? '').includes('openalex') && (t.textContent ?? '').includes('出错')
    })()`)
    record('03e尝试过的来源', triedOk, triedOk ? '来源 + 结果 + 时间列表渲染（cand:pdfAttempts）' : '尝试过的来源缺失')
    ok = ok && triedOk

    // 「再试一次查找」：发出 cand:retryFindPdf；后端按刚保存的来源顺序执行（新顺序=[自定义, 开放获取(停用)]）
    await evalJs<void>(`document.querySelector('[data-testid="nopdf-retry"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const uiRetryOk = await waitFor(`(() => {
      const r = window.__gtSmokeCand.calls.retry
      return r.length === 1 && r[0].paperId === ${uiGamma.id}
    })()`)
    record('03e再试一次查找', uiRetryOk, uiRetryOk ? `cand:retryFindPdf 只发 paperId=${uiGamma.id}；新顺序已在上一步 setPdfSources 保存（D133，按顺序查找归 lane/fetch）` : '再试一次未发出 retryFindPdf')
    ok = ok && uiRetryOk

    // 进度：locating → no_pdf（03e 进度行如实显示相位）
    await evalJs<void>(`window.__gtSmokeCand.fire({ paperId: ${uiGamma.id}, phase: 'locating' })`)
    const locatingOk = await waitFor(`(document.querySelector('[data-testid="nopdf-progress"]')?.textContent ?? '').includes('查找 PDF')`)
    record('03e进度行', locatingOk, locatingOk ? 'event:cand:progress locating → 「正在查找 PDF」' : '进度行未出现')
    ok = ok && locatingOk
    await evalJs<void>(`window.__gtSmokeCand.fire({ paperId: ${uiGamma.id}, phase: 'no_pdf', message: '开放来源都未找到' })`)
    const uiNoPdfOk = await waitFor(`(document.querySelector('[data-testid="nopdf-progress"]')?.textContent ?? '').includes('未找到 PDF')`)
    record('03e无PDF进度', uiNoPdfOk, uiNoPdfOk ? 'no_pdf 相位如实显示（D54 无 PDF 口径）' : 'no_pdf 未显示')
    ok = ok && uiNoPdfOk

    // 拖入：合成 drop（DataTransfer + File）。合成 File 没有磁盘路径——渲染层应直接提示、
    // 不发 IPC（建议修 3；合并日集成 smoke 用主进程落下的真实小 PDF 再拖，不入 git）
    await evalJs<void>(`(() => {
      const dt = new DataTransfer()
      dt.items.add(new File(['%PDF-smoke'], 'smoke-drop.pdf', { type: 'application/pdf' }))
      document.querySelector('[data-testid="nopdf-drop"]').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    })()`)
    const attachOk = await waitFor(`(() => {
      const toast = (document.querySelector('.toasts')?.textContent ?? '')
      return toast.includes('路径') && window.__gtSmokeCand.calls.attach.length === 0
    })()`)
    record('03e拖入空路径拒收', attachOk, attachOk ? '合成 File 无磁盘路径 → toast 提示、不发 cand:attachPdf（建议修 3）' : '空路径未被拒收')
    ok = ok && attachOk

    // 只收 .pdf：.txt 拒收（不发 attachPdf、出提示）
    await evalJs<void>(`(() => {
      const dt = new DataTransfer()
      dt.items.add(new File(['x'], 'notes.txt'))
      document.querySelector('[data-testid="nopdf-drop"]').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    })()`)
    await sleep(200)
    const onlyPdf = await evalJs<boolean>(`(() => {
      const toast = (document.querySelector('.toasts')?.textContent ?? '')
      return toast.includes('只支持 PDF') && window.__gtSmokeCand.calls.attach.length === 0
    })()`)
    record('03e只收PDF', onlyPdf, onlyPdf ? '.txt 拖入被忽略（不发 attachPdf + 提示）' : '非 PDF 文件被接受')
    ok = ok && onlyPdf

    // 解析完成态：parsing →（主进程侧 has_pdf 翻真）→ done → 页面切到正常详情
    await evalJs<void>(`window.__gtSmokeCand.fire({ paperId: ${uiGamma.id}, phase: 'parsing' })`)
    const parsingOk = await waitFor(`(document.querySelector('[data-testid="nopdf-progress"]')?.textContent ?? '').includes('解析')`)
    record('03e解析进度', parsingOk, parsingOk ? 'parsing 相位显示「正在解析」' : '解析进度未显示')
    ok = ok && parsingOk
    state.db.prepare('UPDATE papers SET has_pdf = 1 WHERE id = ?').run(uiGamma.id)
    await evalJs<void>(`window.__gtSmokeCand.fire({ paperId: ${uiGamma.id}, phase: 'done' })`)
    const switchOk = await waitFor(`(() => {
      const page = document.querySelector('[data-testid="paper-detail-page"]')
      return !!page && !page.querySelector('[data-testid="nopdf-drop"]') && (page.textContent ?? '').includes('打开 PDF')
    })()`)
    record('03e拖入后切正常详情', switchOk, switchOk ? 'done + has_pdf 翻真 → 03e 切到正常详情（D111）' : '完成后未切换视图')
    ok = ok && switchOk

    // ── 3. 候选确认 → 卡片进度 → 已入库 → 点击跳论文 ──
    // 抽屉（会话 mock）：回画布开图级入口（graph 入口下已有会话），发「冒烟候选」→ 候选卡 + 虚线节点
    if (!(await backToGraph())) {
      record('候选卡片与虚线节点', false, '返回画布失败')
      return finish(false)
    }
    if (!(await waitFor(`!!document.querySelector('[data-testid="chat-drawer"]')`, 3000))) {
      await evalJs<void>(`document.querySelector('[data-testid="chat-toggle"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    }
    if (!(await waitFor(`!!document.querySelector('[data-testid="chat-input"]:not([disabled])')`, 4000))) {
      // 该入口下还没有选中会话：⌘N 新建（与 M6 prereq 段同法）
      await evalJs<void>(`document.querySelector('[data-testid="chat-new-session"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    }
    if (!(await waitFor(`!!document.querySelector('[data-testid="chat-input"]:not([disabled])')`))) {
      const diag = await evalJs<string>(`JSON.stringify({
        drawer: !!document.querySelector('[data-testid="chat-drawer"]'),
        input: !!document.querySelector('[data-testid="chat-input"]'),
        entry: (document.querySelector('[data-testid="chat-entry"]')?.textContent ?? '').slice(0, 60),
        newSess: !!document.querySelector('[data-testid="chat-new-session"]')
      })`)
      record('候选确认卡片进度', false, `抽屉输入框不可用: ${diag}`)
      return finish(false)
    }
    await evalJs<boolean>(`__gt.setInput('[data-testid="chat-input"]', '冒烟候选')`)
    await evalJs<void>(`document.querySelector('[data-testid="chat-send"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const candCardsOk = await waitFor(`(() => {
      const cards = [...document.querySelectorAll('[data-testid="part-paper-card"]')]
      const ext = cards.find((c) => (c.textContent ?? '').includes('Smoke Candidate External') && c.querySelector('[data-testid="card-confirm"]'))
      return !!ext && !!ext.querySelector('[data-testid="card-confirm"]') && document.querySelectorAll('[data-testid="cand-node"]').length >= 2
    })()`, 15000)
    record('候选卡片与虚线节点', candCardsOk, candCardsOk ? '「冒烟候选」→ 库外候选卡 + 画布虚线节点就绪' : `候选链路未建立: ${await evalJs<string>(`JSON.stringify({
      drawer: !!document.querySelector('[data-testid="chat-drawer"]'),
      inputDisabled: document.querySelector('[data-testid="chat-input"]')?.disabled ?? null,
      entry: (document.querySelector('[data-testid="chat-entry"]')?.textContent ?? '').slice(0, 50),
      cards: document.querySelectorAll('[data-testid="part-paper-card"]').length,
      nodes: document.querySelectorAll('[data-testid="cand-node"]').length,
      toasts: (document.querySelector('.toasts')?.textContent ?? '').slice(0, 60)
    })`)}`)
    ok = ok && candCardsOk
    if (!candCardsOk) return finish(false)

    // 库外确认 → cand:importConfirm：画布按钮点一次（评审必须修 1：走 candApi 内存 mock，
    // 乐观「入库中」防连点），卡片订阅同一事件流——两边一起被驱动
    await evalJs<void>(`[...document.querySelectorAll('[data-testid="cand-node"]')]
      .find((n) => (n.textContent ?? '').includes('Smoke Candidate External'))
      .querySelector('[data-testid="cand-confirm"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const importingOk = await waitFor(`(() => {
      const node = [...document.querySelectorAll('[data-testid="cand-node"]')].find((n) => (n.textContent ?? '').includes('Smoke Candidate External'))
      const calls = window.__gtSmokeCand.calls.import
      const badge = node?.querySelector('[data-testid="cand-progress"]')
      const btn = node?.querySelector('[data-testid="cand-confirm"]')
      return calls.length === 1 && !!badge && (badge.textContent ?? '').includes('入库') && !!btn && btn.disabled
    })()`)
    record('画布确认入库', importingOk, importingOk ? '画布「确认入库」→ cand:importConfirm（candApi mock）+ 乐观「入库中」且按钮禁用' : '画布确认后无乐观进度')
    ok = ok && importingOk
    const extCandId = await evalJs<number>(`window.__gtSmokeCand.calls.import[window.__gtSmokeCand.calls.import.length - 1].candidateId`)
    await evalJs<void>(`window.__gtSmokeCand.fire({ candidateId: ${extCandId}, paperId: ${uiDelta.id}, phase: 'downloading' })`)
    const cardDlOk = await waitFor(`(() => {
      const ext = [...document.querySelectorAll('[data-testid="part-paper-card"]')].find((c) => (c.textContent ?? '').includes('Smoke Candidate External') && c.querySelector('[data-testid="card-progress"]'))
      return (ext?.querySelector('[data-testid="card-progress"]')?.textContent ?? '').includes('下载 PDF')
    })()`)
    // 画布虚线节点同步进度徽标
    const nodeBadgeOk = await waitFor(`(() => {
      const nodes = [...document.querySelectorAll('[data-testid="cand-node"]')]
      const ext = nodes.find((n) => (n.textContent ?? '').includes('Smoke Candidate External'))
      return (ext?.querySelector('[data-testid="cand-progress"]')?.textContent ?? '').includes('下载 PDF')
    })()`)
    record('画布候选进度徽标', cardDlOk && nodeBadgeOk, cardDlOk && nodeBadgeOk ? '卡片与画布虚线节点同步「正在下载 PDF」' : `卡片=${cardDlOk} 画布=${nodeBadgeOk}`)
    ok = ok && cardDlOk && nodeBadgeOk

    // 画布 no_pdf「再试查找」：按钮在，不叠确认/转圈；只发 paperId（顺序不在 IPC 体里）
    await evalJs<void>(`window.__gtSmokeCand.fire({ candidateId: ${extCandId}, paperId: ${uiDelta.id}, phase: 'no_pdf' })`)
    const canvasNoPdfReady = await waitFor(`(() => {
      const node = [...document.querySelectorAll('[data-testid="cand-node"]')].find((n) => (n.textContent ?? '').includes('Smoke Candidate External'))
      const retry = node?.querySelector('[data-testid="cand-retry-pdf"]')
      return !!node && !!retry && !retry.disabled && !node.querySelector('[data-testid="cand-confirm"]') && !node.querySelector('[data-testid="cand-progress"]') && !!node.querySelector('[data-testid="cand-nopdf"]')
    })()`)
    let canvasRetryOk = false
    if (canvasNoPdfReady) {
      const retryBefore = await evalJs<number>(`window.__gtSmokeCand.calls.retry.length`)
      await evalJs<void>(`[...document.querySelectorAll('[data-testid="cand-node"]')]
        .find((n) => (n.textContent ?? '').includes('Smoke Candidate External'))
        .querySelector('[data-testid="cand-retry-pdf"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      canvasRetryOk = await waitFor(`(() => {
        const r = window.__gtSmokeCand.calls.retry
        const last = r[r.length - 1]
        return r.length === ${retryBefore + 1} && !!last && last.paperId === ${uiDelta.id}
      })()`)
    }
    record(
      '画布no_pdf再试查找',
      canvasNoPdfReady && canvasRetryOk,
      canvasNoPdfReady && canvasRetryOk
        ? `画布 no_pdf →「再试查找」cand:retryFindPdf paperId=${uiDelta.id}，不叠确认按钮/转圈`
        : `no_pdf 按钮=${canvasNoPdfReady} 调用=${canvasRetryOk}`
    )
    ok = ok && canvasNoPdfReady && canvasRetryOk

    // done：mock 的 listCandidates 仍把候选留在 pending，虚线节点不会自己消失。
    // 这里只证明 UI 派发 gt:graph-changed 并重拉到「这次事件的 paperId」对应的新成员。
    // 不用预先就在画布上的 Smoke Paper Delta 充数。
    // 真实 IPC 的「离开 pending + 成员在图上」在 fetch 段「M6 fetch 虚线转实线」。
    // 不把真实进度灌进本 mock，避免和后面的 fire 混在一起。
    const epsNow = new Date().toISOString()
    const epsIns = state.db
      .prepare(
        `INSERT INTO papers (title, source, has_pdf, first_author, year, created_at, updated_at)
         VALUES ('Smoke Paper Epsilon', 'zotero', 0, 'Epsilon', 2025, ?, ?)`
      )
      .run(epsNow, epsNow)
    const epsId = Number(epsIns.lastInsertRowid)
    state.db
      .prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 460, 180, ?)')
      .run(graphId, epsId, epsNow)
    const epsAbsent = await evalJs<boolean>(
      `![...document.querySelectorAll('.react-flow__node')].some((n) => (n.textContent ?? '').includes('Smoke Paper Epsilon'))`
    )
    await evalJs<void>(`(() => {
      window.__gtGraphChangedCount = 0
      if (!window.__gtOnGraphChanged) {
        window.__gtOnGraphChanged = () => { window.__gtGraphChangedCount++ }
        window.addEventListener('gt:graph-changed', window.__gtOnGraphChanged)
      }
    })()`)
    await evalJs<void>(`window.__gtSmokeCand.fire({ candidateId: ${extCandId}, paperId: ${epsId}, phase: 'done' })`)
    const reloadOk = await waitFor(`(() => {
      const node = [...document.querySelectorAll('[data-testid="cand-node"]')].find((n) => (n.textContent ?? '').includes('Smoke Candidate External'))
      const solid = [...document.querySelectorAll('.react-flow__node')].some((n) => !n.querySelector('[data-testid="cand-node"]') && (n.textContent ?? '').includes('Smoke Paper Epsilon'))
      return (window.__gtGraphChangedCount ?? 0) >= 1 && solid && !!node
        && !!node.querySelector('[data-testid="cand-done"]')
        && !node.querySelector('[data-testid="cand-confirm"]')
        && !node.querySelector('[data-testid="cand-progress"]')
    })()`, 8000)
    record(
      '画布done触发重拉',
      epsAbsent && reloadOk,
      epsAbsent && reloadOk
        ? 'done 派发 gt:graph-changed，重拉后出现本次 paperId 的新成员 Epsilon；确认按钮不渲染、不与「已入库」叠转圈。mock 仍留虚线；真实 IPC 的离开 pending 见 fetch 段'
        : `事件前 Epsilon 不在场=${epsAbsent} 重拉=${reloadOk}`
    )
    ok = ok && epsAbsent && reloadOk

    const importedOk = await waitFor(`(() => {
      const ext = [...document.querySelectorAll('[data-testid="part-paper-card"]')].find((c) => (c.textContent ?? '').includes('Smoke Candidate External') && (c.textContent ?? '').includes('已入库'))
      return !!ext && !!ext.querySelector('[data-testid="card-open"]')
    })()`)
    record('候选已入库态', importedOk, importedOk ? 'done → 卡片「已入库」+ 打开论文按钮' : '已入库态未出现')
    ok = ok && importedOk
    await evalJs<void>(`[...document.querySelectorAll('[data-testid="part-paper-card"]')]
      .find((c) => (c.textContent ?? '').includes('Smoke Candidate External') && c.querySelector('[data-testid="card-open"]'))
      .querySelector('[data-testid="card-open"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const jumpOk = await waitFor(`(document.querySelector('[data-testid="paper-detail-page"]')?.textContent ?? '').includes('Smoke Paper Epsilon')`)
    record('已入库点击跳论文', jumpOk, jumpOk ? '卡片「打开论文」→ 本次 done 的 paperId（Epsilon），不是预先在场的 Delta' : '未跳到本次入库的论文')
    ok = ok && jumpOk

    // ── 4. 导出 Markdown 弹窗（原型 08；D31/D60/D132；exportApi() 渲染层 mock，零真实网络）──
    if (!(await backToGraph())) {
      record('导出弹窗打开', false, '返回画布失败')
      return finish(false)
    }
    await evalJs<void>(`document.querySelector('.toolbar button[title="更多"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    await evalJs<void>(`document.querySelector('[data-testid="menu-export-md"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const expOpen = await waitFor(`!!document.querySelector('[data-testid="export-dialog"]') && (document.querySelector('[data-testid="export-preview"]')?.textContent ?? '').includes('冒烟图谱')`, 10000)
    record('导出弹窗打开', expOpen, expOpen ? '图谱「更多 → 导出 Markdown…」→ 弹窗 + export:preview 预览（mock）' : '导出弹窗未打开')
    ok = ok && expOpen

    // D132 + D178：概览默认不勾；勾选只显示中性「会调用一次模型」，导出 DOM 无金额。
    const ovUnchecked = await evalJs<boolean>(`(() => {
      const opt = document.querySelector('[data-testid="export-opt-overview"]')
      return !opt.querySelector('input').checked && !(opt.textContent ?? '').includes('预计') && !(opt.textContent ?? '').includes('¥')
    })()`)
    await evalJs<void>(`document.querySelector('[data-testid="export-opt-overview"] input').click()`)
    const ovHint = await waitFor(`(() => {
      const opt = document.querySelector('[data-testid="export-opt-overview"]')
      const t = opt.textContent ?? ''
      return t.includes('会调用一次模型') && !t.includes('¥') && !t.includes('计入后台用量') &&
        !!document.querySelector('[data-testid="export-gen-overview"]')
    })()`)
    record('导出概览D132', ovUnchecked && ovHint, ovUnchecked && ovHint ? '概览默认不勾；勾选显示中性模型调用说明 + 生成概览按钮，无金额' : '概览默认态/中性文案不对')
    ok = ok && ovUnchecked && ovHint

    // 生成概览（mock overview 一次）→ 概览文本拼进预览
    await evalJs<void>(`document.querySelector('[data-testid="export-gen-overview"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const ovOk = await waitFor(`(document.querySelector('[data-testid="export-preview"]')?.textContent ?? '').includes('这条线围绕') && window.__gtSmokeExport.calls.overview.length === 1`, 8000)
    // uat4-fix1 S4：第一次点击是真实计费生成（mock 第一次 cached=false）→ 显示「已生成」，
    // 不写「预计」也不写「缓存」；「已生成（缓存，不再计费）」只在确有缓存时显示
    const ovCached = await waitFor(`(() => {
      const opt = document.querySelector('[data-testid="export-opt-overview"]')
      const t = opt.textContent ?? ''
      return t.includes('已生成') && !t.includes('预计') && !t.includes('缓存')
    })()`, 8000)
    record('导出生成概览', ovOk && ovCached, ovOk && ovCached ? 'export:overview 调一次（不随选项重选重复花钱），概览块进预览，本次计费生成显示「已生成」（无「预计」无「缓存」）' : '概览未生成/重复调用/文案不对')
    ok = ok && ovOk

    // 改选项 → 防抖预览更新（mock 预览带选项标记）
    await evalJs<void>(`document.querySelector('[data-testid="export-opt-details"] input').click()`)
    const prevOk = await waitFor(`(document.querySelector('[data-testid="export-preview"]')?.textContent ?? '').includes('details=true')`, 8000)
    record('导出预览随选项', prevOk, prevOk ? '勾「附详情」→ 防抖后预览更新（export:preview 收到 details=true）' : '预览未随选项更新')
    ok = ok && prevOk

    // 保存（mock 返回路径）→ toast 显示路径
    await evalJs<void>(`document.querySelector('[data-testid="export-save"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const saveOk = await waitFor(`(document.querySelector('.toasts')?.textContent ?? '').includes('/tmp/gt-export-smoke.md') && window.__gtSmokeExport.calls.save.length === 1 && !document.querySelector('[data-testid="export-dialog"]')`, 8000)
    record('导出保存', saveOk, saveOk ? 'export:save 收到选项；mock 路径 → toast + 关闭（取消返回 null 另有单测）' : '保存未成功')
    ok = ok && saveOk

    // ── 5. 用量页「联网」类别（web，D125/D126）+ D137「解析环境」行名 ──
    state.db
      .prepare("INSERT INTO usage_records (occurred_at, category, cost_cny, input_tokens, output_tokens) VALUES (?, 'web', 0.005, 100, 50)")
      .run(new Date().toISOString())
    await evalJs<void>(`document.querySelector('.toolbar button[title="设置"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    await evalJs<boolean>(`__gt.clickText('.sitem', '用量与费用')`)
    const webOk = await waitFor(`(document.querySelector('.setmain')?.textContent ?? '').includes('联网')`, 8000)
    record('用量联网类别', webOk, webOk ? 'usage_records web 行 → 「用量与费用」显示「联网」类别（062 口径）' : '联网类别未显示')
    ok = ok && webOk
    await evalJs<boolean>(`__gt.clickText('.sitem', 'PDF 解析')`)
    const d137Ok = await waitFor(`(() => {
      const t = document.querySelector('.setmain')?.textContent ?? ''
      // D137 行名「解析环境」保留。uat8c 的「模型文件」是模型目录大小，不是把环境行改回去。
      return t.includes('解析环境') && t.includes('模型文件') && t.includes('最近一次解析')
    })()`, 8000)
    record('设置解析环境行D137', d137Ok, d137Ok ? '「解析环境」仍在；另有模型文件大小与最近一次解析' : 'D137 行名未改')
    ok = ok && d137Ok
    await evalJs<boolean>(`__gt.clickText('.sitem', '返回')`)
    if (!(await waitFor(`!!document.querySelector('.react-flow__node')`))) {
      record('设置解析环境行D137', false, '返回画布失败')
      return finish(false)
    }

    // ── 6. D138：阅读器页边笔记卡跟随锚点高度（点页面中部 → 卡片不在固定 56px）──
    if (!(await clickNode('Delta'))) {
      record('阅读器笔记卡位置D138', false, '点击 Delta 未进详情页')
      return finish(false)
    }
    await evalJs<boolean>(`__gt.clickText('button', '打开 PDF')`)
    if (!(await waitFor(`!!document.querySelector('.gt-page')`, 20000))) {
      record('阅读器笔记卡位置D138', false, '阅读器未就绪')
      return finish(false)
    }
    await evalJs<void>(`document.querySelector('.gt-reader-toolbar button[title="笔记"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    // 点页面中部 → 建独立笔记锚点 + 笔记卡（锚点 y ≈ 页中部）。
    // 注意：页内单击走 textlayer 的 mouseup（无选区 → onPageTap），不是 click
    await evalJs<void>(`(() => {
      const layer = document.querySelector('.gt-textlayer')
      const r = layer.getBoundingClientRect()
      layer.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }))
    })()`)
    const ncardOk = await waitFor(`(() => {
      const card = document.querySelector('[data-testid="notecard"]')
      if (!card) return false
      const body = document.querySelector('.gt-reader-body')
      const top = Number.parseFloat(card.style.top)
      return Number.isFinite(top) && top >= 100 && top <= body.getBoundingClientRect().height - 8
    })()`, 10000)
    record('阅读器笔记卡位置D138', ncardOk, ncardOk ? '笔记卡 top 跟随锚点（页中部，≥100px，非旧固定 56px）且在视口内' : `笔记卡未跟随锚点: ${await evalJs<string>(`JSON.stringify({
      card: !!document.querySelector('[data-testid="notecard"]'),
      top: document.querySelector('[data-testid="notecard"]')?.style.top ?? null,
      toolBtn: !!document.querySelector('.gt-reader-toolbar button[title="笔记"]'),
      toasts: (document.querySelector('.toasts')?.textContent ?? '').slice(0, 80),
      page: !!document.querySelector('.gt-page')
    })`)}`)
    ok = ok && ncardOk
    // 卡片出现后再滚一截：top 必须变，并且仍夹在 [margin, bodyHeight - cardHeight - margin]
    let followOk = false
    let followDiag = '笔记卡未出现，未滚动'
    if (ncardOk) {
      const beforeTop = await evalJs<number>(`Number.parseFloat(document.querySelector('[data-testid="notecard"]')?.style.top ?? 'NaN')`)
      await evalJs<void>(`(() => {
        const vp = document.querySelector('.gt-reader-viewport')
        if (!vp) return
        vp.scrollTop = Math.min(vp.scrollHeight, vp.scrollTop + 240)
        vp.dispatchEvent(new Event('scroll'))
      })()`)
      followOk = await waitFor(`(() => {
        const card = document.querySelector('[data-testid="notecard"]')
        const body = document.querySelector('.gt-reader-body')
        if (!card || !body) return false
        const top = Number.parseFloat(card.style.top)
        const margin = 8
        const cardH = card.getBoundingClientRect().height
        const bodyH = body.getBoundingClientRect().height
        const max = Math.max(margin, bodyH - cardH - margin)
        return Number.isFinite(top) && Math.abs(top - ${beforeTop}) > 0.5 && top >= margin - 0.5 && top <= max + 0.5
      })()`, 5000)
      if (!followOk) {
        followDiag = await evalJs<string>(`JSON.stringify({
          before: ${beforeTop},
          top: document.querySelector('[data-testid="notecard"]')?.style.top ?? null,
          scrollTop: document.querySelector('.gt-reader-viewport')?.scrollTop ?? null,
          scrollHeight: document.querySelector('.gt-reader-viewport')?.scrollHeight ?? null,
          clientHeight: document.querySelector('.gt-reader-viewport')?.clientHeight ?? null
        })`)
      }
    }
    record(
      '阅读器笔记卡滚动跟随D138',
      followOk,
      followOk ? '滚动后笔记卡 top 变化，且仍落在上下贴边范围内' : `滚动后位置未跟随: ${followDiag}`
    )
    ok = ok && followOk
    await evalJs<void>(`document.querySelector('.gt-reader-toolbar button[title="关闭"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    await waitFor(`!document.querySelector('[data-testid="pdf-reader"]')`)

    // ===== M6 lane/ui steps end =====

    // ===== uat1 lane/uat1 steps =====（uat1 只在本段内追加步骤）
    // MinerU 安装失败可见性（uat1 第 2/3 部分）：smoke 模式 sidecar=unavailable，首启门
    // 平时不进——用渲染层接缝 __gtSmokeMineru 注入 install_failed（纯渲染层事件，假 sidecar
    // 状态注入，不真装、不触主进程）。验证全链路：首启界面 00 失败态 + 通俗 toast →
    // 重试（installMineru 调用）→ 恢复 stopped 自动回首页 → 状态点弹层「环境」条目 →
    // 设置页失败文案 + 重试安装/重新安装可用。
    // 先回到首页：上一段（M6 lane/ui）结尾在阅读器 → 详情页 → 图谱 → 首页
    await evalJs<void>(`document.querySelector('.gt-reader-toolbar button[title="关闭"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    await sleep(300)
    await evalJs<boolean>(`__gt.clickText('[data-testid="paper-detail-page"] .toolbar button', '返回')`)
    if (!(await waitFor(`!!document.querySelector('.react-flow__node')`))) {
      record('MinerU安装失败注入', false, '返回图谱失败')
      return finish(false)
    }
    await evalJs<boolean>(`__gt.clickText('.toolbar button', '我的图谱')`)
    if (!(await waitFor(`document.body.innerText.includes('我的图谱') && [...document.querySelectorAll('button')].some((b) => (b.textContent ?? '').includes('新建图谱'))`))) {
      record('MinerU安装失败注入', false, '返回首页失败')
      return finish(false)
    }
    const mineruMockReady = await waitFor(`!!window.__gtSmokeMineru`, 10000)
    record('MinerU mock 就绪', mineruMockReady, mineruMockReady ? 'window.__gtSmokeMineru 可用（mineruApi 渲染层接缝）' : 'mineru mock 未建立')
    ok = ok && mineruMockReady
    if (!mineruMockReady) return finish(false)

    // 1) 注入 install_failed → 首启安装界面（00）取代首页：标题/失败说明/重试/跳过齐全，
    //    并有一个通俗中文 toast（不是唯一入口）
    await evalJs<void>(`window.__gtSmokeMineru.fire({
      state: 'install_failed', version: null, port: null, pid: null,
      error: 'MinerU 安装失败（下载模型文件）：uv run 退出码 1：错误: 请传入模型仓库名或 --tier。',
      installProgress: null, modelsPath: null, modelsReady: false
    })`)
    const firstRunOk = await waitFor(`(() => {
      const p = document.querySelector('[data-testid="first-run-page"]')
      if (!p) return false
      const t = p.textContent ?? ''
      const toast = document.querySelector('.toasts')?.textContent ?? ''
      return t.includes('正在安装解析组件（MinerU）') &&
        t.includes('MinerU 安装失败：下载模型文件时出错。') &&
        !t.includes('退出码 1') &&
        t.includes('Graphictero 首次启动会在本机安装 Python 和 MinerU，') &&
        t.includes('并下载模型文件（几 GB），只需一次。') &&
        !!p.querySelector('[data-testid="first-run-retry"]') &&
        !!p.querySelector('[data-testid="first-run-skip"]') &&
        toast.includes('MinerU 安装失败：下载模型文件时出错。')
    })()`, 10000)
    record('首启界面安装失败态', firstRunOk, firstRunOk ? '00 界面：失败说明（不含开发者原文）+ 重试 + 先跳过 + 通俗 toast' : '首启失败态渲染不全')
    ok = ok && firstRunOk

    // 2) 首启界面「重试」→ installMineru（mock 计数；真实主进程走 start() 到 ready）；
    //    随后注入 ready（uat1-fix1：成功终态是 ready = 可用，补排只经 ready 事件触发一次）
    await evalJs<void>(`document.querySelector('[data-testid="first-run-retry"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const mineruRetryOk = await waitFor(`window.__gtSmokeMineru.installCalls >= 1`)
    record('首启界面重试安装', mineruRetryOk, mineruRetryOk ? '重试按钮触发 installMineru（pdf:sidecarInstall → start()）' : '重试未发出 installMineru')
    ok = ok && mineruRetryOk
    await evalJs<void>(`window.__gtSmokeMineru.fire({
      state: 'ready', version: '4.0.12', port: 34567, pid: 123, error: null,
      installProgress: null, modelsPath: '/tmp/gt-smoke/venv', modelsReady: true
    })`)
    const backHome = await waitFor(`!document.querySelector('[data-testid="first-run-page"]') && document.body.innerText.includes('我的图谱')`)
    record('安装成功回首页', backHome, backHome ? '成功终态 ready（可用）后首启门自动放开；真实进程此际经 ready 事件补排一次（主进程单测覆盖）' : '到 ready 后仍卡在首启界面')
    ok = ok && backHome

    // 3) 再注入 install_failed → 首启门又出现（失败不能丢）→「先跳过，稍后再装」出口
    //    进首页（跳过只对本进程生效，失败态仍在状态点/设置页可见）
    await evalJs<void>(`window.__gtSmokeMineru.fire({
      state: 'install_failed', version: null, port: null, pid: null,
      error: 'MinerU 安装失败（安装依赖）：uv sync 退出码 1：Could not resolve',
      installProgress: null, modelsPath: null, modelsReady: false
    })`)
    const gateAgain = await waitFor(`!!document.querySelector('[data-testid="first-run-page"]')`)
    record('失败再进门', gateAgain, gateAgain ? 'install_failed 重新触发首启安装界面（不丢失败）' : '失败后首启门未再出现')
    ok = ok && gateAgain
    await evalJs<void>(`document.querySelector('[data-testid="first-run-skip"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const skippedHome = await waitFor(`!document.querySelector('[data-testid="first-run-page"]') && document.body.innerText.includes('我的图谱')`)
    record('首启跳过出口', skippedHome, skippedHome ? '「先跳过，稍后再装」可进首页（D95 照常不点红）' : '跳过出口无效')
    ok = ok && skippedHome

    // 4) 顶栏状态点错误色 + 弹层「环境」条目（D95：不伪造解析任务行；seed 的 Alpha
    //    失败任务也点红状态点，本步只断言 MinerU 专属条目出现）
    const dotRed = await waitFor(`!!document.querySelector('.stdot .dot.red')`)
    record('状态点错误色', dotRed, dotRed ? '错误色（含 MinerU 环境错误注入）' : '状态点未变红')
    ok = ok && dotRed
    await evalJs<void>(`document.querySelector('.stdot button[title="任务状态"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const envRow = await waitFor(`(() => {
      const row = document.querySelector('[data-testid="stpop-mineru-env"]')
      if (!row) return false
      const t = row.textContent ?? ''
      return t.includes('解析组件（MinerU）安装失败') && !!row.querySelector('button')
    })()`, 10000)
    record('弹层MinerU环境条目', envRow, envRow ? '「环境」组：解析组件（MinerU）安装失败 + 重试入口' : '弹层无 MinerU 环境条目')
    ok = ok && envRow
    await evalJs<void>(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
    await sleep(200)

    // 4) 设置页「PDF 解析」：失败标签 + 通俗原因 + 重试安装/重新安装都可用（不再禁用）
    await evalJs<boolean>(`__gt.clickText('button', '我的图谱')`)
    if (!(await waitFor(`document.body.innerText.includes('我的图谱') && [...document.querySelectorAll('button')].some((b) => (b.textContent ?? '').includes('新建图谱'))`))) {
      record('设置页MinerU失败态', false, '返回首页失败')
      return finish(false)
    }
    await evalJs<boolean>(`__gt.clickText('.sitem', '设置')`)
    if (!(await waitFor(`document.body.innerText.includes('数据与备份')`))) {
      record('设置页MinerU失败态', false, '设置页未打开')
      return finish(false)
    }
    await evalJs<boolean>(`__gt.clickText('.sitem', 'PDF 解析')`)
    const settingsFail = await waitFor(`(() => {
      if (!document.body.innerText.includes('安装失败')) return false
      const f = document.querySelector('[data-testid="mineru-install-failed"]')
      if (!f || !(f.textContent ?? '').includes('MinerU 安装失败：安装依赖时出错。')) return false
      const retry = document.querySelector('[data-testid="mineru-retry-install"]')
      const reinst = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('重新安装…'))
      return !!retry && !retry.disabled && !!reinst && !reinst.disabled
    })()`, 10000)
    record('设置页MinerU失败态', settingsFail, settingsFail ? '失败标签 + 通俗原因（安装依赖类）+ 重试安装/重新安装可用' : '设置页失败态渲染或按钮不可用')
    ok = ok && settingsFail
    // ===== uat1 lane/uat1 steps end =====

    // ===== uat1b lane/uat1 steps =====（uat1b 只在本段内追加步骤）
    // D144：MinerU 不可用可见性——经 __gtSmokeMineru 注入 stopped（真实 unavailable 是
    // smoke 占位态，不适用 D144）；waitingCount 走真实 pdf:waitingCount（smoke 库里有
    // 有 PDF 未处理的合成论文）。验证：弹层「解析组件不可用 · 影响 N 篇 · 去设置」→
    // 直达 设置 → PDF 解析 → 库行/节点「等待解析组件」标签 → ready 后消失。
    // uat1 段结尾在设置页 PDF 解析组：先返回再回画布。
    // 此时库里已有「冒烟图谱二」（空图，updated_at 更新，侧栏/卡片排在前面）。
    // clickText 的 includes('冒烟图谱') 会先点中它，空图没有 .react-flow__node，
    // 于是误报「返回画布失败」。与上面「重开冒烟图谱」同口径：等卡片出现后精确匹配。
    await evalJs<boolean>(`__gt.clickText('.sitem', '返回')`)
    if (!(await waitFor(`document.body.innerText.includes('我的图谱') && [...document.querySelectorAll('button')].some((b) => (b.textContent ?? '').includes('新建图谱'))`))) {
      record('D144弹层汇总行', false, '返回首页失败')
      return finish(false)
    }
    if (!(await waitFor(`[...document.querySelectorAll('.gcard .nm')].some((n) => (n.textContent ?? '').trim() === '冒烟图谱')`))) {
      record('D144弹层汇总行', false, '首页没有「冒烟图谱」卡片')
      return finish(false)
    }
    await evalJs<boolean>(`[...document.querySelectorAll('.gcard')].find((g) => ((g.querySelector('.nm')?.textContent ?? '').trim() === '冒烟图谱')).dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    if (!(await waitFor(`(document.querySelector('.ttl')?.textContent ?? '').trim() === '冒烟图谱' && __gt.nodeCount() >= 1`))) {
      const diag = await evalJs<string>(`JSON.stringify({ ttl: document.querySelector('.ttl')?.textContent ?? null, nodes: __gt.nodeCount() })`)
      record('D144弹层汇总行', false, `返回画布失败：${diag}`)
      return finish(false)
    }
    await evalJs<void>(`window.__gtSmokeMineru.fire({
      state: 'stopped', version: '4.0.12', port: null, pid: null, error: null,
      installProgress: null, modelsPath: '/tmp/gt-smoke/venv', modelsReady: true
    })`)
    const d144Dot = await waitFor(`!!document.querySelector('.stdot .dot.red')`)
    record('D144状态点已停止红色', d144Dot, d144Dot ? '已停止按错误色' : '状态点未变红')
    ok = ok && d144Dot
    await evalJs<void>(`document.querySelector('.stdot button[title="任务状态"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const d144Row = await waitFor(`(() => {
      const row = document.querySelector('[data-testid="stpop-mineru-waiting"]')
      if (!row) return false
      const t = row.textContent ?? ''
      const m = t.match(/影响 (\\d+) 篇/)
      return !!m && Number(m[1]) >= 1 && !!row.querySelector('button')
    })()`, 10000)
    record('D144弹层汇总行', d144Row, d144Row ? '「解析组件不可用 · 影响 N 篇（N≥1）· 去设置」+ 已停止错误行并存且不重复空态' : '汇总行缺失或 N 不对')
    ok = ok && d144Row

    // 「去设置」直达 设置 → PDF 解析（MineruSection 渲染即落在该组）
    await evalJs<void>(`document.querySelector('[data-testid="stpop-mineru-waiting"] button').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const d144Settings = await waitFor(`document.body.innerText.includes('解析环境') && document.body.innerText.includes('最近一次解析')`)
    record('D144去设置直达PDF解析', d144Settings, d144Settings ? '点击直达 设置 → PDF 解析组' : '未落到 PDF 解析组')
    ok = ok && d144Settings

    // 库行「等待解析组件」：设置页返回 → 画布侧栏「论文库 · 其他」里有 hasPdf 未处理论文
    await evalJs<boolean>(`__gt.clickText('.sitem', '返回')`)
    if (!(await waitFor(`!!document.querySelector('.react-flow__node')`))) {
      record('D144等待解析标签', false, '返回画布失败')
      return finish(false)
    }
    const d144RowTag = await waitFor(`!!document.querySelector('.sidepanel [data-testid="row-wait-parse"], [data-testid="row-wait-parse"]')`, 10000)
    record('D144库行等待解析标签', d144RowTag, d144RowTag ? '侧栏库行出现「等待解析组件」（原因在 tooltip）' : '库行无等待解析标签')
    ok = ok && d144RowTag

    // 节点标签：把带 PDF 的等待论文加进图谱 → 画布节点出现「等待解析组件」
    await evalJs<void>(`(() => {
      const row = [...document.querySelectorAll('.prow')].find((r) => r.querySelector('[data-testid="row-wait-parse"]'))
      row?.querySelector('.add')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })()`)
    const d144NodeTag = await waitFor(`!!document.querySelector('[data-testid="node-wait-parse"]')`, 10000)
    record('D144节点等待解析标签', d144NodeTag, d144NodeTag ? '节点元信息行出现「等待解析组件」' : '节点无等待解析标签')
    ok = ok && d144NodeTag

    // ready（MinerU 可用）：标签与汇总行消失、库行回到常规口径（渲染层经状态推送刷新）
    await evalJs<void>(`window.__gtSmokeMineru.fire({
      state: 'ready', version: '4.0.12', port: 34567, pid: 123, error: null,
      installProgress: null, modelsPath: '/tmp/gt-smoke/venv', modelsReady: true
    })`)
    const d144Gone = await waitFor(`!document.querySelector('[data-testid="node-wait-parse"]') && !document.querySelector('[data-testid="row-wait-parse"]')`, 10000)
    record('D144可用后标签消失', d144Gone, d144Gone ? 'ready 推送后等待解析标签消失（smoke 占位解析器不入队，UI 口径先收敛）' : 'ready 后标签仍在')
    ok = ok && d144Gone
    await evalJs<void>(`window.__gtSmokeMineru.fire({
      state: 'unavailable', version: null, port: null, pid: null, error: null,
      installProgress: null, modelsPath: null, modelsReady: false
    })`)
    // ===== uat1b lane/uat1 steps end =====

    // ===== uat4 lane/uat4 steps =====（uat4 只在本段内追加步骤）
    // 导出组：画布工具栏「更多」按钮 → 菜单「导出 Markdown…」→ 导出对话框出现。
    // uat1b 段结尾在画布页（节点已上画布）。
    await evalJs<void>(`document.querySelector('button[title="更多"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const exportMenuOpen = await waitFor(`!!document.querySelector('[data-testid="menu-export-md"]')`)
    record('导出菜单入口', exportMenuOpen, exportMenuOpen ? '「更多」按钮弹出菜单，含「导出 Markdown…」项' : '「更多」菜单未打开')
    ok = ok && exportMenuOpen
    if (!exportMenuOpen) return finish(false)
    await evalJs<void>(`document.querySelector('[data-testid="menu-export-md"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    const exportDialogOpen = await waitFor(`!!document.querySelector('[data-testid="export-dialog"]')`, 10000)
    record('导出对话框出现', exportDialogOpen, exportDialogOpen ? '点击菜单项后 export-dialog 渲染' : '导出对话框未出现')
    ok = ok && exportDialogOpen
    // 关闭弹窗收尾（避免影响后续断言）
    await evalJs<void>(`document.querySelector('[data-testid="export-close"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    await sleep(200)
    // ===== uat4 lane/uat4 steps end =====

    // ===== uat6 lane/uat6 steps =====（uat6 只在本段内追加步骤）
    // M1 冷启动画布 0 条边：整窗 reload（渲染进程冷启动）→ 从首页重开图谱 →
    // 画布 DOM 边数必须等于 getGraph 关系数（真实 Chromium 全链路，含 xyflow 测量路径）。
    // 根因修复见 lib/flowNodes.ts paperNodeDeclarative（边锚点不依赖异步测量）。
    win.webContents.reload()
    const homeUat6 = await waitFor(`document.body.innerText.includes('我的图谱')`)
    if (!homeUat6) {
      record('冷启动首次打开图谱边数=关系数', false, 'reload 后首页未恢复')
      return finish(false)
    }
    await evalJs<void>(PAGE_HELPERS) // reload 后需重新注入
    // 侧栏有「冒烟图谱」和「冒烟图谱二」两张图——精确匹配主图（子串会误点第二张空图）
    const clickMain = `(() => { const el = [...document.querySelectorAll('.sitem')].find((e) => (e.textContent ?? '').includes('冒烟图谱') && !(e.textContent ?? '').includes('二')); if (!el) return false; el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true })()`
    const clicked = await waitFor(clickMain, 10000)
    const graphBack = await waitFor(`(document.querySelector('.ttl')?.textContent ?? '').includes('冒烟图谱')`, 15000)
    if (!graphBack) {
      const diag = await evalJs<string>(`JSON.stringify({ clicked: ${clicked}, sitems: [...document.querySelectorAll('.sitem')].map((e) => e.textContent) })`)
      record('冷启动首次打开图谱边数=关系数', false, `重开图谱失败 ${diag}`)
      return finish(false)
    }
    // 节点/边就绪前可重开（防导航单击被侧栏重渲染吞掉；最多 3 次）
    for (let attempt = 0; attempt < 3; attempt++) {
      const up = await waitFor(`document.querySelectorAll('.react-flow__node').length >= 2`, 6000)
      if (up) break
      await evalJs<boolean>(clickMain)
      await sleep(500)
    }
    await sleep(1000) // 等首帧边渲染（声明式锚点下与节点同帧，留余量）
    const coldStartState = await evalJs<{ dom: number; rels: number; nodes: number; mem: number; ids: string; rf: boolean; toast: string; head: string; emptyc: boolean; side: string }>(`
      window.graphictero.getGraph(${graphId}).then((d) => ({
        dom: document.querySelectorAll('.react-flow__edge').length,
        rels: d.relations.length,
        nodes: document.querySelectorAll('.react-flow__node').length,
        mem: d.members.length,
        ids: d.relations.map((r) => r.srcPaper + '>' + (r.paperLow === r.srcPaper ? r.paperHigh : r.paperLow)).join(','),
        rf: !!document.querySelector('.react-flow'),
        toast: (document.querySelector('.toasts')?.textContent ?? '').slice(0, 100),
        head: [...document.querySelectorAll('.toolbar .t3')].map((e) => e.textContent).join('|'),
        emptyc: !!document.querySelector('.emptyc'),
        side: (document.querySelector('span.cap')?.textContent ?? '').slice(0, 40)
      }))
    `)
    const coldStartOk =
      coldStartState.dom === coldStartState.rels && coldStartState.rels > 0 && coldStartState.nodes >= 2
    record(
      '冷启动首次打开图谱边数=关系数',
      coldStartOk,
      `画布 ${coldStartState.dom} 条边 / 库内 ${coldStartState.rels} 条关系 / 节点 ${coldStartState.nodes} / 成员 ${coldStartState.mem}（${coldStartState.ids}）rf=${coldStartState.rf} toast=${coldStartState.toast} head=${coldStartState.head} emptyc=${coldStartState.emptyc} side=${coldStartState.side}`
    )
    ok = ok && coldStartOk
    // ===== uat6 lane/uat6 steps end =====

    // ===== uat7 lane/uat7 steps =====（D176–D181；全部使用本 smoke 隔离数据与可信输入）
    {
      const selectedCount = async (): Promise<number> => evalJs<number>(`document.querySelectorAll('.pnode.sel').length`)
      const memberCount = async (): Promise<number> => evalJs<number>(`window.graphictero.getGraph(${graphId}).then((d) => d.members.length)`)
      const memberRows = state.db.prepare(
        `SELECT p.id AS id, p.title AS title FROM graph_members m
         JOIN papers p ON p.id = m.paper_id
         WHERE m.graph_id = ? AND p.deleted_at IS NULL`
      ).all(graphId) as Array<{ id: number; title: string }>
      const alphaRow = memberRows.find((r) => r.title.includes('Alpha'))
      const betaRow = memberRows.find((r) => r.title.includes('Beta'))
      const otherRows = memberRows.filter((r) => r !== alphaRow && r !== betaRow)
      const ensureRel = (a: number, b: number): void => {
        const low = Math.min(a, b)
        const high = Math.max(a, b)
        const exists = state.db.prepare(
          'SELECT 1 FROM relations WHERE graph_id = ? AND paper_low = ? AND paper_high = ? AND deleted_at IS NULL'
        ).get(graphId, low, high)
        if (exists) return
        const t = new Date().toISOString()
        state.db.prepare(
          `INSERT INTO relations (graph_id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types,
             source_type, model, prompt_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'uat7 smoke edge', '["compares"]', '[]', 'session', 'deepseek-flash', 'uat7', ?, ?)`
        ).run(graphId, low, high, low, t, t)
      }
      // 子图与批量移除都要：Alpha–Beta 内部边，以及各自连到未选节点的边。
      if (alphaRow && betaRow && otherRows.length >= 2) {
        ensureRel(alphaRow.id, betaRow.id)
        ensureRel(alphaRow.id, otherRows[0].id)
        ensureRel(betaRow.id, otherRows[1].id)
      }
      await evalJs<void>(`window.dispatchEvent(new CustomEvent('gt:graph-changed'))`)
      await waitFor(`window.graphictero.getGraph(${graphId}).then((d) => d.relations.length >= 3 && d.members.some((m) => m.paper.title.includes('Alpha')) && d.members.some((m) => m.paper.title.includes('Beta')))`)

      // 1. 单击只选择，不开详情
      const singleSelected = (await singleClickNode('Alpha')) && (await waitFor(`document.querySelectorAll('.pnode.sel').length === 1 && !document.querySelector('[data-testid="paper-detail-page"]')`))
      record('单击节点只选择', singleSelected, singleSelected ? 'Alpha 强调色描边，路由仍在画布' : '单击未选中或误开详情')
      ok = ok && singleSelected

      // 2. 双击进详情，再返回画布
      const doubleOpened = (await doubleClickNode('Alpha')) && (await waitFor(`(() => { const page = document.querySelector('[data-testid="paper-detail-page"]'); return !!page && (page.querySelector('.ttl')?.textContent ?? '').includes('Alpha') })()`))
      const doubleBack = doubleOpened && (await backToGraph())
      record('双击节点进详情', doubleBack, doubleBack ? '双击打开 03 详情并返回；失败节点共用同一入口' : '双击未打开详情或返回失败')
      ok = ok && doubleBack

      // 3. ⌘/Shift 多选与切换（详情返回会重置选择，先重选 Alpha）
      await singleClickNode('Alpha')
      await singleClickNode('Beta', ['meta'])
      await singleClickNode('Gamma', ['shift'])
      const threeSelected = await waitFor(`document.querySelectorAll('.pnode.sel').length === 3`)
      await singleClickNode('Gamma', ['meta'])
      const twoAfterToggle = await waitFor(`document.querySelectorAll('.pnode.sel').length === 2`)
      record('⌘/Shift 多选', threeSelected && twoAfterToggle, `三选=${threeSelected} 切换后两选=${twoAfterToggle}`)
      ok = ok && threeSelected && twoAfterToggle

      // 4. Shift + 空白拖框框选 Alpha/Beta。起点必须落在 pane 空白上，否则变成节点拖动。
      const boxSpot = await evalJs<{ x: number; y: number; endX: number; endY: number } | null>(`(() => {
        const pane = document.querySelector('.react-flow__pane')
        if (!pane) return null
        const pr = pane.getBoundingClientRect()
        const nodes = [...document.querySelectorAll('.react-flow__node')].map((n) => n.getBoundingClientRect())
        const onNode = (x, y) => nodes.some((r) => x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2)
        let spot = null
        for (let y = pr.top + 10; y < pr.bottom - 10 && !spot; y += 16) {
          for (let x = pr.left + 10; x < pr.right - 10; x += 16) {
            const el = document.elementFromPoint(x, y)
            if (!el || !pane.contains(el) || el.closest('.react-flow__node') || onNode(x, y)) continue
            spot = { x, y }
            break
          }
        }
        if (!spot) return null
        return { x: spot.x, y: spot.y, endX: pr.right - 8, endY: pr.bottom - 8 }
      })()`)
      let boxOk = false
      if (boxSpot) {
        mouse('mouseDown', boxSpot.x, boxSpot.y)
        mouse('mouseUp', boxSpot.x, boxSpot.y)
        const cleared = await waitFor(`document.querySelectorAll('.pnode.sel').length === 0`)
        await drag({ x: boxSpot.x, y: boxSpot.y }, { x: boxSpot.endX, y: boxSpot.endY }, 12, ['shift'])
        boxOk = cleared && (await waitFor(`(() => {
          const sel = [...document.querySelectorAll('.react-flow__node')].filter((n) => n.querySelector('.pnode.sel'))
          const titles = sel.map((n) => n.textContent ?? '').join('\\n')
          return sel.length >= 2 && titles.includes('Alpha') && titles.includes('Beta')
        })()`))
      }
      record('框选', boxOk, boxOk ? 'Shift + 空白拖框选中 Alpha/Beta' : '框选未选中目标节点')
      ok = ok && boxOk

      // 5. Backspace 不删节点 / 关系成员；用实际 keydown 到达作同步点，不靠固定 sleep
      const beforeDelete = await memberCount()
      await evalJs<void>(`window.__uat7BackspaceSeen = false; window.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace') window.__uat7BackspaceSeen = true
      }, { once: true })`)
      key('Backspace')
      const backspaceArrived = await waitFor(`window.__uat7BackspaceSeen === true`)
      const afterDelete = await memberCount()
      const deleteSafe = backspaceArrived && beforeDelete === afterDelete && (await selectedCount()) >= 2
      record('Backspace 不删节点', deleteSafe, `成员 ${beforeDelete} → ${afterDelete}，选择=${await selectedCount()}（deleteKeyCode=null）`)
      ok = ok && deleteSafe

      // 6. 已选 Alpha/Beta 拖入对话：chips +2、位置回滚、不写库
      await evalJs<void>(`document.querySelector('.react-flow__pane').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      await singleClickNode('Alpha')
      await singleClickNode('Beta', ['meta'])
      await waitFor(`document.querySelectorAll('.pnode.sel').length === 2`)
      const chipPosBefore = await evalJs<Array<{ id: number; x: number; y: number }>>(`window.graphictero.getGraph(${graphId}).then((d) => d.members.filter((m) => ['Alpha','Beta'].some((s) => m.paper.title.includes(s))).map((m) => ({ id: m.paper.id, x: m.x, y: m.y })))`)
      await evalJs<void>(`document.querySelector('[data-testid="chat-toggle"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      await waitFor(`!!document.querySelector('[data-testid="chat-drawer"]')`)
      await evalJs<void>(`document.querySelector('[data-testid="chat-new-session"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      await waitFor(`!!document.querySelector('[data-testid="chat-input"]:not([disabled])')`)
      const chipsBefore = await evalJs<number>(`document.querySelectorAll('[data-testid="chat-chip"]').length`)
      const chipPoint = await pointOnNode('Alpha')
      // uat7b M3：拖入对话前后视口 transform 必须一致（autoPanOnNodeDrag=false，
      // 拖到抽屉上方不再把视口拖走约 2000px）。
      const vpBefore = await evalJs<string>(`document.querySelector('.react-flow__viewport')?.style.transform ?? ''`)
      const chipDrawerRect = await evalJs<SmokeRect | null>(`(() => { const r = document.querySelector('[data-testid="chat-drawer"]')?.getBoundingClientRect(); return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null })()`)
      if (chipPoint && chipDrawerRect) {
        await drag(
          chipPoint,
          { x: chipDrawerRect.left + chipDrawerRect.width / 2, y: chipDrawerRect.top + Math.min(300, chipDrawerRect.height / 2) },
          12
        )
      }
      const vpAfter = await evalJs<string>(`document.querySelector('.react-flow__viewport')?.style.transform ?? ''`)
      const vpSame = vpBefore === vpAfter && vpBefore !== ''
      const chipDropOk = vpSame && (await waitFor(`(async () => {
        const chips = [...document.querySelectorAll('[data-testid="chat-chip"]')]
        const titles = chips.map((c) => c.textContent ?? '').join('\\n')
        if (chips.length !== ${chipsBefore} + 2 || !titles.includes('Alpha') || !titles.includes('Beta')) return false
        const d = await window.graphictero.getGraph(${graphId})
        return ${JSON.stringify(chipPosBefore)}.every((p) => {
          const m = d.members.find((mm) => mm.paper.id === p.id)
          return m && Math.abs(m.x - p.x) < 0.01 && Math.abs(m.y - p.y) < 0.01
        })
      })()`, 12000))
      record('拖入对话作上下文', chipDropOk, chipDropOk ? '两个 paper chip 去重注入；两节点库坐标与拖前完全一致；视口未平移' : 'chip 数不对、拖放写动了节点位置或视口被拖走')
      ok = ok && chipDropOk

      // 6b. B3：未选中节点拖进同一抽屉。只加这一篇 chip，库坐标不变。
      // 点 pane 的合成 click 清不掉 xyflow 选择；先失焦再 Esc（无弹层时清选择）。
      await evalJs<void>(`document.activeElement instanceof HTMLElement && document.activeElement.blur()`)
      let selectionCleared = false
      for (let attempt = 0; attempt < 3 && !selectionCleared; attempt++) {
        await key('Escape')
        selectionCleared = await waitFor(`document.querySelectorAll('.pnode.sel').length === 0`, 1500)
      }
      const unselectedTitle = 'Gamma'
      const unselectedBefore = await evalJs<Array<{ id: number; x: number; y: number }>>(`window.graphictero.getGraph(${graphId}).then((d) => d.members.filter((m) => m.paper.title.includes(${JSON.stringify(unselectedTitle)})).map((m) => ({ id: m.paper.id, x: m.x, y: m.y })))`)
      const chipsAtUnselected = await evalJs<number>(`document.querySelectorAll('[data-testid="chat-chip"]').length`)
      const unselectedDropTarget = chipDrawerRect
        ? { x: chipDrawerRect.left + chipDrawerRect.width / 2, y: chipDrawerRect.top + Math.min(280, chipDrawerRect.height / 2) }
        : null
      let unselectedDropOk = false
      for (let attempt = 0; attempt < 3 && selectionCleared && unselectedDropTarget && !unselectedDropOk; attempt++) {
        const unselectedPoint = await pointOnNode(unselectedTitle)
        if (!unselectedPoint) break
        await drag(unselectedPoint, unselectedDropTarget, 12)
        unselectedDropOk = await waitFor(`(async () => {
          const chips = [...document.querySelectorAll('[data-testid="chat-chip"]')]
          const titles = chips.map((c) => c.textContent ?? '').join('\\n')
          if (chips.length !== ${chipsAtUnselected} + 1 || !titles.includes(${JSON.stringify(unselectedTitle)})) return false
          if (document.querySelectorAll('.pnode.sel').length !== 0) return false
          const d = await window.graphictero.getGraph(${graphId})
          return ${JSON.stringify(unselectedBefore)}.every((p) => {
            const m = d.members.find((mm) => mm.paper.id === p.id)
            return m && Math.abs(m.x - p.x) < 0.01 && Math.abs(m.y - p.y) < 0.01
          })
        })()`, 4000)
      }
      const unselectedDiag = unselectedDropOk
        ? '只增加 Gamma 一个 chip，坐标未写库，选择数保持 0'
        : await evalJs<string>(`JSON.stringify({ sel: document.querySelectorAll('.pnode.sel').length, chips: document.querySelectorAll('[data-testid="chat-chip"]').length, gamma: !!window.__gt.nodeRect(${JSON.stringify(unselectedTitle)}), cleared: ${selectionCleared} })`)
      record('未选中节点拖入对话', unselectedDropOk, unselectedDiag)
      ok = ok && unselectedDropOk

      // 7. 多选右键进入子图。拖进抽屉会把镜头推走，节点可能被抽屉盖住；先收起并 fitView。
      if (await evalJs<boolean>(`!!document.querySelector('[data-testid="chat-drawer"]')`)) {
        await evalJs<void>(`document.querySelector('[data-testid="chat-collapse"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
        await waitFor(`!document.querySelector('[data-testid="chat-drawer"]')`)
      }
      await evalJs<void>(`document.querySelector('.react-flow__controls-fitview')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      await waitFor(`__gt.stillNodeRects('Alpha', 'Beta')`)
      if (!(await waitFor(`document.querySelectorAll('.pnode.sel').length === 2`, 800))) {
        await singleClickNode('Alpha')
        await singleClickNode('Beta', ['meta'])
        await waitFor(`document.querySelectorAll('.pnode.sel').length === 2`)
      }
      await contextClickNode('Alpha')
      const subMenu = await waitFor(`!!document.querySelector('[data-testid="selection-menu"] [data-testid="menu-subgraph"]')`)
      await evalJs<boolean>(`__gt.clickText('[data-testid="menu-subgraph"]', '查看所选子图')`)
      const subOk = await waitFor(`(() => {
        if (!document.querySelector('[data-testid="subgraph-banner"]')) return false
        const dim = [...document.querySelectorAll('.react-flow__node.gt-sub-dim')]
        const hi = [...document.querySelectorAll('.react-flow__node.gt-sub-hi')]
        return dim.length > 0 && hi.length === 2 && dim.every((n) => Number(getComputedStyle(n).opacity) < 0.3) &&
          hi.every((n) => Number(getComputedStyle(n).opacity) === 1) &&
          document.querySelectorAll('.react-flow__edge.gt-sub-hi').length > 0 && document.querySelectorAll('.react-flow__edge.gt-sub-dim').length > 0
      })()`)
      const subDetail = subMenu && subOk
        ? '已选节点/内部边高亮；非选节点 <0.3，单端边淡化'
        : await evalJs<string>(`JSON.stringify({ menu: !!document.querySelector('[data-testid="selection-menu"]'), banner: !!document.querySelector('[data-testid="subgraph-banner"]'), hi: document.querySelectorAll('.react-flow__node.gt-sub-hi').length, dim: document.querySelectorAll('.react-flow__node.gt-sub-dim').length, edgeHi: document.querySelectorAll('.react-flow__edge.gt-sub-hi').length, edgeDim: document.querySelectorAll('.react-flow__edge.gt-sub-dim').length, sel: document.querySelectorAll('.pnode.sel').length })`).catch(() => '子图高亮集合或横幅不对')
      record('右键进子图视图', subMenu && subOk, subDetail)
      ok = ok && subMenu && subOk

      // uat7b M1：子图里双击**暗化**节点不离开图谱页（handler 守卫，不靠 CSS）。
      await doubleClickNode('Gamma')
      const dimNoDetail = await waitFor(`!!document.querySelector('[data-testid="subgraph-banner"]') && !document.querySelector('[data-testid="paper-detail-page"]')`)
      record('子图暗化节点双击忽略', dimNoDetail, dimNoDetail ? '双击 Gamma（暗化）仍在子图，未开详情' : '暗化节点双击误开详情或子图丢失')
      ok = ok && dimNoDetail

      // uat7b M1：子图里双击已选节点进详情，返回后子图与选择恢复。
      await doubleClickNode('Alpha')
      const detailOpened = await waitFor(`!!document.querySelector('[data-testid="paper-detail-page"]')`)
      const backOk = detailOpened && (await backToGraph())
      const restored = backOk && (await waitFor(`!!document.querySelector('[data-testid="subgraph-banner"]') && document.querySelectorAll('.pnode.sel').length === 2`))
      record('子图详情往返恢复', detailOpened && restored, detailOpened && restored ? '返回后 banner 与 2 个选中节点恢复' : '详情未打开或返回后子图/选择未恢复')
      ok = ok && detailOpened && restored
      // D184-②：子图里选中描边（.pnode.sel 强调色圈）始终可见。
      const selRing = await evalJs<boolean>(`(() => {
        const ring = [...document.querySelectorAll('.react-flow__node.gt-sub-hi .pnode.sel')]
        return ring.length === 2 && ring.every((el) => { const s = getComputedStyle(el).boxShadow; return s && s !== 'none' })
      })()`)
      record('子图选中描边可见', selRing, selRing ? '2 个高亮已选节点 box-shadow 描边在' : '子图里选中描边不可见')
      ok = ok && selRing

      // 8. Esc 先退子图保留选择，再 Esc 清空
      await key('Escape')
      const escSub = await waitFor(`!document.querySelector('[data-testid="subgraph-banner"]') && document.querySelectorAll('.pnode.sel').length === 2 && !document.querySelector('.gt-sub-dim')`)
      record('Esc 退出子图', escSub, escSub ? '横幅消失、透明度恢复、选择仍是 2 个' : 'Esc 未退出子图或选择被清掉')
      ok = ok && escSub
      await key('Escape')
      const escSelection = await waitFor(`document.querySelectorAll('.pnode.sel').length === 0`)
      record('Esc 清空选择', escSelection, escSelection ? '再按 Esc 后选择清空' : '选择未被清空')
      ok = ok && escSelection

      // 9. Esc 先关弹层；输入框 Esc 不动选择。子图步收起了抽屉，菜单点在画布上，再打开抽屉测输入框。
      await evalJs<void>(`document.querySelector('.react-flow__controls-fitview')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      await waitFor(`__gt.stillNodeRects('Alpha')`)
      await singleClickNode('Alpha')
      await contextClickNode('Alpha')
      await waitFor(`!!document.querySelector('[data-testid="paper-menu"]')`)
      await key('Escape')
      const escMenu = await waitFor(`!document.querySelector('[data-testid="paper-menu"]') && document.querySelectorAll('.pnode.sel').length === 1`)
      if (!(await evalJs<boolean>(`!!document.querySelector('[data-testid="chat-input"]')`))) {
        await evalJs<void>(`document.querySelector('[data-testid="chat-toggle"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
        await waitFor(`!!document.querySelector('[data-testid="chat-input"]')`)
      }
      await evalJs<void>(`document.querySelector('[data-testid="chat-input"]')?.focus()`)
      await key('Escape')
      const escInput = await evalJs<boolean>(`document.querySelectorAll('.pnode.sel').length === 1`)
      record('Esc 先关弹层', escMenu && escInput, `菜单层=${escMenu} 输入层=${escInput}`)
      ok = ok && escMenu && escInput
      await evalJs<void>(`document.activeElement instanceof HTMLElement && document.activeElement.blur()`)

      // uat7b D184：子图 + 对话输入框有草稿——Esc① 只 blur 留草稿，Esc② 退子图留选择，Esc③ 清空。
      await evalJs<void>(`document.querySelector('.react-flow__controls-fitview')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      await waitFor(`__gt.stillNodeRects('Alpha')`)
      await singleClickNode('Alpha')
      await singleClickNode('Beta', ['meta'])
      await waitFor(`document.querySelectorAll('.pnode.sel').length === 2`)
      await contextClickNode('Alpha')
      await evalJs<boolean>(`__gt.clickText('[data-testid="menu-subgraph"]', '查看所选子图')`)
      await waitFor(`!!document.querySelector('[data-testid="subgraph-banner"]')`)
      if (!(await evalJs<boolean>(`!!document.querySelector('[data-testid="chat-input"]')`).catch(() => false))) {
        if (!(await evalJs<boolean>(`!!document.querySelector('[data-testid="chat-drawer"]')`))) {
          await evalJs<void>(`document.querySelector('[data-testid="chat-toggle"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
          await waitFor(`!!document.querySelector('[data-testid="chat-drawer"]')`)
        }
      }
      const d184Draft = 'uat7b 草稿'
      await evalJs<boolean>(`__gt.setInput('[data-testid="chat-input"]', ${JSON.stringify(d184Draft)})`)
      // uat7b-fix1 S-b / uat8b：焦点偶发不在输入框时，第一下真实 Esc 会被层级处理器吃掉
      // （关菜单或不动草稿），后两下仍能退子图、清选择。只在横幅和 2 个选中都还在时
      // 重新写入草稿、聚焦再发 Esc。横幅已经没了就停，避免把退子图误记成这一步。
      let escBlur = false
      let blurDiag = ''
      for (let attempt = 0; attempt < 3 && !escBlur; attempt++) {
        const ready = await waitFor(`(() => {
          const input = document.querySelector('[data-testid="chat-input"]')
          if (!(input instanceof HTMLTextAreaElement)) return false
          if (input.value !== ${JSON.stringify(d184Draft)}) {
            const desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
            desc.set.call(input, ${JSON.stringify(d184Draft)})
            input.dispatchEvent(new Event('input', { bubbles: true }))
          }
          if (document.activeElement !== input) input.focus()
          return document.activeElement === input && input.value === ${JSON.stringify(d184Draft)} &&
            !!document.querySelector('[data-testid="subgraph-banner"]') &&
            document.querySelectorAll('.pnode.sel').length === 2
        })()`, 4000)
        if (!ready) {
          blurDiag = await evalJs<string>(`JSON.stringify({ ready: false, attempt: ${attempt}, active: document.activeElement && (document.activeElement.getAttribute('data-testid') || document.activeElement.tagName), value: document.querySelector('[data-testid="chat-input"]')?.value ?? null, banner: !!document.querySelector('[data-testid="subgraph-banner"]'), sel: document.querySelectorAll('.pnode.sel').length })`)
          break
        }
        await key('Escape')
        escBlur = await waitFor(`(() => {
          const input = document.querySelector('[data-testid="chat-input"]')
          return !!input && document.activeElement !== input && input.value === ${JSON.stringify(d184Draft)} &&
            !!document.querySelector('[data-testid="subgraph-banner"]') &&
            document.querySelectorAll('.pnode.sel').length === 2
        })()`, 4000)
        if (!escBlur) {
          blurDiag = await evalJs<string>(`JSON.stringify({ ready: true, attempt: ${attempt}, active: document.activeElement && (document.activeElement.getAttribute('data-testid') || document.activeElement.tagName), value: document.querySelector('[data-testid="chat-input"]')?.value ?? null, banner: !!document.querySelector('[data-testid="subgraph-banner"]'), sel: document.querySelectorAll('.pnode.sel').length })`)
          const stillLayered = await evalJs<boolean>(`!!document.querySelector('[data-testid="subgraph-banner"]') && document.querySelectorAll('.pnode.sel').length === 2`)
          if (!stillLayered) break
        }
      }
      await key('Escape')
      const escExitSub = await waitFor(`!document.querySelector('[data-testid="subgraph-banner"]') && document.querySelectorAll('.pnode.sel').length === 2`)
      await key('Escape')
      const escClearSel = await waitFor(`document.querySelectorAll('.pnode.sel').length === 0`)
      const d184Ok = escBlur && escExitSub && escClearSel
      record(
        '子图输入框 Esc 分层',
        d184Ok,
        d184Ok
          ? `blur留草稿=${escBlur} 退子图=${escExitSub} 清选择=${escClearSel}`
          : `blur留草稿=${escBlur} 退子图=${escExitSub} 清选择=${escClearSel} ${blurDiag}`
      )
      ok = ok && d184Ok
      // D184-②：子图里点空白不清选择。先收抽屉（避免遮挡节点点击），每步断言。
      if (await evalJs<boolean>(`!!document.querySelector('[data-testid="chat-drawer"]')`)) {
        await evalJs<void>(`document.querySelector('[data-testid="chat-collapse"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
        await waitFor(`!document.querySelector('[data-testid="chat-drawer"]')`)
      }
      await evalJs<void>(`document.querySelector('.react-flow__controls-fitview')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      await waitFor(`__gt.stillNodeRects('Alpha')`)
      await singleClickNode('Alpha')
      await singleClickNode('Beta', ['meta'])
      const d184twoSel = await waitFor(`document.querySelectorAll('.pnode.sel').length === 2`)
      await contextClickNode('Alpha')
      const d184menu = await waitFor(`!!document.querySelector('[data-testid="selection-menu"] [data-testid="menu-subgraph"]')`)
      await evalJs<boolean>(`__gt.clickText('[data-testid="menu-subgraph"]', '查看所选子图')`)
      const d184subBack = await waitFor(`!!document.querySelector('[data-testid="subgraph-banner"]')`)
      await evalJs<void>(`document.querySelector('.react-flow__pane').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      const paneKeepsSel = await waitFor(`document.querySelectorAll('.pnode.sel').length === 2 && !!document.querySelector('[data-testid="subgraph-banner"]')`)
      record('子图点空白不清选择', d184twoSel && d184menu && d184subBack && paneKeepsSel,
        `选2=${d184twoSel} 菜单=${d184menu} 子图=${d184subBack} 点空白保留=${paneKeepsSel}`)
      ok = ok && paneKeepsSel
      await key('Escape')
      await key('Escape')
      await waitFor(`document.querySelectorAll('.pnode.sel').length === 0`)
      if (await evalJs<boolean>(`!!document.querySelector('[data-testid="chat-drawer"]')`)) {
        await evalJs<void>(`document.querySelector('[data-testid="chat-collapse"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
        await waitFor(`!document.querySelector('[data-testid="chat-drawer"]')`)
      }
      await evalJs<void>(`document.activeElement instanceof HTMLElement && document.activeElement.blur()`)
      // 10. 选择 / 子图 / 拖入对话均不进撤销栈
      const undoBefore = await evalJs<{ members: number; relations: number }>(`window.graphictero.getGraph(${graphId}).then((d) => ({ members: d.members.length, relations: d.relations.length }))`)
      await key('z', ['meta'])
      const undoToast = await waitFor(`(document.querySelector('.toasts')?.textContent ?? '').includes('没有可撤销的操作')`)
      const undoAfter = await evalJs<{ members: number; relations: number }>(`window.graphictero.getGraph(${graphId}).then((d) => ({ members: d.members.length, relations: d.relations.length }))`)
      const noViewUndo = undoToast && JSON.stringify(undoBefore) === JSON.stringify(undoAfter)
      let noViewUndoDetail = '⌘Z 提示无可撤销；节点与边均未变化'
      if (!noViewUndo) {
        const undoDiag = await evalJs<string>(`(async () => {
          const d = await window.graphictero.getGraph(${graphId})
          return JSON.stringify({
            toast: (document.querySelector('.toasts')?.textContent ?? '').slice(0, 200),
            dataBefore: ${JSON.stringify(undoBefore)},
            dataAfter: { members: d.members.length, relations: d.relations.length }
          })
        })()`).catch((e: unknown) => `诊断eval失败:${e instanceof Error ? e.message : String(e)}`)
        noViewUndoDetail = `toast=${undoToast} 数据未变=${JSON.stringify(undoBefore) === JSON.stringify(undoAfter)} ${undoDiag}`
      }
      record('选择不进撤销栈', noViewUndo, noViewUndoDetail)
      ok = ok && noViewUndo

      // 11. + 弹层长标题在默认宽与最窄抽屉都不越界。先收起再打开，让论文库重新拉取刚插入的长标题。
      const longTitle = `UAT7 Long Title ${'x'.repeat(150)}`
      const longNow = new Date().toISOString()
      state.db.prepare("INSERT INTO papers (title, source, has_pdf, first_author, year, created_at, updated_at) VALUES (?, 'zotero', 0, 'UAT7', 2026, ?, ?)").run(longTitle, longNow, longNow)
      if (await evalJs<boolean>(`!!document.querySelector('[data-testid="chat-drawer"]')`)) {
        await evalJs<void>(`document.querySelector('[data-testid="chat-collapse"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
        await waitFor(`!document.querySelector('[data-testid="chat-drawer"]')`)
      }
      await evalJs<void>(`document.querySelector('[data-testid="chat-toggle"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      await waitFor(`!!document.querySelector('[data-testid="chat-drawer"]')`)
      await evalJs<void>(`document.querySelector('[data-testid="chat-at"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      const atMenuCode = `(() => {
        const drawerEl = document.querySelector('[data-testid="chat-drawer"]')
        const menuEl = document.querySelector('[data-testid="chat-at-menu"]')
        const item = [...document.querySelectorAll('[data-testid="chat-at-item"] .gt-sess-item-name')].find((el) => el.getAttribute('title') === ${JSON.stringify(longTitle)})
        if (!drawerEl || !menuEl || !item) return false
        const row = item.closest('[data-testid="chat-at-item"]')
        const drawer = drawerEl.getBoundingClientRect()
        const inside = (el) => {
          const r = el.getBoundingClientRect()
          return r.left >= drawer.left && r.right <= drawer.right && r.top >= drawer.top && r.bottom <= drawer.bottom
        }
        const style = getComputedStyle(item)
        return ${JSON.stringify(longTitle)}.length >= 150 && inside(menuEl) && inside(row) && inside(item) &&
          item.scrollWidth > item.clientWidth && style.textOverflow === 'ellipsis' && style.whiteSpace === 'nowrap' &&
          menuEl.scrollWidth <= menuEl.clientWidth
      })()`
      const atDefault = await waitFor(atMenuCode)
      const rz = await evalJs<SmokeRect | null>(`(() => { const r = document.querySelector('[data-testid="chat-rz"]').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height } })()`)
      if (rz) await drag({ x: rz.left + rz.width / 2, y: rz.top + 100 }, { x: rz.left + 1000, y: rz.top + 100 }, 8)
      await waitFor(`document.querySelector('[data-testid="chat-drawer"]').getBoundingClientRect().width <= 301`)
      // 拖宽度会点到抽屉外，+ 弹层被点外关闭；收窄后再打开测一次。
      if (!(await evalJs<boolean>(`!!document.querySelector('[data-testid="chat-at-menu"]')`))) {
        await evalJs<void>(`document.querySelector('[data-testid="chat-at"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      }
      const atNarrow = await waitFor(atMenuCode)
      record('+ 弹层长标题不越界', atDefault && atNarrow, `默认宽=${atDefault} 最窄 300px=${atNarrow}（menu/item/name 均在抽屉内、ellipsis、完整 title）`)
      ok = ok && atDefault && atNarrow

      // 12. 画布 / 对话（产生 mock 费用）/ 导出 / 状态弹层 / 详情 / 库 / 非用量设置均无金额
      await evalJs<boolean>(`__gt.setInput('[data-testid="chat-input"]', 'uat7 mock fee')`)
      await evalJs<void>(`document.querySelector('[data-testid="chat-send"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      await waitFor(`document.querySelectorAll('[data-testid="chat-msg-ai"]').length > 0 && !document.querySelector('[data-testid="chat-stop"]')`)
      const chatFree = await evalJs<boolean>(`!(document.querySelector('[data-testid="chat-drawer"]')?.textContent ?? '').includes('¥')`)
      await evalJs<void>(`document.querySelector('[data-testid="chat-collapse"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      await waitFor(`!document.querySelector('[data-testid="chat-drawer"]')`)
      const canvasFree = await evalJs<boolean>(`!document.body.innerText.includes('¥')`)
      await evalJs<void>(`document.querySelector('button[title="更多"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      await waitFor(`!!document.querySelector('[data-testid="menu-export-md"]')`)
      await evalJs<void>(`document.querySelector('[data-testid="menu-export-md"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      const exportDialogUp = await waitFor(`!!document.querySelector('[data-testid="export-dialog"]')`)
      if (exportDialogUp) await evalJs<void>(`document.querySelector('[data-testid="export-opt-overview"] input').click()`)
      const exportFree = exportDialogUp && (await waitFor(`!!document.querySelector('[data-testid="export-dialog"]') && !(document.querySelector('[data-testid="export-dialog"]').textContent ?? '').includes('¥') && (document.querySelector('[data-testid="export-opt-overview"]').textContent ?? '').length > 0`))
      await evalJs<void>(`document.querySelector('[data-testid="export-close"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      await waitFor(`!document.querySelector('[data-testid="export-dialog"]')`)
      await evalJs<void>(`document.querySelector('.stdot button[title="任务状态"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      const statusFree = await waitFor(`!!document.querySelector('.stpop') && !document.body.innerText.includes('¥')`)
      await key('Escape')
      await evalJs<void>(`document.querySelector('.react-flow__controls-fitview')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      await waitFor(`__gt.stillNodeRects('Alpha')`)
      await doubleClickNode('Alpha')
      const detailFree = await waitFor(`!!document.querySelector('[data-testid="paper-detail-page"]') && (document.querySelector('[data-testid="paper-detail-page"] .ttl')?.textContent ?? '').includes('Alpha') && !document.body.innerText.includes('¥')`)
      const detailFreeInfo = detailFree
        ? ''
        : await evalJs<string>(`(() => {
            const page = document.querySelector('[data-testid="paper-detail-page"]')
            const t = document.body.innerText || ''
            const i = t.indexOf('¥')
            const yen = i < 0 ? '' : t.slice(Math.max(0, i - 24), i + 24).replace(/\\s+/g, ' ')
            return 'page=' + !!page + ' ttl=' + (page?.querySelector('.ttl')?.textContent ?? '') + ' yen=' + yen
          })()`)
      await backToGraph()
      await evalJs<boolean>(`__gt.clickText('.toolbar button', '我的图谱')`)
      const libraryFree = await waitFor(`document.body.innerText.includes('论文库') && !document.body.innerText.includes('¥')`)
      const homeNav = await evalJs<boolean>(`(() => {
        const text = (sel) => document.querySelector(sel)?.textContent ?? ''
        const caps = [...document.querySelectorAll('.sidebar .shead .cap')].map((e) => (e.textContent ?? '').trim())
        const foot = document.querySelector('.sidebar .zfoot')?.textContent ?? ''
        const bar = document.querySelector('.toolbar')
        const title = [...(bar?.children ?? [])].find((el) => (el.textContent ?? '').includes('Graphictero'))
        const dot = bar?.querySelector('button[title="任务状态"]')
        const field = bar?.querySelector('.field')
        const dotAfterTitle = !!(title && dot && (title.compareDocumentPosition(dot) & Node.DOCUMENT_POSITION_FOLLOWING))
        const searchAfterDot = !!(dot && field && (dot.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING))
        return text('[data-testid="home-nav-all"]').includes('全部图谱') &&
          text('[data-testid="home-nav-recent"]').includes('最近打开') &&
          text('[data-testid="home-nav-library"]').includes('论文库') &&
          !caps.includes('论文库') &&
          foot.includes('论文库') && foot.includes('篇') &&
          dotAfterTitle && searchAfterDot
      })()`)
      record('首页侧栏三项', homeNav, homeNav ? '全部图谱 / 最近打开 / 论文库，无重复标题，状态点在搜索前' : '侧栏三项或论文库去重不符')
      ok = ok && homeNav
      // 从首页再回画布后开设置，使下一步「返回」回到画布而不是首页。
      await evalJs<void>(`[...document.querySelectorAll('.gcard')].find((g) => ((g.querySelector('.nm')?.textContent ?? '').trim() === '冒烟图谱'))?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      await waitFor(`(document.querySelector('.ttl')?.textContent ?? '').trim() === '冒烟图谱' && !!document.querySelector('.react-flow__node')`)
      await evalJs<void>(`document.querySelector('.toolbar button[title="设置"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      const generalFree = await waitFor(`!!document.querySelector('[data-testid="open-usage"]') && !document.body.innerText.includes('¥')`)
      record('设置外无金额', chatFree && canvasFree && exportFree && statusFree && detailFree && libraryFree && generalFree,
        `对话=${chatFree} 画布=${canvasFree} 导出=${exportFree} 状态=${statusFree} 详情=${detailFree}${detailFreeInfo ? ` ${detailFreeInfo}` : ''} 库=${libraryFree} 语言模型=${generalFree}`)
      ok = ok && chatFree && canvasFree && exportFree && statusFree && detailFree && libraryFree && generalFree

      // 13. D180：临时库插入 3 天 × 6 来源（含 088 reasoning_tokens），真实 usage:series IPC。
      const uatUsageInsert = state.db.prepare(
        `INSERT INTO usage_records (occurred_at, category, model, input_tokens, cache_hit_tokens, cache_miss_tokens,
           output_tokens, cost_cny, thinking, reasoning_tokens) VALUES (?, ?, 'deepseek-flash', ?, 100, ?, ?, ?, 1, ?)`
      )
      const uatUsageCategories = ['chat', 'detail', 'relation', 'card', 'web', 'overview'] as const
      uatUsageCategories.forEach((category, i) => {
        const at = new Date()
        at.setDate(at.getDate() - (i % 3))
        const input = 1000 + i * 100
        uatUsageInsert.run(at.toISOString(), category, input, input - 100, 200 + i * 10, 0.01 * (i + 1), 11 * (i + 1))
      })
      const groupOrder = await evalJs<boolean>(`(() => {
        const a = [...document.querySelectorAll('.sidebar .sitem')].map((e) => (e.textContent ?? '').trim())
        const want = ['返回', '语言模型', '用量与费用', '导入来源', 'PDF 来源', 'PDF 解析', '数据与备份', '外观']
        const page = document.querySelector('.setmain')?.textContent ?? ''
        return a.join('|') === want.join('|') && !a.includes('通用') &&
          a.indexOf('用量与费用') === a.indexOf('语言模型') + 1 &&
          page.includes('服务商') && page.includes('模型') && page.includes('API Key') &&
          !!document.querySelector('[data-testid="open-usage"]')
      })()`)
      await evalJs<void>(`document.querySelector('[data-testid="open-usage"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      await waitFor(`!!document.querySelector('[data-testid="usage-section"]')`)
      await evalJs<void>(`document.querySelector('[data-testid="usage-range-7d"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      const usageSources = await waitFor(`(async () => {
        const s = await window.graphictero.getUsageSeries({ range: '7d', month: undefined })
        const text = document.querySelector('[data-testid="usage-section"]')?.textContent ?? ''
        return s.days.length === 7 && s.reasoningKnown &&
          ['chat', 'detail', 'relation', 'card', 'web', 'overview'].every((c) => s.totals[c].calls >= 1) &&
          ['Agent 对话','联网搜索 / 抓取','详情生成','关系生成','名片','导出概览'].every((t) => text.includes(t)) &&
          !!document.querySelector('[data-testid="usage-timeseries"] svg') && !!document.querySelector('[data-testid="usage-donut"] svg')
      })()`)
      record('设置用量按来源', groupOrder && usageSources, `顺序=${groupOrder} 3天×6来源/推理/双图表=${usageSources}`)
      ok = ok && groupOrder && usageSources

      // 13b. D185/D193：按会话汇总跟随当前 7 天范围。无 session_id 的第 13 步记录并入后台行。
      const sessionGraph = Number(state.db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('用量图谱', new Date().toISOString(), new Date().toISOString()).lastInsertRowid)
      const sessionNow = new Date().toISOString()
      const priceyId = Number(state.db.prepare("INSERT INTO sessions (graph_id, entry_type, entry_id, name, created_at, updated_at) VALUES (?, 'graph', NULL, '最贵会话', ?, ?)").run(sessionGraph, sessionNow, sessionNow).lastInsertRowid)
      state.db.prepare(
        `INSERT INTO usage_records (occurred_at, category, session_id, model, input_tokens, cache_hit_tokens, cache_miss_tokens, output_tokens, cost_cny, thinking, reasoning_tokens)
         VALUES (?, 'chat', ?, 'deepseek-flash', 10, 0, 10, 5, 88.88, 1, NULL)`
      ).run(sessionNow, priceyId)
      const sessionRollup = await waitFor(`(async () => {
        const rows = await window.graphictero.getUsageBySession({ range: '7d' })
        const block = document.querySelector('[data-testid="usage-by-session"]')
        const dom = [...(block?.querySelectorAll('[data-testid="usage-session-row"]') ?? [])]
        const first = rows[0]
        const text = dom[0]?.textContent ?? ''
        return !!first && first.title === '最贵会话' && first.graphName === '用量图谱' &&
          Math.abs(first.costCny - 88.88) < 1e-9 && rows.some((r) => r.kind === 'background') &&
          rows.length >= 2 && dom.length === Math.min(rows.length, 10) &&
          text.includes('最贵会话') && text.includes('¥88.88') && text.includes('用量图谱')
      })()`, 12000)
      record('用量按会话', sessionRollup, sessionRollup ? '首行最贵会话 ¥88.88，行数与 fixture 一致' : '按会话区块与 fixture 不一致')
      ok = ok && sessionRollup

      const periodRecent = await waitFor(`(() => {
        const text = document.querySelector('[data-testid="usage-section"]')?.textContent ?? ''
        return !!document.querySelector('[data-testid="usage-by-period"]') &&
          !!document.querySelector('[data-testid="usage-recent"]') &&
          text.includes('按时段') && text.includes('最近调用')
      })()`)
      record('用量按时段与最近调用', periodRecent, periodRecent ? '按时段 / 最近调用都在' : '用量页缺按时段或最近调用')
      ok = ok && periodRecent
      await evalJs<boolean>(`__gt.clickText('.sitem', '导入来源')`)
      const importPage = await waitFor(`(() => {
        const text = document.body.innerText
        return text.includes('Zotero') && text.includes('单向导入') && text.includes('OpenAlex API Key') && text.includes('localhost:23119')
      })()`)
      record('导入来源展示', importPage, importPage ? 'Zotero 与 OpenAlex API Key' : '导入来源页缺 Zotero 或 OpenAlex')
      ok = ok && importPage
      await evalJs<boolean>(`__gt.clickText('.sitem', '外观')`)
      await waitFor(`!!document.querySelector('[data-testid="theme-dark"]')`)
      await evalJs<void>(`document.querySelector('[data-testid="theme-dark"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      const darkOn = await waitFor(`document.documentElement.dataset.theme === 'dark'`)
      await evalJs<void>(`document.querySelector('[data-testid="theme-light"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      const lightOn = await waitFor(`document.documentElement.getAttribute('data-theme') == null`)
      const themeOk = darkOn && lightOn
      record('外观主题切换', themeOk, themeOk ? '深色 data-theme=dark 后切回浅色' : '深色=' + darkOn + ' 浅色=' + lightOn)
      ok = ok && themeOk

      // uat9 D194①：再设深色后整窗 reload = 新 renderer 冷启动。窗口首帧底色与
      // preload 写入的 data-theme 都必须是 dark；恢复原偏好后重开图谱继续后续步。
      await evalJs<void>(`(async () => { await window.graphictero.setTheme('dark') })()`)
      await waitFor(`document.documentElement.dataset.theme === 'dark'`)
      const darkWindowBg = win.getBackgroundColor().toUpperCase() === '#1C1C1E'
      win.webContents.reload()
      const themeRestart = await waitFor(`(async () => {
        const view = await window.graphictero.getTheme()
        return view.pref === 'dark' && view.resolved === 'dark' &&
          document.documentElement.dataset.theme === 'dark' &&
          getComputedStyle(document.body).backgroundColor === 'rgb(28, 28, 30)'
      })()`)
      const restartBg = win.getBackgroundColor().toUpperCase() === '#1C1C1E'
      await evalJs<void>(`(async () => { await window.graphictero.setTheme('light') })()`)
      const restartLight = await waitFor(`document.documentElement.getAttribute('data-theme') == null`)
      const themeRestartOk = darkWindowBg && restartBg && themeRestart && restartLight
      record('主题重启保持', themeRestartOk,
        themeRestartOk ? 'reload 后 data-theme=dark，窗口与 body 首帧底色均为深色；已恢复 light' : `窗口前=${darkWindowBg} 窗口后=${restartBg} renderer=${themeRestart} 恢复=${restartLight}`)
      ok = ok && themeRestartOk

      await evalJs<void>(PAGE_HELPERS)
      await waitFor(`[...document.querySelectorAll('.sitem')].some((e) => (e.textContent ?? '').includes('冒烟图谱'))`)
      await evalJs<void>(`(() => {
        const row = [...document.querySelectorAll('[data-testid="home-graph-row"]')].find((e) =>
          (e.textContent ?? '').includes('冒烟图谱') && !(e.textContent ?? '').includes('冒烟图谱二')
        )
        row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })()`)
      await waitFor(`(document.querySelector('.ttl')?.textContent ?? '').trim() === '冒烟图谱' && !!document.querySelector('.react-flow__node')`)

      // 14. 单节点右键没有从库删除（上一步已重开图谱，无需再进一次设置返回）
      await waitFor(`(document.querySelector('.ttl')?.textContent ?? '').includes('冒烟图谱') && !!document.querySelector('.react-flow__node')`)
      await contextClickNode('Gamma')
      const singleMenuOk = await waitFor(`(() => {
        const m = document.querySelector('[data-testid="paper-menu"]')
        return !!m && (m.textContent ?? '').includes('从图谱移除') && !(m.textContent ?? '').includes('从库删除')
      })()`)
      const singleMenuDiag = singleMenuOk ? '' : await evalJs<string>(`JSON.stringify({
        title: document.querySelector('.ttl')?.textContent ?? null,
        menu: [...document.querySelectorAll('[data-testid$="menu"], .menu')].map((m) => ({ testid: m.getAttribute('data-testid'), text: (m.textContent ?? '').slice(0, 120) })),
        gamma: __gt.nodeRect('Gamma'),
        selected: document.querySelectorAll('.pnode.sel').length,
        body: (document.body.innerText ?? '').slice(-300)
      })`)
      record('单节点右键无从库删除', singleMenuOk, singleMenuOk ? '单节点菜单仅对话上下文 + 从图谱移除' : `单节点菜单项目不对：${singleMenuDiag}`)
      ok = ok && singleMenuOk
      if (!singleMenuOk) return finish(false)
      await key('Escape')

      // 15. 多选批量移除，一次 ⌘Z 整批恢复、⌘⇧Z 重做，再复原留给后续步骤
      await singleClickNode('Alpha')
      await singleClickNode('Beta', ['meta'])
      await waitFor(`document.querySelectorAll('.pnode.sel').length === 2`)
      const batchBefore = await evalJs<{ members: Array<{ paper: { id: number; title: string }; x: number; y: number }>; relations: Array<{ id: number; paperLow: number; paperHigh: number }> }>(`window.graphictero.getGraph(${graphId})`)
      const batchIds = batchBefore.members.filter((m) => ['Alpha','Beta'].some((s) => m.paper.title.includes(s))).map((m) => m.paper.id)
      const batchRelIds = batchBefore.relations.filter((r) => batchIds.includes(r.paperLow) || batchIds.includes(r.paperHigh)).map((r) => r.id).sort((a, b) => a - b)
      await contextClickNode('Alpha')
      const multiMenuOk = await waitFor(`(() => {
        const m = document.querySelector('[data-testid="selection-menu"]')
        return !!m && (m.textContent ?? '').includes('查看所选子图') && (m.textContent ?? '').includes('从图谱移除所选 2 篇') && !(m.textContent ?? '').includes('从库删除')
      })()`)
      await evalJs<void>(`document.querySelector('[data-testid="menu-remove-graph"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      const batchRemoved = await waitFor(`(document.querySelector('.toasts')?.textContent ?? '').includes('已从图谱移除') && window.graphictero.getGraph(${graphId}).then((d) => d.members.length === ${batchBefore.members.length - 2} && d.relations.every((r) => ![${batchRelIds.join(',')}].includes(r.id)))`)
      await key('z', ['meta'])
      const batchUndoWait = await waitFor(`window.graphictero.getGraph(${graphId}).then((d) => d.members.length === ${batchBefore.members.length} && d.relations.length === ${batchBefore.relations.length})`)
      const batchUndoData = await evalJs<typeof batchBefore>(`window.graphictero.getGraph(${graphId})`)
      const positionsRestored = batchBefore.members.every((m) => {
        const now = batchUndoData.members.find((x) => x.paper.id === m.paper.id)
        return now && now.x === m.x && now.y === m.y
      })
      const relationIdsRestored = JSON.stringify(batchUndoData.relations.map((r) => r.id).sort((a, b) => a - b)) === JSON.stringify(batchBefore.relations.map((r) => r.id).sort((a, b) => a - b))
      await key('z', ['meta', 'shift'])
      const batchRedo = await waitFor(`window.graphictero.getGraph(${graphId}).then((d) => d.members.length === ${batchBefore.members.length - 2})`)
      await key('z', ['meta'])
      const batchFinal = await waitFor(`window.graphictero.getGraph(${graphId}).then((d) => d.members.length === ${batchBefore.members.length} && d.relations.length === ${batchBefore.relations.length})`)
      const batchOk = multiMenuOk && batchRemoved && batchUndoWait && positionsRestored && relationIdsRestored && batchRedo && batchFinal
      record('多选批量从图谱移除 + ⌘Z', batchOk,
        `菜单=${multiMenuOk} 移除=${batchRemoved} 坐标=${positionsRestored} 边id无重复=${relationIdsRestored} 重做=${batchRedo} 复原=${batchFinal}`)
      ok = ok && batchOk

      // 16. 从库删除只从侧栏论文行右键进入，D75 软删除
      const delTitle = 'UAT7 Delete Fixture'
      const delNow = new Date().toISOString()
      const delId = Number(state.db.prepare("INSERT INTO papers (title, source, has_pdf, first_author, year, created_at, updated_at) VALUES (?, 'zotero', 0, 'UAT7', 2026, ?, ?)").run(delTitle, delNow, delNow).lastInsertRowid)
      state.db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 520, 320, ?)').run(graphId, delId, delNow)
      await evalJs<void>(`window.dispatchEvent(new CustomEvent('gt:graph-changed'))`)
      await waitFor(`[...document.querySelectorAll('[data-testid="side-member-row"]')].some((r) => (r.textContent ?? '').includes(${JSON.stringify(delTitle)}))`)
      await contextClickNode('Gamma')
      const canvasStillClean = await waitFor(`(() => {
        const m = document.querySelector('[data-testid="paper-menu"], [data-testid="selection-menu"]')
        return !!m && !(m.textContent ?? '').includes('从库删除')
      })()`)
      await key('Escape')
      await evalJs<void>(`[...document.querySelectorAll('[data-testid="side-member-row"]')].find((r) => (r.textContent ?? '').includes(${JSON.stringify(delTitle)})).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 240, clientY: 280 }))`)
      const sideDeleteMenu = canvasStillClean && (await waitFor(`(() => {
        const m = document.querySelector('[data-testid="library-menu"]')
        return !!m && !!m.querySelector('[data-testid="menu-delete-library"]') && (m.textContent ?? '').includes('从库删除')
      })()`))
      await evalJs<void>(`document.querySelector('[data-testid="menu-delete-library"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      await waitFor(`!!document.querySelector('.modal.cfm')`)
      await evalJs<boolean>(`__gt.clickText('.modal.cfm button', '从库删除')`)
      const sideDeleted = await waitFor(`window.graphictero.getGraph(${graphId}).then((d) => d.members.every((m) => m.paper.id !== ${delId}))`)
      const softDeleted = (state.db.prepare('SELECT deleted_at FROM papers WHERE id = ?').get(delId) as { deleted_at: string | null }).deleted_at != null
      record('侧栏右键从库删除', sideDeleteMenu && sideDeleted && softDeleted,
        `侧栏菜单=${sideDeleteMenu} 画布移除=${sideDeleted} deleted_at 软删=${softDeleted}`)
      ok = ok && sideDeleteMenu && sideDeleted && softDeleted

      // 16b. uat8b B5：从图谱移除之后再从库软删，⌘Z 不得把论文带回，也不改 graphs.updated_at。
      const b5Title = 'UAT8B Skip'
      const b5Now = new Date().toISOString()
      const b5Id = Number(state.db.prepare("INSERT INTO papers (title, source, has_pdf, first_author, year, created_at, updated_at) VALUES (?, 'zotero', 0, 'UAT8B', 2026, ?, ?)").run(b5Title, b5Now, b5Now).lastInsertRowid)
      state.db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 40, 40, ?)').run(graphId, b5Id, b5Now)
      await evalJs<void>(`window.dispatchEvent(new CustomEvent('gt:graph-changed'))`)
      const b5Node = await waitFor(`[...document.querySelectorAll('.react-flow__node')].some((n) => (n.textContent ?? '').includes(${JSON.stringify(b5Title)}))`)
      await evalJs<void>(`(() => { const n = [...document.querySelectorAll('.react-flow__node')].find((el) => (el.textContent ?? '').includes(${JSON.stringify(b5Title)})); n?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 240, clientY: 280 })) })()`)
      const b5Menu = b5Node && (await waitFor(`!!document.querySelector('[data-testid="paper-menu"] [data-testid="menu-remove-graph"]')`))
      await evalJs<void>(`document.querySelector('[data-testid="menu-remove-graph"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      const b5Removed = b5Menu && (await waitFor(`(document.querySelector('.toasts')?.textContent ?? '').includes('已从图谱移除') && window.graphictero.getGraph(${graphId}).then((d) => d.members.every((m) => m.paper.id !== ${b5Id}))`))
      const b5Updated = (state.db.prepare('SELECT updated_at FROM graphs WHERE id = ?').get(graphId) as { updated_at: string }).updated_at
      state.db.prepare('UPDATE papers SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), b5Id)
      await key('z', ['meta'])
      const b5Toast = await waitFor(`(document.querySelector('.toasts')?.textContent ?? '').includes('论文已从论文库删除，无法恢复') && window.graphictero.getGraph(${graphId}).then((d) => d.members.every((m) => m.paper.id !== ${b5Id}))`)
      const b5UpdatedAfter = (state.db.prepare('SELECT updated_at FROM graphs WHERE id = ?').get(graphId) as { updated_at: string }).updated_at
      const b5StillDeleted = (state.db.prepare('SELECT deleted_at FROM papers WHERE id = ?').get(b5Id) as { deleted_at: string | null }).deleted_at != null
      const b5Ok = !!b5Removed && b5Toast && b5UpdatedAfter === b5Updated && b5StillDeleted
      record('软删后撤销不恢复', b5Ok, `移除=${!!b5Removed} 提示=${b5Toast} updated_at 未改=${b5UpdatedAfter === b5Updated} 仍软删=${b5StillDeleted}`)
      ok = ok && b5Ok

      // 17. 用量页 token、范围、tooltip、来源过滤、排序与灰阶
      const usageMod = await import('./llm/usage')
      for (const [daysAgo, category, reasoning] of [[2, 'chat', 120], [1, 'detail', 80], [0, 'relation', undefined]] as const) {
        usageMod.recordUsage(state.db, {
          category, model: 'smoke-usage', at: new Date(Date.now() - daysAgo * 86400000),
          usage: { inputTokens: 1000 + daysAgo * 100, cacheHitTokens: 200, outputTokens: 500 + daysAgo * 50, ...(reasoning == null ? {} : { reasoningTokens: reasoning }) }
        })
      }
      usageMod.recordWebCall(state.db, { at: new Date(Date.now() - 86400000) })
      // 第 13 步已写入同月推理 token，页面显示的是合计，不是后插的单条。
      const usageMonth = usageMod.usageMonthRange(usageMod.currentUsageMonth())
      const reasoningText = (category: string): string => {
        const row = state.db.prepare(
          `SELECT SUM(reasoning_tokens) AS n FROM usage_records
           WHERE category = ? AND occurred_at >= ? AND occurred_at < ?`
        ).get(category, usageMonth.start.toISOString(), usageMonth.end.toISOString()) as { n: number | null }
        const n = row.n ?? 0
        const abs = Math.abs(n)
        if (abs >= 10000) return `${(n / 10000).toFixed(abs % 10000 === 0 ? 0 : 1)} 万`
        return n.toLocaleString('zh-CN')
      }
      const chatReason = reasoningText('chat')
      const detailReason = reasoningText('detail')
      await evalJs<void>(`document.querySelector('button[title="设置"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      const usageNav = await waitFor(`[...document.querySelectorAll('.sitem')].some((e) => (e.textContent ?? '').trim() === '用量与费用')`)
      if (usageNav) await evalJs<boolean>(`__gt.clickText('.sitem', '用量与费用')`)
      await waitFor(`!!document.querySelector('[data-testid="usage-timeseries"] svg') && !!document.querySelector('[data-testid="usage-donut"] svg')`, 15000)
      await evalJs<void>(`document.querySelector('[data-testid="usage-metric-tokens"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      await evalJs<void>(`document.querySelector('[data-testid="usage-token-reasoning"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      const tokenOk = await waitFor(`(() => {
        const cell = (sel) => {
          const tds = document.querySelector(sel)?.querySelectorAll('td')
          return (tds && tds.length ? tds[tds.length - 1].textContent : '')?.trim() ?? ''
        }
        const total = document.querySelector('[data-testid="usage-total"]')?.textContent ?? ''
        const heads = [...document.querySelectorAll('.gt-usage-th')].map((b) => b.textContent ?? '').join(' ')
        return total.includes('推理') && heads.includes('其中推理') &&
          ${JSON.stringify(chatReason)} !== '0' && ${JSON.stringify(detailReason)} !== '0' &&
          cell('[data-testid="usage-row-chat"]') === ${JSON.stringify(chatReason)} &&
          cell('[data-testid="usage-row-detail"]') === ${JSON.stringify(detailReason)}
      })()`)
      const rangeDays = await evalJs<number[]>(`Promise.all(['7d','30d','all'].map((range) => window.graphictero.getUsageSeries({ range }))).then((rs) => rs.map((r) => r.days.length))`)
      for (const range of ['7d', '30d', 'all']) {
        await evalJs<void>(`document.querySelector('[data-testid="usage-range-${range}"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
        await waitFor(`document.querySelector('[data-testid="usage-range-${range}"]').classList.contains('on')`)
      }
      const rangesOk = rangeDays[0] === 7 && rangeDays[1] === 30 && rangeDays[2] >= 3
      let tooltipOk = false
      const chartRect = await evalJs<SmokeRect | null>(`(() => { const r = document.querySelector('[data-testid="usage-timeseries"] svg').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height } })()`)
      if (chartRect) {
        for (const ratio of [0.25, 0.45, 0.65, 0.82]) {
          mouse('mouseMove', chartRect.left + chartRect.width * ratio, chartRect.top + chartRect.height * 0.55)
          await sleep(180)
          tooltipOk = await evalJs<boolean>(`[...document.querySelectorAll('[data-testid="usage-timeseries"] div')].some((d) => d.style.position === 'absolute' && d.offsetParent !== null && /Agent 对话|详情生成|关系生成/.test(d.textContent ?? ''))`)
          if (tooltipOk) break
        }
      }
      await evalJs<void>(`document.querySelector('[data-testid="usage-row-detail"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      const filterOk = await waitFor(`(() => {
        const chip = document.querySelector('[data-testid="usage-filter-chip"]')?.textContent ?? ''
        const row = document.querySelector('[data-testid="usage-row-detail"]')
        const labels = [...(document.querySelector('[data-testid="usage-timeseries"]')?.querySelectorAll('text') ?? [])].map((n) => n.textContent ?? '')
        return chip.includes('来源：详情生成') && row?.classList.contains('selected') &&
          !document.querySelector('[data-testid="usage-row-chat"]') &&
          labels.some((t) => t.includes('详情生成')) &&
          !labels.some((t) => /Agent 对话|关系生成|名片|导出概览|联网/.test(t))
      })()`)
      await evalJs<void>(`document.querySelector('[data-testid="usage-filter-clear"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      const outputHeader = `[...document.querySelectorAll('.gt-usage-th')].find((b) => (b.textContent ?? '').startsWith('输出'))`
      await evalJs<void>(`${outputHeader}.click()`)
      const sortDesc = await waitFor(`(${outputHeader}).closest('th').getAttribute('aria-sort') === 'descending'`)
      await evalJs<void>(`${outputHeader}.click()`)
      const sortAsc = await waitFor(`(${outputHeader}).closest('th').getAttribute('aria-sort') === 'ascending'`)
      mouse('mouseMove', 8, 8)
      await sleep(200)
      const nonGray = await evalJs<string[]>(`(() => {
        const css = getComputedStyle(document.documentElement)
        const norm = (value) => {
          if (!value) return null
          const v = String(value).trim()
          if (!v || v === 'none' || v === 'transparent' || v === 'currentColor' || v.startsWith('url(')) return null
          let m = v.match(/^#([0-9a-fA-F]{3})$/)
          if (m) {
            const h = m[1]
            return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)].join(',')
          }
          m = v.match(/^#([0-9a-fA-F]{6})/)
          if (m) {
            const h = m[1]
            return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)].join(',')
          }
          m = v.match(/rgba?\\(\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*,\\s*([\\d.]+)/)
          if (m) return [Math.round(Number(m[1])), Math.round(Number(m[2])), Math.round(Number(m[3]))].join(',')
          return 'raw:' + v
        }
        const allowed = new Set(['47,111,235',
          // uat7b D186：六个来源的系列色（映射常量，唯一非灰来源）
          '176,117,47', '63,134,176', '47,138,110', '176,90,78', '160,106,146', '156,138,46'
        ])
        for (const name of ['--text','--text2','--text3','--edgeHi','--edge','--edge2','--line','--line2','--nodeb','--dot','--accent','--bg','--panel','--canvas','--side']) {
          const n = norm(css.getPropertyValue(name))
          if (n) allowed.add(n)
        }
        const bad = new Set()
        const check = (value) => {
          const n = norm(value)
          if (!n) return
          if (n.startsWith('raw:')) { bad.add(String(value).trim()); return }
          const p = n.split(',').map((x) => Number(x))
          if (p[0] === p[1] && p[1] === p[2]) return
          if (allowed.has(n)) return
          bad.add(String(value).trim())
        }
        for (const root of [document.querySelector('[data-testid="usage-timeseries"]'), document.querySelector('[data-testid="usage-donut"]')]) {
          if (!root) continue
          for (const el of root.querySelectorAll('*')) {
            check(el.getAttribute('fill')); check(el.getAttribute('stroke'))
            check(el.style.fill); check(el.style.stroke); check(el.style.color)
          }
        }
        return [...bad]
      })()`)
      const usageInteractiveOk = tokenOk && rangesOk && tooltipOk && filterOk && sortDesc && sortAsc && nonGray.length === 0
      record('用量页 token 与图表交互', usageInteractiveOk,
        `token=${tokenOk}（对话推理 ${chatReason} / 详情推理 ${detailReason}）范围=${rangesOk} tooltip=${tooltipOk} 过滤=${filterOk} 排序=${sortDesc}/${sortAsc} 越界色=${nonGray.join(',') || '无'}（D186 六来源色为允许集）`)
      ok = ok && usageInteractiveOk

      // uat7b D186：系列色 = 来源映射——柱图与环形图至少两个来源色块都在，且与映射一致。
      const fills = await evalJs<string[]>(`(() => {
        const pick = (testid) => [...document.querySelectorAll('[data-testid="' + testid + '"] [fill]')].map((e) => e.getAttribute('fill'))
        return [...pick('usage-timeseries'), ...pick('usage-donut')]
      })()`)
      const d186Colors = ['#B0752F', '#3F86B0', '#2F8A6E', '#B05A4E', '#A06A92', '#9C8A2E']
      const presentColors = d186Colors.filter((c) => fills.includes(c))
      const d186Ok = presentColors.length >= 3 && fills.includes('#2F8A6E') &&
        fills.filter((f) => f === '#B0752F').length >= 2 // 柱图条 + 图例色块同源同色
      record('用量图表按来源上色', d186Ok, `映射色命中=${presentColors.join(' ') || '无'}（柱/扇区/图例同源同色）`)
      ok = ok && d186Ok

      // uat7b M2：点图例隐藏「详情生成」→ 等 3 秒轮询 → 仍隐藏（不被复原）。
      const legendPoint = await evalJs<{ x: number; y: number } | null>(`(() => {
        const t = [...document.querySelectorAll('[data-testid="usage-timeseries"] text')].find((n) => (n.textContent ?? '').trim() === '详情生成')
        if (!t) return null
        const r = t.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`)
      let m2LegendOk = false
      if (legendPoint) {
        win.webContents.sendInputEvent({ type: 'mouseDown', x: legendPoint.x, y: legendPoint.y, button: 'left', clickCount: 1 })
        win.webContents.sendInputEvent({ type: 'mouseUp', x: legendPoint.x, y: legendPoint.y, button: 'left', clickCount: 1 })
        await sleep(300)
        const hiddenNow = await evalJs<boolean>(`![...document.querySelectorAll('[data-testid="usage-timeseries"] [fill]')].some((e) => e.getAttribute('fill') === '#2F8A6E')`)
        await sleep(3400) // 跨过一次 3 秒轮询
        const hiddenAfterPoll = await evalJs<boolean>(`![...document.querySelectorAll('[data-testid="usage-timeseries"] [fill]')].some((e) => e.getAttribute('fill') === '#2F8A6E')`)
        m2LegendOk = hiddenNow && hiddenAfterPoll
        // 恢复图例显示，避免影响后续步骤的图表断言。
        win.webContents.sendInputEvent({ type: 'mouseDown', x: legendPoint.x, y: legendPoint.y, button: 'left', clickCount: 1 })
        win.webContents.sendInputEvent({ type: 'mouseUp', x: legendPoint.x, y: legendPoint.y, button: 'left', clickCount: 1 })
        await sleep(300)
      }
      record('图例隐藏跨轮询保留', m2LegendOk, m2LegendOk ? '隐藏详情生成 → 3s 轮询后仍隐藏' : '图例点击无效或轮询复原了隐藏')
      ok = ok && m2LegendOk

      // 18–19. 自造短详情：窄图 / MinerU 表卡 / 窄 Markdown 表居中，宽表横向滚动
      const centerTitle = 'UAT7 Detail Layout Fixture'
      const centerNow = new Date().toISOString()
      const centerId = Number(state.db.prepare("INSERT INTO papers (title, source, has_pdf, first_author, year, created_at, updated_at) VALUES (?, 'zotero', 1, 'UAT7', 2026, ?, ?)").run(centerTitle, centerNow, centerNow).lastInsertRowid)
      const centerDir = join(state.dataDir, 'papers', String(centerId))
      const centerImgDir = join(centerDir, 'mineru', 'images')
      mkdirSync(centerImgDir, { recursive: true })
      writeFileSync(join(centerDir, 'paper.pdf'), smokeFixturePdf())
      const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
      writeFileSync(join(centerImgDir, 'figure.png'), pixel)
      writeFileSync(join(centerImgDir, 'table.png'), pixel)
      writeFileSync(join(centerDir, 'mineru', 'structured_content.json'), JSON.stringify({ pages: [{ page_idx: 0, blocks: [
        { type: 'image', bbox: [0.1, 0.1, 0.3, 0.2], captions: [{ content: 'Figure 1 UAT7 窄图' }], image_source: 'images/figure.png' },
        { type: 'table', bbox: [0.1, 0.3, 0.3, 0.4], captions: [{ content: 'Figure 2 UAT7 窄表' }], image_source: 'images/table.png' }
      ] }] }))
      state.db.prepare('UPDATE papers SET pdf_hash = ? WHERE id = ?').run('uat7-layout-v1', centerId)
      state.db.prepare("INSERT INTO jobs (kind, paper_id, status, payload, created_at, updated_at) VALUES ('process_paper', ?, 'succeeded', '{}', ?, ?)").run(centerId, centerNow, centerNow)
      const narrowMd = '| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |'
      const wideMd = `| ${Array.from({ length: 20 }, (_, i) => 'C' + i).join(' | ')} |\n| ${Array.from({ length: 20 }, () => '---').join(' | ')} |\n| ${Array.from({ length: 20 }, (_, i) => 'value-' + i).join(' | ')} |`
      const centerParts = [
        { type: 'data-figure', id: 'uf1', status: 'done', figureNo: 1, caption: 'UAT7 窄图卡' },
        { type: 'data-figure', id: 'ut1', status: 'done', figureNo: 2, caption: 'UAT7 MinerU 表卡' },
        { type: 'text', text: `${narrowMd}\n\n${wideMd}` },
        { type: 'data-mermaid', id: 'um1', status: 'done', title: 'UAT7 窄流程', code: 'graph TD\nA-->B' }
      ]
      state.db.prepare(`INSERT INTO paper_details (paper_id, parts, model, prompt_version, pdf_hash, generated_at, created_at, updated_at)
        VALUES (?, ?, 'deepseek-flash', ?, 'uat7-layout-v1', ?, ?, ?)`).run(centerId, JSON.stringify(centerParts), DETAIL_PROMPT.version, centerNow, centerNow, centerNow)
      await evalJs<void>(`window.dispatchEvent(new CustomEvent('gt:open-paper', { detail: ${centerId} }))`)
      const centerReady = await waitFor(`document.querySelectorAll('[data-testid="part-figure"]').length === 2 && document.querySelectorAll('[data-testid="md-table-wrap"]').length === 2 && !!document.querySelector('.gt-mermaid-svg svg')`, 20000)
      const centers = await evalJs<Array<{ kind: string; delta: number }>>(`(() => {
        const root = document.querySelector('.gt-parts').getBoundingClientRect()
        const cx = root.left + root.width / 2
        const out = []
        const measure = (kind, el) => { const r = el.getBoundingClientRect(); out.push({ kind, delta: Math.abs(r.left + r.width / 2 - cx) }) }
        document.querySelectorAll('[data-testid="part-figure"] .gt-figure-card').forEach((el, i) => measure('figure-' + i, el))
        measure('md-narrow', document.querySelectorAll('[data-testid="md-table-wrap"] table')[0])
        measure('mermaid', document.querySelector('.gt-mermaid-svg svg'))
        return out
      })()`)
      const centerOk = centerReady && centers.length === 4 && centers.every((c) => c.delta <= 2)
      writeFileSync(`${_outPath}.uat7-center.png`, (await win.webContents.capturePage()).toPNG())
      record('详情页窄图表居中', centerOk, `中心差=${centers.map((c) => `${c.kind}:${c.delta.toFixed(2)}px`).join(' / ')}；截图=${_outPath}.uat7-center.png`)
      ok = ok && centerOk

      const wideScroll = await evalJs<{ overflow: boolean; leftAligned: boolean; rightVisible: boolean; pageOk: boolean; scrollWidth: number; clientWidth: number }>(`(() => {
        const wrap = document.querySelectorAll('[data-testid="md-table-wrap"]')[1]
        const table = wrap.querySelector('table')
        wrap.scrollLeft = 0
        const leftAligned = Math.abs(wrap.getBoundingClientRect().left - table.getBoundingClientRect().left) <= 1
        wrap.scrollLeft = wrap.scrollWidth - wrap.clientWidth
        const rightVisible = Math.abs(wrap.getBoundingClientRect().right - table.getBoundingClientRect().right) <= 1
        const page = document.querySelector('.gt-pd-page')
        return { overflow: wrap.scrollWidth > wrap.clientWidth, leftAligned, rightVisible, pageOk: page.scrollWidth <= page.clientWidth, scrollWidth: wrap.scrollWidth, clientWidth: wrap.clientWidth }
      })()`)
      const wideOk = wideScroll.overflow && wideScroll.leftAligned && wideScroll.rightVisible && wideScroll.pageOk
      record('详情页宽表横向滚动', wideOk, `scrollWidth=${wideScroll.scrollWidth} clientWidth=${wideScroll.clientWidth} 左缘=${wideScroll.leftAligned} 右缘=${wideScroll.rightVisible} 页面无横滚=${wideScroll.pageOk}`)
      ok = ok && wideOk
    }
    // ===== uat7 lane/uat7 steps end =====

    // ===== uat12 lane/uat12 steps =====（uat12 只在本段内追加步骤）
    {
      // D201：详情页「定位」→ 回画布等节点测量完成后瞬时（smoke motion=off）居中该节点并 flash。
      // 节点放得离其它节点足够远：整图取景的中心 ≠ 该节点中心，能证明视口确实被定位移动过。
      const locateNow = new Date().toISOString()
      const locateId = Number(
        state.db
          .prepare("INSERT INTO papers (title, source, has_pdf, first_author, year, created_at, updated_at) VALUES ('UAT12 Locate Fixture', 'zotero', 1, 'UAT12', 2026, ?, ?)")
          .run(locateNow, locateNow).lastInsertRowid
      )
      state.db.prepare("INSERT INTO paper_authors (paper_id, position, family, given, normalized) VALUES (?, 0, 'UAT12', 'Fixture', 'fixture uat12')").run(locateId)
      state.db.prepare("INSERT INTO jobs (kind, paper_id, status, payload, created_at, updated_at) VALUES ('process_paper', ?, 'succeeded', '{}', ?, ?)").run(locateId, locateNow, locateNow)
      state.db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 1800, -1400, ?)').run(graphId, locateId, locateNow)
      state.db
        .prepare(`INSERT INTO paper_details (paper_id, parts, model, prompt_version, pdf_hash, generated_at, created_at, updated_at)
          VALUES (?, ?, 'deepseek-flash', ?, 'uat12-locate-v1', ?, ?, ?)`)
        .run(locateId, JSON.stringify([{ type: 'text', text: 'UAT12 定位冒烟详情正文。' }]), DETAIL_PROMPT.version, locateNow, locateNow, locateNow)
      const memberCount = (state.db.prepare('SELECT COUNT(*) AS n FROM graph_members WHERE graph_id = ?').get(graphId) as { n: number }).n

      await evalJs<void>(`window.dispatchEvent(new CustomEvent('gt:open-paper', { detail: ${locateId} }))`)
      const locatePageUp = await waitFor(`(() => {
        const page = document.querySelector('[data-testid="paper-detail-page"]')
        return !!page && (page.querySelector('.ttl')?.textContent ?? '').includes('UAT12') && !!page.querySelector('[data-testid="pd-locate"]')
      })()`)
      record('详情页定位入口', locatePageUp, locatePageUp ? '详情页出现「定位」按钮' : '详情页或定位按钮未出现')
      ok = ok && locatePageUp

      await evalJs<boolean>(`(() => { const b = document.querySelector('[data-testid="pd-locate"]'); if (!b) return false; b.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true })()`)
      // 回画布：目标节点在视口内、位于画布中心附近（fitView 单节点居中），且带 flash 高亮类。
      const locateCheck = await waitFor(`(() => {
        if (__gt.nodeCount() !== ${memberCount}) return false
        const flow = document.querySelector('.react-flow')
        if (!flow) return false
        const fr = flow.getBoundingClientRect()
        const r = window.__gt.nodeRect('UAT12')
        if (!window.__gt.inView(r)) return false
        const d = Math.hypot(r.left + r.width / 2 - (fr.left + fr.width / 2), r.top + r.height / 2 - (fr.top + fr.height / 2))
        const flashed = [...document.querySelectorAll('.react-flow__node.gt-flash')].some((n) => (n.textContent ?? '').includes('UAT12'))
        return d <= 50 && flashed
      })()`, 10000)
      record('详情页定位回画布', locateCheck, locateCheck ? '节点居中且被 flash' : '节点未居中 / 未 flash / 节点数不符')
      ok = ok && locateCheck
    }
    // ===== uat12 lane/uat12 steps end =====

    // ===== uat16 lane/uat16 steps =====
    {
      // D211：全自造幂律 fixture，经真实 DB → 详情 IPC → PartsView；不调用 LLM 或网络。
      const interactiveNow = new Date().toISOString()
      const interactiveId = Number(
        state.db
          .prepare("INSERT INTO papers (title, source, has_pdf, pdf_hash, first_author, year, created_at, updated_at) VALUES ('UAT16 Interactive Fixture', 'zotero', 1, 'uat16-v1', 'UAT16', 2026, ?, ?)")
          .run(interactiveNow, interactiveNow).lastInsertRowid
      )
      state.db.prepare("INSERT INTO jobs (kind, paper_id, status, payload, created_at, updated_at) VALUES ('process_paper', ?, 'succeeded', '{}', ?, ?)").run(interactiveId, interactiveNow, interactiveNow)
      const interactiveParts = [{
        type: 'data-interactive',
        id: 'uat16-power-law',
        status: 'done',
        title: 'UAT16 幂律收敛交互讲解',
        params: [
          { id: 'a', label: '收敛指数 a', control: 'slider', min: 0.2, max: 3, step: 0.1, default: 1 },
          { id: 'C', label: '尺度 C', control: 'select', default: 2, options: [{ label: '标准', value: 2 }, { label: '双倍', value: 4 }] },
          { id: 'n', label: '迭代次数 n', control: 'number', min: 1, max: 1000, step: 1, default: 4 }
        ],
        expressions: [{ id: 'err', label: '误差', expr: 'C * n^(-a)', precision: 4, format: 'fixed' }],
        plot: {
          x: { xVar: 'n', from: 1, to: 1000, samples: 120 },
          series: [{ expr: 'err', label: '误差曲线' }],
          xLabel: 'n',
          yLabel: '误差',
          kind: 'line'
        },
        caption: '调整 a、C 或 n，观察读数与误差曲线。',
        sourceNote: '自造冒烟 fixture：式 (1)'
      }]
      state.db
        .prepare(`INSERT INTO paper_details (paper_id, parts, model, prompt_version, pdf_hash, generated_at, created_at, updated_at)
          VALUES (?, ?, 'deepseek-flash', ?, 'uat16-v1', ?, ?, ?)`)
        .run(interactiveId, JSON.stringify(interactiveParts), DETAIL_PROMPT.version, interactiveNow, interactiveNow, interactiveNow)
      const interactiveErrorStart = await evalJs<number>('(window.__gtErrors || []).length')
      const interactiveConsoleStart = rendererErrors.length
      await evalJs<void>(`window.dispatchEvent(new CustomEvent('gt:open-paper', { detail: ${interactiveId} }))`)
      const interactiveReady = await waitFor(`(() => {
        const root = document.querySelector('[data-testid="part-interactive"]')
        if (!root) return false
        const paths = [...root.querySelectorAll('[data-testid="interactive-chart"] svg path')]
        const curve = paths.some((p) => ((p.getAttribute('d') ?? '').match(/[LC]/g) ?? []).length >= 10)
        return !!root.querySelector('[data-testid="interactive-param-a"]') &&
          !!root.querySelector('[data-testid="interactive-param-C"]') &&
          !!root.querySelector('[data-testid="interactive-param-n"]') &&
          root.querySelector('[data-testid="interactive-value-err"]')?.textContent === '0.5' &&
          curve && !root.querySelector('canvas')
      })()`, 20000)
      record('D211 交互讲解渲染', interactiveReady, interactiveReady ? '详情页滑条/选择/数值控件、读数与 SVG 曲线就绪' : '交互控件、读数或曲线未就绪')
      if (!interactiveReady) return finish(false)
      const interactivePathBefore = await evalJs<string>(`(() => {
        const paths = [...document.querySelectorAll('[data-testid="part-interactive"] [data-testid="interactive-chart"] svg path')]
        return paths.map((p) => p.getAttribute('d') ?? '').find((d) => ((d.match(/[LC]/g) ?? []).length >= 10)) ?? ''
      })()`)
      await evalJs<boolean>(`__gt.setInput('[data-testid="part-interactive"] [data-testid="interactive-param-a"]', '2')`)
      const interactiveChanged = await waitFor(`(() => {
        const root = document.querySelector('[data-testid="part-interactive"]')
        if (!root || root.querySelector('[data-testid="interactive-value-err"]')?.textContent !== '0.125') return false
        const paths = [...root.querySelectorAll('[data-testid="interactive-chart"] svg path')]
        const d = paths.map((p) => p.getAttribute('d') ?? '').find((v) => ((v.match(/[LC]/g) ?? []).length >= 10)) ?? ''
        return !!d && d !== ${JSON.stringify(interactivePathBefore)}
      })()`, 10000)
      record('D211 交互参数实时计算', interactiveChanged, interactiveChanged ? 'a=1→2 后误差 0.5→0.125，曲线路径同步更新' : '读数或曲线未随参数更新')
      ok = ok && interactiveChanged
      await sleep(300)
      const interactiveErrors = await evalJs<string[]>(`(window.__gtErrors || []).slice(${interactiveErrorStart})`)
      const interactiveConsoleErrors = rendererErrors.slice(interactiveConsoleStart)
      const errorText = [...interactiveErrors, ...interactiveConsoleErrors].join('\n')
      const interactiveStillUp = await evalJs<boolean>(`!!document.querySelector('[data-testid="part-interactive"]')`)
      const noInteractive185 = interactiveStillUp && !/(#185|react\.dev\/errors\/185|Maximum update depth)/i.test(errorText)
      record('D211 交互无React185', noInteractive185, noInteractive185 ? '参数交互后组件仍在，无最大更新深度错误' : errorText.slice(0, 500) || '交互组件已卸载')
      ok = ok && noInteractive185
    }
    // ===== uat16 lane/uat16 steps end =====

    // ===== uat17 lane/uat17 steps =====（D212；仅本地 DB fixture 与可信输入）
    {
      const backUat17 = await backToGraph()
      const graphUat17 = backUat17 && (await waitFor(`(document.querySelector('.ttl')?.textContent ?? '').includes('冒烟图谱') && !!document.querySelector('.react-flow__node')`))
      record('uat17 画布就绪', graphUat17, graphUat17 ? '从交互详情返回冒烟图谱' : '无法返回冒烟图谱')
      if (!graphUat17) return finish(false)

      // 取一条现有关系改成唯一的「具体实现」单类型边，验证真正不渲染与重置恢复。
      const filterRel = state.db.prepare('SELECT id FROM relations WHERE graph_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1').get(graphId) as { id: number } | undefined
      if (!filterRel) {
        record('uat17 关系过滤 fixture', false, '冒烟图谱没有可用关系')
        return finish(false)
      }
      state.db.prepare("UPDATE relations SET llm_types = '[\"implements\"]', auto_types = '[]' WHERE id = ?").run(filterRel.id)
      await evalJs<void>(`window.dispatchEvent(new CustomEvent('gt:graph-changed'))`)
      const filterFixture = await waitFor(`window.graphictero.getGraph(${graphId}).then((d) => d.relations.some((r) => r.id === ${filterRel.id} && r.llmTypes.length === 1 && r.llmTypes[0] === 'implements'))`)
      record('uat17 关系过滤 fixture', filterFixture, filterFixture ? `关系 #${filterRel.id} = 具体实现` : '关系类型 fixture 未刷新')
      ok = ok && filterFixture

      await evalJs<boolean>(`__gt.clickText('.toolbar button[title="按关系类型筛选"]', '筛选')`)
      await waitFor(`!!document.querySelector('.fpop')`)
      await evalJs<boolean>(`__gt.clickText('.fpop .frow', '具体实现')`)
      const filteredOut = await waitFor(`!document.querySelector('.react-flow__edge[data-id="${filterRel.id}"]') && document.querySelector('[data-testid="relation-filter"]')?.dataset.filtered === 'true'`)
      record('类型过滤隐藏整边', filteredOut, filteredOut ? '取消「具体实现」后目标边从 DOM 消失，节点保留' : '目标边仍渲染或过滤状态未提示')
      ok = ok && filteredOut
      await evalJs<boolean>(`__gt.clickText('.fpop button', '全部显示')`)
      const filterReset = await waitFor(`!!document.querySelector('.react-flow__edge[data-id="${filterRel.id}"]') && document.querySelector('[data-testid="relation-filter"]')?.dataset.filtered === 'false'`)
      await key('Escape') // 关筛选层
      record('类型过滤重置', filterReset, filterReset ? '全部显示后目标边恢复' : '重置后目标边未恢复')
      ok = ok && filterReset

      // 孤立 UAT12 节点不在 Alpha 的 1 跳邻域，作为明确的非邻居。
      await evalJs<void>(`document.querySelector('.react-flow__controls-fitview')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
      await waitFor(`__gt.stillNodeRects('Alpha', 'UAT12')`)
      const viewportBeforeFocus = await evalJs<string>(`document.querySelector('.react-flow__viewport')?.style.transform ?? ''`)
      const focusContext = await contextClickNode('Alpha')
      const focusMenu = focusContext && (await waitFor(`!!document.querySelector('[data-testid="paper-menu"] [data-testid="menu-focus-paper"]')`))
      await evalJs<boolean>(`__gt.clickText('[data-testid="menu-focus-paper"]', '聚焦此论文')`)
      const focusEntered = await waitFor(`(() => {
        if (!document.querySelector('[data-testid="focus-banner"]')) return false
        const outside = [...document.querySelectorAll('.react-flow__node')].find((n) => (n.textContent ?? '').includes('UAT12'))
        const hidden = !outside || getComputedStyle(outside).visibility === 'hidden' || getComputedStyle(outside).display === 'none'
        return hidden && (document.querySelector('[data-testid="focus-banner"]')?.textContent ?? '').includes('Alpha')
      })()`)
      record('右键聚焦隐藏非邻居', focusMenu && focusEntered, focusMenu && focusEntered ? 'Alpha 1 跳聚焦，孤立 UAT12 隐藏，指示条出现' : '右键入口、指示条或非邻居隐藏失败')
      ok = ok && focusMenu && focusEntered
      await key('Escape')
      const focusEscaped = await waitFor(`!document.querySelector('[data-testid="focus-banner"]') && document.querySelector('.react-flow__viewport')?.style.transform === ${JSON.stringify(viewportBeforeFocus)} && !!window.__gt.nodeRect('UAT12')`)
      record('Esc退聚焦恢复视口', focusEscaped, focusEscaped ? '聚焦退出且进入前视口恢复' : '聚焦未退出或原视口未恢复')
      ok = ok && focusEscaped

      const selectedForF = await singleClickNode('Alpha')
      const emphasisOk = selectedForF && (await waitFor(`(() => {
        const alpha = [...document.querySelectorAll('.react-flow__node.gt-neighbor-hi')].some((n) => (n.textContent ?? '').includes('Alpha'))
        const outside = [...document.querySelectorAll('.react-flow__node.gt-neighbor-dim')].some((n) => (n.textContent ?? '').includes('UAT12'))
        return alpha && outside
      })()`))
      record('选中节点按需强调', emphasisOk, emphasisOk ? 'Alpha 邻域高亮，孤立节点淡化' : '邻域类未按选择应用')
      ok = ok && emphasisOk
      key('F')
      const focusByF = await waitFor(`!!document.querySelector('[data-testid="focus-banner"]')`)
      record('F快捷键聚焦', focusByF, focusByF ? '单选 Alpha 后裸 F 进入聚焦' : 'F 未进入聚焦')
      ok = ok && focusByF

      // uat17b 建议修 3：双击挪到退聚焦之前，证明聚焦中双击仍开详情。
      // 建议修 5：详情返回后聚焦按 graphId 暂存恢复，一并在此断言。
      const doubleStillOpens = await clickNode('Alpha')
      const focusSurvivedDetail = doubleStillOpens && (await backToGraph()) && (await waitFor(`!!document.querySelector('[data-testid="focus-banner"]')`))
      record('聚焦后双击仍开详情', doubleStillOpens && focusSurvivedDetail, doubleStillOpens ? '聚焦中双击 Alpha 打开详情，返回后聚焦恢复' : '聚焦中双击详情行为被破坏')
      ok = ok && doubleStillOpens && focusSurvivedDetail
      await key('Escape')
      await waitFor(`!document.querySelector('[data-testid="focus-banner"]')`)
    }
    // ===== uat17 lane/uat17 steps end =====

    return finish(ok)
  } catch (e) {
    const errs = await evalJs<string>(`JSON.stringify((window.__gtErrors || []).slice(0, 4))`).catch(() => 'errors-unavailable')
    record('冒烟驱动异常', false, `${e instanceof Error ? e.message : String(e)}｜渲染错误=${errs}`)
    return finish(false)
  }

  async function addViaModal(substr: string): Promise<boolean> {
    await evalJs<boolean>(`__gt.clickText('button', '添加论文')`)
    if (!(await waitFor(`[...document.querySelectorAll('.lrow')].some((r) => (r.textContent ?? '').includes('${substr}'))`))) {
      record(`添加论文(${substr})`, false, '弹窗里没有该行')
      return false
    }
    await evalJs<boolean>(`
      [...document.querySelectorAll('.lrow')].find((r) => (r.textContent ?? '').includes('${substr}'))
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    `)
    await sleep(150)
    await evalJs<boolean>(`__gt.clickText('button', '添加 1 篇')`)
    const ok = await waitFor(`__gt.nodeCount() === ${substr === 'Alpha' ? 1 : 2}`)
    // 关掉弹窗（取消按钮），回到画布
    await evalJs<boolean>(`__gt.clickText('button', '取消')`)
    await sleep(200)
    record(`添加论文(${substr})`, ok, ok ? '节点已上画布' : '节点未出现')
    return ok
  }

  function finish(ok: boolean): SmokeResult {
    return { ok, dataDir: state.dataDir, steps }
  }
}
