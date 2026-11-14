import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import {
  CAND_NODE_H,
  CAND_NODE_W,
  confirmCandidate,
  findExistingPaper,
  ignoreCandidate,
  listCandidates,
  moveCandidate,
  normalizeArxiv,
  proposeCandidate,
  type ProposeCandidateOptions
} from './candidates'
import { normalizeDoi } from '../zotero/ids'
import { makeFakeOpenAlex } from '../openalex/testing'

/** M5 lane/agent 批 3：候选链路（D82/D55 去重、D117 确认边界、状态机、增量布局）。 */

let dir: string
let db: Database.Database
let graphId: number
let sessionId: number
let paperId: number

const now = (): string => new Date().toISOString()

function propose(
  overrides: Partial<Parameters<typeof proposeCandidate>[1]> = {},
  options?: ProposeCandidateOptions
) {
  return proposeCandidate(
    db,
    {
      graphId,
      sessionId,
      title: '候选论文',
      authors: ['张三', '李四'],
      year: 2024,
      doi: '10.1/AbC ',
      arxivId: null,
      reason: '方法与图谱主题相关',
      ...overrides
    },
    options
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-agent-'))
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS)
  graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('候选图', now(), now()).lastInsertRowid)
  sessionId = Number(db.prepare("INSERT INTO sessions (graph_id, entry_type, entry_id, name, created_at, updated_at) VALUES (?, 'graph', NULL, 's', ?, ?)").run(graphId, now(), now()).lastInsertRowid)
  paperId = Number(db.prepare("INSERT INTO papers (title, source, doi, arxiv_id, created_at, updated_at) VALUES ('库内', 'zotero', '10.1/abc', '2501.12345', ?, ?)").run(now(), now()).lastInsertRowid)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('候选规范化与去重（D82/D55）', () => {
  it('normalizeDoi / normalizeArxiv：小写去空白、去 resolver/abs 前缀、arXiv 去版本后缀', () => {
    expect(normalizeDoi(' 10.1145/ABC-DEF ')).toBe('10.1145/abc-def')
    expect(normalizeDoi('https://doi.org/10.1145/abc-def')).toBe('10.1145/abc-def') // 复用 zotero/ids（评审建议修 1）
    expect(normalizeDoi('doi:10.1145/ABC')).toBe('10.1145/abc')
    expect(normalizeArxiv('2501.12345v2')).toBe('2501.12345')
    expect(normalizeArxiv('cs/9901001V12')).toBe('cs/9901001')
    expect(normalizeArxiv('https://arxiv.org/abs/2501.12345v3')).toBe('2501.12345') // extractArxivId 剥 URL 前缀
  })

  it('DOI 大小写/空白归一后精确命中库内论文，填 existing_paper_id', async () => {
    const v = await propose({ doi: ' 10.1/ABC ' })
    expect(v.existingPaperId).toBe(paperId)
    expect(v.status).toBe('pending')
    const row = db.prepare('SELECT session_id, doi FROM graph_candidates WHERE id = ?').get(v.id) as { session_id: number; doi: string }
    expect(row.session_id).toBe(sessionId) // 040 的 session_id 接线
    expect(row.doi).toBe('10.1/abc')
  })

  it('模型从正文读出 URL 形式标识也能命中：https://doi.org/ 前缀与 arxiv.org/abs（评审建议修 1）', async () => {
    expect((await propose({ doi: 'https://doi.org/10.1/ABC' })).existingPaperId).toBe(paperId)
    expect((await propose({ doi: null, arxivId: 'https://arxiv.org/abs/2501.12345v2' })).existingPaperId).toBe(paperId)
  })

  it('arXiv 去版本后缀命中；都不命中则库外候选', async () => {
    expect((await propose({ doi: null, arxivId: '2501.12345v3' })).existingPaperId).toBe(paperId)
    expect((await propose({ doi: '10.9/zzz', arxivId: null })).existingPaperId).toBeNull()
    expect(findExistingPaper(db, normalizeDoi('10.1/ABC'), null)).toBe(paperId) // 调用方负责规范化
  })
})

