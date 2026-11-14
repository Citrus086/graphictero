import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { startStubLlm, type StubLlm } from '../llm/stubServer'
import { findRelatedPapers, generateForGraph, generateForPaper, parseCandidateIdsJson, parseRelationsJson, RELATIONS_PER_CALL, writeRelationDrafts } from './generator'
import { upsertRelation } from '../db/relations'
import { RetryableLlmError, BadRequestLlmError } from '../llm/errors'
import { DEEPSEEK_FLASH_MAX_OUTPUT } from '../llm/client'
import { indexPaperFts } from '../db/fts'
import { NEW_PAPER_RELATION_PROMPT, RELATION_GEN_PROMPT } from './prompts'

/**
 * 关系生成测试（D40/D66/D84/D86/D89/D93）：本地 stub LLM（流式 SSE 含 thinking、
 * finishReason=length 截断），不断网、不调真实 deepseek/OpenAlex。
 */

let dir: string
let dataDir: string
let db: Database.Database
let stub: StubLlm
let graphId: number
let paperA: number
let paperB: number
let paperC: number

function addPaperToGraph(title: string): number {
  const now = new Date().toISOString()
  const r = db
    .prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES (?, 'zotero', 1, ?, ?)")
    .run(title, now, now)
  const id = Number(r.lastInsertRowid)
  db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)').run(graphId, id, now)
  return id
}

