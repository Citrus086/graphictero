import type Database from 'better-sqlite3'
import { listLibrary } from './appService'
import { searchFullText } from './db/fulltextFts'
import {
  SIDEBAR_BODY_MIN_CHARS,
  SIDEBAR_SEARCH_LIMIT,
  mergeSidebarHits,
  sidebarQueryChars,
  type SidebarPaperRef,
  type SidebarSearchResult
} from '../shared/sidebarSearch'

/**
 * uat8a D188：侧栏搜索的主进程入口。复用 papers_text_fts / searchFullText，
 * 不另建索引。正文查询失败（MATCH 语法等）降级为只返回标题命中，不抛到 UI。
 *
 * 空串与 1 个码位不查正文。空串返回该段全部论文（不截断）；有查询时每段最多 limit 条。
 */

/** 正文索引多取一些再按段过滤，避免 bm25 前排都是另一段的论文。 */
const BODY_FETCH_CAP = 1000

export type SidebarBodySearch = (
  db: Database.Database,
  query: string,
  limit: number
) => Array<{ paper_id: number; rank: number }>

export interface SearchSidebarOptions {
  limit?: number
  /** 测试注入。缺省 searchFullText。抛错时当作无正文命中。 */
  searchBody?: SidebarBodySearch
}

export function searchSidebar(
  db: Database.Database,
  graphId: number,
  query: string,
  options: SearchSidebarOptions = {}
): SidebarSearchResult {
  if (!Number.isInteger(graphId) || graphId <= 0) throw new Error('图谱 ID 不合法')
  const q = typeof query === 'string' ? query : ''
  const limit = options.limit ?? SIDEBAR_SEARCH_LIMIT
  const members = loadMembers(db, graphId)
  const others: SidebarPaperRef[] = listLibrary(db, graphId)
    .filter((p) => !p.inGraph)
    .map((p) => ({ id: p.id, title: p.title, firstAuthor: p.firstAuthor }))

  let body: Array<{ paperId: number; rank: number }> = []
  if (sidebarQueryChars(q) >= SIDEBAR_BODY_MIN_CHARS) {
    const fetchLimit = Math.min(BODY_FETCH_CAP, Math.max(limit * 4, 200))
    try {
      const rows = (options.searchBody ?? searchFullText)(db, q.trim(), fetchLimit)
      body = rows.map((r) => ({ paperId: r.paper_id, rank: r.rank }))
    } catch {
      body = []
    }
  }

  return {
    members: mergeSidebarHits(members, q, body, limit),
    others: mergeSidebarHits(others, q, body, limit)
  }
}

function loadMembers(db: Database.Database, graphId: number): SidebarPaperRef[] {
  const rows = db
    .prepare(
      `SELECT p.id AS id, p.title AS title, p.first_author AS firstAuthor
       FROM graph_members m
       JOIN papers p ON p.id = m.paper_id
       WHERE m.graph_id = ? AND p.deleted_at IS NULL
       ORDER BY m.added_at, m.paper_id`
    )
    .all(graphId) as Array<{ id: number; title: string; firstAuthor: string | null }>
  return rows.map((r) => ({ id: r.id, title: r.title ?? '', firstAuthor: r.firstAuthor }))
}