describe('候选确认/忽略状态机（D117）', () => {
  it('已在库中：确认 = 加入图谱（坐标用候选位，不动旧成员），重复确认幂等', async () => {
    const other = Number(db.prepare("INSERT INTO papers (title, source, created_at, updated_at) VALUES ('旧', 'zotero', ?, ?)").run(now(), now()).lastInsertRowid)
    db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 300, 200, ?)').run(graphId, other, now())
    const c = await propose({}) // 命中 paperId

    const r = confirmCandidate(db, c.id)
    expect(r.candidate.status).toBe('confirmed')
    expect(r.addedPaperId).toBe(paperId)
    expect(r.sessionId).toBe(sessionId) // 候选行来源会话带出（040 列，评审建议修 3）
    const m = db.prepare('SELECT x, y FROM graph_members WHERE graph_id = ? AND paper_id = ?').get(graphId, paperId) as { x: number; y: number }
    expect([m.x, m.y]).toEqual([c.x, c.y]) // 候选坐标成为节点坐标
    // 旧成员坐标不动
    const old = db.prepare('SELECT x, y FROM graph_members WHERE graph_id = ? AND paper_id = ?').get(graphId, other) as { x: number; y: number }
    expect([old.x, old.y]).toEqual([300, 200])

    const again = confirmCandidate(db, c.id)
    expect(again.addedPaperId).toBeNull() // 幂等
  })

  it('库外候选确认（M6 lane/fetch 批 1，D124）：真入库——papers(source=agent) + 加图谱 + confirmed 回填 + 排 candidate_pdf', async () => {
    const c = await propose({ doi: '10.9/zzz', year: 2023 })
    const r = confirmCandidate(db, c.id)
    expect(r.candidate.status).toBe('confirmed')
    expect(r.addedPaperId).toBeGreaterThan(0)
    expect(r.jobId).toBeGreaterThan(0) // 已排 candidate_pdf（D130）

    const paper = db.prepare('SELECT * FROM papers WHERE id = ?').get(r.addedPaperId as number) as Record<string, unknown>
    expect(paper.source).toBe('agent')
    expect(paper.doi).toBe('10.9/zzz')
    expect(paper.year).toBe(2023)
    expect(paper.first_author).toBe('张三') // 中文名单 token，整体当姓（与 Zotero 导入口径一致）
    const csl = JSON.parse(paper.csl_json as string) as Record<string, unknown>
    expect(csl.DOI).toBe('10.9/zzz')
    expect(db.prepare('SELECT 1 FROM graph_members WHERE graph_id = ? AND paper_id = ?').get(graphId, r.addedPaperId)).toBeTruthy()
    const row = db.prepare('SELECT status, paper_id, existing_paper_id FROM graph_candidates WHERE id = ?').get(c.id) as Record<string, unknown>
    expect(row).toMatchObject({ status: 'confirmed', paper_id: r.addedPaperId, existing_paper_id: null })
    const job = db.prepare("SELECT kind FROM jobs WHERE id = ?").get(r.jobId as number) as { kind: string }
    expect(job.kind).toBe('candidate_pdf')
  })

  it('库外确认 D82 去重命中：不新建论文，复用库内行', async () => {
    const c = await propose({ doi: ' 10.1/ABC ' }) // 命中 paperId
    const r = confirmCandidate(db, c.id)
    expect(r.addedPaperId).toBe(paperId)
    expect(r.candidate.existingPaperId).toBe(paperId)
    expect(db.prepare('SELECT COUNT(*) AS n FROM papers WHERE doi = ?').get('10.1/abc')).toEqual({ n: 1 })
  })

  it('忽略：pending → ignored，幂等；已忽略的不能确认', async () => {
    const c = await propose({})
    expect(ignoreCandidate(db, c.id).candidate.status).toBe('ignored')
    const ignored = ignoreCandidate(db, c.id) // ignored → ignored 幂等
    expect(ignored.candidate.status).toBe('ignored')
    expect(ignored.sessionId).toBe(sessionId)
    expect(() => confirmCandidate(db, c.id)).toThrow('已忽略')
  })
})

