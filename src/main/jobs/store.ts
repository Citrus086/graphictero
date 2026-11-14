import type Database from 'better-sqlite3'
import type { JobStatus } from '../../shared/jobStatus'

/**
 * 统一任务表存取（D70：一张 jobs 表 + 七种状态；D85：job_steps 按步骤记录）。
 * 状态枚举在 src/shared/jobStatus.ts（并行车道共享类型）。
 */

/** 任务类型（001 注释里的建议值；本批只用 process_paper = 解析+名片+详情，D85） */
export type JobKind = 'process_paper' | 'relation_gen' | 'reference_fetch' | 'detail_regen' | 'candidate_pdf'

/** process_paper 的步骤（D85：解析 → 名片 → 详情，一篇论文一个任务） */
export const PROCESS_PAPER_STEPS = ['parse', 'card', 'detail'] as const
/** M6 前置 2c（D130）：候选 PDF 查找下载任务，locate → download（步骤实现归
 *  lane/fetch 的 jobs/candidatePdf.ts，runner 只调度） */
export const CANDIDATE_PDF_STEPS = ['locate', 'download'] as const
export type StepName = (typeof PROCESS_PAPER_STEPS)[number] | (typeof CANDIDATE_PDF_STEPS)[number]
/** D108：detail_regen（手动重新生成详情，D42）收编进 JobRunner，单步 */
export const DETAIL_REGEN_STEPS = ['detail'] as const satisfies readonly StepName[]
/** JobRunner 负责的任务类型（relation_gen 归 RelationGenEngine，D101/D120，不得进此列） */
export const RUNNER_JOB_KINDS = ['process_paper', 'detail_regen', 'candidate_pdf'] as const satisfies readonly JobKind[]

export function stepsForKind(kind: JobKind): readonly StepName[] {
  if (kind === 'process_paper') return PROCESS_PAPER_STEPS
  if (kind === 'detail_regen') return DETAIL_REGEN_STEPS
  if (kind === 'candidate_pdf') return CANDIDATE_PDF_STEPS
  return []
}

export interface JobRow {
  id: number
  kind: JobKind
  graphId: number | null
  paperId: number | null
  status: JobStatus
  currentStep: string | null
  failedStep: string | null
  error: string | null
  retryCount: number
  progress: number | null
  payload: Record<string, unknown>
  nextRetryAt: string | null
  startedAt: string | null
  createdAt: string
  updatedAt: string
}

const nowIso = (): string => new Date().toISOString()

