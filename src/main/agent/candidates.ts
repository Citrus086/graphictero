import type Database from 'better-sqlite3'
import type { CandidateView } from '../../shared/ipc/agent'
import { extractArxivId, normalizeDoi } from '../zotero/ids'
import { importCandidatePaper } from '../candidates/importer'
import { enqueueJob } from '../jobs/store'
import type { OpenAlexClient } from '../openalex/client'
import type { OpenAlexWorkFull } from '../openalex/oa'
import { titleSim } from '../openalex/match'
import { citePaper, replaceInternalRefTokens, resolveStoredIdToken } from '../text/internalRefs'
import { placeNewNode } from '../../shared/layout/placeNewNode'

/**
 * M5 lane/agent：候选论文链路（D11/D16/D30/D32/D55/D82/D117；表 001 + 040 的
 * session_id 首次接线）。
 *
 * - proposeCandidate：写 graph_candidates（status=pending，session_id 记录来源
 *   会话）；DOI/arXiv 复用 zotero/ids 的库内同款规范化后精确去重（D82/D55），
 *   另加 OpenAlex wid（D159）。命中库中论文填 existing_paper_id。
 *   元数据先用本地库（含 Zotero），否则 OpenAlex 回填；Agent 只提供理由。
 *   x/y 落在现有内容左下方（uat3b 4.4：避开右侧对话抽屉）；
 * - confirmCandidate：「已在库中 → 加入图谱」；库外候选确认真入库（D124）；
 * - ignoreCandidate：pending → ignored。
 */

export interface ProposeCandidateInput {
  graphId: number
  sessionId: number
  title: string
  authors: string[]
  year?: number | null
  doi?: string | null
  arxivId?: string | null
  reason: string
  /** D134 bug5：已知摘要（检索命中或模型带回）入库前先落在候选行上 */
  abstract?: string | null
  venue?: string | null
  oaUrl?: string | null
  openalexWid?: string | null
}

/** null / 缺省 = 不访问 OpenAlex（单测与冒烟）。生产由 runtime 注入。 */
export interface ProposeCandidateOptions {
  openAlex?: OpenAlexClient | null
}

/**
 * D82 规范化：DOI 用 zotero/ids 的 normalizeDoi（与入库路径同款，剥
 * https://doi.org/、doi: 前缀）；arXiv 先用 extractArxivId 剥 arxiv.org/abs|pdf/
 * 前缀（URL 形式），裸 ID 回退本地小写/去空白/去版本后缀（v1/v2…）。
 */
export function normalizeArxiv(arxivId: string): string {
  const extracted = extractArxivId({ archiveID: arxivId })
  if (extracted) return extracted
  return arxivId.trim().toLowerCase().replace(/\s+/g, '').replace(/v\d+$/, '')
}