describe('候选布局与列表', () => {
  it('uat5 建议修 7：候选落位与既有内容包围盒不相交（黄金角螺旋），连续提案互不重叠', async () => {
    db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 100, 100, ?)').run(graphId, paperId, now())
    const a = await propose({ doi: '10.9/a1' })
    const b = await propose({ doi: '10.9/a2' })
    const c = await propose({ doi: '10.9/a3' })
    const boxes = [
      { x: 100, y: 100 }, // 成员
      { x: a.x, y: a.y },
      { x: b.x, y: b.y },
      { x: c.x, y: c.y }
    ]
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const p = boxes[i]
        const q = boxes[j]
        const overlap = p.x < q.x + CAND_NODE_W + 2 && q.x < p.x + CAND_NODE_W + 2 && p.y < q.y + CAND_NODE_H + 2 && q.y < p.y + CAND_NODE_H + 2
        expect(overlap).toBe(false)
      }
    }
  })

  it('uat5 建议修 7：已忽略 / dismissed 的旧坐标不再把新候选越推越远', async () => {
    db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 100, 100, ?)').run(graphId, paperId, now())
    // 一个掉到很远的已忽略候选（旧坐标）
    const old = await propose({ doi: '10.9/old', title: '旧候选' })
    db.prepare("UPDATE graph_candidates SET status = 'ignored' WHERE id = ?").run(old.id)
    moveCandidate(db, old.id, 100, 5000)
    const fresh = await propose({ doi: '10.9/fresh', title: '新候选' })
    // 新候选贴着既有簇（成员 100,100 附近），而不是被旧坐标推到 5000+160
    expect(fresh.y).toBeLessThan(1000)
    const near = Math.abs(fresh.x - 100) <= 800 && Math.abs(fresh.y - 100) <= 800
    expect(near).toBe(true)
  })

  it('listCandidates 按 id 倒序；图谱隔离', async () => {
    await propose({ doi: '10.9/a1' })
    await propose({ doi: '10.9/a2' })
    const otherGraph = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('别图', now(), now()).lastInsertRowid)
    await proposeCandidate(db, { graphId: otherGraph, sessionId, title: '别图候选', authors: [], reason: 'x' })
    expect(listCandidates(db, graphId)).toHaveLength(2)
    expect(listCandidates(db, otherGraph)).toHaveLength(1)
  })

  it('proposeCandidate 校验：空标题 / 图谱不存在', async () => {
    await expect(propose({ title: '   ' })).rejects.toThrow('标题')
    await expect(proposeCandidate(db, { graphId: 99999, sessionId, title: 'x', authors: [], reason: 'r' })).rejects.toThrow('图谱')
  })

  it('moveCandidate 写回坐标', async () => {
    const v = await propose({ doi: '10.9/move' })
    moveCandidate(db, v.id, 40, 80)
    expect(db.prepare('SELECT x, y FROM graph_candidates WHERE id = ?').get(v.id)).toEqual({ x: 40, y: 80 })
  })
})