function setDetail(paperId: number, text: string): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO paper_details (paper_id, parts, model, prompt_version, generated_at, created_at, updated_at)
     VALUES (?, ?, 'deepseek-flash', 'detail-v1', ?, ?, ?)`
  ).run(paperId, JSON.stringify([{ type: 'text', text }]), now, now, now)
}

function addAuthor(paperId: number, position: number, givenFamily: string, normalized: string): void {
  const [given, family] = givenFamily.split(' ')
  db.prepare('INSERT INTO paper_authors (paper_id, position, family, given, normalized) VALUES (?, ?, ?, ?, ?)').run(
    paperId,
    position,
    family ?? given,
    family ? given : null,
    normalized
  )
}

function relations(): Array<{ id: number; paper_low: number; paper_high: number; src_paper: number; llm_types: string; auto_types: string; statement_text: string; no_ref_basis: number }> {
  return db
    .prepare('SELECT id, paper_low, paper_high, src_paper, llm_types, auto_types, statement_text, no_ref_basis FROM relations WHERE deleted_at IS NULL ORDER BY id')
    .all() as Array<{ id: number; paper_low: number; paper_high: number; src_paper: number; llm_types: string; auto_types: string; statement_text: string; no_ref_basis: number }>
}

const llm = () => ({ baseUrl: stub.baseUrl, apiKey: 'k', model: 'deepseek-flash' })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gt-gen-'))
  dataDir = join(dir, 'Graphictero')
  mkdirSync(dataDir, { recursive: true })
  db = new Database(join(dataDir, 'graphictero.db'))
  runMigrations(db, MIGRATIONS)
  const now = new Date().toISOString()
  graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('测试图', now, now).lastInsertRowid)
  paperA = addPaperToGraph('Alpha Method')
  paperB = addPaperToGraph('Beta Improvement')
  paperC = addPaperToGraph('Gamma Baseline')
  setDetail(paperA, 'Alpha: 提出基础方法 X，解决任务 T。')
  setDetail(paperB, 'Beta: 基于 Alpha 的方法 X，提出改进 Y。')
  setDetail(paperC, 'Gamma: 与 Alpha 同时期的对比基线 Z。')
  stub = await startStubLlm()
})

afterEach(async () => {
  await stub.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('parseRelationsJson（截断容错）', () => {
  it('完整 JSON：解析 relations 与 done', () => {
    const r = parseRelationsJson('前言 {"relations":[{"src":"P01","dst":"P02","types":["对比"],"statement":"S"}],"done":true} 后记')
    expect(r.relations).toHaveLength(1)
    expect(r.done).toBe(true)
  })

  it('截断 mid-array：捞出完整的元素，done=false', () => {
    const cut = '{"relations":[{"src":"P01","dst":"P02","types":["对比"],"statement":"S1"},{"src":"P02","dst":"P03","types":["对比"],"statement":"S2"'
    const r = parseRelationsJson(cut)
    expect(r.relations).toHaveLength(1)
    expect(r.done).toBe(false)
  })
})

describe('uat2b D150：引用依据标记 + 陈述禁内部编号（后处理兜底）', () => {
  it('「基于/改进」无引用依据：类型保留，no_ref_basis 置 1', async () => {
    // 不插任何 paper_references：A–B 之间无引用关系
    await stub.close()
    stub = await startStubLlm([
      {
        kind: 'ok',
        text: JSON.stringify({
          relations: [{ src: 'P01', dst: 'P02', types: ['基于/改进'], statement: 'Beta 的方法可能受 Alpha 启发。' }],
          done: true
        })
      }
    ])
    const r = await generateForGraph({ db, llm }, graphId)
    expect(r.written).toBe(1)
    const rels = relations()
    expect(rels).toHaveLength(1)
    expect(JSON.parse(rels[0].llm_types)).toContain('based_on') // 类型照样保留（D150 修订口径）
    expect(rels[0].no_ref_basis).toBe(1)
  })

  it('陈述里的 P01/P06 内部编号被替换成《短标题》（查不到的记号剔除）；整句替换后为空则丢弃', async () => {
    await stub.close()
    stub = await startStubLlm([
      {
        kind: 'ok',
        text: JSON.stringify({
          relations: [
            { src: 'P01', dst: 'P02', types: ['对比'], statement: 'P01 与 P02 是同期工作，P99 是无关记号。' },
            { src: 'P01', dst: 'P02', types: ['对比'], statement: 'P99' } // 替换后为空 → 丢弃
          ],
          done: true
        })
      }
    ])
    const r = await generateForGraph({ db, llm }, graphId)
    expect(r.written).toBe(1)
    expect(r.invalid).toBe(1) // uat2-fix1 建议修 5：空陈述丢弃
    const rels = relations()
    expect(rels).toHaveLength(1)
    expect(rels[0].statement_text).not.toMatch(/\bP\d{1,3}\b/) // 内部编号绝不落库
    expect(rels[0].statement_text).toContain('《Alpha Method》')
    expect(rels[0].statement_text).toContain('《Beta Improvement…》') // uat6 S2 词边界截断：整词 ≤14+5 不切断单词
    expect(rels[0].statement_text).not.toContain('P99')
  })

  it('uat2-fix1 建议修 5：NEW 映射为新论文《短标题》', () => {
    // 直接测后处理纯函数路径：NEW 在 shortToId 里（generateForPaper 的固定短 id）
    const shortToId = new Map([
      ['NEW', paperC],
      ['P01', paperA]
    ])
    const stats = writeRelationDrafts(
      db,
      graphId,
      [{ src: 'P01', dst: 'NEW', types: ['对比'], statement: 'NEW 在任务 T 上对比 P01。' }],
      shortToId,
      { sourceJobId: null, model: 'deepseek-flash', promptVersion: 'relation-new-paper-v3' }
    )
    expect(stats.written).toBe(1)
    const rels = relations()
    expect(rels[0].statement_text).toContain('《Gamma Baseline》')
    expect(rels[0].statement_text).not.toMatch(/\bNEW\b/)
  })

  it('uat3b D150：#N 换成论文短标题或关系两端；查不到的编号剔除', () => {
    const now = new Date().toISOString()
    const low = Math.min(paperB, paperC)
    const high = Math.max(paperB, paperC)
    db.prepare(
      `INSERT INTO relations (id, graph_id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types, source_type, created_at, updated_at)
       VALUES (9001, ?, ?, ?, ?, '预置', '["compares"]', '[]', 'job', ?, ?)`
    ).run(graphId, low, high, paperB, now, now)
    const lib = Number(
      db.prepare("INSERT INTO papers (title, source, created_at, updated_at) VALUES ('Library Only Title', 'zotero', ?, ?)").run(now, now).lastInsertRowid
    )
    const stats = writeRelationDrafts(
      db,
      graphId,
      [{ src: 'P01', dst: 'P02', types: ['对比'], statement: `对照 #${paperA}、关系 #9001、库内 #${lib} 与 #99999。` }],
      new Map([
        ['P01', paperA],
        ['P02', paperB]
      ]),
      { sourceJobId: null, model: 'deepseek-flash', promptVersion: 'relation-gen-v3' }
    )
    expect(stats.written).toBe(1)
    const written = db
      .prepare('SELECT statement_text FROM relations WHERE graph_id = ? AND paper_low = ? AND paper_high = ? AND deleted_at IS NULL')
      .get(graphId, Math.min(paperA, paperB), Math.max(paperA, paperB)) as { statement_text: string }
    expect(written.statement_text).toContain('《Alpha Method》')
    expect(written.statement_text).toContain('《Beta Improvement…》与《Gamma Baseline》') // uat6 S2 词边界截断
    expect(written.statement_text).toContain('《Library Only…》') // uat6 S2：取整词 'Library Only'（≤14+5 最接近上限的断点）
    expect(written.statement_text).not.toMatch(/#\d+/)
  })

  it('D150 prompt：保留类型口径（无引用依据不劝改「对比」）+ 陈述禁内部编号（v3）', () => {
    expect(RELATION_GEN_PROMPT.version).toBe('relation-gen-v3')
    expect(NEW_PAPER_RELATION_PROMPT.version).toBe('relation-new-paper-v3')
    for (const p of [RELATION_GEN_PROMPT, NEW_PAPER_RELATION_PROMPT]) {
      expect(p.system).toContain('引用关系')
      expect(p.system).toContain('AI 推断 · 无引用依据')
      expect(p.system).not.toContain('写「对比」') // uat2-fix1 必须修 2：不得指示模型降级
      expect(p.system).not.toContain('宁可用「对比」')
    }
  })
})

