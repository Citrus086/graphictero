import type Database from 'better-sqlite3'
import { BadRequestLlmError, NetworkLlmError, RetryableLlmError } from '../llm/errors'
import { createOpenAlexClient, type OpenAlexClient } from '../openalex/client'
import { readOpenAlexSettings } from '../openalex/env'
import { bumpOpenAlexDailyCount } from '../openalex/search'
import { paperFolder } from '../zotero/importer'
import { getPdfSources } from '../pdfsource/settings'
import { pullNextPdf, startPdfWalk, type LocatedPdf, type PdfWalk } from '../pdfsource/chain'
import { downloadPdf, PdfSourceError } from '../pdfsource/download'
import { recordPdfAttempt } from '../pdfsource/attempts'
import { enqueueProcessJobs } from '../appService'
import { lookupCandidateSessionId, sessionIdOfPayload } from './sessionAttr'
import type { PaperParser } from './mineru'
import type { JobRow, StepName } from './store'
import type { CandProgressEvent } from '../../shared/ipc/cand'

/**
 * lane/fetch 批 1：candidate_pdf 任务步骤执行器（D130；m6_plan §5.1-5/2c）。
 *
 * - locate：按来源顺序找到第一条链接即停（pdfsource/chain.ts）。全未命中记入
 *   noPdfCache（带 paperId）；网络错原样抛出，不广播 failed；
 * - download：试这条链接。HTML / 超限 / 404 / 单条 SSRF 记 pdf_attempts 后继续
 *   下一个来源。全部是内容错误 → 广播 no_pdf、步骤成功（D54/D85，不自动重试）。
 *   网络 / 可重试错误保持原类型抛出，不被后面的内容错误覆盖，也不广播 failed；
 * - 只有 BadRequestLlmError（论文不存在、只剩非法模板）广播 failed；
 * - 成功时先写 has_pdf，再广播 parsing/done。进度带 paperId，库里有候选行时再带 candidateId；
 * - 步骤间状态在内存（store 无 payload 更新口，runner/store 冻结）。暂存带 paperId，
 *   恢复备份后同号任务不会串味。
 *
 * 接线：RunnerDeps.candidatePdf 注入点（预备提交留好）。index.ts 冻结，合并时由
 * 维护者在 createRunner 里接线；ipc/cand.ts 注册后有一条等价的惰性自接线兜底
 * （见该文件注释），两条路互不冲突。
 */

export interface CandidatePdfDeps {
  /** 惰性取库（对齐 RunnerDeps.db 口径：恢复备份重开库后不用重建） */
  db: () => Database.Database
  dataDir: string
  /** D95：解析成功后衔接 process_paper 用的解析器（AppState.parser，惰性） */
  parser?: () => PaperParser | undefined
  /** 进度广播（生产 = event:cand:progress）；可选，测试不传 */
  onProgress?: (e: CandProgressEvent) => void
  /** 衔接 process_paper 后驱动调度；可选 */
  drain?: () => void
  fetchImpl?: typeof fetch
  openAlex?: OpenAlexClient // 测试注入；缺省按数据目录环境文件 + 环境缝现建
  /** 单次下载超时 ms（默认 30s；测试用小值验超时分类） */
  downloadTimeoutMs?: number
}

interface WalkState {
  paperId: number
  next: number
  pending: LocatedPdf | null
  sawCleanMiss: boolean
  sawContentError: boolean
  badRequest: BadRequestLlmError | null
}

/** jobId → 查找游标（步骤间传态；重启丢失时 download 会补跑 locate） */
const locatedCache = new Map<number, WalkState>()
/** jobId → 已确认无 PDF 的 paperId（paperId 不符则重查，建议修 2） */
const noPdfCache = new Map<number, number>()

/** 测试专用：步骤间暂存清零（每个用例独立 db，避免同号任务串味） */
export function clearCandidatePdfStepCache(): void {
  locatedCache.clear()
  noPdfCache.clear()
}

interface PaperLocateRow {
  id: number
  doi: string | null
  arxiv_id: string | null
  openalex_wid: string | null
  has_pdf: number
}

