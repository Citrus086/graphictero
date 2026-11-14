import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { indexPaperFts } from '../db/fts'
import { indexFullTextFts } from '../db/fulltextFts'
import { clipWords, createAgentTools, type ToolContext } from './tools'
import { makeFakeOpenAlex } from '../openalex/testing'
import { AGENT_TOOL_NAMES } from '../llm/prompts'
import { restoreSnapshot } from '../relations/snapshots'
import type { PaperCardPart } from '../../shared/parts'
import type { GraphChangePart, TracePart } from '../../shared/parts'

/** M5 lane/agent：本地 6 工具（校验错误作为工具结果返回 D86；改图 source=session D16；自动类型 D89）。 */

let dir: string
let db: Database.Database
let dataDir: string
let graphId: number
let paperA: number
let paperB: number
let traces: TracePart[]
let changes: GraphChangePart[]
let cards: PaperCardPart[]
let sessionId: number

const now = (): string => new Date().toISOString()

function makeCtx(): ToolContext {
  return {
    db,
    dataDir,
    sessionId,
    graphId,
    turnId: 'turn-test-1',
    model: 'deepseek-flash',
    promptVersion: 'agent-v7',
    emitTrace: (t) => {
      traces.push({ type: 'data-trace', toolName: t.toolName, paperId: t.paperId ?? undefined, summary: t.summary, excerpt: t.excerpt })
    },
    onGraphChange: (c) => {
      changes.push({ type: 'data-graph-change', id: `g${changes.length + 1}`, status: 'done', ...c })
    },
    onPaperCard: (card) => {
      cards.push(card)
    }
  }
}