/** uat3b D159：规范化标题匹配（小写、去标点和空白） */
export function normalizeTitleForDedupe(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function cleanDoi(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null
  return normalizeDoi(raw)
}

function cleanArxiv(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null
  const a = normalizeArxiv(raw).trim()
  return a || null
}

/**
 * uat5 建议修 5 + uat5-fix1 S1：理由后处理。提示词要求「短标题开头、独立成句、不用同上」，这里兜底：
 * - 去掉「同上 / 同上所述 / 如前所述 / 同前」类开头（理由不得指代别的候选或条目）；
 * - 开头短标题后紧跟的（《长标题》）回声括注**只删括注、保留短标题**
 *   （「HALT（《HALT: Verifica…》）验证…」→「HALT 验证…」）。
 * 清洗后为空则保留原文（reason 由 zod min(1) 保证非空输入）。
 */
export function sanitizeCandidateReason(reason: string): string {
  const original = reason.trim()
  let s = original.replace(/^(?:同上所述|如前所述|同前所述|同上|同前)[，,、：:；;．.。]?\s*/, '')
  const echo = /^(.{1,40}?)[(（]《[^》]*》[)）]/.exec(s)
  if (echo) {
    const rest = s.slice(echo[0].length).trimStart()
    const head = echo[1].trimEnd()
    // 保留短标题；两侧都是非空白时补一个空格（「HALT 验证…」）
    s = head && rest ? `${head} ${rest}` : head || rest
  }
  s = s.trim()
  return s.length > 0 ? s : original
}

/** uat3b D150：候选理由里的 P0x / NEW / #N → 《短标题》或作者+年份（查不到则剔除）。 */
export function stripInternalRefTokens(db: Database.Database, graphId: number, text: string): string {
  const rows = db
    .prepare(
      `SELECT p.id FROM graph_members m JOIN papers p ON p.id = m.paper_id
       WHERE m.graph_id = ? AND p.deleted_at IS NULL ORDER BY p.id`
    )
    .all(graphId) as Array<{ id: number }>
  const shortToId = new Map(rows.map((r, i) => [`P${String(i + 1).padStart(2, '0')}`, r.id]))
  const cache = new Map<number, string | null>()
  const cite = (pid: number): string | null => {
    if (!cache.has(pid)) {
      const row = db
        .prepare('SELECT title, first_author, year FROM papers WHERE id = ? AND deleted_at IS NULL')
        .get(pid) as { title: string; first_author: string | null; year: number | null } | undefined
      cache.set(pid, row ? citePaper({ title: row.title, firstAuthor: row.first_author, year: row.year }) : null)
    }
    return cache.get(pid) ?? null
  }
  return replaceInternalRefTokens(text, (token) => {
    if (token.startsWith('#')) {
      const id = Number(token.slice(1))
      return Number.isFinite(id) ? resolveStoredIdToken(db, graphId, id, cite) : null
    }
    const pid = shortToId.get(token)
    return pid == null ? null : cite(pid)
  })
}

interface CandidateRow {
  id: number
  graph_id: number
  title: string
  authors_json: string
  year: number | null
  doi: string | null
  arxiv_id: string | null
  existing_paper_id: number | null
  reason: string | null
  x: number
  y: number
  status: string
  /** 040：候选来源会话 */
  session_id: number | null
  /** 061（M6 预备 2b）：直达列，可空 */
  paper_id: number | null
  venue: string | null
  openalex_wid: string | null
  abstract: string | null
  oa_url: string | null
  /** 083（uat3b D159）：只有规范化标题命中库中论文（其它键都没中）→ 1 */
  title_dup: number
  /** 083（uat3b D161）：去重命中的论文已在当前图谱 → 1（不建画布候选节点） */
  in_graph: number
  /** 085（uat5 D168/必须修 2）：OpenAlex 回填是否核实（0=卡片「未核实」类提示） */
  verified: number
  created_at: string
  updated_at: string
}

export function toCandidateView(r: CandidateRow): CandidateView {
  return {
    id: r.id,
    graphId: r.graph_id,
    title: r.title,
    authors: JSON.parse(r.authors_json) as string[],
    year: r.year,
    doi: r.doi,
    arxivId: r.arxiv_id,
    existingPaperId: r.existing_paper_id,
    reason: r.reason,
    x: r.x,
    y: r.y,
    status: r.status === 'confirmed' ? 'confirmed' : r.status === 'ignored' ? 'ignored' : r.status === 'dismissed' ? 'dismissed' : 'pending',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.session_id != null ? { sessionId: r.session_id } : {}),
    ...(r.paper_id != null ? { paperId: r.paper_id } : {}),
    ...(r.venue != null ? { venue: r.venue } : {}),
    ...(r.oa_url != null ? { oaUrl: r.oa_url } : {}),
    ...(r.openalex_wid ? { openalexWid: r.openalex_wid } : {}),
    ...(r.title_dup === 1 ? { titleDup: true } : {}),
    ...(r.in_graph === 1 ? { inGraph: true } : {}),
    ...(r.verified === 0 ? { unverified: true } : {})
  }
}

function getRow(db: Database.Database, candidateId: number): CandidateRow {
  const r = db.prepare('SELECT * FROM graph_candidates WHERE id = ?').get(candidateId) as CandidateRow | undefined
  if (!r) throw new Error(`候选 ${candidateId} 不存在`)
  return r
}

