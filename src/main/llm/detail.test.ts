import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { coerceDetailParts, generateDetail, getDetailView, getPaperMetaView, parseDetailParts, repairDetailJson } from './detail'
import { DETAIL_PROMPT } from './prompts'
import { startStubLlm, type StubLlm } from './stubServer'

/**
 * 详情读取服务层测试（D29/D106，M4 lane/detail 批 1）：
 * - staleReason 三种取值（prompt 版本变化 / PDF 哈希变化 / 均不变 = null）；
 * - v1 纯文本详情（非合法 parts 数组）读取时降级包成单个 text part（D106）；
 * - getMeta：paper_authors 优先、csl_json container-title 出处、abstract_source。
 * 全部走测试库，不触 LLM / 网络。
 */

let dir: string
let db: Database.Database

let doiSeq = 0
function insertPaper(opts: { hasPdf?: number; pdfHash?: string | null; deleted?: boolean } = {}): number {
  const now = new Date().toISOString()
  const r = db
    .prepare(
      "INSERT INTO papers (title, source, has_pdf, pdf_hash, csl_json, doi, year, zotero_item_key, created_at, updated_at) VALUES (?, 'zotero', ?, ?, ?, ?, 2024, 'ABCD2345', ?, ?)"
    )
    .run('Test Paper', opts.hasPdf ?? 1, opts.pdfHash ?? null, JSON.stringify({ 'container-title': ['Proc. Test'], author: [{ given: 'Zed', family: 'Csl' }] }), `10.1000/x${doiSeq++}`, now, now)
  const id = Number(r.lastInsertRowid)
  if (opts.deleted) db.prepare('UPDATE papers SET deleted_at = ? WHERE id = ?').run(now, id)
  return id
}

