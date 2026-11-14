import type Database from 'better-sqlite3'
import type { RelationRestoreInput } from '../../shared/ipc/relations'
import type { RelationType } from '../../shared/relationTypes'
import { restoreRelation } from './restore'

/**
 * M6 前置 2a（D129 = Q-M6-6 ①）：关系改动前快照。
 *
 * - snapshotRelation：Agent 的 updateRelation 修改或 deleteRelation 删除时，
 *   在写库的**同一事务内**先存原样（before_json = RelationRestoreInput 全量 + provenance）；
 * - restoreSnapshot：⌘Z 按快照还原（含原 source_type / source_job_id / 方向 / 陈述）。
 *   跨回合冲突（**较新回合**的快照又改过同一条边）按 D104 守卫拒绝，给中文原因；
 *   同回合的多次改写不受阻——按快照 id 逆序还原可回到回合前（撤销组口径）。
 * 快照绑 (session_id, turn_id)；会话物理删除（D122）时随 FK 级联删除。
 */

export interface RelationSnapshotInput {
  sessionId: number
  turnId: string
  relationId: number
  op: 'update' | 'delete'
}

/** 快照里的完整还原输入（RelationRestoreInput + provenance，JSON 存 before_json）。 */
export type SnapshotRestoreInput = RelationRestoreInput & {
  sourceType: 'job' | 'session'
  sourceJobId: number | null
  model: string | null
  promptVersion: string | null
}

interface RelationRow {
  id: number
  graph_id: number
  paper_low: number
  paper_high: number
  src_paper: number
  statement_text: string
  llm_types: string
  auto_types: string
  source_type: string
  source_job_id: number | null
  model: string | null
  prompt_version: string | null
  updated_at: string
}

/** 在写库同一事务内调用：把该关系当前原样存进 relation_snapshots，返回快照 id。 */
export function snapshotRelation(db: Database.Database, input: RelationSnapshotInput): number {
  const r = db
    .prepare(
      `SELECT id, graph_id, paper_low, paper_high, src_paper, statement_text,
              llm_types, auto_types, source_type, source_job_id, model, prompt_version,
              updated_at
       FROM relations WHERE id = ? AND deleted_at IS NULL`
    )
    .get(input.relationId) as RelationRow | undefined
  if (!r) throw new Error(`关系 ${input.relationId} 不存在或已删除，无法写改动前快照`)
  // before_json：srcPaperId/dstPaperId 按原方向还原（src_paper 指向的一端为 src）
  const srcIsLow = r.src_paper === r.paper_low
  const before: SnapshotRestoreInput = {
    graphId: r.graph_id,
    srcPaperId: srcIsLow ? r.paper_low : r.paper_high,
    dstPaperId: srcIsLow ? r.paper_high : r.paper_low,
    statement: r.statement_text,
    llmTypes: JSON.parse(r.llm_types) as RelationType[],
    autoTypes: JSON.parse(r.auto_types) as RelationType[],
    sourceType: r.source_type === 'job' ? 'job' : 'session',
    sourceJobId: r.source_job_id,
    model: r.model,
    promptVersion: r.prompt_version,
    // uat4 建议修11（D148/D164「原样恢复」）：原 updated_at 进快照，撤销复活时写回，
    // 不盖成撤销时刻（重复撤销 / 重做不回退）
    updatedAt: r.updated_at
  }
  const ins = db
    .prepare(
      `INSERT INTO relation_snapshots (session_id, turn_id, relation_id, op, before_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(input.sessionId, input.turnId, input.relationId, input.op, JSON.stringify(before), new Date().toISOString())
  return Number(ins.lastInsertRowid)
}

/**
 * 按快照还原（⌘Z 撤销修改 / 删除）。跨回合守卫（D104 口径更窄）：
 * 同一条边存在**更新**的快照（更新回合又改过它）时拒绝，给中文原因。
 */
export function restoreSnapshot(db: Database.Database, snapshotId: number): number {
  const row = db
    .prepare('SELECT id, relation_id, op, turn_id, before_json FROM relation_snapshots WHERE id = ?')
    .get(snapshotId) as { id: number; relation_id: number; op: string; turn_id: string; before_json: string } | undefined
  if (!row) throw new Error(`改动前快照 ${snapshotId} 不存在（会话可能已删除）`)
  // 跨回合守卫（D104）：**较新回合**又改过同一条边才拒绝；同回合的多次改写按
  // 快照 id 逆序还原不受阻（撤销组口径：同回合同边改两次可回到回合前）
  const newer = db
    .prepare('SELECT 1 FROM relation_snapshots WHERE relation_id = ? AND id > ? AND turn_id <> ? LIMIT 1')
    .get(row.relation_id, snapshotId, row.turn_id)
  if (newer) {
    throw new Error('该关系在更新的回合被再次改动，无法按本回合快照撤销（D104）')
  }
  const before = JSON.parse(row.before_json) as SnapshotRestoreInput
  if (row.op === 'delete') {
    // 撤销删除：原地复活原行（保 id / created_at），不按 upsert 造新行
    // uat4 建议修11：updated_at 写回快照里的原值（D148/D164 原样恢复），老快照无该字段则记当前时刻
    const now = before.updatedAt ?? new Date().toISOString()
    const r = db
      .prepare(
        `UPDATE relations SET
           deleted_at = NULL, src_paper = ?, statement_text = ?, llm_types = ?, auto_types = ?,
           source_type = ?, source_job_id = ?, source_session_id = NULL, model = ?, prompt_version = ?,
           updated_at = ?
         WHERE id = ?`
      )
      .run(
        before.srcPaperId,
        before.statement,
        JSON.stringify(before.llmTypes),
        JSON.stringify(before.autoTypes ?? []),
        before.sourceType,
        before.sourceJobId ?? null,
        before.model ?? null,
        before.promptVersion ?? null,
        now,
        row.relation_id
      )
    if (r.changes > 0) return row.relation_id
    // 原行已被物理删除（理论上不存在）：退回 upsert 语义兜底
  }
  const restoredId = restoreRelation(db, before)
  // uat4 建议修11：op='update' 走 upsert 合并（保留库中 auto_types / edited_at 现值，
  // 快照不带 id 不触发原地复活分支），updated_at 在这里补写回快照原值——
  // upsertRelation（db/relations.ts）无时间戳入参，不动它
  if (before.updatedAt) {
    db.prepare('UPDATE relations SET updated_at = ? WHERE id = ?').run(before.updatedAt, restoredId)
  }
  return restoredId
}