/** 库内精确去重：DOI 或 arXiv 命中未删除论文即「已在库中」（D82/D55）。 */
export function findExistingPaper(
  db: Database.Database,
  doi: string | null,
  arxivId: string | null
): number | null {
  if (doi) {
    const r = db.prepare('SELECT id FROM papers WHERE doi = ? AND deleted_at IS NULL').get(doi) as { id: number } | undefined
    if (r) return r.id
  }
  if (arxivId) {
    const r = db.prepare('SELECT id FROM papers WHERE arxiv_id = ? AND deleted_at IS NULL').get(arxivId) as
      | { id: number }
      | undefined
    if (r) return r.id
  }
  return null
}

/** uat3b D159：OpenAlex work ID（W…，大写规整）命中即重复。 */
export function findExistingPaperByWid(db: Database.Database, wid: string | null): number | null {
  if (!wid?.trim()) return null
  const w = wid.trim().toUpperCase()
  const r = db.prepare('SELECT id FROM papers WHERE UPPER(openalex_wid) = ? AND deleted_at IS NULL').get(w) as
    | { id: number }
    | undefined
  return r?.id ?? null
}

/** uat3b D159：规范化标题命中（不自动拦截，仅提示「可能是已有论文的另一版本」）。 */
export function findPaperByNormalizedTitle(db: Database.Database, title: string): number | null {
  const norm = normalizeTitleForDedupe(title)
  if (!norm) return null
  const rows = db.prepare('SELECT id, title FROM papers WHERE deleted_at IS NULL').all() as Array<{ id: number; title: string }>
  for (const r of rows) {
    if (normalizeTitleForDedupe(r.title) === norm) return r.id
  }
  return null
}

interface LibraryMeta {
  id: number
  title: string
  year: number | null
  doi: string | null
  arxivId: string | null
  openalexWid: string | null
  abstract: string | null
  authors: string[]
  venue: string | null
}

function venueOfCsl(cslJson: string): string | null {
  try {
    const p = JSON.parse(cslJson) as unknown
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null
    const container = (p as Record<string, unknown>)['container-title']
    if (Array.isArray(container)) {
      const s = container.find((x): x is string => typeof x === 'string' && x.trim().length > 0)
      return s?.trim() ?? null
    }
    if (typeof container === 'string' && container.trim()) return container.trim()
    return null
  } catch {
    return null
  }
}

function authorsOfPaper(
  db: Database.Database,
  paperId: number,
  firstAuthor: string | null,
  cslJson: string
): string[] {
  const rows = db
    .prepare('SELECT family, given FROM paper_authors WHERE paper_id = ? ORDER BY position')
    .all(paperId) as Array<{ family: string | null; given: string | null }>
  const authors = rows
    .map((a) => [a.given, a.family].filter(Boolean).join(' ').trim())
    .filter((s) => s.length > 0)
  if (authors.length > 0) return authors
  try {
    const p = JSON.parse(cslJson) as unknown
    const cslAuthors =
      p && typeof p === 'object' && !Array.isArray(p) && Array.isArray((p as Record<string, unknown>).author)
        ? ((p as Record<string, unknown>).author as Array<Record<string, unknown>>)
        : []
    for (const a of cslAuthors) {
      const name = [a?.given, a?.family].filter((x): x is string => typeof x === 'string' && x.length > 0).join(' ')
      if (name) authors.push(name)
    }
  } catch {
    /* csl 损坏按空处理 */
  }
  if (authors.length === 0 && firstAuthor?.trim()) authors.push(firstAuthor.trim())
  return authors
}

function loadLibraryMeta(db: Database.Database, paperId: number): LibraryMeta | null {
  const row = db
    .prepare(
      `SELECT id, title, year, doi, arxiv_id, openalex_wid, abstract, first_author, csl_json
       FROM papers WHERE id = ? AND deleted_at IS NULL`
    )
    .get(paperId) as
    | {
        id: number
        title: string
        year: number | null
        doi: string | null
        arxiv_id: string | null
        openalex_wid: string | null
        abstract: string | null
        first_author: string | null
        csl_json: string
      }
    | undefined
  if (!row) return null
  return {
    id: row.id,
    title: row.title,
    year: row.year,
    doi: row.doi,
    arxivId: row.arxiv_id,
    openalexWid: row.openalex_wid,
    abstract: row.abstract,
    authors: authorsOfPaper(db, row.id, row.first_author, row.csl_json),
    venue: venueOfCsl(row.csl_json)
  }
}