function insertDetail(paperId: number, parts: unknown, opts: { promptVersion?: string; pdfHash?: string | null } = {}): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO paper_details (paper_id, parts, model, prompt_version, pdf_hash, generated_at, created_at, updated_at)
     VALUES (?, ?, 'deepseek-flash', ?, ?, ?, ?, ?)`
  ).run(paperId, typeof parts === 'string' ? parts : JSON.stringify(parts), opts.promptVersion ?? DETAIL_PROMPT.version, opts.pdfHash ?? null, now, now, now)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-detail-read-'))
  db = openDatabase(join(dir, 'graphictero.db'))
  runMigrations(db, MIGRATIONS)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

let stub: StubLlm | null = null

async function detailWith(text: string, paperId: number, opts: { force?: boolean } = {}) {
  stub = await startStubLlm([{ kind: 'ok', text }])
  const llm = () => ({ baseUrl: stub!.baseUrl, apiKey: 'k', model: 'deepseek-flash' })
  return generateDetail({ db, paperId, markdown: '# Paper\n\n正文。', pdfHash: 'h1', llm, now: () => new Date('2026-10-26T12:00:00Z'), force: opts.force })
}

afterEach(async () => {
  await stub?.close()
  stub = null
})

const interactivePart = {
  type: 'data-interactive',
  id: 'power-law',
  status: 'done',
  title: '幂律误差探索',
  params: [
    { id: 'a', label: '指数 a', control: 'slider', min: 0.2, max: 3, step: 0.1, default: 1 },
    { id: 'n', label: '次数 n', control: 'number', min: 1, max: 1000, step: 1, default: 10 }
  ],
  expressions: [{ id: 'err', label: '误差', expr: 'n^(-a)', precision: 4 }],
  plot: {
    x: { xVar: 'n', from: 1, to: 1000, samples: 100 },
    series: [{ expr: 'err', label: '误差' }],
    kind: 'line'
  },
  caption: '调整参数。',
  sourceNote: '自造式 (1)'
}

describe('parseDetailParts（D106 生成侧解析）', () => {
  it('合法 parts 数组原样通过；空数组不合法', () => {
    const arr = [{ type: 'text', text: 'x' }, { type: 'data-figure', id: 'f1', status: 'done', figureNo: 2 }, interactivePart]
    expect(parseDetailParts(JSON.stringify(arr))).toEqual(arr)
    expect(parseDetailParts('[]')).toBeNull()
  })
  it('剥 ```json 围栏后解析', () => {
    expect(parseDetailParts('```json\n[{"type":"text","text":"围栏内"}]\n```')).toEqual([{ type: 'text', text: '围栏内' }])
    expect(parseDetailParts('```\n[{"type":"text","text":"无语言标记"}]\n```')).toEqual([{ type: 'text', text: '无语言标记' }])
  })
  it('非法 JSON / zod 不过返回 null', () => {
    expect(parseDetailParts('不是 JSON')).toBeNull()
    expect(parseDetailParts('{"type":"text"}')).toBeNull() // 非数组
    expect(parseDetailParts('[{"type":"nope"}]')).toBeNull()
    expect(parseDetailParts('[{"type":"data-figure","id":"f","status":"done"}]')).toBeNull() // 缺 figureNo
    const invalidInteractive = structuredClone(interactivePart)
    invalidInteractive.expressions[0].expr = 'missing + n'
    expect(parseDetailParts(JSON.stringify([{ type: 'text', text: '保留' }, invalidInteractive]))).toBeNull()
  })

  describe('D210 未转义引号修复', () => {
    // 自造样例（非真实论文）：text 值内有未转义 ASCII 双引号 + 裸换行/制表符
    const broken =
      '[{"type":"text","text":"## 它在解决什么问题\n\n现有评测比较的是"某一时刻的完整系统"，\t不够细。"},' +
      '{"type":"data-figure","id":"fig-1","status":"done","figureNo":3,"caption":"示例图注"}]'
    const repaired = [
      { type: 'text', text: '## 它在解决什么问题\n\n现有评测比较的是"某一时刻的完整系统"，\t不够细。' },
      { type: 'data-figure', id: 'fig-1', status: 'done', figureNo: 3, caption: '示例图注' }
    ]
    it('repairDetailJson 转义字符串值内的内容引号与裸换行/制表符', () => {
      expect(() => JSON.parse(broken)).toThrow()
      const fixed = repairDetailJson(broken)
      expect(JSON.parse(fixed)).toEqual(repaired)
    })
    it('repairDetailJson 不动合法 JSON', () => {
      const good = JSON.stringify(repaired)
      expect(repairDetailJson(good)).toBe(good)
    })
    it('parseDetailParts 修复未转义引号 + data-figure 的样例', () => {
      expect(parseDetailParts(broken)).toEqual(repaired)
      expect(parseDetailParts(JSON.stringify(repaired))).toEqual(repaired)
    })
    it('确实乱码（值内伪 "key": 结构）仍返回 null', () => {
      expect(parseDetailParts('[{"type":"text","text":"他说"key": 1"}]')).toBeNull()
    })
    it('生成侧：stub 返回未转义引号 JSON → 修复后按 parts 入库（不再降级为单 text）', async () => {
      const pid = insertPaper({ pdfHash: 'h1' })
      const r = await detailWith(broken, pid)
      expect(r.parts).toEqual(repaired)
      const row = db.prepare('SELECT parts FROM paper_details WHERE paper_id = ?').get(pid) as { parts: string }
      expect(JSON.parse(row.parts)).toEqual(repaired)
      expect(stub!.requests.length).toBe(1) // 修复不产生二次调用
    })
    it('读取侧自愈：单 text part 去围栏后以 [ 开头 → 返回修复后 parts', () => {
      // 当年生成侧降级入库的样子：parts 数组里包着一段原始（坏）JSON 字符串
      const stored = JSON.stringify([{ type: 'text', text: broken }])
      expect(coerceDetailParts(stored)).toEqual(repaired)
    })
    it('读取侧自愈：带 ```json 围栏的降级文本同样可修复', () => {
      const stored = JSON.stringify([{ type: 'text', text: '```json\n' + broken + '\n```' }])
      expect(coerceDetailParts(stored)).toEqual(repaired)
    })
    it('读取侧自愈写库且幂等：getDetailView 修复后回写，再次读取不再改写', () => {
      const pid = insertPaper({ pdfHash: 'h1' })
      insertDetail(pid, JSON.stringify([{ type: 'text', text: broken }]), { promptVersion: DETAIL_PROMPT.version, pdfHash: 'h1' })
      const v1 = getDetailView(db, pid)!
      expect(v1.parts).toEqual(repaired)
      const afterFirst = (db.prepare('SELECT parts FROM paper_details WHERE paper_id = ?').get(pid) as { parts: string }).parts
      expect(JSON.parse(afterFirst)).toEqual(repaired) // 已回写修复结果
      const v2 = getDetailView(db, pid)!
      expect(v2.parts).toEqual(repaired)
      const afterSecond = (db.prepare('SELECT parts FROM paper_details WHERE paper_id = ?').get(pid) as { parts: string }).parts
      expect(afterSecond).toBe(afterFirst) // 幂等：第二次读取不再写
    })
    it('D211 交互 part 同样经过宽松修复与读取自愈，修复后再过 schema', () => {
      const repaired = [{ ...interactivePart, caption: '原文称"误差幂律"可见。' }]
      const brokenInteractive = JSON.stringify(repaired).replaceAll('\\"', '"')
      expect(() => JSON.parse(brokenInteractive)).toThrow()
      expect(parseDetailParts(brokenInteractive)).toEqual(repaired)
      const stored = JSON.stringify([{ type: 'text', text: brokenInteractive }])
      expect(coerceDetailParts(stored)).toEqual(repaired)
    })
    it('v1 纯 Markdown 读取路径不受影响（不以 [ 开头不触发修复）', () => {
      const md = '# 标题\n\n正文。'
      expect(coerceDetailParts(md)).toEqual([{ type: 'text', text: md }])
    })
  })
})