function blankState(paperId: number): WalkState {
  return { paperId, next: 0, pending: null, sawCleanMiss: false, sawContentError: false, badRequest: null }
}

export function createCandidatePdfExecutor(deps: CandidatePdfDeps): { runStep(job: JobRow, step: StepName): Promise<void> } {
  const candidateIdOf = (paperId: number): number | undefined => {
    const row = deps
      .db()
      .prepare('SELECT id FROM graph_candidates WHERE paper_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1')
      .get(paperId) as { id: number } | undefined
    return row?.id
  }

  const progress = (paperId: number, phase: CandProgressEvent['phase'], message?: string): void => {
    const candidateId = candidateIdOf(paperId)
    deps.onProgress?.({
      ...(candidateId != null ? { candidateId } : {}),
      paperId,
      phase,
      ...(message ? { message } : {})
    })
  }

  const getPaper = (job: JobRow): PaperLocateRow => {
    if (job.paperId == null) throw new BadRequestLlmError('candidate_pdf 任务缺少论文 id', 400)
    const paper = deps
      .db()
      .prepare('SELECT id, doi, arxiv_id, openalex_wid, has_pdf FROM papers WHERE id = ? AND deleted_at IS NULL')
      .get(job.paperId) as PaperLocateRow | undefined
    if (!paper) throw new BadRequestLlmError(`论文 ${job.paperId} 不存在或已删除`, 400)
    return paper
  }

  const client = (): OpenAlexClient => {
    if (deps.openAlex) return deps.openAlex
    const s = readOpenAlexSettings(deps.dataDir)
    return createOpenAlexClient({
      apiKey: s.apiKey,
      mailto: s.mailto,
      onBillable: () => bumpOpenAlexDailyCount(deps.db())
    })
  }

  const inputFor = (job: JobRow, paper: PaperLocateRow) => ({
    db: deps.db(),
    paperId: paper.id,
    doi: paper.doi,
    arxivId: paper.arxiv_id,
    openalexWid: paper.openalex_wid,
    cachedOaUrl: (job.payload.oaUrl as string | null | undefined) ?? null,
    settings: getPdfSources(deps.db(), deps.dataDir),
    openAlex: client(),
    fetchImpl: deps.fetchImpl
  })

  const absorb = (state: WalkState, walk: PdfWalk): void => {
    state.next = walk.next
    if (walk.sawCleanMiss) state.sawCleanMiss = true
    if (walk.badRequest) state.badRequest = walk.badRequest
  }

  /** 从 state.next 拉到第一条链接，或确认后面没有了。网络错原样抛出。 */
  const fillPending = async (job: JobRow, paper: PaperLocateRow, state: WalkState): Promise<void> => {
    if (state.pending) return
    const walk = startPdfWalk(inputFor(job, paper), state.next)
    let pending: LocatedPdf | null
    try {
      pending = await pullNextPdf(walk)
    } catch (e) {
      absorb(state, walk)
      locatedCache.set(job.id, state)
      throw e
    }
    absorb(state, walk)
    state.pending = pending
    if (!pending) {
      if (state.badRequest && !state.sawCleanMiss && !state.sawContentError) {
        locatedCache.set(job.id, state)
        throw state.badRequest
      }
      locatedCache.delete(job.id)
      noPdfCache.set(job.id, paper.id)
      return
    }
    noPdfCache.delete(job.id)
    locatedCache.set(job.id, state)
  }

  const finishNoPdf = (paper: PaperLocateRow): void => {
    progress(paper.id, 'no_pdf', '所有来源都找不到开放 PDF，已按「无 PDF」入库')
  }

  const downloadAll = async (job: JobRow, paper: PaperLocateRow, state: WalkState): Promise<void> => {
    progress(paper.id, 'downloading', '开始按来源顺序下载 PDF…')
    for (;;) {
      if (!state.pending) {
        await fillPending(job, paper, state)
        if (!state.pending) {
          if (noPdfCache.get(job.id) === paper.id) finishNoPdf(paper)
          return
        }
      }
      const { source, url } = state.pending
      try {
        const res = await downloadPdf(url, paperFolder(deps.dataDir, paper.id), {
          fetchImpl: deps.fetchImpl,
          timeoutMs: deps.downloadTimeoutMs
        })
        const pdfSource = source.startsWith('custom:') ? 'custom' : 'open_access'
        // 先落 has_pdf，再广播 parsing/done（UI 收到 done 会立刻重读）
        // uat1-fix1 建议修 1：查找下载补齐 PDF 时一并清「条目有附件没找到文件」标记
        deps
          .db()
          .prepare('UPDATE papers SET has_pdf = 1, pdf_source = ?, pdf_hash = ?, pdf_unresolved = 0, updated_at = ? WHERE id = ?')
          .run(pdfSource, res.sha256, new Date().toISOString(), paper.id)
        recordPdfAttempt(deps.db(), paper.id, source, 'ok', url)
        locatedCache.delete(job.id)
        noPdfCache.delete(job.id)
        const parser = deps.parser?.()
        let queued = false
        if (parser) {
          const before = (
            deps.db().prepare('SELECT COUNT(*) AS n FROM jobs WHERE kind = ? AND paper_id = ?').get('process_paper', paper.id) as { n: number }
          ).n
          const sessionId = sessionIdOfPayload(job.payload) ?? lookupCandidateSessionId(deps.db(), paper.id)
          enqueueProcessJobs(deps.db(), deps.dataDir, [paper.id], parser, sessionId)
          queued =
            (deps.db().prepare('SELECT COUNT(*) AS n FROM jobs WHERE kind = ? AND paper_id = ?').get('process_paper', paper.id) as { n: number }).n > before
          if (queued) deps.drain?.()
        }
        progress(paper.id, queued ? 'parsing' : 'done', queued ? 'PDF 已下载，解析任务已排队' : 'PDF 已下载（解析器未就绪，稍后自动补排）')
        return
      } catch (e) {
        recordPdfAttempt(deps.db(), paper.id, source, 'error', url)
        if (e instanceof NetworkLlmError || e instanceof RetryableLlmError) {
          // 保留 pending，重试仍打这一条；不让后面的内容错误改写类型
          locatedCache.set(job.id, state)
          throw e
        }
        if (e instanceof PdfSourceError || e instanceof BadRequestLlmError) {
          state.sawContentError = true
          if (e instanceof BadRequestLlmError) state.badRequest = e
          state.pending = null
          locatedCache.set(job.id, state)
          continue
        }
        locatedCache.set(job.id, state)
        throw e
      }
    }
  }

  return {
    async runStep(job: JobRow, step: StepName): Promise<void> {
      const paper = getPaper(job)
      try {
        if (step === 'locate') {
          if (paper.has_pdf === 1) return
          const cached = locatedCache.get(job.id)
          if (cached && cached.paperId !== paper.id) {
            locatedCache.delete(job.id)
            noPdfCache.delete(job.id)
          }
          if (noPdfCache.get(job.id) === paper.id) return
          const state = locatedCache.get(job.id)
          if (state?.pending && state.paperId === paper.id) return
          progress(paper.id, 'locating', '正在按来源顺序查找 PDF…')
          await fillPending(job, paper, state?.paperId === paper.id ? state : blankState(paper.id))
          return
        }
        if (step !== 'download') throw new BadRequestLlmError(`candidate_pdf 不支持步骤 ${step}`, 400)

        if (paper.has_pdf === 1) {
          locatedCache.delete(job.id)
          noPdfCache.delete(job.id)
          return
        }
        if (noPdfCache.get(job.id) === paper.id) {
          finishNoPdf(paper)
          return
        }
        let state = locatedCache.get(job.id)
        if (!state || state.paperId !== paper.id) {
          progress(paper.id, 'locating', '正在按来源顺序查找 PDF…')
          state = blankState(paper.id)
          await fillPending(job, paper, state)
          if (!state.pending) {
            if (noPdfCache.get(job.id) === paper.id) finishNoPdf(paper)
            return
          }
        }
        await downloadAll(job, paper, state)
      } catch (e) {
        // 必须修 3：只有 BadRequest 广播 failed。网络/可重试留给 runner，不发 failed。
        if (e instanceof BadRequestLlmError) {
          progress(paper.id, 'failed', e.message)
        }
        throw e
      }
    }
  }
}