describe('generateForGraph（首建整图）', () => {
  it('写 LLM 关系 + 自动附加 引用/同一作者（D89/D93），校验错误丢弃', async () => {
    // B 引用了 A（paper_references），A 与 B 有共同作者
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO paper_references (paper_id, openalex_wid, doi, title, year, matched_paper_id, source, created_at) VALUES (?, 'W1', NULL, 'Alpha', 2024, ?, 'openalex', ?)"
    ).run(paperB, paperA, now)
    addAuthor(paperA, 0, 'Wei Zhang', 'wei zhang')
    addAuthor(paperB, 0, 'Wei Zhang', 'wei zhang')

    await stub.close()
    stub = await startStubLlm([
      {
        kind: 'ok',
        text: JSON.stringify({
          relations: [
            { src: 'P01', dst: 'P02', types: ['基于/改进'], statement: 'Beta 在 Alpha 的方法 X 上提出改进 Y。' },
            { src: 'P01', dst: 'P01', types: ['对比'], statement: '自环应被拒' },
            { src: 'P99', dst: 'P01', types: ['对比'], statement: '越界 id 应被拒' },
            { src: 'P02', dst: 'P03', types: ['对比', '引用'], statement: 'LLM 选引用类型应被拒（D89）' }
          ],
          done: true
        })
      }
    ])
    const r = await generateForGraph({ db, llm }, graphId)
    expect(r.written).toBe(1)
    expect(r.invalid).toBe(3)
    expect(r.autoAttached).toBe(1)

    const rels = relations()
    expect(rels).toHaveLength(1)
    const rel = rels[0]
    expect([rel.paper_low, rel.paper_high]).toEqual([paperA, paperB].sort((a, b) => a - b))
    expect(JSON.parse(rel.llm_types)).toEqual(['based_on'])
    const auto = JSON.parse(rel.auto_types) as string[]
    expect(auto).toContain('cites')
    expect(auto).toContain('same_author')
    // 引用方向：被引方 A → 引用方 B（B 的参考文献里有 A）
    expect(rel.src_paper).toBe(paperA)
    expect(rel.src_paper).not.toBe(paperB)
    expect(rel.no_ref_basis).toBe(0) // uat2b D150：有引用依据的 基于/改进 不标
  })

  it('只有引用、LLM 没连的论文对不单独建边（D89）', async () => {
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO paper_references (paper_id, openalex_wid, doi, title, year, matched_paper_id, source, created_at) VALUES (?, 'W1', NULL, 'Alpha', 2024, ?, 'openalex', ?)"
    ).run(paperB, paperA, now)
    await stub.close()
    stub = await startStubLlm([{ kind: 'ok', text: JSON.stringify({ relations: [], done: true }) }])
    await generateForGraph({ db, llm }, graphId)
    expect(relations()).toHaveLength(0) // A–B 有引用信号但 LLM 没连边 → 无边
  })

  it('截断（finishReason=length）后从已写入的边接着跑，不产生重复边（D86）', async () => {
    await stub.close()
    stub = await startStubLlm([
      {
        kind: 'ok',
        finishReason: 'length',
        text: '{"relations":[{"src":"P01","dst":"P02","types":["对比"],"statement":"S1"},' // 截断
      },
      {
        kind: 'ok',
        text: JSON.stringify({
          relations: [{ src: 'P02', dst: 'P03', types: ['对比'], statement: 'S2' }],
          done: true
        })
      }
    ])
    const r = await generateForGraph({ db, llm }, graphId)
    expect(r.llmCalls).toBe(2)
    expect(r.written).toBe(2)
    expect(relations()).toHaveLength(2)
    const rels = relations()
    expect(JSON.parse(rels[0].llm_types)).toEqual(['compares'])
    expect(JSON.parse(rels[1].llm_types)).toEqual(['compares'])
  })

  it('写入幂等 + 按论文记已处理：重跑不再调 LLM（D86）', async () => {
    await stub.close()
    stub = await startStubLlm([
      { kind: 'ok', text: JSON.stringify({ relations: [{ src: 'P01', dst: 'P02', types: ['对比'], statement: 'S' }], done: true }) }
    ])
    await generateForGraph({ db, llm }, graphId)
    expect(relations()).toHaveLength(1)
    const processed = (db.prepare('SELECT COUNT(*) AS n FROM relation_gen_progress WHERE graph_id = ?').get(graphId) as { n: number }).n
    expect(processed).toBe(3) // 三篇都记了已处理

    await generateForGraph({ db, llm }, graphId) // 第二次：全部已处理 → 0 次 LLM 调用
    expect(stub.requests).toHaveLength(1)
    expect(relations()).toHaveLength(1)
  })

  it('规模超限（D86）：自动改名片打底 + 逐篇新增流程', async () => {
    await stub.close()
    stub = await startStubLlm([{ kind: 'ok', text: JSON.stringify({ relations: [], done: true }) }])
    const r = await generateForGraph({ db, llm, limits: { maxPapers: 1 } }, graphId)
    expect(r.strategy).toBe('cards_then_per_paper')
    expect(r.llmCalls).toBeGreaterThanOrEqual(4) // 1 次名片打底 + 3 次逐篇
    const processed = (db.prepare('SELECT COUNT(*) AS n FROM relation_gen_progress WHERE graph_id = ?').get(graphId) as { n: number }).n
    expect(processed).toBe(3)
  })

  it('每批最多 50 条（D86 的每步约 50 条口径）', () => {
    expect(RELATIONS_PER_CALL).toBe(50)
  })

  it('迭代保险丝耗尽：抛可重试错误、不把论文标已处理（评审建议 6）', async () => {
    // 每轮都写出有效关系但 done=false → 迭代到上限 → 保险丝耗尽
    await stub.close()
    stub = await startStubLlm([
      { kind: 'ok', text: JSON.stringify({ relations: [{ src: 'P01', dst: 'P02', types: ['对比'], statement: 'S' }], done: false }) },
      { kind: 'ok', text: JSON.stringify({ relations: [{ src: 'P01', dst: 'P02', types: ['对比'], statement: 'S' }], done: false }) }
    ])
    await expect(generateForGraph({ db, llm, limits: { maxIterations: 2 } }, graphId)).rejects.toThrow(/保险丝/)
    const processed = (db.prepare('SELECT COUNT(*) AS n FROM relation_gen_progress WHERE graph_id = ?').get(graphId) as { n: number }).n
    expect(processed).toBe(0) // 没标已处理：重试整步还能补漏
  })
})