describe('generateDetail · prompt v3（D106/D92/D100；uat2 固定小标题）', () => {
  it('uat2 f：DETAIL_PROMPT 为 v3 且要求原型 v45_03 四个固定小标题（逐字）', () => {
    expect(DETAIL_PROMPT.version).toBe('detail-v3')
    for (const h of ['它在解决什么问题', '## 方法', '## 结论', '## 局限']) {
      expect(DETAIL_PROMPT.system).toContain(h)
    }
    // 固定小标题顺序：问题 → 方法 → 结论 → 局限
    const idx = ['它在解决什么问题', '## 方法', '## 结论', '## 局限'].map((s) => DETAIL_PROMPT.system.indexOf(s))
    expect(idx.every((i) => i >= 0)).toBe(true)
    expect(idx).toEqual([...idx].sort((a, b) => a - b))
    expect(DETAIL_PROMPT.system).toContain('data-interactive')
    expect(DETAIL_PROMPT.system).toContain('每篇最多 1–2 个')
    expect(DETAIL_PROMPT.system).toContain('不得编造')
    expect(DETAIL_PROMPT.system).toContain('log 是 log10')
  })

  it('合法 parts JSON 入库为数组，版本写 detail-v3', async () => {
    const pid = insertPaper({ pdfHash: 'h1' })
    const arr = [
      { type: 'text', text: '## 方法\n\n正文。' },
      { type: 'data-figure', id: 'fig-overview', status: 'done', figureNo: 2, caption: '方法总览' },
      { type: 'data-mermaid', id: 'mm-flow', status: 'done', title: '流程', code: 'graph TD; A-->B' },
      interactivePart
    ]
    const r = await detailWith(JSON.stringify(arr), pid)
    expect(r.parts).toEqual(arr)
    const row = db.prepare('SELECT parts, prompt_version FROM paper_details WHERE paper_id = ?').get(pid) as { parts: string; prompt_version: string }
    expect(row.prompt_version).toBe('detail-v3')
    expect(JSON.parse(row.parts)).toEqual(arr)
    // 生成后读取：版本一致 → 不过期
    expect(getDetailView(db, pid)!.staleReason).toBeNull()
  })
  it('围栏包裹的合法 JSON 同样入库为 parts', async () => {
    const pid = insertPaper()
    const r = await detailWith('```json\n[{"type":"text","text":"围栏正文"}]\n```', pid)
    expect(r.parts).toEqual([{ type: 'text', text: '围栏正文' }])
  })
  it('非法 JSON → 整段降级为单个 text part（保留原文，不重试、只计一次调用）', async () => {
    const pid = insertPaper()
    const r = await detailWith('模型胡言乱语，不是 JSON', pid)
    expect(r.parts).toEqual([{ type: 'text', text: '模型胡言乱语，不是 JSON' }])
    expect(stub!.requests.length).toBe(1)
    const row = db.prepare('SELECT parts FROM paper_details WHERE paper_id = ?').get(pid) as { parts: string }
    expect(JSON.parse(row.parts)).toEqual([{ type: 'text', text: '模型胡言乱语，不是 JSON' }])
  })
  it('zod 校验不过 → 降级为单个 text part', async () => {
    const pid = insertPaper()
    const r = await detailWith('[{"type":"text"},{"type":"data-figure"}]', pid)
    expect(r.parts).toEqual([{ type: 'text', text: '[{"type":"text"},{"type":"data-figure"}]' }])
  })
  it('D211 非法 data-interactive 沿用整份详情文本降级，不影响其它 part 的既有规则', async () => {
    const badInteractive = JSON.stringify([{ ...interactivePart, expressions: [{ id: 'err', label: '误差', expr: 'forward + 1' }] }])
    const pid = insertPaper()
    const r = await detailWith(badInteractive, pid)
    expect(r.parts).toEqual([{ type: 'text', text: badInteractive }])
    expect(stub!.requests.length).toBe(1)
  })
  it('存量 v1 纯文本详情读取显示「可能已过期」（D110 口径：prompt 版本变化）', () => {
    const pid = insertPaper({ pdfHash: 'h1' })
    insertDetail(pid, 'v1 时代的整段 Markdown 详情。', { promptVersion: 'detail-v1', pdfHash: 'h1' })
    const v = getDetailView(db, pid)!
    expect(v.staleReason).toBe('prompt')
    expect(v.parts).toEqual([{ type: 'text', text: 'v1 时代的整段 Markdown 详情。' }])
  })
  it('内嵌 base64 图片在送入模型前换成短占位（D141）', async () => {
    const pid = insertPaper({ pdfHash: 'h-b64' })
    stub = await startStubLlm([{ kind: 'ok', text: '[{"type":"text","text":"ok"}]' }])
    const llm = () => ({ baseUrl: stub!.baseUrl, apiKey: 'k', model: 'deepseek-flash' })
    const blob = 'A'.repeat(4096)
    await generateDetail({
      db,
      paperId: pid,
      markdown: `前文\n![示意图](data:image/png;base64,${blob})\n后文`,
      pdfHash: 'h-b64',
      llm,
      now: () => new Date('2026-10-26T12:00:00Z')
    })
    const body = JSON.stringify(stub.requests)
    expect(body).not.toContain('base64,')
    expect(body).toContain('[图：示意图]')
    expect(body).toContain('后文')
  })
  it('force 重新生成覆盖旧详情（D42，版本+哈希未变也强制）', async () => {
    const pid = insertPaper({ pdfHash: 'h1' })
    insertDetail(pid, [{ type: 'text', text: '旧详情' }], { promptVersion: DETAIL_PROMPT.version, pdfHash: 'h1' })
    const r = await detailWith('[{"type":"text","text":"新详情"}]', pid, { force: true })
    expect(r.parts).toEqual([{ type: 'text', text: '新详情' }])
    expect(getDetailView(db, pid)!.parts).toEqual([{ type: 'text', text: '新详情' }])
  })
})

