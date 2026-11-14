import type Database from 'better-sqlite3'

/**
 * 关系生成进度（D86「任务按论文记录『已处理』」，表在迁移 010）。
 * 截断 / 失败后续跑时跳过已处理论文，只补漏掉的；终态失败手动重试同理。
 */

export function markPaperProcessed(db: Database.Database, graphId: number, paperId: number, now = new Date().toISOString()): void {
  db.prepare(
    `INSERT INTO relation_gen_progress (graph_id, paper_id, done_at) VALUES (?, ?, ?)
     ON CONFLICT(graph_id, paper_id) DO UPDATE SET done_at = excluded.done_at`
  ).run(graphId, paperId, now)
}

export function isPaperProcessed(db: Database.Database, graphId: number, paperId: number): boolean {
  return !!db
    .prepare('SELECT 1 FROM relation_gen_progress WHERE graph_id = ? AND paper_id = ?')
    .get(graphId, paperId)
}

export function processedPaperIds(db: Database.Database, graphId: number): Set<number> {
  const rows = db.prepare('SELECT paper_id FROM relation_gen_progress WHERE graph_id = ?').all(graphId) as Array<{
    paper_id: number
  }>
  return new Set(rows.map((r) => r.paper_id))
}

export function clearPaperProcessed(db: Database.Database, graphId: number, paperId: number): void {
  db.prepare('DELETE FROM relation_gen_progress WHERE graph_id = ? AND paper_id = ?').run(graphId, paperId)
}

/**
 * uat2-fix1 必须修 3：D148 撤销「从图谱移除」时恢复原 (graph, paper) 的进度行——
 * **仅当原来有**才插回（调用方负责记忆，见 GraphPage removeFromGraph 的 hadProgress），
 * 否则「从未处理完就移除」的论文会被误标成已处理，合法补排被跳过。已存在则不动。
 */
export function restorePaperProgress(db: Database.Database, graphId: number, paperId: number, now = new Date().toISOString()): void {
  db.prepare(
    `INSERT INTO relation_gen_progress (graph_id, paper_id, done_at) VALUES (?, ?, ?)
     ON CONFLICT(graph_id, paper_id) DO NOTHING`
  ).run(graphId, paperId, now)
}

/**
 * uat7b S1：撤销「从图谱移除」时把成员行与进度行按移除前的原时间戳恢复——
 * added_at / done_at 原样写回（doneAt 为 null = 原来没有进度行，不插，uat2-fix1 口径不变）。
 * 坐标由调用方随后经 setNodePosition 写回（与旧撤销路径一致）。
 * uat7b-fix1 S-f：时间戳必须是 ISO 形状——本通道只能写回移除快照，不成任意写入口。
 */
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

function assertIsoTs(value: string, field: string): void {
  if (!ISO_TS.test(value)) throw new Error(`${field} 必须是 ISO 时间戳（快照写回通道）`)
}

export function restoreRemovedPaper(
  db: Database.Database,
  graphId: number,
  paperId: number,
  meta: { addedAt: string; doneAt: string | null }
): void {
  assertIsoTs(meta.addedAt, 'addedAt')
  if (meta.doneAt != null) assertIsoTs(meta.doneAt, 'doneAt')
  const tx = db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)').run(
      graphId,
      paperId,
      meta.addedAt
    )
    if (meta.doneAt != null) restorePaperProgress(db, graphId, paperId, meta.doneAt)
  })
  tx()
}

/** uat7b S1：撤销「从图谱移除」后把 graphs.updated_at 写回移除前的原值（一批一次）。 */
export function restoreGraphUpdatedAt(db: Database.Database, graphId: number, updatedAt: string): void {
  assertIsoTs(updatedAt, 'updatedAt')
  db.prepare('UPDATE graphs SET updated_at = ? WHERE id = ?').run(updatedAt, graphId)
}