describe('uat3b 去重、回填与编号（D159–D161 / D150）', () => {
  it('wid 大小写归一后命中；只有标题命中不拦截并标 titleDup', async () => {
    db.prepare('UPDATE papers SET openalex_wid = ? WHERE id = ?').run('W123', paperId)
    const byWid = await propose({ doi: null, arxivId: null, openalexWid: 'w123', title: '另一篇' })
    expect(byWid.existingPaperId).toBe(paperId)
    expect(byWid.titleDup).toBeUndefined()

    const byTitle = await propose({ doi: '10.9/title-only', arxivId: null, title: '库 内!' })
    expect(byTitle.existingPaperId).toBeNull()
    expect(byTitle.titleDup).toBe(true)
    expect(byTitle.inGraph).toBeUndefined()
  })

  it('pending 同一 DOI 返回既有候选且不插入第二行', async () => {
    const a = await propose({ doi: '10.9/dup', title: '第一篇' })
    const b = await propose({ doi: '10.9/DUP', title: '第二篇' })
    expect(b.id).toBe(a.id)
    expect(b.duplicateOfId).toBe(a.id)
    expect(db.prepare('SELECT COUNT(*) AS n FROM graph_candidates').get()).toEqual({ n: 1 })
  })

  it('已在本图谱自动收起为 dismissed（D169），确认被拒、重复提议仍去重', async () => {
    db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 10, 10, ?)').run(graphId, paperId, now())
    const v = await propose({ doi: '10.1/abc' })
    expect(v.existingPaperId).toBe(paperId)
    expect(v.inGraph).toBe(true)
    expect(v.status).toBe('dismissed')
    expect(db.prepare('SELECT in_graph, status FROM graph_candidates WHERE id = ?').get(v.id)).toEqual({ in_graph: 1, status: 'dismissed' })
    expect(() => confirmCandidate(db, v.id)).toThrow('已在本图谱中')
    // 同一篇再提议：命中 dismissed 行去重，不再出第二张卡片
    const again = await propose({ doi: '10.1/ABC', title: '重复提议' })
    expect(again.id).toBe(v.id)
    expect(db.prepare('SELECT COUNT(*) AS n FROM graph_candidates').get()).toEqual({ n: 1 })
  })

  it('库内非空元数据盖过 Agent 字段，且不调用 OpenAlex', async () => {
    db.prepare('UPDATE papers SET year = 2018, csl_json = ? WHERE id = ?').run(JSON.stringify({ 'container-title': 'Nature' }), paperId)
    db.prepare('INSERT INTO paper_authors (paper_id, position, family, given, normalized) VALUES (?, 0, ?, ?, ?)').run(
      paperId,
      'Chen',
      'Ru',
      'ru chen'
    )
    const fake = makeFakeOpenAlex()
    const v = await propose(
      { doi: '10.1/abc', title: 'Agent Title', authors: ['Agent Author'], year: 2099 },
      { openAlex: fake }
    )
    expect(fake.calls).toEqual([])
    expect(v.title).toBe('库内')
    expect(v.year).toBe(2018)
    expect(v.authors).toEqual(['Ru Chen'])
    expect(v.venue).toBe('Nature')
    expect(v.arxivId).toBe('2501.12345')
  })

  it('OpenAlex 回填 21 位作者与 wid（核对通过才采用）；抛错则保留 Agent 字段并标未核实', async () => {
    const authors = Array.from({ length: 21 }, (_, i) => `Author ${i}`)
    const hit = makeFakeOpenAlex()
    hit.fetchWorkFullByDoi = async () => ({
      wid: 'w21',
      doi: '10.9/oa21',
      title: 'OA Title: Verified Match', // 与 Agent 标题高度相似（核对通过）
      year: 2020,
      authors,
      venue: 'ICML',
      abstract: 'abs',
      oaUrl: 'https://oa.example/a.pdf',
      arxivId: null,
      citedBy: 1,
      referencedWorks: []
    })
    const v = await propose({ doi: '10.9/oa21', title: 'OA Title Verified Match', authors: ['A', 'B'], year: 1999 }, { openAlex: hit })
    expect(v.unverified).toBeUndefined()
    const row = db.prepare('SELECT authors_json, openalex_wid, title, venue, verified FROM graph_candidates WHERE id = ?').get(v.id) as {
      authors_json: string
      openalex_wid: string
      title: string
      venue: string
      verified: number
    }
    expect(JSON.parse(row.authors_json)).toEqual(authors)
    expect(row.openalex_wid).toBe('W21')
    expect(row.title).toBe('OA Title: Verified Match')
    expect(row.venue).toBe('ICML')
    expect(row.verified).toBe(1)

    const down = makeFakeOpenAlex()
    down.fetchWorkFullByDoi = async () => {
      throw new Error('down')
    }
    const kept = await propose({ doi: '10.9/down', title: 'Agent Keeps', authors: ['保持'], year: 2011 }, { openAlex: down })
    expect(kept.title).toBe('Agent Keeps')
    expect(kept.authors).toEqual(['保持'])
    expect(kept.year).toBe(2011)
    expect(kept.openalexWid).toBeUndefined()
    expect(kept.unverified).toBe(true) // 核对失败（抛错）标未核实
  })

  it('uat5 必须修 2：DOI 解析到无关记录（CareerX 情形）拒绝——保留 Agent 元数据、不写入错误 wid/DOI、标未核实', async () => {
    const fake = makeFakeOpenAlex()
    // DOI 径返回标题完全无关的记录（测试者 复测：Self-RAG 被覆盖成《CareerX…》）
    fake.fetchWorkFullByDoi = async () => ({
      wid: 'wcareerx',
      doi: '10.9/wrong',
      title: 'CareerX: Benchmarking Career Recommendations',
      year: 2024,
      authors: ['Someone Else'],
      venue: 'KDD',
      abstract: null,
      oaUrl: null,
      arxivId: null,
      citedBy: 9,
      referencedWorks: []
    })
    const v = await propose({ doi: '10.9/selfrag', arxivId: '2310.11511', title: 'Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection', authors: ['Akari Asai'], year: 2023 }, { openAlex: fake })
    expect(v.title).toContain('Self-RAG') // Agent 元数据原样保留
    expect(v.authors).toEqual(['Akari Asai'])
    expect(v.year).toBe(2023)
    expect(v.openalexWid).toBeUndefined() // 错误的 wid 不进库
    expect(v.unverified).toBe(true)
    const row = db.prepare('SELECT doi, arxiv_id, openalex_wid, verified FROM graph_candidates WHERE id = ?').get(v.id) as Record<string, unknown>
    expect(row.doi).toBe('10.9/selfrag')
    expect(row.arxiv_id).toBe('2310.11511')
    expect(row.openalex_wid).toBeNull()
    expect(row.verified).toBe(0)
  })

  it('uat5 必须修 2：arXiv id 一致即核实（标题写法不同也采用）', async () => {
    const fake = makeFakeOpenAlex()
    fake.fetchWorkFullByDoi = async () => ({
      wid: 'woa',
      doi: '10.48550/arxiv.2310.11511',
      title: 'Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection',
      year: 2023,
      authors: ['Akari Asai', 'Zeji Wu'],
      venue: 'ICLR',
      abstract: 'abs',
      oaUrl: null,
      arxivId: '2310.11511',
      citedBy: 99,
      referencedWorks: []
    })
    const v = await propose({ doi: null, arxivId: '2310.11511v2', title: 'Self-RAG（自反思检索增强）', authors: ['A'], year: null }, { openAlex: fake })
    expect(v.unverified).toBeUndefined()
    expect(v.openalexWid).toBe('WOA')
    expect(v.venue).toBe('ICLR')
    expect(v.authors).toEqual(['Akari Asai', 'Zeji Wu'])
  })

  it('D168：只给标题——OpenAlex 高度相似命中则采用；无结果或标题不相似则保留并标未核实', async () => {
    const hit = makeFakeOpenAlex()
    hit.searchWorksFull = async () => [
      {
        wid: 'wtitle',
        doi: '10.9/title-hit',
        title: 'Graph Neural Networks for Citation Recommendation',
        year: 2022,
        authors: ['X Wang'],
        venue: 'WWW',
        abstract: null,
        oaUrl: null,
        arxivId: null,
        citedBy: 3,
        referencedWorks: []
      }
    ]
    const adopted = await propose({ doi: null, arxivId: null, title: 'Graph Neural Networks for Citation Recommendation', authors: [], year: null }, { openAlex: hit })
    expect(adopted.unverified).toBeUndefined()
    expect(adopted.doi).toBe('10.9/title-hit')
    expect(adopted.openalexWid).toBe('WTITLE')

    const miss = makeFakeOpenAlex() // 默认 searchWorksFull 返回 []
    const notFound = await propose({ doi: null, arxivId: null, title: 'A Paper That Does Not Exist Anywhere', authors: [], year: null }, { openAlex: miss })
    expect(notFound.unverified).toBe(true)
    expect(notFound.doi).toBeNull()

    const off = makeFakeOpenAlex()
    off.searchWorksFull = async () => [
      {
        wid: 'wother',
        doi: '10.9/other',
        title: 'Completely Different Topic in Biology',
        year: 2020,
        authors: ['Y'],
        venue: null,
        abstract: null,
        oaUrl: null,
        arxivId: null,
        citedBy: 1,
        referencedWorks: []
      }
    ]
    const rejected = await propose({ doi: null, arxivId: null, title: 'Advanced Retrieval Augmented Generation Survey', authors: [], year: null }, { openAlex: off })
    expect(rejected.unverified).toBe(true)
    expect(rejected.title).toBe('Advanced Retrieval Augmented Generation Survey')
    expect(rejected.openalexWid).toBeUndefined()
  })

  it('D168（uat5-fix1 文案对齐）：0.80–0.95 的仅标题命中——标未核实、不回填（比核对阈值 0.8 严，少认错论文）', async () => {
    // 与 query「…through Self-Reflection」的 bigram Dice ≈ 0.85（0.8 与 0.95 之间）
    const near = makeFakeOpenAlex()
    near.searchWorksFull = async () => [
      {
        wid: 'wnear',
        doi: '10.9/near-hit',
        title: 'Self-RAG: Learning to Retrieve, Generate, and Critique in the Wild',
        year: 2024,
        authors: ['Someone'],
        venue: 'KDD',
        abstract: null,
        oaUrl: null,
        arxivId: null,
        citedBy: 1,
        referencedWorks: []
      }
    ]
    const v = await propose(
      { doi: null, arxivId: null, title: 'Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection', authors: [], year: null },
      { openAlex: near }
    )
    expect(v.unverified).toBe(true) // 0.85 没过仅标题采用阈值 0.95
    expect(v.doi).toBeNull() // 不回填
    expect(v.openalexWid).toBeUndefined()
    expect(v.venue).toBeUndefined()
    const row = db.prepare('SELECT verified, doi, openalex_wid FROM graph_candidates WHERE id = ?').get(v.id) as Record<string, unknown>
    expect(row).toEqual({ verified: 0, doi: null, openalex_wid: null })
  })

  it('uat5 建议修 5 + fix1 S1：理由去「同上」类开头；回声括注只删括注、保留短标题', async () => {
    const v1 = await propose({ doi: '10.9/r1', reason: '同上，亦采用检索增强提升事实性。' })
    expect(v1.reason).toBe('亦采用检索增强提升事实性。')
    const v2 = await propose({ doi: '10.9/r2', reason: 'HALT（《HALT: Verifying Multi-step Reasoning…》）验证推理链可靠性。' })
    expect(v2.reason).toBe('HALT 验证推理链可靠性。') // 短标题保留，只删《长标题》回声括注
    const v3 = await propose({ doi: '10.9/r3', reason: '提出新的耦合度量。' })
    expect(v3.reason).toBe('提出新的耦合度量。')
  })

  it('候选理由里的 P01 与 #N 换成短标题', async () => {
    db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)').run(graphId, paperId, now())
    const v = await propose({ doi: '10.9/reason', reason: `对照 P01 与 #${paperId}。` })
    expect(v.reason).toContain('《库内》')
    expect(v.reason).not.toMatch(/\bP\d/)
    expect(v.reason).not.toMatch(/#\d/)
  })
})
