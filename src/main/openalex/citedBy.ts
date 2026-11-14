import type Database from 'better-sqlite3'
import type { PaperHit } from '../../shared/ipc/agent'
import type { OpenAlexClient } from './client'
import type { OpenAlexWorkFull } from './oa'
import { findExistingPaper } from '../agent/candidates'

/**
 * lane/fetch 批 1：向前引用追踪（cited_by）——OpenAlex `filter=cites:W…` 查引用
 * 指定 work 的论文（m6_plan §5.1-2 / §1.2-2）。库内去重标 inLibraryPaperId（D82）。
 */

/** OpenAlex work 富视图 → PaperHit（契约 src/shared/ipc/agent.ts；D82 去重） */
export function hitFromFull(db: Database.Database, w: OpenAlexWorkFull): PaperHit {
  const inLibraryPaperId = findExistingPaper(db, w.doi, w.arxivId)
  return {
    title: w.title ?? '',
    authors: w.authors,
    year: w.year,
    ...(w.doi ? { doi: w.doi } : {}),
    ...(w.arxivId ? { arxivId: w.arxivId } : {}),
    ...(w.venue ? { venue: w.venue } : {}),
    ...(w.citedBy != null ? { citedBy: w.citedBy } : {}),
    ...(w.abstract ? { abstract: w.abstract } : {}),
    ...(w.oaUrl ? { oaUrl: w.oaUrl } : {}),
    ...(inLibraryPaperId != null ? { inLibraryPaperId } : {})
  }
}

/** 向前引用：返回引用 wid 的论文命中（按 OpenAlex 默认相关度顺序，最多 limit 条） */
export async function citedByHits(
  db: Database.Database,
  client: OpenAlexClient,
  wid: string,
  limit = 24
): Promise<PaperHit[]> {
  const works = await client.fetchCitingWorksByWid(wid, Math.min(Math.max(limit, 1), 25))
  return works.slice(0, limit).map((w) => hitFromFull(db, w))
}
