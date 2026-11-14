import type Database from 'better-sqlite3'
import type { PdfAttemptView } from '../../shared/ipc/cand'

/**
 * lane/fetch 批 1：PDF 来源尝试记录（063 pdf_attempts；D65(6) 03e「尝试过的来源
 * + 时间」、D133 重试依据）。每次查找链的每个来源写一行；拖入 PDF 记 user_drop ok。
 */

export type PdfAttemptResult = 'not_found' | 'error' | 'ok'

export function recordPdfAttempt(
  db: Database.Database,
  paperId: number,
  source: string,
  result: PdfAttemptResult,
  url?: string | null
): void {
  db.prepare('INSERT INTO pdf_attempts (paper_id, source, url, result, at) VALUES (?, ?, ?, ?, ?)').run(
    paperId,
    source,
    url ?? null,
    result,
    new Date().toISOString()
  )
}

export function listPdfAttempts(db: Database.Database, paperId: number): PdfAttemptView[] {
  const rows = db
    .prepare('SELECT source, url, result, at FROM pdf_attempts WHERE paper_id = ? ORDER BY id')
    .all(paperId) as Array<{ source: string; url: string | null; result: string; at: string }>
  return rows.map((r) => ({
    source: r.source,
    ...(r.url ? { url: r.url } : {}),
    result: r.result as PdfAttemptView['result'],
    at: r.at
  }))
}
