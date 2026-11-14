import type Database from 'better-sqlite3'
import type { OpenAlexWorkFull } from '../openalex/oa'
import { indexPaperFts } from '../db/fts'
import { enqueueJob } from '../jobs/store'
import { extractArxivId, normalizeDoi } from '../zotero/ids'
import { normalizeAuthorName } from '../zotero/authorName'

/**
 * lane/fetch 批 1：库外候选入库（D124/D82/D130；m6_plan §5.1-3）。
 *
 * - OpenAlex work / 候选行字段 → CSL-JSON（D61 口径对齐 zotero/csl.ts 的字段约定）
 *   → papers（source='agent'，DOI 归一化，写 openalex_wid / OpenAlex 摘要）；
 * - 去重只按 DOI / arXiv（D82）：先查；并发确认撞唯一索引（m6_plan 风险 5）转
 *   「已在库中」，不报错、复用既有论文；
 * - 同事务加入当前图谱（graph_members，沿用候选坐标）+ 候选标记 confirmed +
 *   回填 paper_id；出来后排 candidate_pdf 任务（locate → download，D130）。
 *
 * 本模块不 import agent/candidates（candidates.ts 反向依赖本模块，保持单向）。
 */

export interface CandidatePaperInput {
  graphId: number
  candidateId?: number | null
  x: number
  y: number
  title: string
  authors: string[]
  year?: number | null
  doi?: string | null
  arxivId?: string | null
  venue?: string | null
  openalexWid?: string | null
  abstract?: string | null
  /** 检索时缓存的 best_oa_location（直接进 candidate_pdf 任务 payload） */
  oaUrl?: string | null
  /** D142：触发入库的 agent 会话，随 candidate_pdf → process_paper 带到后台记账 */
  sessionId?: number | null
}

export interface ImportCandidateResult {
  paperId: number
  /** 排的 candidate_pdf 任务 id；论文已有 PDF 时为 null */
  jobId: number | null
  /** D82 命中既有论文（含并发撞唯一索引） */
  alreadyInLibrary: boolean
}

interface CslFields {
  id: string
  title: string
  authors: string[]
  year: number | null
  doi: string | null
  venue: string | null
  abstract: string | null
  url: string | null
}

/** 「名 姓」→ { family, given }（姓取末词；单名整体当姓，与 Zotero 导入口径一致） */
function splitAuthor(name: string): { family: string; given: string | null } {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return { family: parts[0], given: null }
  return { family: parts[parts.length - 1], given: parts.slice(0, -1).join(' ') }
}

/** CSL-JSON 构造（D61，与 zotero/csl.ts 同一口径：article-journal，年是字符串） */
function cslFromFields(f: CslFields): Record<string, unknown> {
  const csl: Record<string, unknown> = { id: f.id, type: 'article-journal', title: f.title }
  const author = f.authors
    .map((a) => splitAuthor(a))
    .filter((a) => a.family !== '')
    .map((a) => ({ family: a.family, ...(a.given ? { given: a.given } : {}) }))
  if (author.length > 0) csl.author = author
  if (f.year != null) csl.issued = { 'date-parts': [[String(f.year)]] }
  if (f.doi) csl.DOI = f.doi
  if (f.venue) csl['container-title'] = f.venue
  if (f.abstract) csl.abstract = f.abstract
  if (f.url) csl.URL = f.url
  return csl
}

/** OpenAlex work → CSL-JSON（D61；id 优先级：DOI > arXiv > OpenAlex W-ID） */
export function workToCsl(work: OpenAlexWorkFull): Record<string, unknown> {
  const doi = normalizeDoi(work.doi) // 双保险：手工构造的 work 也归一（parseWorkFull 已归一）
  return cslFromFields({
    id: doi ?? (work.arxivId ? `arXiv:${work.arxivId}` : `oa:${work.wid}`),
    title: work.title ?? '',
    authors: work.authors,
    year: work.year,
    doi,
    venue: work.venue,
    abstract: work.abstract,
    url: work.oaUrl ?? (doi ? `https://doi.org/${doi}` : null)
  })
}

/** D82 去重查询（DOI / arXiv 精确；未删除行） */
function lookupExisting(db: Database.Database, doi: string | null, arxivId: string | null): number | null {
  if (doi) {
    const r = db.prepare('SELECT id FROM papers WHERE doi = ? AND deleted_at IS NULL').get(doi) as { id: number } | undefined
    if (r) return r.id
  }
  if (arxivId) {
    const r = db.prepare('SELECT id FROM papers WHERE arxiv_id = ? AND deleted_at IS NULL').get(arxivId) as { id: number } | undefined
    if (r) return r.id
  }
  return null
}