describe('findRelatedPapers（信号候选，D40/D102）', () => {
  it('引用 / 关键词 / 名片三路信号标注正确', () => {
    // 引用：B 引用了 A
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO paper_references (paper_id, openalex_wid, doi, title, year, matched_paper_id, source, created_at) VALUES (?, 'W1', NULL, 't', 2024, ?, 'openalex', ?)"
    ).run(paperB, paperA, now)
    // 关键词：C 的摘要含 transformer，A 的关键词有 transformer
    db.prepare("INSERT INTO paper_keywords (paper_id, keyword) VALUES (?, 'transformer')").run(paperA)
    indexPaperFts(db, paperA, { title: 'Alpha Method', abstract: null, keywords: ['transformer'] })
    indexPaperFts(db, paperC, { title: 'Gamma Baseline', abstract: 'A transformer baseline comparison.', keywords: [] })

    const forA = findRelatedPapers(db, graphId, paperA)
    const b = forA.find((c) => c.paperId === paperB)
    const c = forA.find((c) => c.paperId === paperC)
    expect(b?.signals).toContain('cites')
    expect(b?.signals).toContain('cards')
    expect(c?.signals).toContain('keywords')
    expect(c?.signals).toContain('cards')
    // 不带自身
    expect(forA.find((x) => x.paperId === paperA)).toBeUndefined()
  })
})

