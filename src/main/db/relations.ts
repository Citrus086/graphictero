import type Database from 'better-sqlite3'

/**
 * 关系写入（D75/D89）。
 *
 * - 唯一约束 (graph_id, 无序论文对)：paper_low < paper_high；
 * - 反向写入合并进已有的那条边（D89）：对同一对论文先写 A→B 再写 B→A，
 *   只剩一条边，内容以后一次写入为准（见 PROGRESS 取舍）；
 * - 删除为软删除（记 deleted_at），同一对论文可再写回（D37：删掉的关系
 *   可以再生成回来）。
 */

/** D84 固定关系类型集合 */
export const RELATION_TYPES = ['based_on', 'implements', 'compares', 'cites', 'same_author'] as const
export type RelationType = (typeof RELATION_TYPES)[number]

/** D89：只能由程序自动附加的类型 */
export const AUTO_RELATION_TYPES: RelationType[] = ['cites', 'same_author']

export interface RelationInput {
  graphId: number
  /** 方向：src → dst 表示「dst 基于 / 针对 src」（D75） */
  srcPaperId: number
  dstPaperId: number
  statement: string
  llmTypes: RelationType[]
  /** 程序自动附加的类型（引用 / 同一作者，D89），可选 */
  autoTypes?: RelationType[]
  sourceType: 'job' | 'session'
  sourceJobId?: number | null
  sourceSessionId?: number | null
  model?: string | null
  promptVersion?: string | null
  /** uat2b D149：手动编辑已有边时置 true——保留 job provenance（不改成手动）并记 edited_at */
  markEdited?: boolean
  /** uat2b D150：「基于/改进」无引用依据（AI 推断） */
  noRefBasis?: boolean
  now?: string
}

export function upsertRelation(db: Database.Database, input: RelationInput): number {
  if (input.srcPaperId === input.dstPaperId) throw new Error('关系不能是自环（D86）')
  const low = Math.min(input.srcPaperId, input.dstPaperId)
  const high = Math.max(input.srcPaperId, input.dstPaperId)
  const now = input.now ?? new Date().toISOString()

  const existing = db
    .prepare(
      `SELECT id, auto_types, source_type, source_job_id, model, prompt_version, edited_at, no_ref_basis
       FROM relations
       WHERE graph_id = ? AND paper_low = ? AND paper_high = ? AND deleted_at IS NULL`
    )
    .get(input.graphId, low, high) as
    | { id: number; auto_types: string; source_type: 'job' | 'session'; source_job_id: number | null; model: string | null; prompt_version: string | null; edited_at: string | null; no_ref_basis: number }
    | undefined

  if (existing) {
    // 反向写入合并：更新方向、陈述、LLM 类型与 provenance，保持只有一条边（D89）。
    // auto_types 是程序自动附加的只读类型（D89）：调用方不传时保留库中原值，
    // 避免 LLM 重写这条边时把「引用 / 同一作者」抹掉。
    // uat2b D149：markEdited（画布手动编辑）时保留 job provenance（不改成 session），记 edited_at；
    // LLM（job）重写时清 edited_at（内容已被模型重新生成，「已编辑」标记失效）。
    const keepJobProvenance = input.markEdited === true && existing.source_type === 'job'
    const autoTypes = input.autoTypes ?? (JSON.parse(existing.auto_types) as RelationType[])
    const editedAt = input.markEdited ? now : input.sourceType === 'job' ? null : existing.edited_at
    db.prepare(
      `UPDATE relations SET
         src_paper = ?, statement_text = ?, llm_types = ?, auto_types = ?,
         source_type = ?, source_job_id = ?, source_session_id = ?,
         model = ?, prompt_version = ?, edited_at = ?, no_ref_basis = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      input.srcPaperId,
      input.statement,
      JSON.stringify(input.llmTypes),
      JSON.stringify(autoTypes),
      keepJobProvenance ? 'job' : input.sourceType,
      keepJobProvenance ? existing.source_job_id : (input.sourceJobId ?? null),
      keepJobProvenance ? null : (input.sourceSessionId ?? null),
      keepJobProvenance ? existing.model : (input.model ?? null),
      keepJobProvenance ? existing.prompt_version : (input.promptVersion ?? null),
      editedAt,
      // uat2-fix1 建议修 3：llm 类型不再含「基于/改进」时清掉无引用依据标记
      (input.noRefBasis ?? (input.llmTypes.includes('based_on') ? existing.no_ref_basis === 1 : false)) ? 1 : 0,
      now,
      existing.id
    )
    return existing.id
  }

  const r = db
    .prepare(
      `INSERT INTO relations (
         graph_id, paper_low, paper_high, src_paper, statement_text,
         llm_types, auto_types, source_type, source_job_id, source_session_id,
         model, prompt_version, edited_at, no_ref_basis, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.graphId,
      low,
      high,
      input.srcPaperId,
      input.statement,
      JSON.stringify(input.llmTypes),
      JSON.stringify(input.autoTypes ?? []),
      input.sourceType,
      input.sourceJobId ?? null,
      input.sourceSessionId ?? null,
      input.model ?? null,
      input.promptVersion ?? null,
      null, // INSERT = 全新边：edited_at 恒 NULL（markEdited 只对已有 job 边的 UPDATE 有意义）
      (input.noRefBasis ?? false) ? 1 : 0,
      now,
      now
    )
  return Number(r.lastInsertRowid)
}

/** 软删除关系；重复删除同一关系幂等（D77：删掉已删的关系也返回成功）。 */
export function deleteRelation(db: Database.Database, relationId: number, now = new Date().toISOString()): void {
  db.prepare('UPDATE relations SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(
    now,
    now,
    relationId
  )
}