interface FilledFields {
  title: string
  authors: string[]
  year: number | null
  doi: string | null
  arxivId: string | null
  openalexWid: string | null
  abstract: string | null
  venue: string | null
  oaUrl: string | null
}

function nonempty(s: string | null | undefined): string | null {
  const t = s?.trim() ?? ''
  return t || null
}

/** 库内非空字段盖过 Agent / OpenAlex；空字段保留已有值。 */
function overlayLibrary(cur: FilledFields, meta: LibraryMeta): FilledFields {
  return {
    title: nonempty(meta.title) ?? cur.title,
    authors: meta.authors.length > 0 ? meta.authors : cur.authors,
    year: meta.year ?? cur.year,
    doi: nonempty(meta.doi) ?? cur.doi,
    arxivId: nonempty(meta.arxivId) ?? cur.arxivId,
    openalexWid: nonempty(meta.openalexWid)?.toUpperCase() ?? cur.openalexWid,
    abstract: nonempty(meta.abstract) ?? cur.abstract,
    venue: nonempty(meta.venue) ?? cur.venue,
    oaUrl: cur.oaUrl
  }
}

/** OpenAlex 非空字段盖过 Agent 手填；作者表为空时保留 Agent 的名单。 */
function overlayOpenAlex(cur: FilledFields, w: OpenAlexWorkFull): FilledFields {
  return {
    title: nonempty(w.title) ?? cur.title,
    authors: w.authors.length > 0 ? w.authors : cur.authors,
    year: w.year ?? cur.year,
    doi: cleanDoi(w.doi) ?? cur.doi,
    arxivId: cleanArxiv(w.arxivId) ?? cur.arxivId,
    openalexWid: nonempty(w.wid)?.toUpperCase() ?? cur.openalexWid,
    abstract: nonempty(w.abstract) ?? cur.abstract,
    venue: nonempty(w.venue) ?? cur.venue,
    oaUrl: nonempty(w.oaUrl) ?? cur.oaUrl
  }
}

const TITLE_SIM_MIN = 0.95

/**
 * uat5 必须修 2：OpenAlex 回填核对阈值。DOI / wid / arXiv-DOI 解析到的记录必须
 * 满足以下任一才算「核实」，否则整条记录不采用（保留 Agent 元数据，不写入错误
 * 的 wid / DOI），候选标 verified=0（卡片低调显示「未核实」）：
 * - arXiv id 归一后一致；或
 * - 规范化标题（D159 normalizeTitleForDedupe）完全一致；或
 * - bigram Dice 标题相似度（openalex/match titleSim）≥ 0.8（高度相似）。
 * 反例（测试者 UAT 复测）：Self-RAG（arXiv 2310.11511）的 DOI 径解析到无关的
 * 《CareerX…》记录——标题相似度 ≈ 0，旧代码盲目覆盖标题/作者/DOI。
 */
export const OA_VERIFY_TITLE_SIM_MIN = 0.8

export function openAlexWorkVerified(q: { title: string; arxivId: string | null }, w: OpenAlexWorkFull): boolean {
  const wArxiv = cleanArxiv(w.arxivId)
  if (q.arxivId && wArxiv && wArxiv === q.arxivId) return true
  if (!w.title?.trim() || !q.title.trim()) return false
  if (normalizeTitleForDedupe(w.title) === normalizeTitleForDedupe(q.title)) return true
  return titleSim(q.title, w.title) >= OA_VERIFY_TITLE_SIM_MIN
}

interface OaLookupResult {
  /** 核对通过、可采用回填的记录；未通过为 null */
  work: OpenAlexWorkFull | null
  /** 是否核实：false = 查到记录但核对被拒 / 抛错 / 无命中（候选标未核实，D168） */
  verified: boolean
}

