import type Database from 'better-sqlite3'
import type { Migration } from './index'
import { normalizeTitleForDedupe, sanitizeCandidateReason, stripInternalRefTokens } from '../../agent/candidates'

/**
 * 089（uat6c M1）：087 把候选 reason 覆盖成状态码 'in_graph' 的数据修复——
 * 状态与理由分开存（D169/uat6c 维护者口径）：
 *
 * - 凡 reason = 'in_graph' 的行：in_graph 列补 1（它们正是 D169 in_graph 判定
 *   命中的行；087 改状态时没写列），reason 恢复为**原中文理由**或置 NULL——
 *   状态用独立列表达，卡片 / 候选面板经 displayCandidateReason 永不显示状态码。
 * - 恢复来源（库内可靠来源，不读 UAT 库 / 备份）：session_messages.parts JSON 里
 *   part.id = `c{候选id}` 的 data-paper-card part——候选创建时出卡落进 assistant
 * - 恢复：**标题规范化一致**的同号卡片的最早一条（标题全不符 → 不用，reason
 *   置 NULL，不猜）。时间序口径：session_messages.id 全库自增；同一候选 id 最早
 *   出现即创建那次出卡（后来的重复提议去重命中卡同一 id 但 reason 是后写的，不采用）。
 * - 匹配安全：part.id 里的候选 id 是行级唯一的（创建时 `c{view.id}`），不存在
 *   跨候选撞号；标题校验是第二道防线（同号卡也不取标题对不上的理由）。
 * - 找不到可恢复来源（会话消息已删 / 压缩归档里也没有）→ reason 置 NULL，不猜。
 * - 写回前再跑一遍 sanitizeCandidateReason / stripInternalRefTokens 同口径
 *   （幂等；防卡片里残留内部记号）。
 * - 幂等：处理后 reason 不再是 'in_graph'，第二遍零写入。
 * - 正常中文理由的 dismissed / pending / confirmed 行一律不动。
 */

interface Row {
  id: number
  graph_id: number
  title: string
  doi: string | null
  arxiv_id: string | null
  openalex_wid: string | null
}

interface CardPart {
  type?: unknown
  id?: unknown
  title?: unknown
  reason?: unknown
}

/** 同号卡片 part 的候选（按消息 id 升序 = 时间序）。 */
function findCardReasons(db: Database.Database, graphId: number, candidateId: number): Array<{ msgId: number; reason: string; title: string }> {
  const rows = db
    .prepare(
      `SELECT sm.id AS msg_id, sm.parts AS parts
       FROM session_messages sm
       JOIN sessions s ON s.id = sm.session_id
       WHERE s.graph_id = ?
       ORDER BY sm.id`
    )
    .all(graphId) as Array<{ msg_id: number; parts: string }>
  const want = `c${candidateId}`
  const out: Array<{ msgId: number; reason: string; title: string }> = []
  for (const r of rows) {
    let parts: unknown
    try {
      parts = JSON.parse(r.parts)
    } catch {
      continue
    }
    if (!Array.isArray(parts)) continue
    for (const p of parts as CardPart[]) {
      if (p?.type !== 'data-paper-card' || p.id !== want) continue
      if (typeof p.reason !== 'string' || !p.reason.trim()) continue
      out.push({ msgId: r.msg_id, reason: p.reason, title: typeof p.title === 'string' ? p.title : '' })
    }
  }
  return out
}

export const migration089: Migration = {
  version: 89,
  name: 'candidate_in_graph_reason_restore',
  up(db: Database.Database): void {
    const rows = db
      .prepare("SELECT id, graph_id, title, doi, arxiv_id, openalex_wid FROM graph_candidates WHERE reason = 'in_graph'")
      .all() as Row[]
    if (rows.length === 0) return
    const upd = db.prepare('UPDATE graph_candidates SET reason = ?, in_graph = 1 WHERE id = ?')
    for (const row of rows) {
      // 恢复：同号卡片的最早一条（创建时出卡），标题规范化一致才算对上
      const cards = findCardReasons(db, row.graph_id, row.id)
      const hit = cards.find((c) => normalizeTitleForDedupe(c.title) === normalizeTitleForDedupe(row.title))
      let reason: string | null = null
      if (hit) {
        const cleaned = stripInternalRefTokens(db, row.graph_id, sanitizeCandidateReason(hit.reason)).trim()
        reason = cleaned || null
      }
      upd.run(reason, row.id)
    }
  }
}
