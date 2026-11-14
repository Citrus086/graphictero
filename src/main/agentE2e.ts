import type { BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { AppState } from './ipc'
import type { SmokeResult, SmokeStep } from './smokeUi'
import { startStubLlm, type StubBehavior, type StubLlm } from './llm/stubServer'
import { writeApiKey } from './llm/config'
import { indexFullTextFts } from './db/fulltextFts'

/**
 * 真实 IPC 端到端冒烟（chat→main 合并批清单①，review_lane_chat3 §九(c)-1 /
 * review_lane_chat4 §六-2）：`--agent-e2e <结果.json>` 触发，scripts/run-agent-e2e.mjs
 * 是启动包装（临时数据目录 + GRAPHICTERO_SIDECAR=off）。
 *
 * 与 `--smoke-ui`（?smoke=1 渲染层 mock）不同：这里窗口**不带 smoke 查询参数**，
 * 渲染层走真实 preload 桥（window.graphictero → ipcRenderer.invoke → ipcMain.handle
 * → AgentRuntime），LLM 经 GRAPHICTERO_LLM_BASE_URL 测试缝（llm/config.ts
 * providerBaseUrl）指向主进程内启动的 stubServer——绝不调真实 DeepSeek。
 *
 * 覆盖：开抽屉 → 发消息 → 流式可见（口径 A part-start 的 UI 表现）→ trace 回源后
 * 仍在 → 停止保留 → 费用行与 usage_records 对账；候选卡（proposeCandidate → 卡 +
 * 虚线节点 → 两处确认/忽略一致 → 确认后画布出新节点）；改图小结定位 flash；
 * M6 第 0 批（main）：listRelations 一步（B1）；快照双验（D129）：(a) addRelation
 * 命中既有边不覆盖（拒绝，无小结/无快照，D143）→ updateRelation 显式修改 → 小结
 * 写「修改」、撤销按快照还原原陈述、(b) 跨回合改写 → 撤销还原到上一回合
 * 内容；本回合新建边删除撤销；双 stop 幂等；deleteSession 与在跑回合竞态。
 */

/** 合成数据：一张图 + 甲乙丙三篇（甲带详情）+ 库外 DOI 论文 + 一条预置既有边。绝不碰真实数据。 */
export function seedAgentE2e(db: Database.Database): void {
  const now = new Date().toISOString()
  const graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('E2E对话图谱', now, now).lastInsertRowid)
  const insPaper = db.prepare(
    `INSERT INTO papers (title, source, doi, first_author, year, abstract, created_at, updated_at)
     VALUES (?, 'zotero', ?, ?, ?, ?, ?, ?)`
  )
  const insAuthor = db.prepare('INSERT INTO paper_authors (paper_id, position, family, given, normalized) VALUES (?, 0, ?, ?, ?)')
  const insMember = db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, ?, ?, ?)')
  const seedPapers: Array<[string, string | null, string, number, number, number]> = [
    // [标题, DOI, 第一作者, 年份, x, y]
    ['E2E 论文甲', null, 'Jia Zhang', 2021, 200, 240],
    ['E2E 论文乙', null, 'Yi Wang', 2022, 520, 240],
    ['E2E 论文丙', null, 'Bing Liu', 2023, 360, 480],
    // 库外候选的「已在库中」命中论文（DOI 去重用，不在图谱里）
    ['E2E 库内命中论文', '10.9999/e2e-in-lib', 'Ru Chen', 2024, 0, 0]
  ]
  const ids: number[] = []
  for (const [title, doi, author, year] of seedPapers) {
    const r = insPaper.run(title, doi, author, year, 'E2E 合成摘要，供 readPaper 读取。', now, now)
    const [family, given] = author.split(' ')
    insAuthor.run(Number(r.lastInsertRowid), family, given, `${given} ${family}`.toLowerCase())
    ids.push(Number(r.lastInsertRowid))
  }
  insMember.run(graphId, ids[0], 200, 240, now)
  insMember.run(graphId, ids[1], 520, 240, now)
  insMember.run(graphId, ids[2], 360, 480, now)
  // 甲的详情（readPaper 带 section 目录的 trace 数据源）
  db.prepare(
    `INSERT INTO paper_details (paper_id, parts, model, prompt_version, generated_at, created_at, updated_at)
     VALUES (?, ?, 'deepseek-flash', 'detail-v2', ?, ?, ?)`
  ).run(ids[0], JSON.stringify([{ type: 'text', text: '## 方法\n甲的方法正文。\n## 结论\n甲的结论正文。' }]), now, now, now)
  // 预置既有边（甲–乙）：created_at 压在远古——T4 的 addRelation 命中它应拒绝、
  // 随后的 updateRelation 修改它，同回合撤销应成功还原（T4(ii)）。手动/程序边在库里都是
  // source_type='session'（001 迁移 CHECK）。
  db.prepare(
    `INSERT INTO relations (graph_id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types,
       source_type, source_session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'E2E 预置既有边', '["compares"]', '[]', 'session', NULL, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`
  ).run(graphId, Math.min(ids[0], ids[1]), Math.max(ids[0], ids[1]), ids[0])
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 页面小工具（注入一次）：受控输入 + 按文本找按钮点击 */
const E2E_HELPERS = `
window.__e2e = {
  setInput(sel, value) {
    const el = document.querySelector(sel)
    if (!el) return false
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  },
  clickText(sel, text) {
    const el = [...document.querySelectorAll(sel)].find((e) => (e.textContent ?? '').includes(text))
    if (!el) return false
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return true
  },
  lastGChange() {
    const blocks = [...document.querySelectorAll('[data-testid="part-graph-change"]')]
    return blocks[blocks.length - 1] ?? null
  }
}
true
`