function insertPaper(title: string): number {
  return Number(
    db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES (?, 'zotero', 1, ?, ?)").run(title, now(), now()).lastInsertRowid
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-agent-'))
  dataDir = join(dir, 'data')
  mkdirSync(join(dataDir, 'papers'), { recursive: true })
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS)
  graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('工具图', now(), now()).lastInsertRowid)
  sessionId = Number(db.prepare("INSERT INTO sessions (graph_id, entry_type, entry_id, name, created_at, updated_at) VALUES (?, 'graph', NULL, 's', ?, ?)").run(graphId, now(), now()).lastInsertRowid)
  paperA = insertPaper('论文甲')
  paperB = insertPaper('论文乙')
  const ins = db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)')
  ins.run(graphId, paperA, now())
  ins.run(graphId, paperB, now())
  traces = []
  changes = []
  cards = []
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('agent 工具（本地 6 个）', () => {
  it('getPapers：列出图谱成员并落 trace', async () => {
    const tools = createAgentTools(makeCtx())
    const r = (await tools.getPapers.execute!({} as never, {} as never)) as { papers: Array<{ paperId: number }> }
    expect(r.papers.map((p) => p.paperId)).toEqual([paperA, paperB])
    expect(traces).toHaveLength(1)
    expect(traces[0].toolName).toBe('getPapers')
  })

  it('readPaper：读 full.md 原文（目录/按节/无原文不回退详情，D68）；未知论文返回 error（D86）', async () => {
    // 详情存在但无 full.md：绝不回退详情解读
    db.prepare(
      `INSERT INTO paper_details (paper_id, parts, model, prompt_version, generated_at, created_at, updated_at)
       VALUES (?, '[{"type":"text","text":"详情正文"}]', 'deepseek-flash', 'detail-v2', ?, ?, ?)`
    ).run(paperA, now(), now(), now())
    const tools0 = createAgentTools(makeCtx())
    const noFull = (await tools0.readPaper.execute!({ paperId: paperA } as never, {} as never)) as { fullText: null; note: string; detail?: string }
    expect(noFull.fullText).toBeNull()
    expect(noFull.note).toContain('还没有解析出全文')
    expect(noFull.detail).toBeUndefined()
    // 写入自造 full.md fixture（短 Markdown，非论文全文）
    mkdirSync(join(dataDir, 'papers', String(paperA), 'mineru'), { recursive: true })
    writeFileSync(
      join(dataDir, 'papers', String(paperA), 'mineru', 'full.md'),
      '# 引言\n本文讨论检索增强。\n\n## 2 方法\n方法用图 1 展示。\n\n## 3 实验\n见表 2。\n',
      'utf8'
    )
    const tools = createAgentTools(makeCtx())
    const toc = (await tools.readPaper.execute!({ paperId: paperA } as never, {} as never)) as {
      fullText: boolean
      toc: { sections: Array<{ title: string }>; figures: string[]; tables: string[] }
    }
    expect(toc.fullText).toBe(true)
    expect(toc.toc.sections.map((s) => s.title)).toEqual(['引言', '2 方法', '3 实验'])
    expect(toc.toc.figures).toEqual(['图 1'])
    expect(toc.toc.tables).toEqual(['表 2'])
    const sec = (await tools.readPaper.execute!({ paperId: paperA, section: '2' } as never, {} as never)) as { section: { title: string }; text: string; location: string }
    expect(sec.section.title).toBe('2 方法')
    expect(sec.text).toContain('图 1')
    expect(sec.location).toBe('§2 方法')
    const missing = (await tools.readPaper.execute!({ paperId: 99999 } as never, {} as never)) as { error: string }
    expect(missing.error).toContain('不存在')
  })

  it('readPaper / searchLibrary：full.md 内嵌 base64 图片替换为占位（uat5 必须修 1，D141）', async () => {
    mkdirSync(join(dataDir, 'papers', String(paperA), 'mineru'), { recursive: true })
    writeFileSync(
      join(dataDir, 'papers', String(paperA), 'mineru', 'full.md'),
      '# 1 概述\n如图所示。\n\n![架构图](data:image/png;base64,QUJDREVGRw==)\n\n## 2 方法\n流程见下。\n\n<img src="data:image/jpeg;base64,QUJDREVGRw==" alt="流程图">\n正文提到 CRISPR 技术。\n',
      'utf8'
    )
    indexFullTextFts(
      db,
      paperA,
      '# 1 概述\n如图所示。\n\n![架构图](data:image/png;base64,QUJDREVGRw==)\n\n## 2 方法\n流程见下。\n\n<img src="data:image/jpeg;base64,QUJDREVGRw==" alt="流程图">\n正文提到 CRISPR 技术。\n'
    )
    const tools = createAgentTools(makeCtx())
    const sec = (await tools.readPaper.execute!({ paperId: paperA, section: '2' } as never, {} as never)) as { text: string }
    expect(sec.text).not.toContain('data:image')
    expect(sec.text).not.toContain('QUJD')
    expect(sec.text).toContain('[图：流程图]')
    const r = (await tools.searchLibrary.execute!({ query: 'CRISPR', limit: 10 } as never, {} as never)) as {
      fullTextHits: Array<{ snippet: string }>
    }
    expect(r.fullTextHits).toHaveLength(1)
    expect(r.fullTextHits[0].snippet).not.toContain('data:image')
    expect(r.fullTextHits[0].snippet).not.toContain('QUJD')
    // 磁盘 full.md 保持 MinerU 原样（阅读器要用 data URI）
    expect(readFileSync(join(dataDir, 'papers', String(paperA), 'mineru', 'full.md'), 'utf8')).toContain('data:image/png;base64')
  })

  it('searchLibrary：元数据 FTS + 原文全文 FTS（命中片段 + 章节位置，D77 不新增工具）', async () => {
    indexPaperFts(db, paperA, { title: '强化学习综述', abstract: 'reinforcement learning survey', keywords: [] })
    indexPaperFts(db, paperB, { title: '无关标题', abstract: 'biology', keywords: [] })
    // 原文索引：paperB 正文含检索词（paperA 正文不含）
    mkdirSync(join(dataDir, 'papers', String(paperB), 'mineru'), { recursive: true })
    writeFileSync(join(dataDir, 'papers', String(paperB), 'mineru', 'full.md'), '# 生物方法\n用 CRISPR 做基因编辑。\n', 'utf8')
    indexFullTextFts(db, paperB, '# 生物方法\n用 CRISPR 做基因编辑。\n')
    const tools = createAgentTools(makeCtx())
    const r = (await tools.searchLibrary.execute!({ query: '强化学习', limit: 10 } as never, {} as never)) as {
      papers: Array<{ paperId: number }>
      fullTextHits: Array<{ paperId: number; section: string | null; snippet: string }>
    }
    expect(r.papers.map((p) => p.paperId)).toEqual([paperA])
    const r2 = (await tools.searchLibrary.execute!({ query: 'CRISPR', limit: 10 } as never, {} as never)) as typeof r
    expect(r2.fullTextHits).toHaveLength(1)
    expect(r2.fullTextHits[0].paperId).toBe(paperB)
    expect(r2.fullTextHits[0].section).toBe('生物方法')
    expect(r2.fullTextHits[0].snippet).toContain('CRISPR')
    expect(traces[0].summary).toContain('强化学习')
  })

  it('getFigure：按图号返回图注；无解析产物时报错', async () => {
    mkdirSync(join(dataDir, 'papers', String(paperA), 'mineru'), { recursive: true })
    writeFileSync(
      join(dataDir, 'papers', String(paperA), 'mineru', 'structured_content.json'),
      JSON.stringify({ pages: [{ page_idx: 2, blocks: [{ type: 'image', bbox: [0.1, 0.1, 0.5, 0.5], captions: [{ content: '图 1：架构图' }], image_source: 'images/a.png' }] }] })
    )
    const tools = createAgentTools(makeCtx())
    const ok = (await tools.getFigure.execute!({ paperId: paperA, figureNo: 1 } as never, {} as never)) as { page: number; caption: string }
    expect(ok).toMatchObject({ page: 3, caption: '图 1：架构图' })
    const missing = (await tools.getFigure.execute!({ paperId: paperB, figureNo: 1 } as never, {} as never)) as { error: string }
    expect(missing.error).toContain('没有找到图 1')
  })

  it('clipWords：拉丁词整词回退，中文按字数截断', () => {
    expect(clipWords('Hello wonderful world', 10)).toBe('Hello…')
    expect(clipWords('中文摘要不按词', 4)).toBe('中文摘要…')
    expect(clipWords('短', 4)).toBe('短')
  })

  it('addRelation：直接生效 source=session，provenance 记会话/模型/prompt；D89 自动类型由程序附加', async () => {
    // D93：同一作者 → 自动附加 same_author
    const insA = db.prepare('INSERT INTO paper_authors (paper_id, position, family, given, normalized) VALUES (?, 0, ?, ?, ?)')
    insA.run(paperA, 'Zhang', 'San', 'zhang san')
    insA.run(paperB, 'Zhang', 'San', 'zhang san')

    const tools = createAgentTools(makeCtx())
    const r = (await tools.addRelation.execute!(
      { srcPaperId: paperA, dstPaperId: paperB, statement: '乙改进了甲的方法', types: ['implements'] } as never,
      {} as never
    )) as { relationId: number; autoTypes: string }

    expect(r.autoTypes).toContain('同一作者') // B7：工具结果只出中文类型名
    const rel = db.prepare('SELECT * FROM relations WHERE id = ?').get(r.relationId) as Record<string, unknown>
    expect(rel).toMatchObject({
      graph_id: graphId,
      src_paper: paperA,
      paper_low: Math.min(paperA, paperB),
      source_type: 'session',
      source_session_id: 1,
      model: 'deepseek-flash',
      prompt_version: 'agent-v7',
      deleted_at: null
    })
    expect(JSON.parse(rel.auto_types as string)).toContain('same_author')
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ changeType: 'addRelation', relationIds: [r.relationId] })
  })

  it('addRelation 校验错误作为工具结果返回（D86）：自环 / 不在图中 / 未知类型 / 自动类型不可手选', async () => {
    const insN = db.prepare('INSERT INTO paper_authors (paper_id, position, family, given, normalized) VALUES (?, 0, ?, ?, ?)')
    insN.run(paperA, 'Zhang', 'San', 'zhang san')
    insN.run(paperB, 'Zhang', 'San', 'zhang san')
    const tools = createAgentTools(makeCtx())

    const self = (await tools.addRelation.execute!({ srcPaperId: paperA, dstPaperId: paperA, statement: 'x', types: ['compares'] } as never, {} as never)) as { error: string }
    expect(self.error).toContain('自环')
    const outsider = insertPaper('局外')
    const notIn = (await tools.addRelation.execute!({ srcPaperId: paperA, dstPaperId: outsider, statement: 'x', types: ['compares'] } as never, {} as never)) as { error: string }
    expect(notIn.error).toContain('不在当前图谱')

    const unknown = (await tools.addRelation.execute!({ srcPaperId: paperA, dstPaperId: paperB, statement: 'x', types: ['不存在的类型'] } as never, {} as never)) as { error: string }
    expect(unknown.error).toContain('未知的关系类型')
    const autoType = (await tools.addRelation.execute!({ srcPaperId: paperA, dstPaperId: paperB, statement: 'x', types: ['cites'] } as never, {} as never)) as { error: string }
    expect(autoType.error).toContain('自动附加')
  })

  it('B7：addRelation 入参中文名与英文 id 等价，结果只出中文类型名', async () => {
    const tools = createAgentTools(makeCtx())
    const zh = (await tools.addRelation.execute!({ srcPaperId: paperA, dstPaperId: paperB, statement: '甲乙对比', types: ['对比'] } as never, {} as never)) as { relationId: number }
    const row = db.prepare('SELECT llm_types FROM relations WHERE id = ?').get(zh.relationId) as { llm_types: string }
    expect(JSON.parse(row.llm_types)).toEqual(['compares'])
    // 工具结果 JSON 里不出现英文类型 id
    const result = JSON.stringify(zh)
    for (const t of ['based_on', 'implements', 'compares', 'cites', 'same_author']) {
      expect(result).not.toContain(t)
    }
  })

  it('D143：addRelation 反向命中既有 job 边 = 拒绝——返回既有边信息，DB 字节不变、无快照、无小结', async () => {
    const insN = db.prepare('INSERT INTO paper_authors (paper_id, position, family, given, normalized) VALUES (?, 0, ?, ?, ?)')
    insN.run(paperA, 'Zhang', 'San', 'zhang san')
    insN.run(paperB, 'Zhang', 'San', 'zhang san')
    // 预置一条 job 边：A→B，带 provenance（source_job_id 外键指向 jobs 行）
    const jobId = Number(
      db.prepare("INSERT INTO jobs (kind, paper_id, status, payload, created_at, updated_at) VALUES ('relation_gen', ?, 'succeeded', '{}', ?, ?)").run(paperA, now(), now()).lastInsertRowid
    )
    db.prepare(
      `INSERT INTO relations (graph_id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types,
         source_type, source_job_id, model, prompt_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, '原 job 陈述', '["compares"]', '["same_author"]', 'job', ?, 'm', 'rel-v1', ?, ?)`
    ).run(graphId, Math.min(paperA, paperB), Math.max(paperA, paperB), paperA, jobId, now(), now())
    const rid = (db.prepare('SELECT id FROM relations WHERE graph_id = ?').get(graphId) as { id: number }).id
    const before = db.prepare('SELECT statement_text, llm_types, auto_types, source_type, src_paper, updated_at FROM relations WHERE id = ?').get(rid) as Record<string, unknown>

    const tools = createAgentTools(makeCtx())
    // 模型反向传参（B→A）：同一对处理，同样拒绝，方向不翻
    const r = (await tools.addRelation.execute!(
      { srcPaperId: paperB, dstPaperId: paperA, statement: '会话版陈述', types: ['基于/改进'] } as never,
      {} as never
    )) as {
      rejected: boolean
      reason: string
      existing: { relationId: number; direction: string; types: string; statement: string; source: string }
      message: string
    }

    expect(r).toMatchObject({ rejected: true, reason: 'pair_has_relation' })
    expect(r.existing).toMatchObject({ relationId: rid, direction: 'P01→P02', types: '对比 · 同一作者', statement: '原 job 陈述', source: '自动生成' })
    expect(r.message).toContain(`updateRelation（relationId=${rid}）`)
    expect(r.message).toContain('deleteRelation')
    // uat3b D156：被拒后不自动 updateRelation——除非用户明确要求，否则说明既有边并问用户
    expect(r.message).toContain('用户明确要求修改这条边')
    expect(r.message).toContain('询问用户是否要修改')
    // D143：不写库——DB 行字节不变（statement/llm_types/auto_types/source_type/src_paper/updated_at）
    const after = db.prepare('SELECT statement_text, llm_types, auto_types, source_type, src_paper, updated_at FROM relations WHERE id = ?').get(rid) as Record<string, unknown>
    expect(after).toEqual(before)
    expect(after.statement_text).toBe('原 job 陈述')
    expect(after.source_type).toBe('job')
    // 不存快照、不改图小结；trace 记一条拒绝
    expect(db.prepare('SELECT COUNT(*) AS n FROM relation_snapshots').get()).toEqual({ n: 0 })
    expect(changes).toHaveLength(0)
    expect(traces.at(-1)!.toolName).toBe('addRelation')
    expect(traces.at(-1)!.summary).toContain('新增关系被拒')
  })

  it('D143：addRelation 同向命中既有 session 边 = 拒绝（同一对只一条边，D89）', async () => {
    const tools = createAgentTools(makeCtx())
    await tools.addRelation.execute!({ srcPaperId: paperA, dstPaperId: paperB, statement: '一', types: ['compares'] } as never, {} as never)
    changes.length = 0
    traces.length = 0

    const r = (await tools.addRelation.execute!({ srcPaperId: paperA, dstPaperId: paperB, statement: '二', types: ['compares'] } as never, {} as never)) as {
      rejected: boolean
      existing: { relationId: number; statement: string; source: string; direction: string; types: string }
    }
    expect(r.rejected).toBe(true)
    expect(r.existing).toMatchObject({ statement: '一', source: '会话或手动', direction: 'P01→P02', types: '对比' })
    // 未写入：陈述不变、无快照、无小结
    expect((db.prepare('SELECT statement_text AS s FROM relations WHERE graph_id = ?').get(graphId) as { s: string }).s).toBe('一')
    expect(db.prepare('SELECT COUNT(*) AS n FROM relation_snapshots').get()).toEqual({ n: 0 })
    expect(changes).toHaveLength(0)
  })

  it('updateRelation：改陈述——同事务快照 + 小结「修改」+ 未给字段保持原值 + 撤销字节还原', async () => {
    const insN = db.prepare('INSERT INTO paper_authors (paper_id, position, family, given, normalized) VALUES (?, 0, ?, ?, ?)')
    insN.run(paperA, 'Zhang', 'San', 'zhang san')
    insN.run(paperB, 'Zhang', 'San', 'zhang san')
    const jobId = Number(
      db.prepare("INSERT INTO jobs (kind, paper_id, status, payload, created_at, updated_at) VALUES ('relation_gen', ?, 'succeeded', '{}', ?, ?)").run(paperA, now(), now()).lastInsertRowid
    )
    db.prepare(
      `INSERT INTO relations (graph_id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types,
         source_type, source_job_id, model, prompt_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, '原 job 陈述', '["compares"]', '["same_author"]', 'job', ?, 'm', 'rel-v1', ?, ?)`
    ).run(graphId, Math.min(paperA, paperB), Math.max(paperA, paperB), paperA, jobId, now(), now())
    const rid = (db.prepare('SELECT id FROM relations WHERE graph_id = ?').get(graphId) as { id: number }).id

    const tools = createAgentTools(makeCtx())
    const r = (await tools.updateRelation.execute!({ relationId: rid, statement: '修改后的陈述' } as never, {} as never)) as {
      relationId: number
      updated: boolean
      before: { types: string; statement: string; source: string; direction: string }
      after: { types: string; statement: string; direction: string }
    }
    expect(r).toMatchObject({ relationId: rid, updated: true })
    expect(r.before).toMatchObject({ types: '对比 · 同一作者', statement: '原 job 陈述', source: '自动生成', direction: 'P01→P02' })
    expect(r.after.statement).toBe('修改后的陈述')

    const row = db.prepare('SELECT * FROM relations WHERE id = ?').get(rid) as Record<string, unknown>
    expect(row.statement_text).toBe('修改后的陈述')
    // 未给的字段保持原值；provenance 翻 session（与 addRelation 新建/updateRelation 修改路径一致，D16）
    expect(row.llm_types).toBe('["compares"]')
    expect(row.src_paper).toBe(paperA)
    expect(JSON.parse(row.auto_types as string)).toContain('same_author') // D89 自动类型重新附加后不丢
    expect(row).toMatchObject({ source_type: 'session', source_job_id: null, source_session_id: sessionId, model: 'deepseek-flash', prompt_version: 'agent-v7' })

    // 同事务改动前快照（D129）+ 改图小结标「修改」+ snapshotIds
    const snap = db.prepare('SELECT * FROM relation_snapshots WHERE relation_id = ?').get(rid) as Record<string, unknown>
    expect(snap.op).toBe('update')
    const beforeJson = JSON.parse(snap.before_json as string) as Record<string, unknown>
    expect(beforeJson).toMatchObject({ statement: '原 job 陈述', sourceType: 'job', sourceJobId: jobId, srcPaperId: paperA })
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ changeType: 'updateRelation', relationIds: [rid], snapshotIds: [snap.id] })
    expect(changes[0].summary).toContain('修改关系')
    expect(changes[0].summary).toContain('原 job 陈述')

    // 撤销：按快照还原，字节一致（含原 source_type / source_job_id / 方向）
    restoreSnapshot(db, snap.id as number)
    const restored = db.prepare('SELECT * FROM relations WHERE id = ?').get(rid) as Record<string, unknown>
    expect(restored.statement_text).toBe('原 job 陈述')
    expect(restored.llm_types).toBe('["compares"]')
    expect(restored.source_type).toBe('job')
    expect(restored.source_job_id).toBe(jobId)
    expect(restored.src_paper).toBe(paperA)
  })

  it('updateRelation：改类型（中英都收）+ 自动类型不可手选 + 未知类型中文报错', async () => {
    db.prepare(
      `INSERT INTO relations (graph_id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types,
         source_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, '原陈述', '["compares"]', '[]', 'session', ?, ?)`
    ).run(graphId, Math.min(paperA, paperB), Math.max(paperA, paperB), paperA, now(), now())
    const rid = (db.prepare('SELECT id FROM relations WHERE graph_id = ?').get(graphId) as { id: number }).id
    const tools = createAgentTools(makeCtx())

    const zh = (await tools.updateRelation.execute!({ relationId: rid, types: ['基于/改进'] } as never, {} as never)) as { updated: boolean; after: { types: string; statement: string } }
    expect(zh.updated).toBe(true)
    expect(zh.after.types).toBe('基于/改进')
    expect(zh.after.statement).toBe('原陈述') // 未给 statement 保持原值
    expect((db.prepare('SELECT llm_types AS t FROM relations WHERE id = ?').get(rid) as { t: string }).t).toBe('["based_on"]')

    const auto = (await tools.updateRelation.execute!({ relationId: rid, types: ['cites'] } as never, {} as never)) as { error: string }
    expect(auto.error).toContain('自动附加')
    const unknown = (await tools.updateRelation.execute!({ relationId: rid, types: ['不存在的类型'] } as never, {} as never)) as { error: string }
    expect(unknown.error).toContain('未知的关系类型')
  })

  it('uat4-fix2 S5：updateRelation 拒绝把展示版当原文——与 listRelations 展示串逐字相同或含《短标题》替换痕迹均拒绝、保留原文；工具描述锁定「展示版」说明', async () => {
    db.prepare(
      `INSERT INTO relations (graph_id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types,
         source_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'P01 的方法被 P02 改进。', '["based_on"]', '[]', 'job', ?, ?)`
    ).run(graphId, Math.min(paperA, paperB), Math.max(paperA, paperB), paperA, now(), now())
    const rid = (db.prepare('SELECT id FROM relations WHERE graph_id = ?').get(graphId) as { id: number }).id
    const tools = createAgentTools(makeCtx())

    // 工具描述里锁「statement 是展示版」说明
    expect(tools.updateRelation.description).toContain('展示版')

    // listRelations 返回的是展示版（P0x→《短标题》）
    const listed = (await tools.listRelations.execute!({} as never, {} as never)) as {
      relations: Array<{ relationId: number; statement: string }>
    }
    const displayVersion = listed.relations.find((r) => r.relationId === rid)!.statement
    expect(displayVersion).toContain('《') // 确认拿到的是替换后的展示串

    // ① 把展示串原样回传 → 拒绝、库内原文不变
    const r1 = (await tools.updateRelation.execute!({ relationId: rid, statement: displayVersion } as never, {} as never)) as { error: string }
    expect(r1.error).toContain('展示版')
    expect((db.prepare('SELECT statement_text AS s FROM relations WHERE id = ?').get(rid) as { s: string }).s).toBe('P01 的方法被 P02 改进。')

    // ② 含《短标题》替换痕迹（原文是 P0x）→ 同样拒绝
    const r2 = (await tools.updateRelation.execute!({ relationId: rid, statement: '《论文甲》 完全超越了 P02 的方法。' } as never, {} as never)) as { error: string }
    expect(r2.error).toContain('展示版')
    expect((db.prepare('SELECT statement_text AS s FROM relations WHERE id = ?').get(rid) as { s: string }).s).toBe('P01 的方法被 P02 改进。')

    // ③ 用户/模型自己组织的新陈述（P0x 写法，非逐字展示串）→ 正常写入
    const r3 = (await tools.updateRelation.execute!({ relationId: rid, statement: 'P02 在 P01 的基础上做了实质性扩展。' } as never, {} as never)) as { updated: boolean }
    expect(r3.updated).toBe(true)
    expect((db.prepare('SELECT statement_text AS s FROM relations WHERE id = ?').get(rid) as { s: string }).s).toBe('P02 在 P01 的基础上做了实质性扩展。')
  })

  it('updateRelation：显式 srcPaperId 才翻转方向；不给方向保持原方向', async () => {
    db.prepare(
      `INSERT INTO relations (graph_id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types,
         source_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, '原陈述', '["compares"]', '[]', 'session', ?, ?)`
    ).run(graphId, Math.min(paperA, paperB), Math.max(paperA, paperB), paperA, now(), now())
    const rid = (db.prepare('SELECT id FROM relations WHERE graph_id = ?').get(graphId) as { id: number }).id
    const tools = createAgentTools(makeCtx())

    const flip = (await tools.updateRelation.execute!({ relationId: rid, srcPaperId: paperB } as never, {} as never)) as {
      updated: boolean
      directionChanged?: string
      after: { direction: string }
    }
    expect(flip.updated).toBe(true)
    expect(flip.directionChanged).toBe('P01→P02')
    expect(flip.after.direction).toBe('P02→P01')
    expect((db.prepare('SELECT src_paper AS s FROM relations WHERE id = ?').get(rid) as { s: number }).s).toBe(paperB)

    // 不给 srcPaperId 的后续修改保持已翻方向
    const keep = (await tools.updateRelation.execute!({ relationId: rid, statement: '只改陈述' } as never, {} as never)) as { updated: boolean; directionChanged?: string }
    expect(keep.updated).toBe(true)
    expect(keep.directionChanged).toBeUndefined()
    expect((db.prepare('SELECT src_paper AS s FROM relations WHERE id = ?').get(rid) as { s: number }).s).toBe(paperB)
  })

  it('D143 遗留夹具：有引用数据时 updateRelation 不隐式翻转方向（引用推定只用于新建边）；显式 srcPaperId 优先', async () => {
    // 引用数据：paperA 的参考文献匹配到 paperB → 推定方向 B→A（与现边 A→B 相反）
    db.prepare(
      `INSERT INTO paper_references (paper_id, openalex_wid, doi, title, year, matched_paper_id, source, created_at)
       VALUES (?, 'W1', NULL, '乙', 2020, ?, 'openalex', ?)`
    ).run(paperA, paperB, now())
    db.prepare(
      `INSERT INTO relations (graph_id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types,
         source_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, '原陈述', '["compares"]', '[]', 'session', ?, ?)`
    ).run(graphId, Math.min(paperA, paperB), Math.max(paperA, paperB), paperA, now(), now())
    const rid = (db.prepare('SELECT id FROM relations WHERE graph_id = ?').get(graphId) as { id: number }).id
    const tools = createAgentTools(makeCtx())

    // ① 只改陈述（不给 srcPaperId）：尽管引用数据推定 B→A，方向也不隐式翻转
    const keep = (await tools.updateRelation.execute!({ relationId: rid, statement: '有引用数据后的新陈述' } as never, {} as never)) as {
      updated: boolean
      directionChanged?: string
    }
    expect(keep.updated).toBe(true)
    expect(keep.directionChanged).toBeUndefined()
    expect((db.prepare('SELECT src_paper AS s FROM relations WHERE id = ?').get(rid) as { s: number }).s).toBe(paperA)

    // ② 显式 srcPaperId 改方向：翻转（引用数据不改变「显式优先」口径）
    const flip = (await tools.updateRelation.execute!({ relationId: rid, srcPaperId: paperB } as never, {} as never)) as {
      updated: boolean
      directionChanged?: string
      after: { direction: string }
    }
    expect(flip.updated).toBe(true)
    expect(flip.directionChanged).toBeDefined()
    expect((db.prepare('SELECT src_paper AS s FROM relations WHERE id = ?').get(rid) as { s: number }).s).toBe(paperB)
  })

  it('updateRelation：错误入参中文报错（不存在/他图/已删除/非端点 srcPaperId/空修改）', async () => {
    db.prepare(
      `INSERT INTO relations (graph_id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types,
         source_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, '原陈述', '["compares"]', '[]', 'session', ?, ?)`
    ).run(graphId, Math.min(paperA, paperB), Math.max(paperA, paperB), paperA, now(), now())
    const rid = (db.prepare('SELECT id FROM relations WHERE graph_id = ?').get(graphId) as { id: number }).id
    const otherGraph = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('别图', now(), now()).lastInsertRowid)
    db.prepare('INSERT INTO relations (graph_id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types, source_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(otherGraph, paperA, paperB, paperA, '别的图', '["compares"]', '[]', 'session', now(), now())
    const otherId = (db.prepare('SELECT id FROM relations WHERE graph_id = ?').get(otherGraph) as { id: number }).id
    const outsider = insertPaper('局外')
    const tools = createAgentTools(makeCtx())

    const missing = (await tools.updateRelation.execute!({ relationId: 99999, statement: 'x' } as never, {} as never)) as { error: string }
    expect(missing.error).toContain('不存在或已删除')
    const cross = (await tools.updateRelation.execute!({ relationId: otherId, statement: 'x' } as never, {} as never)) as { error: string }
    expect(cross.error).toContain('不存在或已删除')
    const notEndpoint = (await tools.updateRelation.execute!({ relationId: rid, srcPaperId: outsider } as never, {} as never)) as { error: string }
    expect(notEndpoint.error).toContain('两端之一')
    const empty = (await tools.updateRelation.execute!({ relationId: rid } as never, {} as never)) as { error: string }
    expect(empty.error).toContain('至少提供一项修改')

    // 已删除的边不能改；且错误路径不写快照
    await tools.deleteRelation.execute!({ relationId: rid } as never, {} as never)
    const deleted = (await tools.updateRelation.execute!({ relationId: rid, statement: 'x' } as never, {} as never)) as { error: string }
    expect(deleted.error).toContain('不存在或已删除')
  })

  it('B1：listRelations 有边/无边/按论文过滤/软删除不出现，只出中文类型名', async () => {
    const tools = createAgentTools(makeCtx())
    const empty = (await tools.listRelations.execute!({} as never, {} as never)) as { relations: unknown[]; total: number }
    expect(empty.relations).toEqual([])
    expect(empty.total).toBe(0)

    await tools.addRelation.execute!({ srcPaperId: paperA, dstPaperId: paperB, statement: '甲乙的关系陈述', types: ['compares'] } as never, {} as never)
    const all = (await tools.listRelations.execute!({} as never, {} as never)) as { relations: Array<Record<string, unknown>>; total: number }
    expect(all.total).toBe(1)
    expect(all.relations[0]).toMatchObject({ relationId: 1, direction: 'P01→P02', types: '对比', source: '会话或手动' })
    expect(String(all.relations[0].statement)).toContain('甲乙的关系陈述')
    expect(traces.at(-1)!.toolName).toBe('listRelations')

    // 按论文过滤：端点命中；无关论文过滤后为空
    const filtered = (await tools.listRelations.execute!({ paperId: paperA } as never, {} as never)) as { relations: unknown[] }
    expect(filtered.relations).toHaveLength(1)
    const none = (await tools.listRelations.execute!({ paperIds: [99999] } as never, {} as never)) as { relations: unknown[] }
    expect(none.relations).toEqual([])

    // 软删除的边不出现
    await tools.deleteRelation.execute!({ relationId: 1 } as never, {} as never)
    const afterDel = (await tools.listRelations.execute!({} as never, {} as never)) as { relations: unknown[]; total: number }
    expect(afterDel.total).toBe(0)

    // 结果 JSON 无英文类型 id
    const s = JSON.stringify(all)
    for (const t of ['based_on', 'implements', 'compares', 'cites', 'same_author']) expect(s).not.toContain(`"${t}"`)
  })

  it('uat6b S3：listRelations 只返回两端都是本图成员的关系——指向非成员论文的遗留边不返回（total 同口径，不删行）', async () => {
    const outsider = insertPaper('非成员论文')
    db.prepare(
      `INSERT INTO relations (graph_id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types, source_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, '指向非成员的遗留边', '["compares"]', '[]', 'job', ?, ?)`
    ).run(graphId, Math.min(paperA, outsider), Math.max(paperA, outsider), paperA, now(), now())
    const tools = createAgentTools(makeCtx())
    await tools.addRelation.execute!({ srcPaperId: paperA, dstPaperId: paperB, statement: '成员间正常边', types: ['compares'] } as never, {} as never)

    const all = (await tools.listRelations.execute!({} as never, {} as never)) as { relations: Array<Record<string, unknown>>; total: number }
    expect(all.total).toBe(1) // 遗留边不计入
    expect(String(all.relations[0].statement)).toContain('成员间正常边')
    expect(JSON.stringify(all)).not.toContain('指向非成员的遗留边')

    // 按非成员论文过滤同样查不到；库里的行仍在（不删）
    const byOutsider = (await tools.listRelations.execute!({ paperId: outsider } as never, {} as never)) as { relations: unknown[]; total: number }
    expect(byOutsider.relations).toEqual([])
    expect(byOutsider.total).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM relations WHERE graph_id = ? AND deleted_at IS NULL').get(graphId) as { n: number }).n).toBe(2)
  })

  it('proposeCandidate：写候选 + 产出 data-paper-card part（cardStatus=candidate 业务态）', async () => {
    const tools = createAgentTools(makeCtx())
    const r = (await tools.proposeCandidate.execute!(
      { title: '新候选', authors: ['王五'], year: 2023, doi: '10.9/new', reason: '方法相关' } as never,
      {} as never
    )) as { candidateId: number; existingPaperId: null; status: string }
    expect(r.status).toBe('pending')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ type: 'data-paper-card', cardStatus: 'candidate', title: '新候选', existingPaperId: undefined })
    expect(cards[0].id).toBe(`c${r.candidateId}`) // part id = 候选行 id，天然唯一（评审建议修 2）
    expect(cards[0].status).toBe('done') // 流式 status 与业务态分离
    expect(db.prepare('SELECT 1 FROM graph_candidates WHERE id = ?').get(r.candidateId)).toBeDefined()
    expect(traces.at(-1)!.toolName).toBe('proposeCandidate')

    const dup = (await tools.proposeCandidate.execute!(
      { title: '重复候选', authors: [], doi: '10.9/new', reason: 'x' } as never,
      {} as never
    )) as { candidateId: number; existingPaperId: null; duplicateOfId?: number; note?: string }
    expect(dup.existingPaperId).toBeNull()
    expect(dup.candidateId).toBe(r.candidateId) // D161：pending 同一 DOI 不重复提议
    expect(dup.duplicateOfId).toBe(r.candidateId)
    // D182（uat6b）：命中 pending → 出「已在待确认候选中」卡片（定位/确认加入），不新建行
    expect(cards).toHaveLength(2)
    expect(cards[1]).toMatchObject({ id: `c${r.candidateId}`, pendingDup: true, cardStatus: 'candidate', status: 'done' })
    expect(dup.note).toContain(`已是待确认候选 #${r.candidateId}`)
    expect(dup.note).toContain('未新建')
    const rows = db.prepare("SELECT status, COUNT(*) AS n FROM graph_candidates GROUP BY status").all() as Array<{ status: string; n: number }>
    expect(rows).toEqual([{ status: 'pending', n: 1 }]) // 候选行数不变、无 dismissed 新行

    const noId = (await tools.proposeCandidate.execute!(
      { title: '仅标题候选', authors: [], reason: 'x' } as never,
      {} as never
    )) as { error?: string; candidateId?: number }
    expect(noId.error).toBeUndefined() // D168：允许只给标题（本 ctx 无 OpenAlex 客户端，跳过联网核对）
    expect(noId.candidateId).toBeGreaterThan(0)
    expect(cards).toHaveLength(3) // 原候选 + D182 去重卡 + 仅标题候选
    expect(cards[2].title).toBe('仅标题候选')
    expect(cards[2].unverified).toBeUndefined() // 未做联网核对不标未核实
  })

  it('D182（uat6b）：命中已 dismissed（in_graph）的旧候选 → 「已在本图谱中」卡片徽标口径，不新建行', async () => {
    const tools = createAgentTools(makeCtx())
    const first = (await tools.proposeCandidate.execute!(
      { title: '图谱内论文', authors: [], doi: '10.9/ingraph', reason: 'x' } as never,
      {} as never
    )) as { candidateId: number }
    // 模拟 D169 落库即 dismissed（论文已是本图成员）的存量行
    db.prepare("UPDATE graph_candidates SET status = 'dismissed', reason = 'in_graph', in_graph = 1 WHERE id = ?").run(first.candidateId)
    const again = (await tools.proposeCandidate.execute!(
      { title: '再次提议同一篇', authors: [], doi: '10.9/ingraph', reason: 'y' } as never,
      {} as never
    )) as { duplicateOfId?: number; note?: string }
    expect(again.duplicateOfId).toBe(first.candidateId)
    expect(cards).toHaveLength(2) // 首次提议一张 + 命中 dismissed 出「已在本图谱中」卡片
    expect(cards[1]).toMatchObject({ id: `c${first.candidateId}`, inGraph: true })
    expect(cards[0].pendingDup).toBeUndefined() // 不是「待确认候选」口径
    expect(again.note).toContain('已在本图谱中')
    const rows = db.prepare('SELECT COUNT(*) AS n FROM graph_candidates').get() as { n: number }
    expect(rows.n).toBe(1) // 不新建重复行
  })

  it('uat6b-fix1 S1：in_graph=0 的 dismissed 旧行（先候选、后入图，087 不写列）再次提议 → 卡片仍按 D169「已在本图谱中」，无确认按钮', async () => {
    const tools = createAgentTools(makeCtx())
    const first = (await tools.proposeCandidate.execute!(
      { title: '后入图的论文', authors: [], doi: '10.9/late-member', reason: 'x' } as never,
      {} as never
    )) as { candidateId: number }
    // 模拟「提议时还不是成员 → 后来入图 → 087 改 dismissed 但不写 in_graph 列」的存量行
    db.prepare("UPDATE graph_candidates SET status = 'dismissed', reason = 'in_graph', in_graph = 0 WHERE id = ?").run(first.candidateId)
    const again = (await tools.proposeCandidate.execute!(
      { title: '再次提议同一篇', authors: [], doi: '10.9/late-member', reason: 'y' } as never,
      {} as never
    )) as { duplicateOfId?: number; note?: string }
    expect(again.duplicateOfId).toBe(first.candidateId)
    expect(cards).toHaveLength(2)
    // 卡片按 D169 视为已在本图谱：徽标在、无 pendingDup 口径；渲染层 inGraph=true 隐藏确认按钮
    expect(cards[1]).toMatchObject({ id: `c${first.candidateId}`, inGraph: true })
    expect(cards[1].pendingDup).toBeUndefined()
    expect(again.note).toContain('已在本图谱中')
    expect((db.prepare('SELECT COUNT(*) AS n FROM graph_candidates').get() as { n: number }).n).toBe(1) // 不新建行
  })

  it('uat6c M1：dismissed 命中卡出卡 reason 不含状态码——087 遗留 reason=\'in_graph\' 出卡为空串（状态走徽标，渲染层守卫兜底）', async () => {
    const tools = createAgentTools(makeCtx())
    const first = (await tools.proposeCandidate.execute!(
      { title: '理由被覆盖的论文', authors: [], doi: '10.9/clobbered', reason: '原中文理由' } as never,
      {} as never
    )) as { candidateId: number }
    db.prepare("UPDATE graph_candidates SET status = 'dismissed', reason = 'in_graph', in_graph = 1 WHERE id = ?").run(first.candidateId)
    const again = (await tools.proposeCandidate.execute!(
      { title: '再次提议同一篇', authors: [], doi: '10.9/clobbered', reason: 'y' } as never,
      {} as never
    )) as { duplicateOfId?: number }
    expect(again.duplicateOfId).toBe(first.candidateId)
    expect(cards).toHaveLength(2)
    expect(cards[1]).toMatchObject({ id: `c${first.candidateId}`, inGraph: true, reason: '' })
    expect(JSON.stringify(cards[1])).not.toContain('in_graph') // 状态码不进卡片任何字段
  })

  it('searchImages 仍是后续版本占位，不发网络请求（D128）', async () => {
    const tools = createAgentTools(makeCtx())
    const img = (await tools.searchImages.execute!({ query: '关键词' } as never, {} as never)) as { available: boolean; message: string }
    expect(img.available).toBe(false)
    expect(img.message).toContain('后续版本')
    expect(img.message).not.toContain('M6 接入')
  })

  it('uat5 D157（review_uat3 建议修 1）：联网三工具描述写明「只在本地没有时兜底、不得下矛盾结论」', () => {
    const tools = createAgentTools(makeCtx())
    for (const name of ['webSearch', 'webFetch', 'searchPapers'] as const) {
      const t = tools[name] as unknown as { description: string }
      expect(t.description).toContain('只在本地')
      expect(t.description).toContain('矛盾')
    }
  })

  it('webSearch / webFetch：注入假服务，非空成功记账，空结果和失败不记账', async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const path = String(input)
      const payload = JSON.parse(String(init?.body ?? '{}')) as { url?: string }
      if (path.endsWith('/v1/tools/search')) {
        return new Response(JSON.stringify({ results: [{ title: 'T', url: 'https://example.com/a', snippet: 's' }] }), { status: 200 })
      }
      if (payload.url?.endsWith('/empty')) {
        return new Response(JSON.stringify({ title: '', url: payload.url, content: '' }), { status: 200 })
      }
      return new Response('{}', { status: 402 })
    }
    const tools = createAgentTools({ ...makeCtx(), web: { apiKey: 'k', baseUrl: 'http://127.0.0.1:9', fetchImpl } })
    const found = (await tools.webSearch.execute!({ query: '探针' } as never, {} as never)) as { results: Array<{ title: string }> }
    expect(found.results).toHaveLength(1)
    const count = (): number => (db.prepare("SELECT COUNT(*) AS n FROM usage_records WHERE category = 'web'").get() as { n: number }).n
    expect(count()).toBe(1)
    const cost = (db.prepare("SELECT cost_cny AS c FROM usage_records WHERE category = 'web'").get() as { c: number }).c
    expect(cost).toBeCloseTo(0.005)
    await tools.webFetch.execute!({ url: 'https://example.com/empty' } as never, {} as never)
    expect(count()).toBe(1)
    const denied = (await tools.webFetch.execute!({ url: 'https://example.com/pay' } as never, {} as never)) as { error: string }
    expect(denied.error).toContain('余额不足')
    expect(count()).toBe(1)
    expect(tools.webFetch.description).toContain('标题或正文')
    expect(tools.webFetch.description).toContain('两者都空白不收费')
    const noKey = (await createAgentTools(makeCtx()).webSearch.execute!({ query: '探针' } as never, {} as never)) as { error: string }
    expect(noKey.error).toContain('API Key')
    expect(count()).toBe(1)
    const webTraces = traces.filter((t) => t.toolName === 'webSearch' || t.toolName === 'webFetch')
    // D178：trace summary 不显示金额；usage_records 的 cost_cny 仍在上方对账
    expect(webTraces.every((t) => !t.summary.includes('¥') && !t.summary.includes('费用'))).toBe(true)
    expect(webTraces.some((t) => t.toolName === 'webSearch' && t.summary.includes('1 条'))).toBe(true)
    expect(webTraces.some((t) => t.toolName === 'webFetch' && t.summary.includes('example.com/empty'))).toBe(true)
    expect(webTraces.some((t) => t.toolName === 'webFetch' && t.summary.includes('失败'))).toBe(true)
    expect(webTraces.some((t) => t.toolName === 'webSearch' && t.summary.includes('缺少 API Key'))).toBe(true)
  })

  it('searchPapers（M6 lane/fetch 批 1）：走注入假客户端真检索，返回 PaperHit 且空 query 报错', async () => {
    const hits = [
      { title: 'Hit A', authors: ['A'], year: 2021, doi: '10.1/a' },
      { title: 'Hit B', authors: ['B'], year: 2022, doi: '10.1/b', inLibraryPaperId: 42 }
    ]
    const fake = makeFakeOpenAlex()
    fake.searchWorksFull = async () => {
      fake.calls.push('searchFull')
      return hits.map((h) => ({ wid: 'W1', doi: h.doi, title: h.title, year: h.year, authors: h.authors, venue: null, abstract: null, citedBy: null, oaUrl: null, arxivId: null, referencedWorks: [] }))
    }
    const tools = createAgentTools({ ...makeCtx(), openAlex: fake })
    const sp = (await tools.searchPapers.execute!({ query: '强化学习', limit: 5 } as never, {} as never)) as { results: typeof hits; note: string }
    expect(sp.results).toHaveLength(2)
    expect(sp.results[1].inLibraryPaperId).toBeUndefined() // 库内无该 DOI：不标
    expect(sp.note).toContain('2')
    const noQuery = (await tools.searchPapers.execute!({ limit: 5 } as never, {} as never)) as { error: string }
    expect(noQuery.error).toContain('缺少 query')
    expect(fake.calls).toEqual(['searchFull']) // 空 query 不算一次联网（B5 口径）
    expect(traces.some((t) => t.toolName === 'searchPapers' && t.summary.includes('检索论文') && !t.summary.includes('¥'))).toBe(true)
    const beforeEmpty = traces.length
    await tools.searchPapers.execute!({ query: '   ' } as never, {} as never)
    expect(traces.length).toBe(beforeEmpty)
  })

  it('searchPapers 命中的摘要在提议候选时写入，确认入库进 papers 与 FTS（D134 bug5）', async () => {
    const abstract = 'm6fixProposeAbstractToken 这是 OpenAlex 返回的摘要，模型没有回传。'
    const fake = makeFakeOpenAlex()
    fake.searchWorksFull = async () => {
      fake.calls.push('searchFull')
      return [
        {
          wid: 'W9',
          doi: '10.9/abs',
          title: '带摘要候选',
          year: 2024,
          authors: ['李四'],
          venue: 'NeurIPS',
          abstract,
          citedBy: 3,
          oaUrl: 'https://oa.example/abs.pdf',
          arxivId: null,
          referencedWorks: []
        }
      ]
    }
    const tools = createAgentTools({ ...makeCtx(), openAlex: fake })
    await tools.searchPapers.execute!({ query: '摘要探针', limit: 5 } as never, {} as never)
    const proposed = (await tools.proposeCandidate.execute!(
      { title: '带摘要候选', authors: ['李四'], year: 2024, doi: '10.9/abs', reason: '方法相关' } as never,
      {} as never
    )) as { candidateId: number }
    const cand = db.prepare('SELECT abstract, venue, oa_url FROM graph_candidates WHERE id = ?').get(proposed.candidateId) as {
      abstract: string
      venue: string
      oa_url: string
    }
    expect(cand.abstract).toBe(abstract)
    expect(cand.venue).toBe('NeurIPS')
    expect(cand.oa_url).toBe('https://oa.example/abs.pdf')
    const { confirmCandidate } = await import('./candidates')
    const confirmed = confirmCandidate(db, proposed.candidateId)
    const paper = db.prepare('SELECT abstract, abstract_source FROM papers WHERE id = ?').get(confirmed.addedPaperId) as {
      abstract: string
      abstract_source: string
    }
    expect(paper).toEqual({ abstract, abstract_source: 'openalex' })
    const fts = db.prepare('SELECT abstract_seg FROM papers_fts WHERE rowid = ?').get(confirmed.addedPaperId) as { abstract_seg: string }
    expect(fts.abstract_seg).toContain('m6fixproposeabstracttoken')
  })

  it('B5：联网工具空参/坏参返回中文结构化错误，不触及后端（占位期也生效）', async () => {
    const tools = createAgentTools(makeCtx())
    for (const name of ['webSearch', 'searchImages'] as const) {
      const empty = (await tools[name].execute!({} as never, {} as never)) as { error: string }
      expect(empty.error).toContain('缺少 query')
      const blank = (await tools[name].execute!({ query: '   ' } as never, {} as never)) as { error: string }
      expect(blank.error).toContain('缺少 query')
    }
    const spBlank = (await tools.searchPapers.execute!({ query: '  ' } as never, {} as never)) as { error: string }
    expect(spBlank.error).toContain('缺少 query')
    const wfEmpty = (await tools.webFetch.execute!({} as never, {} as never)) as { error: string }
    expect(wfEmpty.error).toContain('缺少 url')
    const wfHttp = (await tools.webFetch.execute!({ url: 'http://example.com' } as never, {} as never)) as { error: string }
    expect(wfHttp.error).toContain('https')
    const wfOk = (await tools.webFetch.execute!({ url: 'https://example.com' } as never, {} as never)) as { error: string }
    expect(wfOk.error).toContain('API Key')
  })

  it('工具清单与 prompts.ts 同源对账（防漂移，批 3）', () => {
    const tools = createAgentTools(makeCtx())
    expect(Object.keys(tools).sort()).toEqual([...AGENT_TOOL_NAMES].sort())
  })

  it('deleteRelation：软删除 + 改图小结；重复删除/越权删除返回 error', async () => {
    const tools = createAgentTools(makeCtx())
    const added = (await tools.addRelation.execute!({ srcPaperId: paperA, dstPaperId: paperB, statement: 'x', types: ['compares'] } as never, {} as never)) as { relationId: number }
    changes.length = 0

    const r = (await tools.deleteRelation.execute!({ relationId: added.relationId } as never, {} as never)) as { deleted: boolean }
    expect(r.deleted).toBe(true)
    expect(db.prepare('SELECT deleted_at FROM relations WHERE id = ?').get(added.relationId)).not.toBeNull()
    expect(changes[0]).toMatchObject({ changeType: 'deleteRelation', relationIds: [added.relationId] })
    // 2a（D129）：删除也写改动前快照，撤销可完整还原
    expect(changes[0].snapshotIds).toHaveLength(1)
    const snap = db.prepare('SELECT op FROM relation_snapshots WHERE id = ?').get(changes[0].snapshotIds![0]) as { op: string }
    expect(snap.op).toBe('delete')

    const again = (await tools.deleteRelation.execute!({ relationId: added.relationId } as never, {} as never)) as { error: string }
    expect(again.error).toContain('不存在或已删除')

    const otherGraph = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('别图', now(), now()).lastInsertRowid)
    db.prepare('INSERT INTO relations (graph_id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types, source_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(otherGraph, paperA, paperB, paperA, '别的图', '["compares"]', '[]', 'session', now(), now())
    const other = db.prepare('SELECT id FROM relations WHERE graph_id = ?').get(otherGraph) as { id: number }
    const cross = (await tools.deleteRelation.execute!({ relationId: other.id } as never, {} as never)) as { error: string }
    expect(cross.error).toContain('不存在或已删除')
  })
})

