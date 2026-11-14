import type Database from 'better-sqlite3'

/**
 * D142：后台用量记到触发它的 agent 会话。
 * 权威来源是任务 payload.sessionId（候选确认 / 拖入 / 重试入队时写入）。
 * 候选链上若 payload 没带，再按论文反查 graph_candidates.session_id。
 * Zotero 导入、手动处理、detail_regen 不归任何会话。
 */

export function positiveSessionId(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

export function sessionIdOfPayload(payload: Record<string, unknown> | null | undefined): number | null {
  return positiveSessionId(payload?.sessionId)
}

/** 库外确认写 paper_id；库内确认只写 existing_paper_id。两边都认。 */
export function lookupCandidateSessionId(db: Database.Database, paperId: number): number | null {
  const row = db
    .prepare(
      `SELECT session_id AS sessionId FROM graph_candidates
       WHERE session_id IS NOT NULL AND (paper_id = ? OR existing_paper_id = ?)
       ORDER BY updated_at DESC, id DESC LIMIT 1`
    )
    .get(paperId, paperId) as { sessionId: number } | undefined
  return positiveSessionId(row?.sessionId)
}

/** 导出概览记到该图谱最近更新的 agent 会话；没有会话则空。 */
export function latestGraphSessionId(db: Database.Database, graphId: number): number | null {
  const row = db
    .prepare('SELECT id FROM sessions WHERE graph_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1')
    .get(graphId) as { id: number } | undefined
  return positiveSessionId(row?.id)
}