describe('coerceDetailParts（D106 读取降级）', () => {
  it('合法 parts 数组原样返回', () => {
    const parts = [
      { type: 'text', text: '第一段' },
      { type: 'data-figure', id: 'f1', status: 'done', figureNo: 2, caption: '图 2' },
      interactivePart
    ]
    expect(coerceDetailParts(JSON.stringify(parts))).toEqual(parts)
  })
  it('v1 纯 Markdown 文本包成单个 text part（不丢内容）', () => {
    const md = '# 标题\n\n## 方法\n\n正文 **加粗**。'
    const out = coerceDetailParts(md)
    expect(out).toEqual([{ type: 'text', text: md }])
  })
  it('非法 JSON / 空数组 / 结构不合法都降级为单个 text part', () => {
    expect(coerceDetailParts('not json{{{')).toEqual([{ type: 'text', text: 'not json{{{' }])
    expect(coerceDetailParts('[]')).toEqual([{ type: 'text', text: '[]' }])
    expect(coerceDetailParts(JSON.stringify([{ type: 'nope' }]))).toEqual([{ type: 'text', text: JSON.stringify([{ type: 'nope' }]) }])
    expect(coerceDetailParts('"just a string"')).toEqual([{ type: 'text', text: '"just a string"' }])
  })
})

