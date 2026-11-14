import type Database from 'better-sqlite3'
import { AuthLlmError, BadRequestLlmError, MissingKeyError, NetworkLlmError, RetryableLlmError } from '../llm/errors'
import type { LlmClientDeps } from '../llm/client'
import {
  enqueueJob,
  getJob,
  getJobSteps,
  getLlmQueuePauseReason,
  markStepFailed,
  markStepRunning,
  markStepSucceeded,
  setJobStatus,
  setLlmQueuePaused,
  supersedeSiblingFailures,
  type JobRow
} from '../jobs/store'
import type { OpenAlexClient } from '../openalex/client'
import { fetchOpenAlexReferences } from '../openalex/references'
import { extractReferencesWithLlm } from './referencesExtract'
import { generateForGraph, generateForPaper } from './generator'
import { paperDetailText } from './context'
import { isPaperProcessed, processedPaperIds } from './progress'
import { paperInGraph as isGraphMember } from './membership'
import type { RelGenerateProgress } from '../../shared/ipc/relations'

/**
 * 关系生成任务引擎（relation_gen，D53/D70/D77/D86）。
 *
 * 为什么不在 JobRunner 里跑：jobs/runner.ts 写死 process_paper 的步骤分发，
 * 且 runner.ts 不在本车道文件名单内（并行车道约定）——relation_gen 由本引擎
 * 执行，错误分类口径逐条镜像 runner（缺 Key→waiting_key、离线→waiting_network
 * 不耗重试、429 遵守 Retry-After、5xx 指数退避自动重试 3 次、401/402 暂停
 * LLM 队列、400→failed_action）。合并回 main 后是否把 relation_gen 收编进
 * JobRunner 由维护者定。
 *
 * - 同一图谱的关系生成任务串行（D77）：按 graphId 串行链；
 * - 步骤 references（OpenAlex W-ID + referenced_works，D71；补不全走 D40
 *   deepseek 兜底）→ generate（首建整图 / 逐篇新增）；
 * - 截断 / 失败后续跑：任务回 queued 后从第一个未 succeeded 的步骤接着跑，
 *   已按论文记「已处理」的跳过（D86，relation_gen_progress 表，迁移 010）。
 */

/** relation_gen 任务的步骤（enqueueJob 只为 process_paper 插步骤行，这里自己插） */
export const RELATION_GEN_STEPS = ['references', 'generate'] as const

export interface RelationEngineDeps {
  /** 惰性取库（与 runner 同口径：迁移/恢复重开库后不用重建引擎） */
  db: () => Database.Database
  dataDir: string
  /** LLM 调用参数；缺 Key 时应抛 MissingKeyError（同 runner 口径） */
  llm: () => LlmClientDeps
  /** OpenAlex 客户端（含限速/重试；Key 与 mailto 由接线方注入） */
  openAlex: () => OpenAlexClient
  /** 评审建议修（rel3）3：OpenAlex 配置（Key/mailto）指纹——指纹变化时重建单例，
   * 用户在设置里改了 mailto / 加 Key 不用重启就生效。省略 = 永远用第一个实例。 */
  openAlexFingerprint?: () => string
  hasLlmKey: () => boolean
  isOnline: () => boolean
  now?: () => Date
  maxRetries?: number
  baseBackoffMs?: number
  /** 进度推送（IPC 层转 event:rel:generateProgress） */
  onProgress?: (p: RelGenerateProgress) => void
}

export class RelationGenEngine {
  private now: () => Date
  private maxRetries: number
  private baseBackoffMs: number
  /** graphId → 串行链尾 promise（D77：同图串行，图间并行） */
  private chains = new Map<number, Promise<void>>()
  private runningJobs = new Set<number>()
  private jobPromises = new Map<number, Promise<void>>()
  /** OpenAlex 客户端单例（评审建议 8）：限速状态（lastRequestAt）按实例记，
   * 每篇论文新建客户端会归零限速——引擎级 memoize 保证跨论文限速生效。
   * 评审建议修（rel3）3：memoize 连同配置指纹快照，指纹变化（设置改了
   * mailto / Key）即重建。 */
  private openAlexClient: OpenAlexClient | null = null
  private openAlexFingerprint: string | null = null

