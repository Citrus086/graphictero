import type Database from 'better-sqlite3'
import type { ParseProgressView } from '../../shared/ipc/pdf'
import {
  AuthLlmError,
  BadRequestLlmError,
  MissingKeyError,
  NetworkLlmError,
  ParseStepError,
  RetryableLlmError
} from '../llm/errors'
import type { LlmClientDeps } from '../llm/client'
import {
  getJob,
  getLlmQueuePauseReason,
  getJobSteps,
  markStepFailed,
  markStepRunning,
  markStepSucceeded,
  RUNNER_JOB_KINDS,
  stepsForKind,
  setJobStatus,
  setLlmQueuePaused,
  type JobRow,
  type StepName
} from './store'
import type { PaperParser } from './mineru'
import { runCardStep, runDetailStep, runParseStep, type ProcessPaperCtx } from './processPaper'
import { sessionIdOfPayload } from './sessionAttr'

/**
 * 任务调度器 / 状态机（D53/D70/D85）。
 *
 * - 一篇论文一个 process_paper 任务，步骤 parse → card → detail 顺序执行；
 *   detail_regen（D108，手动重新生成详情 D42）单步 detail，强制覆盖；
 *   已 succeeded 的步骤跳过，重试从失败步骤接着跑（D85）；
 * - 各篇互不阻塞：每个任务是独立 promise，一篇失败不影响其他；
 * - 并发：MinerU 解析并发 1（D72 实测口径）；LLM 步骤（名片/详情）并发写死
 *   DETAIL_LLM_CONCURRENCY = 3（D85 要求 2–4）；
 * - 错误分类（D53/D70）：
 *   · MissingKeyError / 未配置 Key → waiting_key（排队，不配为失败）；
 *   · 离线（net.isOnline() = false）→ waiting_network，不消耗重试次数；
 *   · 429 / 5xx / 超时 / 在线网络错误 → 自动重试 3 次（指数退避；429 遵守
 *     Retry-After），仍失败 → failed_retryable（界面给「重试」）；
 *   · 401 / 402 → 暂停整个 LLM 队列（app_settings.llm_queue_paused），相关
 *     任务停 waiting_key，顶栏汇总一行「API Key 无效 · 影响 N 个任务」；
 *   · 400 等 → failed_action，显示明确原因，不自动重试；
 *   · MinerU 解析步骤失败 → failed_retryable，手动重试（D85）。
 * - drain() 是显式驱动的调度循环（生产用定时器 + 事件触发，测试直接 await）。
 */

/** D108：runner 捞取的任务类型（relation_gen 不在内，D101） */
const KIND_SQL = RUNNER_JOB_KINDS.map((k) => `'${k}'`).join(', ')

/** D85：详情生成并发 2–4 篇写死 → 取 3 */
export const DETAIL_LLM_CONCURRENCY = 3
/** MinerU 解析并发 1（D72） */
export const PARSE_CONCURRENCY = 1
/** 自动重试次数（D53/D70） */
export const MAX_AUTO_RETRIES = 3

export interface RunnerDeps {
  /** 评审建 3：惰性取库——数据目录迁移/恢复失败重开库（state.db 换新对象）后，
   *  调度器不需要重建就能继续工作 */
  db: () => Database.Database
  dataDir: string
  parser: PaperParser
  /** 是否已配置 API Key（读 .env；调度器据此进 waiting_key，不空打请求） */
  hasLlmKey: () => boolean
  /** 取当前 LLM 调用参数（Key/模型/baseUrl；测试指向本地 stub） */
  llmClient: () => LlmClientDeps
  /** 离线判定（生产 = electron net.isOnline()） */
  isOnline: () => boolean
  /** 解析进度回调（生产 = IPC 层广播 event:pdf:parseProgress）；可选，测试不传 */
  onParseProgress?: (paperId: number, p: ParseProgressView) => void
  /** 详情生成/重生成成功后回调（生产 = 广播 event:detail:updated）；可选，测试不传。
   *  覆盖 process_paper 与 detail_regen（stepsForKind 含 detail 的两类任务） */
  onDetailUpdated?: (paperId: number) => void
  /** M6 前置 2c（D130）：candidate_pdf 步骤执行器（locate/download）；由 lane/fetch
   *  的 jobs/candidatePdf.ts 提供并接线。缺省时 candidate_pdf 任务安全失败为
   *  failed_action（不空转重试），由批 1 替换为真实现 */
  candidatePdf?: { runStep(job: JobRow, step: StepName): Promise<void> }
  now?: () => Date
  maxRetries?: number
  baseBackoffMs?: number
}