/**
 * 查找顺序 wid → DOI → arXiv-DOI → 标题检索；每条候选记录先过 openAlexWorkVerified
 * 核对，被拒则继续走下一路（DOI 命中错记录时标题径仍可能找回真记录），全被拒返回
 * verified=false。整段包在 try 里：第一次抛错就停（避免死端口连试）。
 */
async function lookupOpenAlex(client: OpenAlexClient, q: FilledFields): Promise<OaLookupResult> {
  const consider = async (fetch: () => Promise<OpenAlexWorkFull | null>): Promise<OpenAlexWorkFull | null> => {
    const w = await fetch()
    if (!w?.wid) return null
    return openAlexWorkVerified(q, w) ? w : null
  }
  try {
    if (q.openalexWid) {
      const w = await consider(() => client.fetchWorkFullByWid(q.openalexWid!))
      if (w) return { work: w, verified: true }
    }
    if (q.doi) {
      const w = await consider(() => client.fetchWorkFullByDoi(q.doi!))
      if (w) return { work: w, verified: true }
    }
    if (q.arxivId) {
      const w = await consider(() => client.fetchWorkFullByDoi(`10.48550/arxiv.${q.arxivId}`))
      if (w) return { work: w, verified: true }
    }
    if (q.title.trim()) {
      const hits = await client.searchWorksFull(q.title, 5)
      const want = normalizeTitleForDedupe(q.title)
      const exact = hits.find((h) => h.wid && h.title && normalizeTitleForDedupe(h.title) === want)
      if (exact) return { work: exact, verified: true }
      let best: OpenAlexWorkFull | null = null
      let bestSim = 0
      for (const h of hits) {
        if (!h.wid || !h.title) continue
        const sim = titleSim(q.title, h.title)
        if (sim >= TITLE_SIM_MIN && sim > bestSim) {
          best = h
          bestSim = sim
        }
      }
      // 标题径同样过核对阈值（D168：只在标题高度相似时采用）
      if (best && openAlexWorkVerified(q, best)) return { work: best, verified: true }
    }
    // 走到这里：没找到可用记录 / 记录全被拒 / 抛错——候选标未核实（卡片「未核实」或
    // 「未找到可核实的记录」，D168），Agent 手填元数据原样保留。
    return { work: null, verified: false }
  } catch {
    return { work: null, verified: false }
  }
}

/**
 * 候选节点落位（uat5 建议修 7）：黄金角螺旋放在既有内容附近、与所有占位包围盒
 * （200×120，与画布候选节点同口径）不相交。只把**论文成员 + pending 候选**算作
 * 占位——已忽略 / 已确认 / dismissed 的旧坐标不再把新候选越推越远
 *（review_uat3「可以不管」条），也不与 pending 候选互相重叠（此前 maxY+160 堆叠
 * 在节点实际高度 >160 时会上下重叠）。
 */
export const CAND_NODE_W = 200
export const CAND_NODE_H = 120

function nextCandidatePosition(db: Database.Database, graphId: number): { x: number; y: number } {
  const members = db
    .prepare('SELECT paper_id AS id, x, y FROM graph_members WHERE graph_id = ?')
    .all(graphId) as Array<{ id: number; x: number; y: number }>
  const pending = db
    .prepare("SELECT id, x, y FROM graph_candidates WHERE graph_id = ? AND status = 'pending'")
    .all(graphId) as Array<{ id: number; x: number; y: number }>
  return placeNewNode(
    [...members, ...pending].filter((n) => Number.isFinite(n.x) && Number.isFinite(n.y)),
    CAND_NODE_W,
    CAND_NODE_H
  )
}

function findPendingDuplicate(
  db: Database.Database,
  graphId: number,
  doi: string | null,
  arxivId: string | null,
  wid: string | null
): CandidateRow | null {
  if (!doi && !arxivId && !wid) return null
  // D169：dismissed（已在本图谱自动收起）同行也算重复——同一篇不再出新卡片
  const pendings = db
    .prepare("SELECT * FROM graph_candidates WHERE graph_id = ? AND status IN ('pending', 'dismissed')")
    .all(graphId) as unknown as CandidateRow[]
  return (
    pendings.find((p) => {
      if (doi && p.doi === doi) return true
      if (arxivId && p.arxiv_id === arxivId) return true
      if (wid && p.openalex_wid != null && p.openalex_wid.toUpperCase() === wid) return true
      return false
    }) ?? null
  )
}