function normArxiv(raw: string): string {
  const extracted = extractArxivId({ archiveID: raw })
  if (extracted) return extracted
  return raw.trim().toLowerCase().replace(/\s+/g, '').replace(/v\d+$/, '')
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e != null && (e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
}

export interface ImportCandidateOptions {
  /**
   * 查重未命中、插入事务开始之前调用。测试用来在另一条连接上抢先插入同一 DOI，
   * 覆盖唯一索引冲突回落（生产路径是两个确认并发）。
   */
  beforeInsert?: () => void
}

export function importCandidatePaper(
  db: Database.Database,
  input: CandidatePaperInput,
  opts: ImportCandidateOptions = {}
): ImportCandidateResult {
  const title = input.title.trim()
  if (!title) throw new Error('候选论文标题不能为空')
  const doi = normalizeDoi(input.doi)
  const arxivId = input.arxivId ? normArxiv(input.arxivId) : null
  const authors = input.authors.map((a) => a.trim()).filter(Boolean)
  const venue = input.venue?.trim() ? input.venue.trim() : null
  const abstract = input.abstract?.trim() ? input.abstract.trim() : null
  const wid = input.openalexWid?.trim() ? input.openalexWid.trim().toUpperCase() : null
  const now = new Date().toISOString()

  let paperId: number = lookupExisting(db, doi, arxivId) ?? 0
  let alreadyInLibrary = paperId !== 0

  const linkGraph = (): void => {
    db.prepare('INSERT OR IGNORE INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, ?, ?, ?)').run(
      input.graphId,
      paperId,
      input.x,
      input.y,
      now
    )
    if (input.candidateId != null) {
      // D82：existing_paper_id 只表示「提议时已在库」。新插入保持 null。
      db.prepare(
        "UPDATE graph_candidates SET status = 'confirmed', paper_id = ?, existing_paper_id = ?, updated_at = ? WHERE id = ?"
      ).run(paperId, alreadyInLibrary ? paperId : null, now, input.candidateId)
    }
  }

  const insertPaper = (): void => {
    const csl = cslFromFields({
      id: doi ?? (arxivId ? `arXiv:${arxivId}` : wid ? `oa:${wid}` : `agent-${input.candidateId ?? Date.now()}`),
      title,
      authors,
      year: input.year ?? null,
      doi,
      venue,
      abstract,
      url: input.oaUrl?.trim() ? input.oaUrl.trim() : doi ? `https://doi.org/${doi}` : null
    })
    const firstAuthor = authors.length > 0 ? splitAuthor(authors[0]).family : null
    const r = db
      .prepare(
        `INSERT INTO papers (
           csl_json, title, first_author, year, doi, doi_match_method, arxiv_id, openalex_wid,
           source, has_pdf, abstract, abstract_source, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'agent', 0, ?, ?, ?, ?)`
      )
      .run(
        JSON.stringify(csl),
        title,
        firstAuthor,
        input.year ?? null,
        doi,
        doi ? 'original' : null,
        arxivId,
        wid,
        abstract,
        abstract ? 'openalex' : null,
        now,
        now
      )
    paperId = Number(r.lastInsertRowid)
    const ins = db.prepare('INSERT INTO paper_authors (paper_id, position, family, given, normalized) VALUES (?, ?, ?, ?, ?)')
    authors.forEach((a, i) => {
      const s = splitAuthor(a)
      ins.run(paperId, i, s.family, s.given, normalizeAuthorName(a))
    })
  }

  if (!alreadyInLibrary) opts.beforeInsert?.()

  try {
    const tx = db.transaction(() => {
      if (!alreadyInLibrary) insertPaper()
      linkGraph()
    })
    tx()
  } catch (e) {
    // m6_plan 风险 5：两张候选同时确认同 DOI → 唯一索引冲突 = 「已在库中」，不报错
    if (!alreadyInLibrary && isUniqueViolation(e)) {
      const existing = lookupExisting(db, doi, arxivId)
      if (existing == null) throw e
      paperId = existing
      alreadyInLibrary = true
      const tx2 = db.transaction(linkGraph)
      tx2()
    } else {
      throw e
    }
  }

  if (paperId === 0) throw new Error('候选入库失败：未取得论文 id')
  // 去重命中（含唯一索引回落）不重建 FTS，避免空关键词覆盖库内已有索引
  if (!alreadyInLibrary) indexPaperFts(db, paperId, { title, abstract, keywords: [] })

  // 排 PDF 查找任务（D130）；论文已有 PDF（去重命中且处理过）不再排
  const hasPdf = (db.prepare('SELECT has_pdf FROM papers WHERE id = ?').get(paperId) as { has_pdf: number }).has_pdf === 1
  const payload: Record<string, unknown> = { oaUrl: input.oaUrl ?? null }
  if (input.sessionId != null && input.sessionId > 0) payload.sessionId = input.sessionId
  const jobId = hasPdf ? null : enqueueJob(db, 'candidate_pdf', { paperId, payload })
  return { paperId, jobId, alreadyInLibrary }
}