function toJobRow(r: Record<string, unknown>): JobRow {
  return {
    id: r.id as number,
    kind: r.kind as JobKind,
    graphId: (r.graph_id as number | null) ?? null,
    paperId: (r.paper_id as number | null) ?? null,
    status: r.status as JobStatus,
    currentStep: (r.current_step as string | null) ?? null,
    failedStep: (r.failed_step as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    retryCount: r.retry_count as number,
    progress: (r.progress as number | null) ?? null,
    payload: JSON.parse((r.payload as string) || '{}') as Record<string, unknown>,
    nextRetryAt: (r.next_retry_at as string | null) ?? null,
    startedAt: (r.started_at as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string
  }
}

export function getJob(db: Database.Database, id: number): JobRow | null {
  const r = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return r ? toJobRow(r) : null
}

/**
 * 排队一个任务。同一论文同一 kind 已有未终结任务（非 failed/succeeded）时
 * 直接返回已有任务 id（幂等，导入重复触发不产生重复任务）。
 */
export function enqueueJob(
  db: Database.Database,
  kind: JobKind,
  opts: { graphId?: number | null; paperId?: number | null; payload?: Record<string, unknown> } = {}
): number {
  if (opts.paperId != null) {
    const existing = db
      .prepare(
        `SELECT id FROM jobs WHERE kind = ? AND paper_id = ?
         AND status IN ('queued', 'running', 'waiting_network', 'waiting_key')`
      )
      .get(kind, opts.paperId) as { id: number } | undefined
    if (existing) return existing.id
  }
  const now = nowIso()
  const r = db
    .prepare(
      `INSERT INTO jobs (kind, graph_id, paper_id, status, payload, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?)`
    )
    .run(kind, opts.graphId ?? null, opts.paperId ?? null, JSON.stringify(opts.payload ?? {}), now, now)
  const id = Number(r.lastInsertRowid)
  const steps = stepsForKind(kind)
  if (steps.length > 0) {
    const ins = db.prepare("INSERT INTO job_steps (job_id, step, status) VALUES (?, ?, 'pending')")
    for (const s of steps) ins.run(id, s)
  }
  return id
}

export function setJobStatus(
  db: Database.Database,
  id: number,
  status: JobStatus,
  patch: Partial<{ currentStep: string | null; failedStep: string | null; error: string | null; retryCount: number; progress: number | null; nextRetryAt: string | null }> = {}
): void {
  const cur = getJob(db, id)
  if (!cur) throw new Error(`任务 ${id} 不存在`)
  db.prepare(
    `UPDATE jobs SET status = ?, current_step = ?, failed_step = ?, error = ?,
       retry_count = ?, progress = ?, next_retry_at = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    status,
    patch.currentStep !== undefined ? patch.currentStep : cur.currentStep,
    patch.failedStep !== undefined ? patch.failedStep : cur.failedStep,
    patch.error !== undefined ? patch.error : cur.error,
    patch.retryCount ?? cur.retryCount,
    patch.progress !== undefined ? patch.progress : cur.progress,
    patch.nextRetryAt !== undefined ? patch.nextRetryAt : cur.nextRetryAt, // 建 5：不传保留（与其他字段一致）；需清空处显式传 null
    nowIso(),
    id
  )
}

export function markStepRunning(db: Database.Database, jobId: number, step: string): void {
  const now = nowIso()
  db.prepare(
    `INSERT INTO job_steps (job_id, step, status, attempts, started_at)
     VALUES (?, ?, 'running', 1, ?)
     ON CONFLICT(job_id, step) DO UPDATE SET
       status = 'running', attempts = attempts + 1, started_at = excluded.started_at, error = NULL`
  ).run(jobId, step, now)
}

export function markStepSucceeded(db: Database.Database, jobId: number, step: string): void {
  db.prepare("UPDATE job_steps SET status = 'succeeded', finished_at = ?, error = NULL WHERE job_id = ? AND step = ?").run(
    nowIso(),
    jobId,
    step
  )
}

export function markStepFailed(db: Database.Database, jobId: number, step: string, error: string): void {
  db.prepare("UPDATE job_steps SET status = 'failed', finished_at = ?, error = ? WHERE job_id = ? AND step = ?").run(
    nowIso(),
    error,
    jobId,
    step
  )
}

export function getJobSteps(db: Database.Database, jobId: number): Array<{ step: string; status: string; attempts: number; error: string | null }> {
  return db
    .prepare('SELECT step, status, attempts, error FROM job_steps WHERE job_id = ? ORDER BY rowid')
    .all(jobId) as Array<{ step: string; status: string; attempts: number; error: string | null }>
}

/** 手动重试（D85）：从失败步骤接着跑——已 succeeded 的步骤保持，任务回 queued、清错误、重置重试预算。
 *  uat6c S2 / D183：重试前把同（kind, graph, 论文组）的其它旧失败收敛为已被取代
 *  （superseded_at），状态点不再重复计它们；已被取代的行本身不可再重试。 */
export function retryJob(db: Database.Database, id: number): void {
  const job = getJob(db, id)
  if (!job) throw new Error(`任务 ${id} 不存在`)
  const superseded = (db.prepare('SELECT superseded_at FROM jobs WHERE id = ?').get(id) as { superseded_at: string | null } | undefined)
    ?.superseded_at
  if (superseded != null) throw new Error(`任务 ${id} 已被更新的任务取代，无需重试`)
  if (job.status !== 'failed_retryable' && job.status !== 'failed_action') {
    throw new Error(`任务 ${id} 当前状态 ${job.status} 不能手动重试`)
  }
  supersedeSiblingFailures(db, job)
  setJobStatus(db, id, 'queued', { failedStep: null, error: null, retryCount: 0, nextRetryAt: null })
}

/**
 * uat6c S2：把与给定任务同（kind, graph, 论文组签名）的其它终态失败任务标为已被
 * 取代（superseded_at = now）——不物理删除、不改状态。论文组签名：paper_id 优先；
 * 否则 payload.paperIds 排序签名；全图任务（无 paper_id 且无 paperIds）= 'full'。
 * 关系任务成功后（engine）与手动重试前（retryJob）各调一次；幂等。
 */
export function supersedeSiblingFailures(db: Database.Database, job: JobRow): void {
  if (job.graphId == null) return
  const sig = signatureOf(job.paperId, job.payload)
  const rows = db
    .prepare(
      `SELECT id, paper_id, payload FROM jobs
       WHERE kind = ? AND graph_id = ? AND id != ? AND superseded_at IS NULL
         AND status IN ('failed_retryable', 'failed_action')`
    )
    .all(job.kind, job.graphId, job.id) as Array<{ id: number; paper_id: number | null; payload: string }>
  const stamp = nowIso()
  const upd = db.prepare('UPDATE jobs SET superseded_at = ? WHERE id = ?')
  for (const r of rows) {
    let payload: Record<string, unknown> = {}
    try {
      payload = JSON.parse(r.payload || '{}') as Record<string, unknown>
    } catch {
      // 坏 payload 按全图组处理
    }
    if (signatureOf(r.paper_id, payload) === sig) upd.run(stamp, r.id)
  }
}

/** 同 supersedeSiblingFailures 的论文组签名（paper_id 优先 → payload.paperIds → 'full'）。 */
export function jobGroupSignature(job: JobRow): string {
  return signatureOf(job.paperId, job.payload)
}

function signatureOf(paperId: number | null, payload: Record<string, unknown>): string {
  if (paperId != null) return `p${paperId}`
  const ids = Array.isArray(payload?.paperIds)
    ? (payload.paperIds as unknown[]).filter((x): x is number => typeof x === 'number').sort((a, b) => a - b)
    : []
  return ids.length > 0 ? `ids:${ids.join(',')}` : 'full'
}

/** D44：App 启动时把遗留的 running 任务标为 failed_retryable（可重试）。 */
export function failStaleRunningJobs(db: Database.Database): number {
  const now = nowIso()
  const r = db
    .prepare(
      `UPDATE jobs SET status = 'failed_retryable', error = 'App 重启，任务中断', updated_at = ?
       WHERE status = 'running'`
    )
    .run(now)
  return r.changes
}

/** LLM 队列暂停（401/402，D70）：记在 app_settings，重启后仍暂停（Key 没改好之前不空转）。 */
export function setLlmQueuePaused(db: Database.Database, reason: string | null): void {
  const now = nowIso()
  if (reason == null) {
    db.prepare("DELETE FROM app_settings WHERE key = 'llm_queue_paused'").run()
  } else {
    db.prepare(
      "INSERT INTO app_settings (key, value, updated_at) VALUES ('llm_queue_paused', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).run(reason, now)
  }
}

export function getLlmQueuePauseReason(db: Database.Database): string | null {
  const r = db.prepare("SELECT value FROM app_settings WHERE key = 'llm_queue_paused'").get() as { value: string } | undefined
  return r?.value ?? null
}