class Semaphore {
  private waiters: Array<() => void> = []
  constructor(private capacity: number) {}
  async acquire(): Promise<() => void> {
    if (this.capacity > 0) {
      this.capacity--
      let released = false
      return () => {
        if (released) return
        released = true
        this.capacity++
        this.waiters.shift()?.()
      }
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    return this.acquire()
  }
}

export class JobRunner {
  private parseSem = new Semaphore(PARSE_CONCURRENCY)
  private llmSem = new Semaphore(DETAIL_LLM_CONCURRENCY)
  private runningJobs = new Set<number>()
  private now: () => Date
  private maxRetries: number
  private baseBackoffMs: number

  constructor(private deps: RunnerDeps) {
    this.now = deps.now ?? (() => new Date())
    this.maxRetries = deps.maxRetries ?? MAX_AUTO_RETRIES
    this.baseBackoffMs = deps.baseBackoffMs ?? 1000
  }

  get db(): Database.Database {
    return this.deps.db()
  }

  /** 条件满足后自动继续（D53）：联网/配好 Key/解除暂停后，排队任务回 queued。 */
  resumeWaiting(): void {
    const db = this.db
    const paused = getLlmQueuePauseReason(db) != null
    if (this.deps.isOnline()) {
      db.prepare("UPDATE jobs SET status = 'queued', next_retry_at = NULL, updated_at = ? WHERE status = 'waiting_network'").run(
        this.now().toISOString()
      )
    }
    if (!paused && this.deps.hasLlmKey()) {
      db.prepare("UPDATE jobs SET status = 'queued', next_retry_at = NULL, updated_at = ? WHERE status = 'waiting_key'").run(
        this.now().toISOString()
      )
    }
  }

  /**
   * 调度循环：捞起所有可执行的任务并行推进（受并发上限约束），直到没有
   * 任务能再动。自动重试到点（next_retry_at <= now）的任务才会被捞起。
   */
  async drain(): Promise<void> {
    for (;;) {
      this.resumeWaiting()
      const runnable = this.db
        .prepare(
          `SELECT id FROM jobs
           WHERE kind IN (${KIND_SQL}) AND status = 'queued' AND (next_retry_at IS NULL OR next_retry_at <= ?)
           ORDER BY id`
        )
        .all(this.now().toISOString()) as Array<{ id: number }>
      const toStart = runnable.filter((r) => !this.runningJobs.has(r.id))
      if (toStart.length === 0) {
        if (this.runningJobs.size === 0) return
        await this.waitForOne()
        continue
      }
      const promises = toStart.map((r) => this.runJob(r.id))
      await Promise.allSettled(promises)
      // 有任务刚跑完：可能有 waiting 条件已变化 / 新重试到点，再走一轮
      if (this.runningJobs.size === 0) {
        const more = this.db
          .prepare(
            `SELECT 1 FROM jobs WHERE kind IN (${KIND_SQL}) AND status = 'queued'
             AND (next_retry_at IS NULL OR next_retry_at <= ?) LIMIT 1`
          )
          .get(this.now().toISOString())
        if (!more) return
      }
    }
  }

  private jobPromises = new Map<number, Promise<void>>()

  private async waitForOne(): Promise<void> {
    await Promise.race([...this.jobPromises.values()])
  }

