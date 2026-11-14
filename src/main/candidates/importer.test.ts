import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { indexPaperFts } from '../db/fts'
import { getJob } from '../jobs/store'
import { importCandidatePaper, workToCsl } from './importer'
import type { OpenAlexWorkFull } from '../openalex/oa'

/**
 * lane/fetch 批 1：候选入库测试（m6_plan §5.1-3）。
 * 断言：work → CSL-JSON 字段口径（D61）、入库落列（source='agent' / 摘要来源 /
 * paper_authors / openalex_wid）、候选 confirmed + 直达列回填、graph_members、
 * candidate_pdf 排队、D82 去重命中（不重复建论文）、并发撞唯一索引转「已在库中」。
 */

let dir: string
let db: Database.Database
let graphId: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-import-'))
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS)
  const now = new Date().toISOString()
  graphId = Number(db.prepare("INSERT INTO graphs (name, created_at, updated_at) VALUES ('g', ?, ?)").run(now, now).lastInsertRowid)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const WORK: OpenAlexWorkFull = {
  wid: 'W555',
  doi: '10.9/Ab.C',
  title: 'Agent Imported Paper',
  year: 2025,
  authors: ['Alice Smith', 'Bob Jones'],
  venue: 'Journal of Agents',
  abstract: 'an agent paper',
  citedBy: 3,
  oaUrl: 'https://pub.example/a.pdf',
  arxivId: null,
  referencedWorks: []
}

describe('workToCsl（D61 字段口径）', () => {
  it('字段快照：id/title/author 拆分/issued/DOI/container-title/abstract/URL', () => {
    expect(workToCsl(WORK)).toEqual({
      id: '10.9/ab.c',
      type: 'article-journal',
      title: 'Agent Imported Paper',
      author: [{ family: 'Smith', given: 'Alice' }, { family: 'Jones', given: 'Bob' }],
      issued: { 'date-parts': [['2025']] },
      DOI: '10.9/ab.c',
      'container-title': 'Journal of Agents',
      abstract: 'an agent paper',
      URL: 'https://pub.example/a.pdf'
    })
  })

  it('id 兜底：无 DOI 用 arXiv / W-ID；单名作者 given 缺省', () => {
    expect(
      workToCsl({ ...WORK, doi: null, arxivId: '2501.1', authors: ['Madonna'], venue: null, abstract: null, oaUrl: null }).id
    ).toBe('arXiv:2501.1')
    expect(workToCsl({ ...WORK, doi: null, arxivId: null, authors: ['Madonna'] }).author).toEqual([{ family: 'Madonna' }])
    expect(workToCsl({ ...WORK, doi: null, arxivId: null }).id).toBe('oa:W555')
  })
})