export async function runAgentE2e(win: BrowserWindow, state: AppState): Promise<SmokeResult> {
  const steps: SmokeStep[] = []
  const record = (step: string, ok: boolean, detail?: string): void => {
    steps.push(detail ? { step, ok, detail } : { step, ok })
    console.log(`[agent-e2e] ${ok ? '✓' : '✗'} ${step}${detail ? ` — ${detail}` : ''}`)
  }
  const evalJs = async <T>(code: string): Promise<T> => (await win.webContents.executeJavaScript(code, true)) as T
  const rendererErrors: string[] = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) rendererErrors.push(String(message).slice(0, 300))
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    rendererErrors.push(`render-gone ${details.reason} ${details.exitCode}`)
  })
  const waitFor = async (code: string, timeoutMs = 15000): Promise<boolean> => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      try {
        if (await evalJs<boolean>(code)) return true
      } catch {
        // 页面加载/重载中，忽略瞬时报错
      }
      await sleep(120)
    }
    return false
  }
  const click = async (code: string): Promise<void> => void evalJs<void>(code)
  const db = state.db
  const paperId = (title: string): number =>
    (db.prepare('SELECT id FROM papers WHERE title = ?').get(title) as { id: number }).id
  const jia = paperId('E2E 论文甲')
  const yi = paperId('E2E 论文乙')
  const bing = paperId('E2E 论文丙')
  const graphId = (db.prepare('SELECT id FROM graphs WHERE name = ?').get('E2E对话图谱') as { id: number }).id
  const latestSessionId = (): number =>
    Number((db.prepare('SELECT MAX(id) AS m FROM sessions WHERE graph_id = ?').get(graphId) as { m: number }).m)
  const liveRelations = (): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM relations WHERE graph_id = ? AND deleted_at IS NULL').get(graphId) as { n: number }).n

  // stub 生命周期：每个回合配全新 stub（script 行为覆盖该回合的工具步 + 总结请求），
  // 避免跨回合行为队列串台；GRAPHICTERO_LLM_BASE_URL 每次换新端口。
  let stub: StubLlm | null = null
  const setStub = async (behaviors: StubBehavior[]): Promise<void> => {
    if (stub) await stub.close()
    stub = await startStubLlm(behaviors)
    process.env.GRAPHICTERO_LLM_BASE_URL = stub.baseUrl
  }

  /** 发一条消息并等本回合的收尾断言成立（等待条件按回合给——chat-send 在重渲染前
   * 有残留窗口，不能单独当回合结束信号）。返回后通常再确认 chat-send 恢复。 */
  const sendText = async (text: string): Promise<void> => {
    await evalJs<boolean>(`__e2e.setInput('[data-testid="chat-input"]', ${JSON.stringify(text)})`)
    await click(`document.querySelector('[data-testid="chat-send"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
  }
  /** 嵌进复合等待条件的「回合已收尾」表达式（chat-send 恢复 = 非运行态） */
  const sendBackCode = `!!document.querySelector('[data-testid="chat-send"]')`
  /** 一次 addRelation 改图回合的 stub 脚本 */
  const addRelScript = (src: number, dst: number, statement: string): StubBehavior[] => [
    {
      kind: 'script',
      rounds: [
        {
          text: '好的，我来调整图谱关系。',
          calls: [
            {
              id: 'call_add',
              name: 'addRelation',
              arguments: JSON.stringify({ srcPaperId: src, dstPaperId: dst, statement, types: ['compares'] })
            }
          ]
        }
      ],
      finalText: '已完成。',
      usage: { prompt_tokens: 200, completion_tokens: 40, prompt_cache_hit_tokens: 50 }
    }
  ]
  /** D143：一次 updateRelation 显式修改回合的 stub 脚本 */
  const updateRelScript = (relationId: number, statement: string): StubBehavior[] => [
    {
      kind: 'script',
      rounds: [
        {
          text: '好的，我来修改这条关系。',
          calls: [{ id: 'call_upd', name: 'updateRelation', arguments: JSON.stringify({ relationId, statement }) }]
        }
      ],
      finalText: '已完成。',
      usage: { prompt_tokens: 200, completion_tokens: 40, prompt_cache_hit_tokens: 50 }
    }
  ]

  let ok = true
  const finish = (): SmokeResult => {
    void stub?.close()
    return { ok, dataDir: state.dataDir, steps }
  }

  // ── 前置：stub LLM 就位 + 假 Key（临时数据目录内，非真实密钥）──
  await setStub([])
  writeApiKey(state.dataDir, 'deepseek', 'e2e-stub-key')

  // ── 进入图谱页（Home → 图谱卡）──
  await waitFor(`!!document.querySelector('.gcard')`, 30000)
  await evalJs<void>(`document.querySelector('.gcard').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
  const onGraph = await waitFor(`(document.querySelector('.ttl')?.textContent ?? '').includes('E2E对话图谱') && document.querySelectorAll('.react-flow__node').length === 3 && document.documentElement.dataset.motion === 'off' && !new URLSearchParams(location.search).has('smoke')`)
  record('打开图谱页', onGraph, onGraph ? 'Home → E2E对话图谱（3 节点 1 既有边）' : '未进入图谱页')
  ok = ok && onGraph
  if (!onGraph) return finish()
  await evalJs<boolean>(E2E_HELPERS)

  // ── 开抽屉 + 新建会话（真实 IPC：agent:createSession / listSessions）──
  await click(`document.querySelector('[data-testid="chat-toggle"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
  const drawerUp = await waitFor(`(() => {
    const d = document.querySelector('[data-testid="chat-drawer"]')
    return !!d && !!d.querySelector('[data-testid="chat-entry"]') && (d.textContent ?? '').includes('E2E对话图谱')
  })()`)
  record('抽屉打开（真实 IPC）', drawerUp, drawerUp ? '02 顶栏「对话」→ 抽屉 + 入口对象行' : '抽屉未出现')
  ok = ok && drawerUp
  if (!drawerUp) return finish()
  await click(`document.querySelector('[data-testid="chat-new-session"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
  const sessReady = await waitFor(`(document.querySelector('[data-testid="session-picker"]')?.textContent ?? '').length > 0 && !!document.querySelector('[data-testid="chat-input"]:not([disabled])')`)
  record('新建会话', sessReady)
  ok = ok && sessReady
  if (!sessReady) return finish()
  const sid1 = latestSessionId()

  // 事件探针（页面侧）：直接经 preload 桥订阅 event:agent:stream，统计真实到达的
  // 流事件种类——T1 断言 part-start > 0（口径 A）与 turn-start（运行态来源）
  await evalJs<boolean>(`window.__evts = []; window.graphictero.onAgentStream((e) => window.__evts.push(e.kind)); true`)

  // ── T1 流式 + trace + 回源 + 费用对账（getPapers → readPaper → 总结）──
  await setStub([
    {
      kind: 'script',
      rounds: [
        { text: '我先看看图谱里有哪些论文。', calls: [{ id: 'c1', name: 'getPapers' }] },
        { text: '再读一下甲这篇。', calls: [{ id: 'c2', name: 'readPaper', arguments: JSON.stringify({ paperId: jia }) }] }
      ],
      finalText: 'E2E 总结：图里三篇，甲的详情已读。',
      // token 量给足：3 次调用合计费用要 > ¥0.01，对账断言才有区分度（峰谷价都满足）
      usage: { prompt_tokens: 200000, completion_tokens: 3000, prompt_cache_hit_tokens: 50000 }
    }
  ])
  await sendText('看看这张图，读一下甲')
  // 口径 A 的 UI 表现：助手消息分块齐全（工具步两块 + 总结一块）——part-start/delta
  // 流式可见；turn-end 后 getMessages 回源替换本地乐观消息，正文一致
  const t1Text = await waitFor(`(() => {
    const ai = document.querySelector('[data-testid="chat-msg-ai"]')
    return document.querySelectorAll('[data-testid="chat-msg-user"]').length === 1 && !!ai &&
      (ai.textContent ?? '').includes('E2E 总结') && (ai.textContent ?? '').includes('我先看看图谱里有哪些论文。')
  })()`)
  const evKinds = await evalJs<string[]>(`window.__evts.slice()`)
  const count = (k: string): number => evKinds.filter((x) => x === k).length
  const t1Events = count('turn-start') === 1 && count('part-start') > 0 && count('part-delta') > 0 && count('trace') === 2 && count('turn-end') === 1
  record('流式回答可见', t1Text && t1Events, `${t1Text ? '正文分块齐全' : '正文缺失'}；流事件 ${evKinds.length} 条（turn-start ${count('turn-start')} / part-start ${count('part-start')} / part-delta ${count('part-delta')} / trace ${count('trace')} / turn-end ${count('turn-end')}）`)
  ok = ok && t1Text && t1Events
  if (!t1Text) return finish()
  // trace 回源后仍在（口径 C：turn-end 后 getMessages 权威历史带回 data-trace part）
  const traceKept = await waitFor(`document.querySelectorAll('[data-testid="part-trace"]').length === 2`)
  record('trace 回源后仍在', traceKept, traceKept ? 'getPapers + readPaper 两行读取记录（DB 回源）' : 'trace 行丢失')
  ok = ok && traceKept
  // D178：对话 DOM 无金额；打开设置 → 用量与费用，用 Agent 对话 / 合计与
  // sessionCost、usage_records 对账（T1 恰好 3 次调用），随后返回画布继续 T2。
  const chatNoMoney = await waitFor(`(() => {
    const d = document.querySelector('[data-testid="chat-drawer"]')
    return !!d && !(d.textContent ?? '').includes('¥') && !document.querySelector('[data-testid="msg-cost"]') &&
      (document.querySelector('[data-testid="chat-cost"]')?.textContent ?? '').includes('deepseek-flash')
  })()`)
  const dbCost = Number((db.prepare('SELECT COALESCE(SUM(cost_cny),0) AS c FROM usage_records WHERE session_id = ?').get(sid1) as { c: number }).c.toFixed(2))
  const usageN = (db.prepare("SELECT COUNT(*) AS n FROM usage_records WHERE session_id = ? AND category = 'chat'").get(sid1) as { n: number }).n
  const apiCost = await evalJs<number>(`window.graphictero.sessionCost(${sid1})`)
  await click(`document.querySelector('.toolbar button[title="设置"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
  const settingsReady = await waitFor(`[...document.querySelectorAll('.sitem')].some((e) => (e.textContent ?? '').trim() === '用量与费用')`)
  if (settingsReady) await click(`__e2e.clickText('.sitem', '用量与费用')`)
  await waitFor(`!!document.querySelector('[data-testid="usage-section"]')`)
  await click(`document.querySelector('[data-testid="usage-range-all"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
  const usageCostOk = await waitFor(`(() => {
    const section = document.querySelector('[data-testid="usage-section"]')
    if (!section) return false
    const money = (sel) => {
      const text = document.querySelector(sel)?.querySelector('b')?.textContent ?? ''
      const match = text.match(/¥([\\d.]+)/)
      return match ? Number(match[1]) : NaN
    }
    const chat = money('[data-testid="usage-subtotal-chat"]')
    const total = money('[data-testid="usage-total"]')
    const totalText = document.querySelector('[data-testid="usage-total"]')?.textContent ?? ''
    const calls = (totalText.match(/(\\d+)\\s*次/) ?? [])[1]
    const chatRow = document.querySelector('[data-testid="usage-row-chat"]')?.textContent ?? ''
    return Math.abs(chat - ${dbCost}) < 0.005 && Math.abs(total - ${dbCost}) < 0.005 &&
      chatRow.includes('Agent 对话') && calls === '3' &&
      !!document.querySelector('[data-testid="usage-timeseries"] svg') &&
      !!document.querySelector('[data-testid="usage-donut"] svg')
  })()`)
  await click(`__e2e.clickText('.sitem', '返回')`)
  const backForT2 = await waitFor(`(document.querySelector('.ttl')?.textContent ?? '').includes('E2E对话图谱') &&
    !!document.querySelector('[data-testid="chat-drawer"] [data-testid="chat-input"]:not([disabled])')`)
  const costOk = chatNoMoney && usageCostOk && backForT2 && usageN === 3 && dbCost > 0.01 && Math.abs(apiCost - dbCost) < 0.005
  record('费用对账', costOk, `对话 DOM 无金额；设置 Agent 对话/合计 = sessionCost/usage_records ${dbCost.toFixed(2)}，${usageN} 次调用；已返回画布`)
  ok = ok && costOk

  // ── T2 停止保留 + 双 stop 幂等（12 轮读甲 × 每轮 150ms 延迟 ≈ 2s 回合窗口，中途 abort。
  //     轮数须 < ToolLoopAgent 默认 isStepCount(20)，否则循环自己到顶收尾）──
  await setStub([
    {
      kind: 'script',
      rounds: Array.from({ length: 12 }, (_, i) => ({
        text: `停止回合第 ${i + 1} 段。`,
        delayMs: 150,
        calls: [{ id: `c_${i}`, name: 'readPaper', arguments: JSON.stringify({ paperId: jia }) }]
      })),
      finalText: '不应到达的总结。',
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 0 }
    }
  ])
  await evalJs<boolean>(`__e2e.setInput('[data-testid="chat-input"]', '跑一个长回合')`)
  await click(`document.querySelector('[data-testid="chat-send"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
  // 运行态观测（页面侧锁存 + 时间线快照）：停止/发送按钮与流式正文分别 latch；
  // 中途补一发 ⌘Z 行为探测——若 toast「Agent 运行中」出现则 anyRunning 真（turns 非空，
  // 问题定位到 sessionId 选择；否则 turns 为空，问题在事件处理链）
  const running = await waitFor(`(() => {
    const t = [...document.querySelectorAll('[data-testid="chat-msg-ai"]')].at(-1)?.textContent ?? ''
    window.__t2 = window.__t2 || []
    window.__t2.push({ stop: !!document.querySelector('[data-testid="chat-stop"]'), send: !!document.querySelector('[data-testid="chat-send"]'), len: t.length })
    if (window.__t2.length > 120) window.__t2.shift()
    if (document.querySelector('[data-testid="chat-stop"]')) window.__sawStop = true
    if (t.includes('停止回合第 1 段')) window.__sawText = true
    if (window.__sawText && !window.__zFired) {
      window.__zFired = true
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }))
    }
    if ((document.querySelector('.toasts')?.textContent ?? '').includes('Agent 运行中')) window.__sawZToast = true
    return !!window.__sawStop && !!window.__sawText
  })()`)
  // 双 stop：连点两次（第二次命中 abort 后的空转路径，幂等不炸；?. 防按钮已消失）
  await click(`document.querySelector('[data-testid="chat-stop"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
  await click(`document.querySelector('[data-testid="chat-stop"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
  const stoppedBack = await waitFor(`!!document.querySelector('[data-testid="chat-send"]')`)
  const lastAi = await evalJs<string | null>(`(() => {
    const ais = [...document.querySelectorAll('[data-testid="chat-msg-ai"]')]
    return ais.length ? (ais[ais.length - 1].textContent ?? '') : null
  })()`)
  const lastAiDb = db
    .prepare("SELECT parts, error FROM session_messages WHERE session_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1")
    .get(sid1) as { parts: string; error: string | null }
  const stopOk =
    running && stoppedBack && lastAi != null && lastAi.includes('停止回合第 1 段') &&
    !lastAi.includes('不应到达的总结') && lastAiDb.error == null
  const stopDiag = !stopOk
    ? `running=${running} sawStop=${await evalJs<boolean>('!!window.__sawStop')} sawZToast=${await evalJs<boolean>('!!window.__sawZToast')} 收尾=${stoppedBack} dbErr=${lastAiDb?.error} 时间线=${await evalJs<string>('JSON.stringify((window.__t2 ?? []).slice(0, 12))')}`
    : ''
  record('停止保留 + 双 stop 幂等', stopOk, stopOk
    ? '中途连点两次停止：已生成段落保留、无错误挂消息（stopped 非错误）、回到发送态'
    : `保留内容/错误态不符：${stopDiag}`)
  ok = ok && stopOk

  // ── T3 候选链路（proposeCandidate → 卡 + 虚线节点 → 两处确认/忽略一致 → 确认后画布出新节点）──
  await setStub([
    {
      kind: 'script',
      rounds: [
        {
          text: '我提议两篇候选。',
          calls: [
            {
              id: 'c_in',
              name: 'proposeCandidate',
              arguments: JSON.stringify({
                title: 'E2E 库内命中论文',
                authors: ['Ru Chen'],
                year: 2024,
                doi: '10.9999/e2e-in-lib',
                reason: '库内命中理由'
              })
            },
            {
              id: 'c_out',
              name: 'proposeCandidate',
              arguments: JSON.stringify({
                title: 'E2E 库外候选',
                authors: ['Wai Zheng'],
                year: 2025,
                doi: '10.9999/e2e-out',
                reason: '库外理由'
              })
            }
          ]
        }
      ],
      finalText: '两篇候选已提出。',
      usage: { prompt_tokens: 300, completion_tokens: 60, prompt_cache_hit_tokens: 0 }
    }
  ])
  await sendText('推荐两篇候选')
  if (!(await waitFor(`document.querySelectorAll('[data-testid="part-paper-card"]').length === 2 && ${sendBackCode}`))) {
    record('候选卡 + 虚线节点', false, '候选回合未收尾（卡片未出现）')
    return finish()
  }
  const candOk = await waitFor(`(() => {
    const cards = [...document.querySelectorAll('[data-testid="part-paper-card"]')]
    const inLib = cards.find((c) => (c.textContent ?? '').includes('E2E 库内命中论文'))
    const out = cards.find((c) => (c.textContent ?? '').includes('E2E 库外候选'))
    if (!inLib || !out) return false
    const inBtn = inLib.querySelector('[data-testid="card-confirm"]')
    const outBtn = out.querySelector('[data-testid="card-confirm"]')
    const legend = document.querySelector('.legend')
    // lane/ui M6 批 1：库外确认实装（D124）——由「禁用 + 提示 M6」改为「可用 + 入库提示」
    return !!inBtn && !inBtn.disabled && !!outBtn && !outBtn.disabled && (outBtn.getAttribute('title') ?? '').includes('入库') &&
      document.querySelectorAll('[data-testid="cand-node"]').length === 2 && !!legend && (legend.textContent ?? '').includes('候选')
  })()`)
  record('候选卡 + 虚线节点', candOk, candOk ? '库内「加入图谱」可用、库外「确认入库」可用（D124）+ 2 虚线节点 + 图例' : `候选 UI 不完整：${await evalJs<string>(
    `JSON.stringify({
      cards: document.querySelectorAll('[data-testid="part-paper-card"]').length,
      candNodes: document.querySelectorAll('[data-testid="cand-node"]').length,
      legend: (document.querySelector('.legend')?.textContent ?? '').slice(0, 30),
      msgs: ([...document.querySelectorAll('[data-testid="chat-msg-ai"]')].at(-1)?.textContent ?? '').slice(0, 120),
      err: document.querySelector('[data-testid="chat-msg-error"]')?.textContent ?? null,
      toasts: (document.querySelector('.toasts')?.textContent ?? '').slice(0, 80),
      dbCands: ${JSON.stringify(db.prepare('SELECT id, title, status, existing_paper_id AS e FROM graph_candidates WHERE graph_id = ?').all(graphId))}
    })`
  )}`)
  ok = ok && candOk
  if (!candOk) return finish()

  // ── D182（uat6b）：重复提议命中本图已有 pending 候选 → 「已在待确认候选中」卡片 ──
  await setStub([
    {
      kind: 'script',
      rounds: [
        {
          text: '我再提议一次库外候选。',
          calls: [
            {
              id: 'c_dup',
              name: 'proposeCandidate',
              arguments: JSON.stringify({ title: 'E2E 库外候选', authors: ['Wai Zheng'], year: 2025, doi: '10.9999/e2e-out', reason: '重复提议理由' })
            }
          ]
        }
      ],
      finalText: '已命中待确认候选。',
      usage: { prompt_tokens: 200, completion_tokens: 40, prompt_cache_hit_tokens: 0 }
    }
  ])
  await sendText('再推一次库外候选')
  const dupCardOk = await waitFor(
    `[...document.querySelectorAll('[data-testid="part-paper-card"]')].some((c) => (c.textContent ?? '').includes('已在待确认候选中') && !!c.querySelector('[data-testid="card-locate"]')) && ${sendBackCode}`
  )
  const candRowsAfterDup = db.prepare('SELECT id, status FROM graph_candidates WHERE graph_id = ? ORDER BY id').all(graphId) as Array<{ id: number; status: string }>
  const dupNoNewRow = candRowsAfterDup.length === 2 && candRowsAfterDup.every((r) => r.status === 'pending') // 不新建重复行、无 dismissed 新行
  record('D182 已在待确认候选中', dupCardOk && dupNoNewRow, dupCardOk && dupNoNewRow
    ? '重复提议命中 pending → 出「已在待确认候选中」卡片（含定位按钮），候选行数不变'
    : `UI=${dupCardOk} rows=${JSON.stringify(candRowsAfterDup)}`)
  ok = ok && dupCardOk && dupNoNewRow
  // 卡片确认 → 加入图谱：节点消失、卡片「已加入图谱」、画布出真实新节点（graph_members 落库）
  const inLibPaper = paperId('E2E 库内命中论文')
  await click(`[...document.querySelectorAll('[data-testid="part-paper-card"]')].find((c) => (c.textContent ?? '').includes('E2E 库内命中论文')).querySelector('[data-testid="card-confirm"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
  // uat5-fix1 S6：库内论文无 PDF 时，确认加入图谱后立即排 candidate_pdf 查找——死端口
  // stub 下卡片很快进入进度/未找到 PDF 相位，「已加入图谱」可能不常驻卡片正文。断言
  // 放宽为：卡片显示「已在本图谱中」（D199 顶部药丸）**或**处于查找进度相位（进度行/未找到 PDF）；
  // 节点与 DB 断言不变（加入图谱即时生效由 member/status 落库兜底）。
  const confirmOk = await waitFor(`(() => {
    const cards = [...document.querySelectorAll('[data-testid="part-paper-card"]')]
    const inLib = cards.find((c) => (c.textContent ?? '').includes('E2E 库内命中论文'))
    const real = document.querySelectorAll('.react-flow__node').length - document.querySelectorAll('[data-testid="cand-node"]').length
    const hidden = [...document.querySelectorAll('.react-flow__node')].some((n) => getComputedStyle(n).visibility === 'hidden' || (n.getAttribute('style') ?? '').includes('visibility:hidden') || (n.getAttribute('style') ?? '').includes('visibility: hidden'))
    if (!inLib) return false
    const txt = inLib.textContent ?? ''
    const cardDone = txt.includes('已在本图谱中') // D199：原先待确认后入图与快照在图同一药丸文案
    const cardProgress = !!inLib.querySelector('[data-testid="card-progress"]') || txt.includes('未找到 PDF')
    return (cardDone || cardProgress) && document.querySelectorAll('[data-testid="cand-node"]').length === 1 && real === 4 && !hidden
  })()`)
  const memberAdded = !!db.prepare('SELECT 1 FROM graph_members WHERE graph_id = ? AND paper_id = ?').get(graphId, inLibPaper)
  const candConfirmed = (db.prepare("SELECT status FROM graph_candidates WHERE graph_id = ? ORDER BY id").all(graphId) as Array<{ status: string }>)[0]?.status === 'confirmed'
  record('候选确认两处一致', confirmOk && memberAdded && candConfirmed, confirmOk && memberAdded && candConfirmed
    ? '卡内「加入图谱」→ 虚线节点移除 + 卡片已在本图谱中 + 画布真实新节点（graph_members 落库）'
    : `UI=${confirmOk} member=${memberAdded} status=${candConfirmed}`)
  ok = ok && confirmOk && memberAdded && candConfirmed
  // 画布忽略 → 卡片同步「已忽略」、节点清零
  await click(`document.querySelector('[data-testid="cand-node"] [data-testid="cand-ignore"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
  const ignoreOk = await waitFor(`(() => {
    const cards = [...document.querySelectorAll('[data-testid="part-paper-card"]')]
    const out = cards.find((c) => (c.textContent ?? '').includes('E2E 库外候选'))
    return !!out && (out.textContent ?? '').includes('已忽略') && document.querySelectorAll('[data-testid="cand-node"]').length === 0
  })()`)
  record('候选忽略两处一致', ignoreOk, ignoreOk ? '画布忽略 → 卡片已忽略、虚线节点清零' : '忽略不同步')
  ok = ok && ignoreOk

  // ── T4 (i)（D143）：addRelation 命中预置既有边 = 拒绝——不改图小结、DB 原样、
  //     无快照行，拒绝信息落在工具结果/trace ──
  const presetRelId = (db.prepare("SELECT id FROM relations WHERE graph_id = ? AND statement_text = 'E2E 预置既有边'").get(graphId) as { id: number }).id
  await setStub(addRelScript(jia, yi, 'E2E 改写既有边'))
  await sendText('把甲和乙连一条关系')
  const rejectSettled = await waitFor(`document.querySelectorAll('[data-testid="part-graph-change"]').length === 0 && ${sendBackCode}`)
  const rejectDb = (() => {
    const row = db.prepare('SELECT statement_text AS s, updated_at AS u FROM relations WHERE id = ?').get(presetRelId) as { s: string; u: string }
    const snaps = (db.prepare('SELECT COUNT(*) AS n FROM relation_snapshots').get() as { n: number }).n
    return row.s === 'E2E 预置既有边' && row.u === '2020-01-01T00:00:00.000Z' && snaps === 0
  })()
  const rejectTrace = await waitFor(`[...document.querySelectorAll('[data-testid="part-trace"]')].some((t) => (t.textContent ?? '').includes('新增关系被拒'))`)
  record('addRelation 不覆盖既有边', rejectSettled && rejectDb && rejectTrace, rejectSettled && rejectDb && rejectTrace
    ? '命中预置边：无改图小结、陈述/updated_at（2020）原样、无快照行、trace「新增关系被拒」（D143）'
    : `收尾=${rejectSettled} DB=${rejectDb} trace=${rejectTrace}`)
  ok = ok && rejectSettled && rejectDb && rejectTrace

  // ── T4 (ii) 快照 (a)（M6 前置 2a，D129）：updateRelation 显式修改预置既有边 →
  //     小结写「修改」，撤销按改动前快照还原原陈述（含原 created_at / source_type）──
  await setStub(updateRelScript(presetRelId, 'E2E 修改后的陈述'))
  await sendText('把甲和乙的那条关系改一下')
  const gc1 = await waitFor(`document.querySelectorAll('[data-testid="part-graph-change"]').length === 1 && ${sendBackCode}`)
  if (!gc1) {
    record('快照a：修改既有边可撤销', false, '改图回合未收尾（小结行未出现）')
    return finish()
  }
  // 小结行写「修改」（D143）+ data-change=updateRelation
  const owText = await evalJs<string | null>(`(() => {
    const gc = __e2e.lastGChange()
    return gc ? (gc.textContent ?? '') + '|' + (gc.getAttribute('data-change') ?? '') : null
  })()`)
  const owSummaryOk = (owText ?? '').includes('修改关系') && (owText ?? '').includes('updateRelation')
  record('修改小结显示「修改」', owSummaryOk, owSummaryOk ? 'updateRelation 小结 + 「修改关系 #N（原：…）」（D143）' : `小结不对：${owText}`)
  ok = ok && owSummaryOk
  // 定位 flash（改图小结「定位」→ 画布边高亮）
  await click(`__e2e.lastGChange().querySelector('[data-testid="gchange-locate"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
  const flashOk = await waitFor(`!!document.querySelector('.react-flow__edge.gt-flash')`)
  record('改图小结定位 flash', gc1 && flashOk, gc1 && flashOk ? 'data-graph-change 小结行 + 定位 → 边 flash 高亮' : '小结行或 flash 缺失')
  ok = ok && gc1 && flashOk
  // 快照写库断言：op=update 的 relation_snapshots 行已存在（撤销前就在）
  const snapRow = db
    .prepare("SELECT id FROM relation_snapshots WHERE op = 'update' ORDER BY id DESC LIMIT 1")
    .get() as { id: number } | undefined
  // 撤销：经 snapshotIds → rel:restoreSnapshot → 还原预置边原陈述
  await click(`__e2e.lastGChange().querySelector('[data-testid="gchange-undo"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
  const guardA = await waitFor(`(document.querySelector('.toasts')?.textContent ?? '').includes('已撤销本轮全部 1 条改动')`)
  const relRow = db
    .prepare('SELECT created_at AS c, statement_text AS s, source_type AS t FROM relations WHERE graph_id = ? AND deleted_at IS NULL')
    .get(graphId) as { c: string; s: string; t: string }
  const guardADb = snapRow != null && relRow.c === '2020-01-01T00:00:00.000Z' && relRow.s === 'E2E 预置既有边' && relRow.t === 'session'
  record('快照a：修改既有边可撤销', guardA && guardADb, guardA && guardADb
    ? `快照 #${snapRow!.id} 还原：原陈述 / created_at（2020）/ source_type 全部还原（D129）`
    : `UI=${guardA} snapshot=${snapRow?.id} DB=${JSON.stringify(relRow)}`)
  ok = ok && guardA && guardADb

  // ── T5 新建边（甲–丙，保留不撤，给守卫 b 当「上一回合建的边」）──
  // 改图后画布重载：边数与顶栏「N 篇 · M 条关系」跟库内活边一致（确认后成员为 4）
  await setStub(addRelScript(jia, bing, 'E2E 上一回合建的边'))
  await sendText('把甲和丙连起来')
  const t5Ok =
    (await waitFor(
      `document.querySelectorAll('[data-testid="part-graph-change"]').length === 2 && document.querySelectorAll('.react-flow__edge').length === 2 && (document.querySelector('.toolbar')?.textContent ?? '').includes('4 篇') && (document.querySelector('.toolbar')?.textContent ?? '').includes('2 条关系') && ${sendBackCode}`
    )) && liveRelations() === 2
  let t5Detail = t5Ok ? '甲–丙新边落库（库内活边 2），画布边与顶栏同步' : '新边未落到画布或顶栏'
  if (!t5Ok) {
    let dom = ''
    try {
      dom = await evalJs<string>(`JSON.stringify({
        gc: document.querySelectorAll('[data-testid="part-graph-change"]').length,
        edges: document.querySelectorAll('.react-flow__edge').length,
        nodes: document.querySelectorAll('.react-flow__node').length,
        cands: document.querySelectorAll('[data-testid="cand-node"]').length,
        toolbar: (document.querySelector('.toolbar')?.textContent ?? '').replace(/\\s+/g, ' ').slice(0, 180),
        send: !!document.querySelector('[data-testid="chat-send"]'),
        stop: !!document.querySelector('[data-testid="chat-stop"]'),
        lastAi: ([...document.querySelectorAll('[data-testid="chat-msg-ai"]')].at(-1)?.textContent ?? '').slice(0, 120),
        tail: (window.__evts ?? []).slice(-8)
      })`)
    } catch (err) {
      dom = err instanceof Error ? err.message : String(err)
    }
    const errTail = rendererErrors.slice(-3).join(' | ')
    t5Detail = `新边未落到画布或顶栏 live=${liveRelations()} ${dom}${errTail ? ` renderer=${errTail}` : ''}`
  }
  record('上一回合新建边', t5Ok, t5Detail)
  ok = ok && t5Ok
  if (!t5Ok) return finish()

  // ── T6 守卫放行路径：本回合新建边（乙–丙）撤销成功删除 ──
  await setStub(addRelScript(yi, bing, 'E2E 本回合新建边'))
  await sendText('把乙和丙连起来')
  if (!(await waitFor(`document.querySelectorAll('[data-testid="part-graph-change"]').length === 3 && ${sendBackCode}`)) || liveRelations() !== 3) {
    record('守卫放行：本回合新建边可撤销', false, '乙–丙新边未落库')
    return finish()
  }
  await click(`__e2e.lastGChange().querySelector('[data-testid="gchange-undo"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
  // 撤销成功 → gt:graph-changed → 画布重载：此刻画布边数 = 库内活边数（2）
  const undoNewOk = await waitFor(`document.querySelectorAll('.react-flow__edge').length === 2 && (document.querySelector('.toasts')?.textContent ?? '').includes('已撤销本轮全部 1 条改动')`)
  const softDeleted = liveRelations() === 2
  record('守卫放行：本回合新建边可撤销', undoNewOk && softDeleted, undoNewOk && softDeleted
    ? '撤销 → 边删除（软删）、toast「已撤销本轮全部 1 条改动」' : `UI=${undoNewOk} 库内活边=${liveRelations()}`)
  ok = ok && undoNewOk && softDeleted

  // ── T7 快照 (b)（M6 前置 2a，D129）：第二个改图回合用 updateRelation 改写 T5 的边
  //     → 撤销还原到 T5 内容（无更晚回合再动过它，守卫放行）──
  const t5RelId = (db.prepare("SELECT id FROM relations WHERE graph_id = ? AND statement_text = 'E2E 上一回合建的边'").get(graphId) as { id: number }).id
  await setStub(updateRelScript(t5RelId, 'E2E 跨回合改写'))
  await sendText('再把甲和丙的关系改一下')
  if (!(await waitFor(`document.querySelectorAll('[data-testid="part-graph-change"]').length === 4 && ${sendBackCode}`))) {
    record('快照b：跨回合改写撤销还原到上一回合内容', false, '第 4 条小结行未出现')
    return finish()
  }
  await click(`__e2e.lastGChange().querySelector('[data-testid="gchange-undo"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
  const guardB = await waitFor(`(document.querySelector('.toasts')?.textContent ?? '').includes('已撤销本轮全部 1 条改动')`)
  const t5EdgeRestored = !!db
    .prepare("SELECT 1 FROM relations WHERE graph_id = ? AND deleted_at IS NULL AND statement_text = 'E2E 上一回合建的边'")
    .get(graphId)
  record('快照b：跨回合改写撤销还原到上一回合内容', guardB && t5EdgeRestored, guardB && t5EdgeRestored
    ? '改写 T5 边的回合撤销 → 快照还原到「E2E 上一回合建的边」（D129）；更晚回合再改同边才拒（单测覆盖）'
    : `UI=${guardB} 边还原=${t5EdgeRestored}`)
  ok = ok && guardB && t5EdgeRestored

  // ── T7b B1：listRelations——模型先查边再回答，trace 行与库内边数一致 ──
  await setStub([
    {
      kind: 'script',
      rounds: [
        {
          text: '我先查一下图上已有的关系。',
          calls: [{ id: 'c_lr', name: 'listRelations', arguments: '{}' }]
        }
      ],
      finalText: '经 listRelations 核对：图上现有 2 条关系，方向与类型已与库内一致。',
      usage: { prompt_tokens: 300, completion_tokens: 60, prompt_cache_hit_tokens: 0 }
    }
  ])
  await sendText('图上有哪些关系？')
  const lrOk = await waitFor(`(() => {
    const ais = [...document.querySelectorAll('[data-testid="chat-msg-ai"]')]
    const last = ais.at(-1)
    if (!last || !(last.textContent ?? '').includes('经 listRelations 核对')) return false
    return [...document.querySelectorAll('[data-testid="part-trace"]')].some((t) => (t.textContent ?? '').includes('查看图谱关系列表'))
  })() && ${sendBackCode}`)
  const lrDb = liveRelations() === 2
  record('listRelations 查边再答', lrOk && lrDb, lrOk && lrDb
    ? '先 listRelations（trace 行「查看图谱关系列表」）再总结；库内活边 2 条与回答一致（B1）'
    : `UI=${lrOk} 库内活边=${liveRelations()}`)
  ok = ok && lrOk && lrDb

  // ── T7c：full.md 原文（readPaper 章节 + searchLibrary 全文），不改 T1 的无原文路径 ──
  {
    const fullMd = '# 方法\n\nuat3b-fullmd-token 是合成原文。\n\n表 3 合成对照。\n\n图 2 合成示意图。\n'
    const mineruDir = join(state.dataDir, 'papers', String(jia), 'mineru')
    mkdirSync(mineruDir, { recursive: true })
    writeFileSync(join(mineruDir, 'full.md'), fullMd, 'utf8')
    indexFullTextFts(db, jia, fullMd)
    await setStub([
      {
        kind: 'script',
        rounds: [
          {
            text: '我先在原文里检索。',
            calls: [{ id: 'c_sl', name: 'searchLibrary', arguments: JSON.stringify({ query: 'uat3b-fullmd-token' }) }]
          },
          {
            text: '再读方法节。',
            calls: [{ id: 'c_rp', name: 'readPaper', arguments: JSON.stringify({ paperId: jia, section: '方法' }) }]
          }
        ],
        finalText: '方法节已读到 uat3b-fullmd-token。',
        usage: { prompt_tokens: 200, completion_tokens: 40, prompt_cache_hit_tokens: 0 }
      }
    ])
    await sendText('方法节里写了什么？')
    const fullUi = await waitFor(`(() => {
      const ais = [...document.querySelectorAll('[data-testid="chat-msg-ai"]')]
      const last = ais.at(-1)
      if (!last || !(last.textContent ?? '').includes('uat3b-fullmd-token')) return false
      return [...document.querySelectorAll('[data-testid="part-trace"]')].some((t) => (t.textContent ?? '').includes('uat3b-fullmd-token'))
    })() && ${sendBackCode}`)
    const fullDb = (
      db.prepare('SELECT summary, excerpt FROM session_traces WHERE session_id = ?').all(sid1) as Array<{
        summary: string
        excerpt: string | null
      }>
    ).some((t) => t.summary.includes('uat3b-fullmd-token') || (t.excerpt ?? '').includes('uat3b-fullmd-token'))
    record('原文 full.md 检索与阅读', fullUi && fullDb, fullUi && fullDb ? 'searchLibrary / readPaper 读到合成原文 token' : `UI=${fullUi} DB=${fullDb}`)
    ok = ok && fullUi && fullDb
  }

  // ── T8 deleteSession 与在跑回合竞态（D122：先 stop 再物理删除级联）──
  let stage = 'init'
  try {
  stage = 'click-new-session'
  await click(`document.querySelector('[data-testid="chat-new-session"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
  // 新会话真实落库（轮询 DB 直到 MAX(id) 越过 sid1），再等输入可用 + 发送态——守卫防竞态
  stage = 'wait-sid2'
  let sid2 = sid1
  for (let i = 0; i < 100 && sid2 <= sid1; i++) {
    await sleep(100)
    sid2 = latestSessionId()
  }
  stage = 'wait-racePre'
  const racePre = await waitFor(`!!document.querySelector('[data-testid="chat-input"]:not([disabled])') && ${sendBackCode}`)
  if (sid2 === sid1 || !racePre) {
    record('deleteSession 与在跑回合竞态', false, `第二个会话未就绪（sid2=${sid2} 输入态=${racePre}）`)
    return finish()
  }
  stage = 'reinject-helpers'
  await evalJs<boolean>(E2E_HELPERS) // 页内工具幂等重注（防页面意外重载后 __e2e 丢失）
  stage = 'set-stub-race'
  await setStub([
    {
      kind: 'script',
      rounds: Array.from({ length: 8 }, (_, i) => ({
        text: `竞态回合第 ${i + 1} 段。`,
        delayMs: 200,
        calls: [{ id: `d_${i}`, name: 'readPaper', arguments: JSON.stringify({ paperId: jia }) }]
      })),
      finalText: '不应到达。',
      usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 0 }
    }
  ])
  stage = 'set-input-race'
  await evalJs<boolean>(`__e2e.setInput('[data-testid="chat-input"]', '跑着别停，我要删会话')`)
  stage = 'wait-sendback'
  await waitFor(sendBackCode)
  stage = 'click-send-race'
  await click(`document.querySelector('[data-testid="chat-send"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
  // 等第 1 段正文 + 首次调用计费落库后再删（保证 usage_records 有行可留）
  stage = 'wait-running-first-seg'
  if (!(await waitFor(`!!document.querySelector('[data-testid="chat-stop"]') && ([...document.querySelectorAll('[data-testid="chat-msg-ai"]')].at(-1)?.textContent ?? '').includes('竞态回合第 1 段')`))) {
    stage = 'race-diag'
    const raceDiag = await evalJs<string>(`JSON.stringify({
      stop: !!document.querySelector('[data-testid="chat-stop"]'),
      send: !!document.querySelector('[data-testid="chat-send"]'),
      lastAi: ([...document.querySelectorAll('[data-testid="chat-msg-ai"]')].at(-1)?.textContent ?? '').slice(0, 60),
      err: document.querySelector('[data-testid="chat-msg-error"]')?.textContent ?? null,
      toasts: (document.querySelector('.toasts')?.textContent ?? '').slice(0, 60),
      evts: (window.__evts ?? []).slice(-6)
    })`)
    record('deleteSession 与在跑回合竞态', false, `回合未进入运行态：${raceDiag}`)
    return finish()
  }
  stage = 'click-session-picker'
  await click(`document.querySelector('[data-testid="session-picker"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
  stage = 'wait-session-menu'
  if (!(await waitFor(`!!document.querySelector('[data-testid="session-menu-delete"]')`))) {
    record('deleteSession 与在跑回合竞态', false, '会话菜单未展开')
    return finish()
  }
  stage = 'click-menu-delete'
  await click(`document.querySelector('[data-testid="session-menu-delete"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
  stage = 'wait-cfm'
  const cfmUp = await waitFor(`!!document.querySelector('.cfm')`)
  stage = 'click-cfm-confirm'
  await click(`document.querySelector('.cfm .btn.dfill')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
  stage = 'wait-deleted-ui'
  const deletedUi = await waitFor(`!document.querySelector('.cfm') && !!document.querySelector('[data-testid="chat-drawer"]')`, 20000)
  // onOk 先同步关弹窗再异步删除（先 stop 再删），轮询等库落地而不是立即查一次
  let sid2Gone = db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sid2) == null
  for (let i = 0; i < 100 && !sid2Gone; i++) {
    await sleep(100)
    sid2Gone = db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sid2) == null
  }
  const msgsGone = () => (db.prepare('SELECT COUNT(*) AS n FROM session_messages WHERE session_id = ?').get(sid2) as { n: number }).n === 0
  const usageKept = () => (db.prepare('SELECT COUNT(*) AS n FROM usage_records WHERE session_id IS NULL').get() as { n: number }).n > 0
  let raceDetail = ''
  if (!sid2Gone) {
    // UI 点删除后库还在：定位断点——读页面 toast / 会话列表，再从页面直接调 IPC 对照
    // （diag 自身包 try：eval/IPC 拒绝都转成可读字符串，不让诊断再抛）
    stage = 'delete-recovery-diag'
    let diag = '<eval-failed>'
    try {
      diag = await evalJs<string>(`JSON.stringify({
      toasts: (document.querySelector('.toasts')?.textContent ?? '').slice(0, 60),
      picker: (document.querySelector('[data-testid="session-picker"]')?.textContent ?? '').slice(0, 60),
      hasApi: typeof window.graphictero,
      cfmStill: !!document.querySelector('.cfm'),
      direct: await (async () => {
        try {
          if (!window.graphictero) return 'no-api'
          await window.graphictero.deleteSession(${sid2})
          return 'ok'
        } catch (err) {
          return 'reject: ' + (err && err.message ? err.message : String(err))
        }
      })()
    })`)
    } catch (err) {
      diag = `<diag eval 失败: ${err instanceof Error ? err.message : String(err)}>`
    }
    raceDetail = ` UI 删除未落库（诊断后页面直调 IPC：${diag}）`
    sid2Gone = db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sid2) == null
  }
  const raceOk = cfmUp && deletedUi && sid2Gone && msgsGone() && usageKept()
  record('deleteSession 与在跑回合竞态', raceOk, raceOk
    ? '运行中删除 → 先 stop 再物理删除；消息级联清空、usage_records 保留（session_id 置空）、应用存活'
    : `cfm=${cfmUp} UI=${deletedUi} session 删=${sid2Gone} 消息删=${msgsGone()} usage 留=${usageKept()}${raceDetail}`)
  ok = ok && raceOk
  } catch (e) {
    // eval 在页面重载/异常 DOM 下抛错：转成可读的失败步骤而不是整场 fatal
    record('deleteSession 与在跑回合竞态', false, `执行异常（stage=${stage}）：${e instanceof Error ? e.message : String(e)}`)
    ok = false
  }

  return finish()
}