describe('findRelatedPapers · 文献耦合（D102）', () => {
  // 被引用的库内论文（X/Y/Z/Q），不进图
  function addLibraryPaper(title: string): number {
    const now = new Date().toISOString()
    return Number(
      db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES (?, 'zotero', 1, ?, ?)").run(title, now, now).lastInsertRowid
    )
  }
  function addRef(paperId: number, wid: string, matchedId: number | null): void {
    db.prepare(
      "INSERT INTO paper_references (paper_id, openalex_wid, doi, title, year, matched_paper_id, source, created_at) VALUES (?, ?, NULL, 't', 2024, ?, 'openalex', ?)"
    ).run(paperId, wid, matchedId, new Date().toISOString())
  }

  it('共享参考文献计数 / 阈值 / 排序，无参考文献不报错', () => {
    const paperD = addPaperToGraph('Delta Unrelated')
    setDetail(paperD, 'Delta: 无关论文。')
    const X = addLibraryPaper('X')
    const Y = addLibraryPaper('Y')
    const Z = addLibraryPaper('Z')
    const Q = addLibraryPaper('Q')
    // A 引用 X、Y；B 引用 X、Y、Z（与 A 共享 2 篇）；C 引用 X、Q（与 A 共享 1 篇，≥阈值 1）；D 无引用
    addRef(paperA, 'W-X', X)
    addRef(paperA, 'W-Y', Y)
    addRef(paperB, 'W-X2', X)
    addRef(paperB, 'W-Y2', Y)
    addRef(paperB, 'W-Z', Z)
    addRef(paperC, 'W-X3', X)
    addRef(paperC, 'W-Q', Q)

    const forA = findRelatedPapers(db, graphId, paperA)
    const b = forA.find((c) => c.paperId === paperB)
    const c = forA.find((c) => c.paperId === paperC)
    const d = forA.find((c) => c.paperId === paperD)
    expect(b?.signals).toContain('coupling')
    expect(b?.couplingCount).toBe(2)
    expect(c?.signals).toContain('coupling') // 共享 1 篇 ≥ COUPLING_MIN_SHARED(1)
    expect(c?.couplingCount).toBe(1)
    expect(d?.signals).not.toContain('coupling')
    expect(d?.couplingCount).toBe(0) // 无参考文献：不报错，只有名片信号
    expect(d?.signals).toContain('cards')
    // 耦合强于名片全量：B 排在只有 cards 的 D 前面
    expect(forA.findIndex((x) => x.paperId === paperB)).toBeLessThan(forA.findIndex((x) => x.paperId === paperD))
    // 反向同样成立（B 视角看 A）
    expect(findRelatedPapers(db, graphId, paperB).find((x) => x.paperId === paperA)?.couplingCount).toBe(2)
  })

  it('评审建议修（rel3）4：仅直接引用的候选排在「耦合+关键词」之前（最强信号档位，非加权和）', () => {
    const paperF = addPaperToGraph('Zeta CitedOnly') // 只有直接引用信号
    setDetail(paperF, 'Zeta: 只被 A 引用。')
    const paperG = addPaperToGraph('Eta CouplingKeywords') // 耦合 + 关键词，无引用
    setDetail(paperG, 'Eta: 与 A 有耦合和关键词重叠。')
    const X = addLibraryPaper('X3')
    const Y = addLibraryPaper('Y3')
    // F 被 A 引用（matched_paper_id = F）
    addRef(paperA, 'W-AF', paperF)
    // G 与 A 共享参考文献 X（耦合信号）
    addRef(paperG, 'W-GX', X)
    addRef(paperA, 'W-AX', X)
    addRef(paperA, 'W-AY', Y)
    // G 命中 A 的关键词（关键词信号）
    db.prepare("INSERT INTO paper_keywords (paper_id, keyword) VALUES (?, 'transformer')").run(paperA)
    indexPaperFts(db, paperA, { title: 'Alpha Method', abstract: null, keywords: ['transformer'] })
    indexPaperFts(db, paperG, { title: 'Eta transformer study', abstract: null, keywords: [] })

    const forA = findRelatedPapers(db, graphId, paperA)
    const f = forA.find((c) => c.paperId === paperF)!
    const g = forA.find((c) => c.paperId === paperG)!
    expect(f.signals).toContain('cites')
    expect(f.signals).not.toContain('coupling')
    expect(g.signals).toContain('coupling')
    expect(g.signals).toContain('keywords')
    expect(g.signals).not.toContain('cites')
    // 旧加权和两者同分（9），Salton 可能把 G 排到 F 前；最强信号档位下 cites 档必在前
    expect(forA.findIndex((x) => x.paperId === paperF)).toBeLessThan(forA.findIndex((x) => x.paperId === paperG))
  })

  it('引用信号优先于文献耦合（D40 信号强度排序）', () => {
    const paperE = addPaperToGraph('Epsilon Coupled')
    setDetail(paperE, 'Epsilon: 与 A 有耦合但没有引用。')
    const X = addLibraryPaper('X2')
    const Y = addLibraryPaper('Y2')
    // E 引用了 A（直接引用信号）且与 A 共享 X
    addRef(paperE, 'W-E1', paperA)
    addRef(paperE, 'W-E2', X)
    addRef(paperA, 'W-A1', X)
    addRef(paperA, 'W-A2', Y)

    const forA = findRelatedPapers(db, graphId, paperA)
    const e = forA.find((c) => c.paperId === paperE)!
    expect(e.signals).toContain('cites')
    expect(e.signals).toContain('coupling')
    expect(e.couplingCount).toBe(1)
    expect(forA[0].paperId).toBe(paperE) // cites+coupling 排最前
  })
})

