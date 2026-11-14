/**
 * uat8a D188：侧栏「搜索论文库」标题命中与正文命中的合并口径。
 * 渲染层（即时标题过滤）与主进程（library:searchSidebar）共用，避免两套排序。
 *
 * - 空串：调用方显示全部，本函数按「全部标题命中」返回（不截断）。
 * - 1 个 Unicode 码位（中文单字算 1）只做标题子串，不带正文命中。
 * - ≥2 个码位才合并正文。标题命中保持原序在前；正文命中按 rank 升序接在后面；
 *   同一篇只保留标题命中。结果截到 limit（标题先占满）。
 */

export const SIDEBAR_BODY_MIN_CHARS = 2
export const SIDEBAR_SEARCH_DEBOUNCE_MS = 250
/** 有查询时两侧各最多展示这么多条。空查询不走截断（侧栏照旧全列）。 */
export const SIDEBAR_SEARCH_LIMIT = 200

export type SidebarHitVia = 'title' | 'body'

export interface SidebarHit {
  paperId: number
  via: SidebarHitVia
}

export interface SidebarPaperRef {
  id: number
  title: string
  firstAuthor?: string | null
}

export interface SidebarSearchResult {
  members: SidebarHit[]
  others: SidebarHit[]
}

/** Unicode 码位计数：中文单字算 1。 */
export function sidebarQueryChars(query: string): number {
  return Array.from(query.trim()).length
}

/** 与改前侧栏同一子串口径：标题 + 第一作者，大小写不敏感。 */
export function sidebarTitleMatches(paper: SidebarPaperRef, query: string): boolean {
  const f = query.trim().toLowerCase()
  if (!f) return true
  return `${paper.title} ${paper.firstAuthor ?? ''}`.toLowerCase().includes(f)
}

/**
 * papers 的顺序就是该段的展示顺序（本图谱 = added_at, paper_id；论文库 = updated_at DESC, id DESC）。
 * bodyHits 里不在 papers 中的 id 丢掉（软删、或不属于本段）。
 */
export function mergeSidebarHits(
  papers: SidebarPaperRef[],
  query: string,
  bodyHits: Array<{ paperId: number; rank: number }>,
  limit = SIDEBAR_SEARCH_LIMIT
): SidebarHit[] {
  const q = query.trim()
  if (!q) return papers.map((p) => ({ paperId: p.id, via: 'title' as const }))

  const titleIds = new Set<number>()
  const titleHits: SidebarHit[] = []
  for (const p of papers) {
    if (!sidebarTitleMatches(p, q)) continue
    titleIds.add(p.id)
    titleHits.push({ paperId: p.id, via: 'title' })
  }

  const order = new Map(papers.map((p, i) => [p.id, i]))
  const bodyOnly = bodyHits
    .filter((h) => order.has(h.paperId) && !titleIds.has(h.paperId))
    .sort((a, b) => a.rank - b.rank || order.get(a.paperId)! - order.get(b.paperId)!)

  const seen = new Set<number>()
  const out: SidebarHit[] = []
  for (const hit of [
    ...titleHits,
    ...bodyOnly.map((h) => ({ paperId: h.paperId, via: 'body' as const }))
  ]) {
    if (seen.has(hit.paperId)) continue
    seen.add(hit.paperId)
    out.push(hit)
    if (out.length >= limit) break
  }
  return out
}

/**
 * 渲染层套用：空查询原样全列；serverHits === null 时只做本地标题过滤
 * （正文结果未回、或查询短于阈值、或正文查询失败）；非 null 时按主进程结果
 * 取序，丢掉当前列表里已经没有的 id。
 */
export function applySidebarHits<T extends SidebarPaperRef>(
  papers: T[],
  query: string,
  serverHits: SidebarHit[] | null
): Array<{ paper: T; via: SidebarHitVia }> {
  if (!query.trim()) return papers.map((paper) => ({ paper, via: 'title' as const }))
  const hits = serverHits ?? mergeSidebarHits(papers, query, [])
  const byId = new Map(papers.map((p) => [p.id, p]))
  const out: Array<{ paper: T; via: SidebarHitVia }> = []
  for (const hit of hits) {
    const paper = byId.get(hit.paperId)
    if (paper) out.push({ paper, via: hit.via })
  }
  return out
}