describe('importCandidatePaper（D124/D82/D130）', () => {
  const baseInput = () => ({
    graphId,
    x: 3,
    y: 4,
    title: WORK.title ?? '',
    authors: WORK.authors,
    year: 2025,
    doi: 'https://doi.org/10.9/Ab.C', // 带前缀的 DOI 也要归一化
    venue: 'Journal of Agents',
    openalexWid: 'w555',
    abstract: 'an agent paper',
    oaUrl: 'https://pub.example/a.pdf'
  })

  it('入库全链路：papers 落列 + 作者 + 图谱成员 + 候选 confirmed 回填 + 排任务', () => {
    const candidateId = Number(
      db.prepare(
        "INSERT INTO graph_candidates (graph_id, title, authors_json, year, doi, reason, x, y, status, created_at, updated_at) VALUES (?, 't', '[]', NULL, '10.9/ab.c', 'r', 3, 4, 'pending', ?, ?)"
      ).run(graphId, new Date().toISOString(), new Date().toISOString()).lastInsertRowid
    )
    const r = importCandidatePaper(db, { ...baseInput(), candidateId })
    expect(r.alreadyInLibrary).toBe(false)

    const paper = db.prepare('SELECT * FROM papers WHERE id = ?').get(r.paperId) as Record<string, unknown>
    expect(paper.source).toBe('agent')
    expect(paper.doi).toBe('10.9/ab.c')
    expect(paper.title).toBe('Agent Imported Paper')
    expect(paper.first_author).toBe('Smith')
    expect(paper.year).toBe(2025)
    expect(paper.openalex_wid).toBe('W555')
    expect(paper.abstract).toBe('an agent paper')
    expect(paper.abstract_source).toBe('openalex')
    expect(paper.has_pdf).toBe(0)
    const csl = JSON.parse(paper.csl_json as string) as Record<string, unknown>
    expect(csl.DOI).toBe('10.9/ab.c')

    const authors = db.prepare('SELECT family, given, normalized FROM paper_authors WHERE paper_id = ? ORDER BY position').all(r.paperId) as Array<{ family: string; given: string | null; normalized: string }>
    expect(authors).toEqual([
      { family: 'Smith', given: 'Alice', normalized: expect.any(String) },
      { family: 'Jones', given: 'Bob', normalized: expect.any(String) }
    ])

    const member = db.prepare('SELECT x, y FROM graph_members WHERE graph_id = ? AND paper_id = ?').get(graphId, r.paperId) as { x: number; y: number }
    expect(member).toEqual({ x: 3, y: 4 })

    const cand = db.prepare('SELECT status, paper_id, existing_paper_id FROM graph_candidates WHERE id = ?').get(candidateId) as { status: string; paper_id: number; existing_paper_id: number | null }
    expect(cand).toEqual({ status: 'confirmed', paper_id: r.paperId, existing_paper_id: null })

    const job = getJob(db, r.jobId as number)
    expect(job?.kind).toBe('candidate_pdf')
    expect(job?.paperId).toBe(r.paperId)
    expect(job?.payload).toEqual({ oaUrl: 'https://pub.example/a.pdf' })
  })

  it('D82 去重命中：不新建论文，不覆盖已有 FTS，existing_paper_id 指向旧行', () => {
    const now = new Date().toISOString()
    const existing = Number(
      db.prepare("INSERT INTO papers (title, source, doi, created_at, updated_at) VALUES ('旧论文', 'zotero', '10.9/ab.c', ?, ?)").run(now, now).lastInsertRowid
    )
    indexPaperFts(db, existing, { title: '旧论文', abstract: 'kept abstract', keywords: ['zzuniquekeyword'] })
    const before = db.prepare('SELECT title_seg, keywords_seg FROM papers_fts WHERE rowid = ?').get(existing)
    const candidateId = Number(
      db.prepare(
        "INSERT INTO graph_candidates (graph_id, title, authors_json, year, doi, reason, x, y, status, created_at, updated_at) VALUES (?, 't', '[]', NULL, '10.9/ab.c', 'r', 3, 4, 'pending', ?, ?)"
      ).run(graphId, now, now).lastInsertRowid
    )
    const r = importCandidatePaper(db, { ...baseInput(), candidateId })
    expect(r).toMatchObject({ paperId: existing, alreadyInLibrary: true })
    expect((db.prepare('SELECT COUNT(*) AS n FROM papers').get() as { n: number }).n).toBe(1)
    expect(db.prepare('SELECT 1 FROM graph_members WHERE graph_id = ? AND paper_id = ?').get(graphId, existing)).toBeTruthy()
    expect(db.prepare('SELECT title_seg, keywords_seg FROM papers_fts WHERE rowid = ?').get(existing)).toEqual(before)
    expect(db.prepare('SELECT existing_paper_id FROM graph_candidates WHERE id = ?').get(candidateId)).toEqual({ existing_paper_id: existing })
  })

  it('唯一索引冲突回落：另一连接抢先插入后不新建论文，也不覆盖 FTS', () => {
    const now = new Date().toISOString()
    const candidateId = Number(
      db.prepare(
        "INSERT INTO graph_candidates (graph_id, title, authors_json, year, doi, reason, x, y, status, created_at, updated_at) VALUES (?, 't', '[]', NULL, '10.9/ab.c', 'r', 3, 4, 'pending', ?, ?)"
      ).run(graphId, now, now).lastInsertRowid
    )
    let existing = 0
    const r = importCandidatePaper(db, { ...baseInput(), candidateId }, {
      beforeInsert: () => {
        const other = openDatabase(join(dir, 't.db'))
        try {
          existing = Number(
            other.prepare("INSERT INTO papers (title, source, doi, created_at, updated_at) VALUES ('旧论文', 'zotero', '10.9/ab.c', ?, ?)").run(now, now).lastInsertRowid
          )
          indexPaperFts(other, existing, { title: '旧论文', abstract: null, keywords: ['zzuniquekeyword'] })
        } finally {
          other.close()
        }
      }
    })
    expect(r).toMatchObject({ paperId: existing, alreadyInLibrary: true })
    expect((db.prepare('SELECT COUNT(*) AS n FROM papers').get() as { n: number }).n).toBe(1)
    const fts = db.prepare('SELECT keywords_seg FROM papers_fts WHERE rowid = ?').get(existing) as { keywords_seg: string }
    expect(fts.keywords_seg).toContain('zzuniquekeyword')
    expect(db.prepare('SELECT existing_paper_id FROM graph_candidates WHERE id = ?').get(candidateId)).toEqual({ existing_paper_id: existing })
  })

  it('空标题拒绝', () => {
    expect(() => importCandidatePaper(db, { ...baseInput(), title: '  ' })).toThrow('标题不能为空')
  })
})