describe('generateForPaper · 两阶段精读候选（D103）', () => {
  /** 往图里加 n 篇带详情的有 PDF 论文，返回短 id 顺序（P01… 从 B 开始） */
  function addOthers(n: number): void {
    for (let i = 0; i < n; i++) {
      const id = addPaperToGraph(`Paper ${String(i + 4).padStart(2, '0')}`)
      setDetail(id, `Paper ${i + 4}: 详情内容。`)
    }
  }
  const selectJson = (ids: string[]): string => JSON.stringify({ candidates: ids })
  const doneJson = JSON.stringify({ relations: [], done: true })
  /** 第二阶段请求正文里「已附详情」的篇数 */
  const deepReadCount = (): number =>
    ((stub.requests[1].body as { messages: Array<{ content: string }> }).messages[1].content.match(/已附详情/g) ?? []).length

  it('LLM 挑 5–8 篇：两阶段各一次调用、各记一次费用（D92/D96/D100）', async () => {
    addOthers(7) // 共 9 篇其他论文 > 8，走两阶段
    await stub.close()
    stub = await startStubLlm([
      { kind: 'ok', text: selectJson(['P01', 'P03', 'P05', 'P07', 'P09']) },
      { kind: 'ok', text: doneJson }
    ])
    const r = await generateForPaper({ db, llm }, graphId, paperA)
    expect(r.llmCalls).toBe(2) // 挑选 1 次 + 写关系 1 次
    expect(stub.requests).toHaveLength(2)
    // D100：两阶段都显式给满 384k
    for (const req of stub.requests) {
      expect((req.body as { max_tokens: number }).max_tokens).toBe(DEEPSEEK_FLASH_MAX_OUTPUT)
    }
    // D96：两阶段各记一条 relation 用量
    const usage = (db.prepare("SELECT COUNT(*) AS n FROM usage_records WHERE category = 'relation'").get() as { n: number }).n
    expect(usage).toBe(2)
    // 第一阶段挑的 5 篇进详情，其余 4 篇名片
    expect(deepReadCount()).toBe(5)
    // 第一阶段请求带信号列表
    const selectUser = (stub.requests[0].body as { messages: Array<{ content: string }> }).messages[1].content
    expect(selectUser).toContain('候选列表')
    // 已处理标记（D86）
    const processed = (db.prepare('SELECT COUNT(*) AS n FROM relation_gen_progress WHERE graph_id = ? AND paper_id = ?').get(graphId, paperA) as { n: number }).n
    expect(processed).toBe(1)
  })

  it('容错：越界 / 重复 id 丢弃，超出截断', async () => {
    addOthers(7)
    await stub.close()
    stub = await startStubLlm([
      { kind: 'ok', text: selectJson(['P01', 'P01', 'P99', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08']) },
      { kind: 'ok', text: doneJson }
    ])
    await generateForPaper({ db, llm }, graphId, paperA)
    expect(deepReadCount()).toBe(8) // P99 越界丢、P01 重复去重、超 8 截断
  })

  it('少于 5 篇按 LLM 选的收（宁缺毋滥）', async () => {
    addOthers(7)
    await stub.close()
    stub = await startStubLlm([
      { kind: 'ok', text: selectJson(['P02']) },
      { kind: 'ok', text: doneJson }
    ])
    const r = await generateForPaper({ db, llm }, graphId, paperA)
    expect(r.llmCalls).toBe(2)
    expect(deepReadCount()).toBe(1)
  })

  it('候选 ≤ 8（小图）：全选深读，跳过第一阶段（0 次挑选调用）', async () => {
    addOthers(5) // 共 7 篇其他论文 ≤ 8
    const r = await generateForPaper({ db, llm }, graphId, paperA)
    expect(r.llmCalls).toBe(1) // 只有写关系一次调用（stub 默认响应够用）
    expect(stub.requests).toHaveLength(1)
  })

  it('第一阶段 429：RetryableLlmError 上抛（引擎重试口径不变）', async () => {
    addOthers(7)
    await stub.close()
    stub = await startStubLlm([{ kind: 'status', status: 429, retryAfter: 60 }])
    await expect(generateForPaper({ db, llm }, graphId, paperA)).rejects.toBeInstanceOf(RetryableLlmError)
    expect(stub.requests).toHaveLength(1) // 第二阶段没跑
  })

  it('第一阶段 400：BadRequestLlmError 上抛', async () => {
    addOthers(7)
    await stub.close()
    stub = await startStubLlm([{ kind: 'status', status: 400 }])
    await expect(generateForPaper({ db, llm }, graphId, paperA)).rejects.toBeInstanceOf(BadRequestLlmError)
  })

  it('第一阶段空/坏输出：降级为信号排序 top 8，不报错不烧重试', async () => {
    addOthers(7)
    await stub.close()
    stub = await startStubLlm([
      { kind: 'ok', text: 'stub 回答' }, // 非 JSON → 0 个有效 id
      { kind: 'ok', text: doneJson }
    ])
    const r = await generateForPaper({ db, llm }, graphId, paperA)
    expect(r.llmCalls).toBe(2)
    expect(deepReadCount()).toBe(8) // 降级取 eligible 前 8
    const processed = (db.prepare('SELECT COUNT(*) AS n FROM relation_gen_progress WHERE graph_id = ? AND paper_id = ?').get(graphId, paperA) as { n: number }).n
    expect(processed).toBe(1)
  })

  it('第一阶段信号含文献耦合（D102 → D103 提示）', async () => {
    addOthers(7)
    const now = new Date().toISOString()
    const X = Number(db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES ('LibX', 'zotero', 1, ?, ?)").run(now, now).lastInsertRowid)
    // A 与 P01(B) 共享参考文献 X
    db.prepare("INSERT INTO paper_references (paper_id, openalex_wid, doi, title, year, matched_paper_id, source, created_at) VALUES (?, 'W1', NULL, 't', 2024, ?, 'openalex', ?)").run(paperA, X, now)
    db.prepare("INSERT INTO paper_references (paper_id, openalex_wid, doi, title, year, matched_paper_id, source, created_at) VALUES (?, 'W2', NULL, 't', 2024, ?, 'deepseek', ?)").run(paperB, X, now)
    await stub.close()
    stub = await startStubLlm([
      { kind: 'ok', text: selectJson(['P01', 'P02', 'P03', 'P04', 'P05']) },
      { kind: 'ok', text: doneJson }
    ])
    await generateForPaper({ db, llm }, graphId, paperA)
    const selectUser = (stub.requests[0].body as { messages: Array<{ content: string }> }).messages[1].content
    expect(selectUser).toContain('文献耦合(共享 1 篇参考文献)')
  })
})

describe('parseCandidateIdsJson（D103 容错）', () => {
  it('完整 JSON 提取 candidates', () => {
    expect(parseCandidateIdsJson('前言 {"candidates":["P01","P03"]} 后记')).toEqual(['P01', 'P03'])
  })
  it('坏输出返回空数组（触发降级）', () => {
    expect(parseCandidateIdsJson('stub 回答')).toEqual([])
    expect(parseCandidateIdsJson('{"candidates":"P01"}')).toEqual([])
    expect(parseCandidateIdsJson('{"candidates":[1,"P02"]}')).toEqual(['P02'])
  })
})


describe('D104：重新生成只替换 job 来源边', () => {
  function liveEdges(): Array<{ id: number; paper_low: number; paper_high: number; statement_text: string; llm_types: string; source_type: string; source_job_id: number | null; deleted_at: string | null }> {
    return db
      .prepare(
        `SELECT id, paper_low, paper_high, statement_text, llm_types, source_type, source_job_id, deleted_at
         FROM relations WHERE graph_id = ? ORDER BY id`
      )
      .all(graphId) as Array<{ id: number; paper_low: number; paper_high: number; statement_text: string; llm_types: string; source_type: string; source_job_id: number | null; deleted_at: string | null }>
  }
  const pair = (lo: number, hi: number) => liveEdges().find((r) => r.paper_low === lo && r.paper_high === hi)
  /** source_job_id 有外键：先造 job 行再写边 */
  function mkJob(): number {
    const now = new Date().toISOString()
    return Number(
      db.prepare("INSERT INTO jobs (kind, graph_id, status, created_at, updated_at) VALUES ('relation_gen', ?, 'succeeded', ?, ?)").run(graphId, now, now).lastInsertRowid
    )
  }

  it('(a)(b)(c)：regenerate 后 session 边原样保留（含 LLM 冲突）、未重写的旧 job 边删除、重写的替换且无重复', async () => {
    await stub.close()
    stub = await startStubLlm([
      {
        kind: 'ok',
        text: JSON.stringify({
          relations: [
            { src: 'P01', dst: 'P02', types: ['基于/改进'], statement: '旧：Beta 基于 Alpha。' },
            { src: 'P02', dst: 'P03', types: ['对比'], statement: '旧：Gamma 对比 Beta。' }
          ],
          done: true
        })
      },
      {
        kind: 'ok',
        text: JSON.stringify({
          relations: [
            { src: 'P01', dst: 'P02', types: ['基于/改进'], statement: '新：Beta 基于 Alpha v2。' },
            { src: 'P01', dst: 'P03', types: ['对比'], statement: 'LLM 想覆盖手动边。' } // 与 session 边同对冲突
          ],
          done: true
        })
      }
    ])
    // 首轮整图生成：两条 job 边
    const job1 = mkJob()
    const r1 = await generateForGraph({ db, llm }, graphId, job1)
    expect(r1.written).toBe(2)
    // 手动创建 A→C 的 session 边
    const sessionId = upsertRelation(db, {
      graphId,
      srcPaperId: paperA,
      dstPaperId: paperC,
      statement: '手动边：A 与 C。',
      llmTypes: ['compares'],
      sourceType: 'session'
    })

    // 模拟 enqueueRegenerate：清「已处理」标记后整图重建（D104 语义）
    db.prepare('DELETE FROM relation_gen_progress WHERE graph_id = ?').run(graphId)
    const job2 = mkJob()
    const r2 = await generateForGraph({ db, llm }, graphId, job2, { force: true, replaceStaleJobEdges: true })

    // (c) 重写的 job 边：内容替换、无重复（同一行，source_job_id 更新为 2）
    const ab = pair(Math.min(paperA, paperB), Math.max(paperA, paperB))!
    expect(ab.deleted_at).toBeNull()
    expect(ab.statement_text).toBe('新：Beta 基于 Alpha v2。')
    expect(ab.source_type).toBe('job')
    expect(ab.source_job_id).toBe(job2)

    // (a) session 边原样保留：行未被重写、内容不变
    expect(r2.skippedSession).toBe(1)
    expect(r2.written).toBe(1)
    const ac = pair(Math.min(paperA, paperC), Math.max(paperA, paperC))!
    expect(ac.id).toBe(sessionId) // upsert 没动它（动了会是同一行但内容变——下面再断内容）
    expect(ac.statement_text).toBe('手动边：A 与 C。')
    expect(ac.source_type).toBe('session')
    expect(ac.source_job_id).toBeNull()

    // (b) 本轮未再生成的旧 job 边（B–C）被软删
    const bc = pair(Math.min(paperB, paperC), Math.max(paperB, paperC))!
    expect(bc.deleted_at).not.toBeNull()

    // 无重复：活边恰好两条（A–B job、A–C session）
    const alive = liveEdges().filter((r) => r.deleted_at == null)
    expect(alive).toHaveLength(2)
  })

  it('(d)：增量生成（generateForPaper）不删除旧 job 边', async () => {
    await stub.close()
    stub = await startStubLlm([
      {
        kind: 'ok',
        text: JSON.stringify({ relations: [{ src: 'P01', dst: 'P02', types: ['基于/改进'], statement: '旧：Beta 基于 Alpha。' }], done: true })
      },
      {
        kind: 'ok',
        text: JSON.stringify({ relations: [{ src: 'NEW', dst: 'P01', types: ['基于/改进'], statement: 'Delta 基于 Alpha。' }], done: true })
      }
    ])
    const job1 = mkJob()
    await generateForGraph({ db, llm }, graphId, job1) // 旧 job 边 A–B

    const paperD = addPaperToGraph('Delta Followup')
    setDetail(paperD, 'Delta: 基于 Alpha 方法 X 的跟进工作。')
    const r = await generateForPaper({ db, llm }, graphId, paperD, mkJob())
    expect(r.written).toBe(1)

    // 旧 job 边原样保留（增量路径不删旧边）
    const ab = pair(Math.min(paperA, paperB), Math.max(paperA, paperB))!
    expect(ab.deleted_at).toBeNull()
    expect(ab.statement_text).toBe('旧：Beta 基于 Alpha。')
    // 新边已写入
    const da = pair(Math.min(paperD, paperA), Math.max(paperD, paperA))!
    expect(da.deleted_at).toBeNull()
    expect(da.source_type).toBe('job')
  })

  it('保险丝耗尽抛错时不删旧 job 边（重试安全）', async () => {
    // 先造一条旧 job 边 + 一条本轮不会被重写的旧 job 边
    const job1 = mkJob()
    upsertRelation(db, { graphId, srcPaperId: paperA, dstPaperId: paperB, statement: '旧 job 边 A–B。', llmTypes: ['based_on'], sourceType: 'job', sourceJobId: job1 })
    upsertRelation(db, { graphId, srcPaperId: paperB, dstPaperId: paperC, statement: '旧 job 边 B–C。', llmTypes: ['compares'], sourceType: 'job', sourceJobId: job1 })

    await stub.close()
    // 10 轮（DEFAULT_MAX_ITERATIONS）全部 done=false + finishReason=length：保险丝耗尽
    stub = await startStubLlm(
      Array.from({ length: 10 }, (_, i) => ({
        kind: 'ok' as const,
        text: JSON.stringify({ relations: [{ src: 'P01', dst: 'P02', types: ['基于/改进'], statement: `迭代 ${i}。` }], done: false }),
        finishReason: 'length'
      }))
    )
    db.prepare('DELETE FROM relation_gen_progress WHERE graph_id = ?').run(graphId)
    await expect(
      generateForGraph({ db, llm }, graphId, mkJob(), { force: true, replaceStaleJobEdges: true })
    ).rejects.toThrow(RetryableLlmError)

    // 抛错路径不删：两条旧 job 边都还在
    expect(pair(Math.min(paperA, paperB), Math.max(paperA, paperB))!.deleted_at).toBeNull()
    expect(pair(Math.min(paperB, paperC), Math.max(paperB, paperC))!.deleted_at).toBeNull()
  })
})