  private openAlex(): OpenAlexClient {
    const fp = this.deps.openAlexFingerprint?.() ?? ''
    if (!this.openAlexClient || this.openAlexFingerprint !== fp) {
      this.openAlexClient = this.deps.openAlex()
      this.openAlexFingerprint = fp
    }
    return this.openAlexClient
  }

  constructor(private deps: RelationEngineDeps) {
    this.now = deps.now ?? (() => new Date())
    this.maxRetries = deps.maxRetries ?? 3
    this.baseBackoffMs = deps.baseBackoffMs ?? 1000
  }

  get db(): Database.Database {
    return this.deps.db()
  }

  private progress(p: RelGenerateProgress): void {
    try {
      this.deps.onProgress?.(p)
    } catch {
      // 进度推送失败不影响任务
    }
  }

  /**
   * 排队一个关系生成任务并立即调度。paperIds 为空 = 全图（首建/补齐漏掉的）；
   * 同图已有活动任务时合并 paperIds 进 payload（幂等，不重复建任务）。
   * opts.regenerate（D104）：整图重建任务——写边只替换 job 来源边，成功后删除
   * 本次未重写到的旧 job 边；由 enqueueRegenerate 置位。
   */
  enqueue(graphId: number, paperIds?: number[], opts: { regenerate?: boolean } = {}): number {
    const db = this.db
    const active = db
      .prepare(
        `SELECT id, payload FROM jobs
         WHERE kind = 'relation_gen' AND graph_id = ? AND status IN ('queued','running','waiting_network','waiting_key')
         ORDER BY id LIMIT 1`
      )
      .get(graphId) as { id: number; payload: string } | undefined
    if (active) {
      // 合并语义（评审必须修 1）：任一方为 null（全图）→ 合并结果保持 null，
      // 全图覆盖指定论文，references 步骤范围不丢；空数组 [] 归一为 null。
      // regenerate 标记原样保留（D104：整图重建语义不被合并进来的增量请求稀释）。
      const payload = JSON.parse(active.payload || '{}') as { paperIds?: number[] | null; regenerate?: boolean }
      const existing = Array.isArray(payload.paperIds) && payload.paperIds.length > 0 ? payload.paperIds : null
      const incoming = Array.isArray(paperIds) && paperIds.length > 0 ? paperIds : null
      const next = existing == null || incoming == null ? null : [...new Set([...existing, ...incoming])]
      db.prepare('UPDATE jobs SET payload = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify({ paperIds: next, ...(payload.regenerate ? { regenerate: true } : {}) }),
        this.now().toISOString(),
        active.id
      )
      void this.kick(graphId)
      return active.id
    }
    const id = enqueueJob(db, 'relation_gen', {
      graphId,
      payload: { paperIds: paperIds ?? null, ...(opts.regenerate ? { regenerate: true } : {}) }
    })
    const ins = db.prepare("INSERT INTO job_steps (job_id, step, status) VALUES (?, ?, 'pending')")
    for (const s of RELATION_GEN_STEPS) ins.run(id, s)
    void this.kick(graphId)
    return id
  }

  /** D88「重新生成关系」：清掉本图「已处理」标记后排队全图重建
   * （写边 upsert 合并，自动类型按当前引用 / 作者数据重算）。二次确认在 UI。
   * 评审建议修 3a：同图已有活动任务时直接拒绝（抛错给 UI 提示），且**不先清**
   * 「已处理」标记——否则运行中任务 + 补排会把全图再跑一遍（多余 LLM 费用）。 */
  enqueueRegenerate(graphId: number): number {
    const active = this.db
      .prepare(
        `SELECT 1 FROM jobs
         WHERE kind = 'relation_gen' AND graph_id = ? AND status IN ('queued','running','waiting_network','waiting_key')
         LIMIT 1`
      )
      .get(graphId)
    if (active) throw new Error('本图已有进行中的关系生成任务，请等待完成后再重新生成')
    this.db.prepare('DELETE FROM relation_gen_progress WHERE graph_id = ?').run(graphId)
    return this.enqueue(graphId, undefined, { regenerate: true })
  }