describe('getDetailView · staleReason（D29）', () => {
  it('prompt 版本与 PDF 哈希都未变 → staleReason null', () => {
    const pid = insertPaper({ pdfHash: 'h1' })
    insertDetail(pid, [{ type: 'text', text: '缓存正文' }], { promptVersion: DETAIL_PROMPT.version, pdfHash: 'h1' })
    const v = getDetailView(db, pid)
    expect(v).not.toBeNull()
    expect(v!.staleReason).toBeNull()
    expect(v!.parts).toEqual([{ type: 'text', text: '缓存正文' }])
    expect(v!.model).toBe('deepseek-flash')
  })
  it('prompt 版本变化 → staleReason=prompt（优先于 pdf）', () => {
    const pid = insertPaper({ pdfHash: 'h2' })
    insertDetail(pid, [{ type: 'text', text: 'x' }], { promptVersion: 'detail-v0', pdfHash: 'h1' })
    expect(getDetailView(db, pid)!.staleReason).toBe('prompt')
  })
  it('prompt 一致但 PDF 哈希变化 → staleReason=pdf', () => {
    const pid = insertPaper({ pdfHash: 'h2' })
    insertDetail(pid, [{ type: 'text', text: 'x' }], { promptVersion: DETAIL_PROMPT.version, pdfHash: 'h1' })
    expect(getDetailView(db, pid)!.staleReason).toBe('pdf')
  })
  it('无详情 / 论文不存在 / 已删除 → null', () => {
    const pid = insertPaper()
    expect(getDetailView(db, pid)).toBeNull()
    expect(getDetailView(db, 9999)).toBeNull()
    const deleted = insertPaper({ deleted: true })
    insertDetail(deleted, [{ type: 'text', text: 'x' }])
    expect(getDetailView(db, deleted)).toBeNull()
  })
})

describe('getPaperMetaView', () => {
  it('作者取 paper_authors（按 position），出处取 csl_json container-title', () => {
    const pid = insertPaper()
    db.prepare("INSERT INTO paper_authors (paper_id, position, family, given, normalized) VALUES (?, 0, 'Zhang', 'Wei', 'wei zhang')").run(pid)
    db.prepare("INSERT INTO paper_authors (paper_id, position, family, given, normalized) VALUES (?, 1, 'Li', 'Na', 'na li')").run(pid)
    const m = getPaperMetaView(db, pid)!
    expect(m.authors).toEqual(['Wei Zhang', 'Na Li'])
    expect(m.venue).toBe('Proc. Test')
    expect(m.doi).toContain('10.1000/x')
    expect(m.year).toBe(2024)
    expect(m.zoteroItemKey).toBe('ABCD2345')
    expect(m.hasPdf).toBe(true)
  })
  it('无 paper_authors 时回退 csl_json 作者，再退 first_author', () => {
    const pid = insertPaper()
    expect(getPaperMetaView(db, pid)!.authors).toEqual(['Zed Csl'])
    db.prepare(`UPDATE papers SET csl_json = '{}' WHERE id = ?`).run(pid)
    db.prepare("UPDATE papers SET first_author = 'Solo' WHERE id = ?").run(pid)
    expect(getPaperMetaView(db, pid)!.authors).toEqual(['Solo'])
  })
  it('摘要与 abstract_source 透传；论文不存在返回 null', () => {
    const pid = insertPaper()
    db.prepare("UPDATE papers SET abstract = 'AI 写的摘要', abstract_source = 'ai' WHERE id = ?").run(pid)
    const m = getPaperMetaView(db, pid)!
    expect(m.abstract).toBe('AI 写的摘要')
    expect(m.abstractSource).toBe('ai')
    expect(getPaperMetaView(db, 9999)).toBeNull()
  })
})