describe('uat4 建议修14a：listRelations 陈述显示层替换内部编号（数据库不改）', () => {
  it('旧陈述里的 P01/P02 换成《短标题》，越界 / NEW / #N 剔除，结果无 P0x 残留', async () => {
    db.prepare(
      `INSERT INTO relations (graph_id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types,
         source_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '["based_on"]', '[]', 'job', ?, ?)`
    ).run(
      graphId,
      Math.min(paperA, paperB),
      Math.max(paperA, paperB),
      paperA,
      'P01 的方法被 P02 改进；P06 越界，P99 与 NEW、#3 一并剔除。',
      now(),
      now()
    )
    const tools = createAgentTools(makeCtx())
    const r = (await tools.listRelations.execute!({} as never, {} as never)) as {
      relations: Array<Record<string, unknown>>
      total: number
    }
    expect(r.total).toBe(1)
    const stmt = String(r.relations[0].statement)
    expect(stmt).toContain('《论文甲》')
    expect(stmt).toContain('《论文乙》')
    expect(stmt).not.toMatch(/\bP\d{2}\b/)
    expect(stmt).not.toMatch(/\bNEW\b/)
    expect(stmt).not.toMatch(/#\d/)
    // 数据库里的原始陈述不改
    const raw = db.prepare('SELECT statement_text AS s FROM relations WHERE graph_id = ?').get(graphId) as { s: string }
    expect(raw.s).toContain('P01')
  })
})