  /** 条件满足后自动继续（D53）：联网 / 配好 Key / 解除暂停后 waiting 任务回 queued。 */
  resumeWaiting(): void {
    const db = this.db
    const paused = getLlmQueuePauseReason(db) != null
    const iso = this.now().toISOString()
    if (this.deps.isOnline()) {
      db.prepare("UPDATE jobs SET status = 'queued', next_retry_at = NULL, updated_at = ? WHERE kind = 'relation_gen' AND status = 'waiting_network'").run(iso)
    }
    if (!paused && this.deps.hasLlmKey()) {
      db.prepare("UPDATE jobs SET status = 'queued', next_retry_at = NULL, updated_at = ? WHERE kind = 'relation_gen' AND status = 'waiting_key'").run(iso)
    }
  }

  /** 把 graphId 的新任务接到串行链尾（不 await，失败只记日志）。 */
  private kick(graphId: number): void {
    const tail = this.chains.get(graphId) ?? Promise.resolve()
    const next = tail.then(() => this.drain()).catch((e) => console.error('[graphictero] 关系引擎调度异常：', e))
    this.chains.set(graphId, next)
  }

  /** 调度循环：捞起本引擎到期可跑的 relation_gen 任务（同图串行由 chains 保证）。 */
  async drain(): Promise<void> {
    for (;;) {
      this.resumeWaiting()
      const runnable = this.db
        .prepare(
          `SELECT id, graph_id FROM jobs
           WHERE kind = 'relation_gen' AND status = 'queued' AND (next_retry_at IS NULL OR next_retry_at <= ?)
           ORDER BY id`
        )
        .all(this.now().toISOString()) as Array<{ id: number; graph_id: number | null }>
      // 评审建议 12：每图只取最老一条排队任务，同图不并行（D77 串行链之外的窄窗防护）
      // 评审必须修（rel3）1：同图已有 running 任务的排队任务在此**直接排除**
      // （retryJob 可把 failed 旧任务回 queued，与活跃任务并存）——若放进 toStart，
      // executeJob 让位 return 的已 resolve promise 会让 for(;;) 微任务自旋、饿死
      // 事件循环（主进程假死）。排除后 toStart 为空 → 落入下方
      // `await Promise.race(jobPromises)` 真等待分支，正常让出事件循环。
      const runningGraphs = new Set(
        (
          this.db
            .prepare("SELECT DISTINCT graph_id FROM jobs WHERE kind = 'relation_gen' AND status = 'running' AND graph_id IS NOT NULL")
            .all() as Array<{ graph_id: number }>
        ).map((r) => r.graph_id)
      )
      const seenGraphs = new Set<number>()
      const toStart = runnable.filter((r) => {
        if (this.runningJobs.has(r.id)) return false
        const gid = r.graph_id ?? 0
        if (seenGraphs.has(gid)) return false
        if (runningGraphs.has(gid)) return false
        seenGraphs.add(gid)
        return true
      })
      if (toStart.length === 0) {
        if (this.runningJobs.size === 0) return
        await Promise.race([...this.jobPromises.values()])
        continue
      }
      await Promise.allSettled(toStart.map((r) => this.runJob(r.id)))
      if (this.runningJobs.size === 0) {
        const more = this.db
          .prepare(
            `SELECT 1 FROM jobs WHERE kind = 'relation_gen' AND status = 'queued'
             AND (next_retry_at IS NULL OR next_retry_at <= ?) LIMIT 1`
          )
          .get(this.now().toISOString())
        if (!more) return
      }
    }
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

  private async executeJob(jobId: number): Promise<void> {
    const db = this.db
    const job = getJob(db, jobId)
    if (!job || job.kind !== 'relation_gen' || job.status !== 'queued') return
    // 评审建议 12：启动前查同图活动任务——retryJob 可把 failed 旧任务回 queued，
    // 可能与活跃新任务并存；让位给同图已在跑的任务，自己留在 queued 等串行链。
    if (job.graphId != null) {
      const conflict = db
        .prepare("SELECT 1 FROM jobs WHERE kind = 'relation_gen' AND graph_id = ? AND status = 'running' AND id != ?")
        .get(job.graphId, jobId)
      if (conflict) return
    }
    setJobStatus(db, jobId, 'running', { error: null, nextRetryAt: null })
    this.progress({ graphId: job.graphId ?? 0, phase: 'references' })

    // uat1b：累计 generate 步写入的关系条数，done 事件带 addedCount（0 = 空跑）
    let addedTotal = 0
    for (const step of RELATION_GEN_STEPS) {
      const row = getJobSteps(db, jobId).find((s) => s.step === step)
      if (row?.status === 'succeeded') continue // 截断/失败后续跑：已成功的步骤跳过（D86）

      // LLM 步骤排队预检（不空打请求、不消耗重试次数，D53/D70）
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

      setJobStatus(db, jobId, 'running', { currentStep: step })
      markStepRunning(db, jobId, step)
      try {
        const written = await this.runStep(job, step)
        if (step === 'generate') addedTotal += written
        markStepSucceeded(db, jobId, step)
      } catch (e) {
        markStepFailed(db, jobId, step, e instanceof Error ? e.message : String(e))
        this.handleStepError(job, step, e)
        // 评审建议修 4：重试耗尽 / 不可重试的终态失败补发 phase:'error'，
        // 进度横幅不会静默消失（waiting_key / waiting_network 不是终态，不发）
        const after = getJob(db, jobId)!
        if (after.status === 'failed_retryable' || after.status === 'failed_action') {
          this.progress({ graphId: job.graphId ?? 0, phase: 'error', error: after.error ?? undefined })
        }
        return
      }
    }
    setJobStatus(db, jobId, 'succeeded', { currentStep: null, failedStep: null, error: null, progress: 1 })
    // uat6c S2 / D183：成功后把同（graph, 论文组）的旧失败任务标为已被取代——
    // 状态点 / 弹层不再重复计历史失败副本（不物理删除）
    supersedeSiblingFailures(db, getJob(db, jobId)!)
    this.progress({ graphId: job.graphId ?? 0, phase: 'done', addedCount: addedTotal })
  }

  /** 目标论文：payload.paperIds；为空 / 空数组 = 全图参与论文（generateForGraph 内部再过滤已处理） */
  private targetPaperIds(job: JobRow): number[] | null {
    const ids = job.payload.paperIds
    if (!Array.isArray(ids) || ids.length === 0) return null
    const nums = ids.filter((x): x is number => typeof x === 'number')
    return nums.length > 0 ? nums : null
  }

  /** 跑一个步骤；返回本步写入的关系条数（references 步恒 0，供 done 事件的 addedCount） */
  private async runStep(job: JobRow, step: (typeof RELATION_GEN_STEPS)[number]): Promise<number> {
    const db = this.db
    const graphId = job.graphId
    if (graphId == null) throw new Error('关系生成任务缺少 graph_id')
    const paperIds = this.targetPaperIds(job)

    if (step === 'references') {
      // D40(a)/D71：OpenAlex 取引用；补不全走 deepseek References 段兜底
      const targets =
        paperIds ??
        (
          db
            .prepare(
              `SELECT p.id FROM graph_members m JOIN papers p ON p.id = m.paper_id
               WHERE m.graph_id = ? AND p.deleted_at IS NULL AND p.has_pdf = 1 ORDER BY p.id`
            )
            .all(graphId) as Array<{ id: number }>
        ).map((r) => r.id)
      for (const pid of targets) {
        // D62/D67：无 PDF 的论文不取引用（也不参与生成）
        if (!this.paperInGraph(db, graphId, pid)) continue
        const r = await fetchOpenAlexReferences(db, this.openAlex(), pid)
        if (!r.workFound || r.refCount === 0 || r.matchedCount === 0) {
          // D40 兜底：OpenAlex 查不到本篇或 referenced_works 为空（最新预印本常态）；
          // uat4 D165：有引用数据但 0 条匹配进库时也兜底（同 refsFetch 口径），
          // deepseek 行与 openalex 行来源不同、互补累计
          const ex = await extractReferencesWithLlm({ db, dataDir: this.deps.dataDir, paperId: pid, llm: this.deps.llm, now: this.now })
          // 评审建议修（rel3）2：截断留日志（D100 给满 384k 后概率已很低，不打扰用户）
          if (ex.truncated) console.error(`[graphictero] 论文 ${pid} 的 References 兜底抽取被截断，只写回 ${ex.wroteCount} 条`)
        }
        this.progress({ graphId, phase: 'references', paperId: pid })
      }
      return 0
    }

    // step === 'generate'
    this.progress({ graphId, phase: 'generate' })
    const genDeps = { db, llm: this.deps.llm, now: this.now }
    if (paperIds != null) {
      let written = 0
      for (const pid of paperIds) {
        if (isPaperProcessed(db, graphId, pid)) continue // D86：只补漏掉的
        // D62/D67/D85：详情未就绪（解析 / 详情任务还没跑到）的论文不参与、不标记，
        // 保持「未处理」等后续补排（新增论文自动补排，见 background.ts）
        if (!this.paperReady(db, graphId, pid)) continue
        written += (await generateForPaper(genDeps, graphId, pid, job.id)).written
        this.progress({ graphId, phase: 'generate', paperId: pid })
      }
      // 兜底补齐：payload 指定了论文但全图还有从未处理过的参与论文（如任务被合并过）
      const rest = (
        db
          .prepare(
            `SELECT p.id FROM graph_members m JOIN papers p ON p.id = m.paper_id
             WHERE m.graph_id = ? AND p.deleted_at IS NULL AND p.has_pdf = 1 ORDER BY p.id`
          )
          .all(graphId) as Array<{ id: number }>
      )
        .map((r) => r.id)
        .filter((pid) => !processedPaperIds(db, graphId).has(pid) && !paperIds.includes(pid))
      if (rest.length > 0) written += (await generateForGraph(genDeps, graphId, job.id)).written
      return written
    }
    // D104：regenerate（payload.regenerate）= 整图重建，只替换 job 边、成功后删未重写的旧 job 边
    return (await generateForGraph(genDeps, graphId, job.id, { replaceStaleJobEdges: job.payload.regenerate === true })).written
  }

  /** 论文是本图成员、未删除、有 PDF（成员判定共用 membership.ts，叠加 D62 的 PDF 门槛） */
  private paperInGraph(db: Database.Database, graphId: number, paperId: number): boolean {
    if (!isGraphMember(db, graphId, paperId)) return false
    const row = db.prepare('SELECT has_pdf AS h FROM papers WHERE id = ?').get(paperId) as { h: number } | undefined
    return row?.h === 1
  }

  /** 参与生成的口径与 generateForGraph 一致：本图成员 + 有 PDF + 详情已就绪 */
  private paperReady(db: Database.Database, graphId: number, paperId: number): boolean {
    return this.paperInGraph(db, graphId, paperId) && paperDetailText(db, paperId) != null
  }

  /** 错误分类：逐条镜像 src/main/jobs/runner.ts 的 handleStepError（口径见文件头注释）。 */
  private handleStepError(job: JobRow, step: string, e: unknown): void {
    const db = this.db
    const msg = e instanceof Error ? e.message : String(e)

    if (e instanceof MissingKeyError) {
      setJobStatus(db, job.id, 'waiting_key', { currentStep: step, error: '缺少 API Key' })
      return
    }
    if (e instanceof AuthLlmError) {
      const reason = e.status === 401 ? 'API Key 无效' : '余额不足'
      setLlmQueuePaused(db, reason) // D70：暂停整个 LLM 队列
      setJobStatus(db, job.id, 'waiting_key', { currentStep: step, error: reason })
      return
    }
    if (e instanceof NetworkLlmError) {
      if (!this.deps.isOnline()) {
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
    this.scheduleRetry(job, step, msg) // 未知错误按可重试处理（保守，同 runner）
  }

  private scheduleRetry(job: JobRow, step: string, msg: string, retryAfterMs?: number): void {
    const retryCount = job.retryCount + 1
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