  private runJob(jobId: number): Promise<void> {
    const p = this.executeJob(jobId).finally(() => {
      this.runningJobs.delete(jobId)
      this.jobPromises.delete(jobId)
    })
    this.runningJobs.add(jobId)
    this.jobPromises.set(jobId, p)
    return p
  }

  /** 推进一个任务的剩余步骤（从第一个未 succeeded 的步骤接着跑）。 */
  private async executeJob(jobId: number): Promise<void> {
    const db = this.db
    const job = getJob(db, jobId)
    if (!job || job.status !== 'queued') return
    // uat2：此处**不**写 running——旧实现一进 executeJob 就置 running，导致排队等
    // 并发额度（解析并发 1，D72）的任务被显示成「处理中」；现在保持 queued
    // （渲染层口径 = 「排队中」），拿到额度、真正开始跑步骤时才认领置 running。

    const steps = stepsForKind(job.kind)
    for (const step of steps) {
      const stepRows = getJobSteps(db, jobId)
      const row = stepRows.find((s) => s.step === step)
      if (row?.status === 'succeeded') continue // D85：从失败步骤接着跑

      // LLM 步骤的排队预检（不空打请求、不消耗重试次数，D53/D70）；
      // candidate_pdf 是联网下载不是 LLM 调用，不查 Key（2c/D130）
      if (step !== 'parse' && job.kind !== 'candidate_pdf') {
        const pauseReason = getLlmQueuePauseReason(db)
        if (pauseReason != null) {
          setJobStatus(db, jobId, 'waiting_key', { currentStep: step, error: pauseReason })
          return
        }
        if (!this.deps.hasLlmKey()) {
          setJobStatus(db, jobId, 'waiting_key', { currentStep: step, error: '缺少 API Key' })
          return
        }
        if (!this.deps.isOnline()) {
          setJobStatus(db, jobId, 'waiting_network', { currentStep: step, error: '等待联网' })
          return
        }
      }

      const sem = step === 'parse' ? this.parseSem : this.llmSem
      const release = await sem.acquire()
      // 拿到额度才认领：DB 原子占位（并发 drain 重入时防双跑），认领失败即放弃
      const claim = db
        .prepare("UPDATE jobs SET status = 'running', error = NULL, next_retry_at = NULL, updated_at = ? WHERE id = ? AND status IN ('queued','running')")
        .run(this.now().toISOString(), jobId)
      if (claim.changes === 0) {
        release()
        return // 状态已被外部改变（如手动重试/删除），本次不执行
      }
      setJobStatus(db, jobId, 'running', { currentStep: step })
      markStepRunning(db, jobId, step)
      try {
        await this.runStep(job, step)
        markStepSucceeded(db, jobId, step)
        const done = stepRows.filter((s) => s.status === 'succeeded').length + 1
        setJobStatus(db, jobId, 'running', { progress: done / steps.length })
      } catch (e) {
        markStepFailed(db, jobId, step, e instanceof Error ? e.message : String(e))
        this.handleStepError(job, step, e)
        return
      } finally {
        release()
      }
    }
    setJobStatus(db, jobId, 'succeeded', { currentStep: null, failedStep: null, error: null, progress: 1 })
    // 详情落库成功 → 通知渲染进程（event:detail:updated）。detail 步被「已是最新」
    // 跳过时多发一次无害（页面只是重读缓存）。
    if (this.deps.onDetailUpdated && job.paperId != null && stepsForKind(job.kind).includes('detail')) {
      this.deps.onDetailUpdated(job.paperId)
    }
  }