export async function proposeCandidate(
  db: Database.Database,
  input: ProposeCandidateInput,
  options: ProposeCandidateOptions = {}
): Promise<CandidateView> {
  const g = db.prepare('SELECT id FROM graphs WHERE id = ?').get(input.graphId)
  if (!g) throw new Error(`图谱 ${input.graphId} 不存在`)
  const title = input.title.trim()
  if (!title) throw new Error('候选论文标题不能为空')

  let fields: FilledFields = {
    title,
    authors: input.authors.map((a) => a.trim()).filter(Boolean),
    year: input.year ?? null,
    doi: cleanDoi(input.doi),
    arxivId: cleanArxiv(input.arxivId),
    openalexWid: input.openalexWid?.trim() ? input.openalexWid.trim().toUpperCase() : null,
    abstract: nonempty(input.abstract),
    venue: nonempty(input.venue),
    oaUrl: nonempty(input.oaUrl)
  }

  // 回填在去重之前：本地库优先；没有才问 OpenAlex；核对通过才采用（uat5 必须修 2），
  // 被拒 / 查不到 / 抛错则保留 Agent 字段并标 verified=0（卡片「未核实」，D168）。
  let existingId = findExistingPaper(db, fields.doi, fields.arxivId) ?? findExistingPaperByWid(db, fields.openalexWid)
  let verified = 1
  if (existingId != null) {
    const meta = loadLibraryMeta(db, existingId)
    if (meta) fields = overlayLibrary(fields, meta)
  } else if (options.openAlex) {
    const oa = await lookupOpenAlex(options.openAlex, fields)
    if (oa.work) fields = overlayOpenAlex(fields, oa.work)
    else verified = 0
    existingId = findExistingPaper(db, fields.doi, fields.arxivId) ?? findExistingPaperByWid(db, fields.openalexWid)
    if (existingId != null) {
      const meta = loadLibraryMeta(db, existingId)
      if (meta) fields = overlayLibrary(fields, meta)
    }
  }
  if (!fields.title.trim()) throw new Error('候选论文标题不能为空')

  // 只有标题命中不拦截，也不把 existing_paper_id / in_graph 设上。
  const titleDupPaperId = existingId == null ? findPaperByNormalizedTitle(db, fields.title) : null
  const inGraph =
    existingId != null &&
    db.prepare('SELECT 1 FROM graph_members WHERE graph_id = ? AND paper_id = ?').get(input.graphId, existingId) != null

  // D161：回填后的 DOI/arXiv/wid 对上已有 pending → 不新建、不再出第二张卡片。
  const dup = findPendingDuplicate(db, input.graphId, fields.doi, fields.arxivId, fields.openalexWid)
  if (dup) return { ...toCandidateView(dup), duplicateOfId: dup.id }

  const pos = nextCandidatePosition(db, input.graphId)
  const now = new Date().toISOString()
  // D169：已在本图谱中的候选自动收起（status='dismissed'，原因 in_graph），不一直停在 pending
  const initialStatus = inGraph ? 'dismissed' : 'pending'
  const r = db
    .prepare(
      `INSERT INTO graph_candidates
         (graph_id, title, authors_json, year, doi, arxiv_id, existing_paper_id, reason, x, y, status, session_id,
          abstract, venue, oa_url, openalex_wid, title_dup, in_graph, verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.graphId,
      fields.title,
      JSON.stringify(fields.authors),
      fields.year,
      fields.doi,
      fields.arxivId,
      existingId,
      stripInternalRefTokens(db, input.graphId, sanitizeCandidateReason(input.reason)),
      pos.x,
      pos.y,
      initialStatus,
      input.sessionId,
      fields.abstract,
      fields.venue,
      fields.oaUrl,
      fields.openalexWid,
      titleDupPaperId != null ? 1 : 0,
      inGraph ? 1 : 0,
      verified,
      now,
      now
    )
  return toCandidateView(getRow(db, Number(r.lastInsertRowid)))
}

/** 拖动画布候选节点后写回坐标（论文节点仍走 graph:setPosition）。 */
export function moveCandidate(db: Database.Database, candidateId: number, x: number, y: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('坐标无效')
  const row = getRow(db, candidateId)
  db.prepare('UPDATE graph_candidates SET x = ?, y = ?, updated_at = ? WHERE id = ?').run(
    x,
    y,
    new Date().toISOString(),
    row.id
  )
}

/** 确认/忽略动作结果：最新视图 + 候选来源会话（040 列，event:agent:candidates 广播带出）。 */
export interface CandidateActionResult {
  candidate: CandidateView
  sessionId: number | null
}

export interface ConfirmResult extends CandidateActionResult {
  /** 「已在库中→加入图谱」/ 库外入库：本次真正插进 graph_members 的论文 id */
  addedPaperId: number | null
  /** M6 lane/fetch 批 1：排入的 candidate_pdf 任务 id（论文已有 PDF / 纯加图谱时为 null） */
  jobId?: number | null
}

export function confirmCandidate(db: Database.Database, candidateId: number): ConfirmResult {
  const row = getRow(db, candidateId)
  if (row.status === 'confirmed') return { candidate: toCandidateView(row), sessionId: row.session_id, addedPaperId: null }
  if (row.status === 'ignored') throw new Error('候选已忽略，不能确认')
  if (row.status === 'dismissed') throw new Error('候选已在本图谱中，无需确认')
  if (row.existing_paper_id == null) {
    const imported = importCandidatePaper(db, {
      graphId: row.graph_id,
      candidateId,
      x: row.x,
      y: row.y,
      title: row.title,
      authors: JSON.parse(row.authors_json) as string[],
      year: row.year,
      doi: row.doi,
      arxivId: row.arxiv_id,
      venue: row.venue,
      openalexWid: row.openalex_wid,
      abstract: row.abstract,
      oaUrl: row.oa_url,
      sessionId: row.session_id
    })
    const updated = getRow(db, candidateId)
    return { candidate: toCandidateView(updated), sessionId: updated.session_id, addedPaperId: imported.paperId, jobId: imported.jobId }
  }
  const paper = db
    .prepare('SELECT id, has_pdf FROM papers WHERE id = ? AND deleted_at IS NULL')
    .get(row.existing_paper_id) as { id: number; has_pdf: number } | undefined
  if (!paper) throw new Error('去重命中的论文已不存在，无法加入图谱')
  const now = new Date().toISOString()
  const tx = db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, ?, ?, ?)').run(
      row.graph_id,
      paper.id,
      row.x,
      row.y,
      now
    )
    db.prepare('UPDATE graph_candidates SET status = ?, updated_at = ? WHERE id = ?').run('confirmed', now, candidateId)
  })
  tx()
  let jobId: number | null = null
  if (paper.has_pdf !== 1) {
    jobId = enqueueJob(db, 'candidate_pdf', {
      paperId: paper.id,
      payload: { oaUrl: row.oa_url, ...(row.session_id != null ? { sessionId: row.session_id } : {}) }
    })
  }
  const updated = getRow(db, candidateId)
  return { candidate: toCandidateView(updated), sessionId: updated.session_id, addedPaperId: paper.id, jobId }
}

export function ignoreCandidate(db: Database.Database, candidateId: number): CandidateActionResult {
  const row = getRow(db, candidateId)
  const now = new Date().toISOString()
  if (row.status === 'pending') {
    db.prepare('UPDATE graph_candidates SET status = ?, updated_at = ? WHERE id = ?').run('ignored', now, candidateId)
  }
  const updated = getRow(db, candidateId)
  return { candidate: toCandidateView(updated), sessionId: updated.session_id }
}

export function listCandidates(db: Database.Database, graphId: number): CandidateView[] {
  const rows = db
    .prepare('SELECT * FROM graph_candidates WHERE graph_id = ? ORDER BY id DESC')
    .all(graphId) as unknown as CandidateRow[]
  return rows.map(toCandidateView)
}
