import type Database from 'better-sqlite3'
import { upsertRelation } from '../db/relations'
import {
  AUTO_RELATION_TYPES,
  isRelationType,
  RELATION_TYPE_LABELS,
  type RelationType
} from '../../shared/relationTypes'
import type { RelationDetailView, RelationRestoreInput } from '../../shared/ipc/relations'
import { paperInGraph } from './membership'

/**
 * 关系恢复与详情（⌘Z 撤销 / 重做、关系面板来源字段）。
 *
 * - restoreRelation：按完整快照恢复一条关系（upsert 语义，无序对幂等，D89）。
 *   撤销「删除」时快照带 autoTypes（删除会把整条边软删，连自动类型一起没了）；
 *   撤销「编辑」时不传 autoTypes，upsertRelation 保留库中现值（D89：自动类型只读，
 *   不被 LLM/手动编辑抹掉）。来源默认记 session——恢复的是用户操作（D88）；
 *   M6 前置 2a（D129）：按 relation_snapshots 还原时可带原始 provenance（含
 *   source_type='job'），快照全量还原，见 snapshots.ts。
 * - relationDetail：单条关系含 provenance（sourceType / model / promptVersion /
 *   updatedAt）；RelationView 在冻结的共享契约里没有这些字段，走本车道视图类型。
 */

export function restoreRelation(db: Database.Database, input: RelationRestoreInput): number {
  if (input.srcPaperId === input.dstPaperId) throw new Error('关系不能是自环（D86）')
  // 评审建议修 5：撤销删除时若端点已「从图谱移除」（D75，该操作本身不可撤销），
  // 恢复会造出端点不在 graph_members 的幽灵边（React Flow 引用不存在的节点）——拒绝。
  for (const pid of [input.srcPaperId, input.dstPaperId]) {
    if (!paperInGraph(db, input.graphId, pid)) {
      throw new Error('关系两端论文都必须在本图谱中（论文可能已从图谱移除）')
    }
  }
  if (input.llmTypes.length === 0 && (input.autoTypes?.length ?? 0) === 0) {
    throw new Error('关系类型不能为空（D84）')
  }
  for (const t of input.llmTypes) {
    if (!isRelationType(t)) throw new Error(`未知的关系类型：${String(t)}`)
    if ((AUTO_RELATION_TYPES as readonly string[]).includes(t)) {
      throw new Error(`「${RELATION_TYPE_LABELS[t]}」由程序自动附加，不能写进 llm_types（D89）`)
    }
  }
  if (input.autoTypes) {
    for (const t of input.autoTypes) {
      if (!isRelationType(t) || !(AUTO_RELATION_TYPES as readonly string[]).includes(t)) {
        throw new Error(`autoTypes 只能是「引用」「同一作者」（D89）：${String(t)}`)
      }
    }
  }
  // uat2b c)：快照带原行 id 时优先原地复活该行（撤销「删除」不新建、id 不变，D148 连带边同口径）
  if (input.id != null) {
    const row = db.prepare('SELECT id FROM relations WHERE id = ?').get(input.id) as { id: number } | undefined
    if (row) {
      db.prepare(
        `UPDATE relations SET
           paper_low = ?, paper_high = ?, src_paper = ?, statement_text = ?,
           llm_types = ?, auto_types = ?, source_type = ?, source_job_id = ?,
           source_session_id = ?, model = ?, prompt_version = ?,
           edited_at = ?, no_ref_basis = ?, deleted_at = NULL, updated_at = ?
         WHERE id = ?`
      ).run(
        Math.min(input.srcPaperId, input.dstPaperId),
        Math.max(input.srcPaperId, input.dstPaperId),
        input.srcPaperId,
        input.statement,
        JSON.stringify(input.llmTypes),
        JSON.stringify(input.autoTypes ?? []),
        input.sourceType ?? 'session',
        input.sourceJobId ?? null,
        input.sourceSessionId ?? null, // uat2-fix1 建议修 4：复活保留会话 id
        input.model ?? null,
        input.promptVersion ?? null,
        input.editedAt ?? null,
        input.noRefBasis ? 1 : 0,
        // uat4 建议修11（D148/D164 原样恢复）：带原行 id 复活时写回快照的原 updated_at，
        // 不盖成撤销时刻；缺省（手动 ⌘Z 无快照时间）仍记当前时刻
        input.updatedAt ?? new Date().toISOString(),
        row.id
      )
      return row.id
    }
    // 原行已被物理清除（不该发生）：退回 upsert 新建
  }
  return upsertRelation(db, {
    graphId: input.graphId,
    srcPaperId: input.srcPaperId,
    dstPaperId: input.dstPaperId,
    statement: input.statement,
    llmTypes: input.llmTypes,
    autoTypes: input.autoTypes,
    // M6 前置 2a：快照还原恢复原始来源（含 job），手动 ⌘Z 恢复仍记 session（D88）
    sourceType: input.sourceType ?? 'session',
    sourceJobId: input.sourceJobId ?? null,
    sourceSessionId: input.sourceSessionId ?? null,
    model: input.model ?? null,
    promptVersion: input.promptVersion ?? null,
    noRefBasis: input.noRefBasis
  })
}

export function relationDetail(db: Database.Database, relationId: number): RelationDetailView {
  const r = db
    .prepare(
      `SELECT id, graph_id, paper_low, paper_high, src_paper, statement_text,
              llm_types, auto_types, source_type, source_job_id, model,
              prompt_version, edited_at, no_ref_basis, created_at, updated_at
       FROM relations WHERE id = ? AND deleted_at IS NULL`
    )
    .get(relationId) as Record<string, unknown> | undefined
  if (!r) throw new Error(`关系 ${relationId} 不存在或已删除`)
  return {
    id: r.id as number,
    graphId: r.graph_id as number,
    paperLow: r.paper_low as number,
    paperHigh: r.paper_high as number,
    srcPaper: r.src_paper as number,
    statement: r.statement_text as string,
    llmTypes: JSON.parse(r.llm_types as string) as RelationType[],
    autoTypes: JSON.parse(r.auto_types as string) as RelationType[],
    sourceType: r.source_type as 'job' | 'session',
    sourceJobId: (r.source_job_id as number | null) ?? null,
    model: (r.model as string | null) ?? null,
    promptVersion: (r.prompt_version as string | null) ?? null,
    editedAt: (r.edited_at as string | null) ?? null,
    noRefBasis: (r.no_ref_basis as number) === 1,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string
  }
}