  private async runStep(job: JobRow, step: StepName): Promise<void> {
    if (job.kind === 'candidate_pdf') {
      if (!this.deps.candidatePdf) {
        // 2c 最小桩：步骤实现归 lane/fetch 批 1——安全失败（failed_action，不自动重试）
        // BadRequestLlmError(400) 口径 → failed_action 终态，不自动重试
        throw new BadRequestLlmError('candidate_pdf 步骤实现由 lane/fetch 批 1 接入（M6 前置 2c）', 400)
      }
      return this.deps.candidatePdf.runStep(job, step)
    }
    if ((job.kind !== 'process_paper' && job.kind !== 'detail_regen') || job.paperId == null) throw new Error(`不支持的任务类型：${job.kind}`)
    const ctx: ProcessPaperCtx = {
      db: this.db,
      dataDir: this.deps.dataDir,
      paperId: job.paperId,
      parser: this.deps.parser,
      llm: this.deps.llmClient,
      now: this.now,
      forceDetail: job.kind === 'detail_regen', // D42/D108：手动重新生成绕过「版本+哈希未变跳过」
      // 只认 payload。detail_regen 与手动/Zotero 入队没有 sessionId，不按论文反查（避免串会话）
      sessionId: job.kind === 'process_paper' ? sessionIdOfPayload(job.payload) : null,
      onProgress: this.deps.onParseProgress ? (p) => this.deps.onParseProgress?.(job.paperId as number, p) : undefined
    }
    if (step === 'parse') return runParseStep(ctx)
    if (step === 'card') return runCardStep(ctx)
    return runDetailStep(ctx)
  }

  private handleStepError(job: JobRow, step: StepName, e: unknown): void {
    const db = this.db
    const msg = e instanceof Error ? e.message : String(e)

    if (e instanceof ParseStepError) {
      // D85：MinerU 解析步骤手动重试
      setJobStatus(db, job.id, 'failed_retryable', { failedStep: step, error: msg })
      return
    }
    if (e instanceof MissingKeyError) {
      // 建 4：Key 在步骤预检之后被清空（竞态）——与预检同口径：waiting_key 排队，
      // 不消耗自动重试次数（下轮 hasLlmKey 恢复后自动继续）
      setJobStatus(db, job.id, 'waiting_key', { currentStep: step, error: '缺少 API Key' })
      return
    }
    if (e instanceof AuthLlmError) {
      // D70：401/402 暂停整个 LLM 队列；任务停 waiting_key，不算处理失败
      const reason = e.status === 401 ? 'API Key 无效' : '余额不足'
      setLlmQueuePaused(db, reason)
      setJobStatus(db, job.id, 'waiting_key', { currentStep: step, error: reason })
      return
    }
    if (e instanceof NetworkLlmError) {
      if (!this.deps.isOnline()) {
        // D70：离线不消耗重试次数
        setJobStatus(db, job.id, 'waiting_network', { currentStep: step, error: '等待联网' })
        return
      }
      this.scheduleRetry(job, step, `网络错误：${msg}`)
      return
    }
    if (e instanceof RetryableLlmError) {
      this.scheduleRetry(job, step, msg, e.retryAfterMs)
      return
    }
    if (e instanceof BadRequestLlmError) {
      setJobStatus(db, job.id, 'failed_action', { failedStep: step, error: msg })
      return
    }
    // 未知错误按可重试处理（保守）
    this.scheduleRetry(job, step, msg)
  }

  private scheduleRetry(job: JobRow, step: StepName, msg: string, retryAfterMs?: number): void {
    const retryCount = job.retryCount + 1
    // D53：自动重试 3 次——初次失败后最多再自动跑 3 次（retryCount 1..3 排队，第 4 次失败才终态）
    if (retryCount > this.maxRetries) {
      setJobStatus(this.db, job.id, 'failed_retryable', { failedStep: step, error: msg, retryCount })
      return
    }
    const backoff = this.baseBackoffMs * 2 ** (retryCount - 1)
    const delay = Math.max(backoff, retryAfterMs ?? 0) // D53：429 遵守 Retry-After
    setJobStatus(this.db, job.id, 'queued', {
      failedStep: step,
      error: msg,
      retryCount,
      nextRetryAt: new Date(this.now().getTime() + delay).toISOString()
    })
  }
}
