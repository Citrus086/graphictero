import type Database from 'better-sqlite3'
import type { PaperHit } from '../../shared/ipc/agent'
import type { OpenAlexClient, OpenAlexWork } from './client'
import { citedByHits, hitFromFull } from './citedBy'
import { arxivIdFromDoi } from './oa'
import { findExistingPaper } from '../agent/candidates'

/**
 * lane/fetch 批 1：searchPapers 检索服务（m6_plan §5.1-2；D82/D117/D126）。
 *
 * - 关键词：OpenAlex `search=` 全文检索，per_page 默认 10、上限 25；
 * - 引用追踪：query 是裸 W-ID / OpenAlex URL / DOI 时，返回 [种子, …向后 referenced_works,
 *   …向前 cited_by]（向后复用 M3 的批量 W-ID 取回口径，信息从简：标题/年份/DOI/一作）；
 * - 每个命中按 D82 查库内去重标 inLibraryPaperId；
 * - OpenAlex 检索日计数（D127 免费额度内不计 ¥，设置页「今日检索 N 次」数据源）。
 */

/** 向后引用的薄视图 → PaperHit（slim OpenAlexWork 只有一作姓，信息从简） */
function hitFromSlim(db: Database.Database, w: OpenAlexWork): PaperHit {
  const inLibraryPaperId = findExistingPaper(db, w.doi, arxivIdFromDoi(w.doi))
  return {
    title: w.title ?? '',
    authors: w.firstAuthorSurname ? [w.firstAuthorSurname] : [],
    year: w.publicationYear,
    ...(w.doi ? { doi: w.doi } : {}),
    ...(inLibraryPaperId != null ? { inLibraryPaperId } : {})
  }
}

/** OpenAlex 检索日计数（app_settings kv：{date, count}，按 UTC 日滚动） */
export function bumpOpenAlexDailyCount(db: Database.Database, now = new Date()): void {
  const date = now.toISOString().slice(0, 10)
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'openalex_daily'").get() as
    | { value: string }
    | undefined
  let cur = { date, count: 0 }
  if (row) {
    try {
      const parsed = JSON.parse(row.value) as { date?: string; count?: number }
      if (parsed.date === date && typeof parsed.count === 'number') cur = { date, count: parsed.count }
    } catch {
      // 坏 JSON 当新的一天重计
    }
  }
  cur.count += 1
  db.prepare(
    "INSERT INTO app_settings (key, value, updated_at) VALUES ('openalex_daily', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(JSON.stringify(cur), now.toISOString())
}

/** 今日 OpenAlex 检索次数（设置页展示；非今日或未计数返回 0） */
export function openAlexDailyCount(db: Database.Database, now = new Date()): number {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'openalex_daily'").get() as
    | { value: string }
    | undefined
  if (!row) return 0
  try {
    const parsed = JSON.parse(row.value) as { date?: string; count?: number }
    return parsed.date === now.toISOString().slice(0, 10) && typeof parsed.count === 'number' ? parsed.count : 0
  } catch {
    return 0
  }
}

const WID_RE = /^(?:https:\/\/openalex\.org\/)?([Ww]\d{1,15})\/?$/i
const DOI_RE = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d+\/\S+?)\/?$/i

function doiFromQuery(query: string): string | null {
  const m = DOI_RE.exec(query.trim())
  if (!m?.[1]) return null
  return m[1].replace(/\/+$/, '').toLowerCase()
}

/**
 * searchPapers 服务层：关键词检索或引用追踪（自动识别 query 形态）。
 * 返回命中列表；引用追踪时第一个元素是种子论文本身。limit 上限 25（默认 10）。
 */
export async function searchPapersService(
  db: Database.Database,
  client: OpenAlexClient,
  query: string,
  limit = 10
): Promise<PaperHit[]> {
  const q = query.trim()
  const cap = Math.min(Math.max(limit, 1), 25)
  const widM = WID_RE.exec(q)
  const doi = widM ? null : doiFromQuery(q)

  if (!widM && !doi) {
    const works = await client.searchWorksFull(q, cap)
    return works.slice(0, cap).map((w) => hitFromFull(db, w))
  }

  // 引用追踪：种子 + 向后 referenced_works + 向前 cited_by。
  // 日计数由客户端每次成功 HTTP 的 onBillable 累加（失败不计）。
  const seed = widM ? await client.fetchWorkFullByWid(widM[1].toUpperCase()) : await client.fetchWorkFullByDoi(doi as string)
  if (!seed) return []
  const out: PaperHit[] = [hitFromFull(db, seed)]
  const remaining = cap - 1
  if (remaining <= 0) return out
  const backCap = Math.ceil(remaining / 2)
  const slimBack = await client.fetchWorksByWids(seed.referencedWorks.slice(0, backCap))
  const back = slimBack.slice(0, backCap).map((w) => hitFromSlim(db, w))
  out.push(...back)
  const frontCap = remaining - back.length
  if (frontCap > 0) {
    const front = await citedByHits(db, client, seed.wid, frontCap)
    out.push(...front)
  }
  return out
}
