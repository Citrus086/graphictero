import { ipcMain, BrowserWindow } from 'electron'
import {
  IPC_CAND,
  AttachPdfInputSchema,
  ImportConfirmInputSchema,
  PdfAttemptsInputSchema,
  RetryFindPdfInputSchema,
  PdfSourcesSchema,
  type CandProgressEvent,
  type PdfSources
} from '../../shared/ipc/cand'
import { confirmCandidate } from '../agent/candidates'
import { createCandidatePdfExecutor } from '../jobs/candidatePdf'
import { enqueueJob } from '../jobs/store'
import { enqueueProcessJobs } from '../appService'
import { lookupCandidateSessionId } from '../jobs/sessionAttr'
import { getPdfSources, setPdfSources } from '../pdfsource/settings'
import { listPdfAttempts } from '../pdfsource/attempts'
import { attachUserPdf } from '../pdfsource/userDrop'
import type { RunnerDeps } from '../jobs/runner'
import type { AppState, IpcWrap } from './types'

/**
 * M6 lane/fetch 批 1：cand:* IPC 实装（替换预备提交「未实现」骨架；D124/D130/D131/D133）。
 *
 * - importConfirm：库外候选确认 → confirmCandidate（importer 真入库 + 排 candidate_pdf）
 *   → 立即返回 { paperId, jobId }，后续进度走 event:cand:progress；
 * - retryFindPdf / attachPdf：03e「再试一次查找」（D133，含 Zotero 导入的无 PDF 论文）
 *   与拖入复制（pdfsource/userDrop.ts 校验 %PDF- 头 / 50MB）；
 * - pdfAttempts：063 表的来源尝试记录（D65(6)）；
 * - get/setPdfSources：app_settings kv（默认只开开放获取，D54/D131）。
 *
 * 执行器接线：RunnerDeps.candidatePdf 注入点在 runner.ts（冻结）。合并时由维护者
 * 在 index.ts createRunner 里 `candidatePdf: createCandidatePdfExecutor({...})`；本条
 * 车道在首次用到时做等价惰性自接线（直接写 runner 实例的 deps 引用——JobRunner 每步
 * 运行时惰性读取 deps.candidatePdf，等价于构造期注入），维护者接线后此处自动空转。
 */

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function registerCandIpc(state: AppState, h: IpcWrap): void {
  const progress = (e: CandProgressEvent): void => broadcast(IPC_CAND.eventProgress, e)

  const ensureExecutor = (): void => {
    const runner = state.runner as unknown as { deps?: RunnerDeps } | null | undefined
    if (!runner?.deps || runner.deps.candidatePdf) return // 已接线（维护者）或无机可注
    runner.deps.candidatePdf = createCandidatePdfExecutor({
      db: () => state.db,
      dataDir: state.dataDir,
      parser: () => state.parser,
      onProgress: progress,
      drain: () => void state.runner?.drain()
    })
  }

  const paperHasPdf = (paperId: number): boolean =>
    (state.db.prepare('SELECT has_pdf FROM papers WHERE id = ? AND deleted_at IS NULL').get(paperId) as { has_pdf: number } | undefined)
      ?.has_pdf === 1

  ipcMain.handle(IPC_CAND.importConfirm, h((_e, input: unknown) => {
    const { candidateId } = ImportConfirmInputSchema.parse(input)
    ensureExecutor()
    const row = state.db
      .prepare('SELECT id, graph_id, paper_id FROM graph_candidates WHERE id = ?')
      .get(candidateId) as { id: number; graph_id: number; paper_id: number | null } | undefined
    if (!row) throw new Error(`候选 ${candidateId} 不存在`)
    const paperId0 = row.paper_id
    if (paperId0 != null) progress({ candidateId, paperId: paperId0, phase: 'importing', message: '候选已入库，正在加入图谱…' })
    const result = confirmCandidate(state.db, candidateId)
    const paperId = result.candidate.paperId ?? result.addedPaperId
    if (paperId == null) throw new Error('候选入库失败：未取得论文 id')
    if (paperId0 == null) progress({ candidateId, paperId, phase: 'importing', message: '已写入论文库并加入图谱' })
    if (result.jobId != null) progress({ candidateId, paperId, phase: 'locating', message: 'PDF 查找任务已排队' })
    return { paperId, jobId: result.jobId ?? 0 } // jobId=0：论文已有 PDF，未排任务
  }))

  ipcMain.handle(IPC_CAND.retryFindPdf, h((_e, input: unknown) => {
    const { paperId } = RetryFindPdfInputSchema.parse(input)
    const paper = state.db.prepare('SELECT id FROM papers WHERE id = ? AND deleted_at IS NULL').get(paperId)
    if (!paper) throw new Error(`论文 ${paperId} 不存在或已删除`)
    ensureExecutor()
    if (paperHasPdf(paperId)) return // 已有 PDF：重试是幂等空操作
    const sessionId = lookupCandidateSessionId(state.db, paperId)
    enqueueJob(state.db, 'candidate_pdf', { paperId, payload: sessionId != null ? { sessionId } : {} })
    const cand = state.db
      .prepare('SELECT id FROM graph_candidates WHERE paper_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1')
      .get(paperId) as { id: number } | undefined
    progress({
      ...(cand ? { candidateId: cand.id } : {}),
      paperId,
      phase: 'locating',
      message: '正在按当前来源顺序重新查找…'
    })
    void state.runner?.drain()
  }))

  ipcMain.handle(IPC_CAND.attachPdf, h((_e, input: unknown) => {
    const { paperId, filePath } = AttachPdfInputSchema.parse(input)
    ensureExecutor()
    attachUserPdf(state.db, state.dataDir, paperId, filePath)
    const parser = state.parser
    const sessionId = lookupCandidateSessionId(state.db, paperId)
    const queued = parser ? enqueueProcessJobs(state.db, state.dataDir, [paperId], parser, sessionId).length > 0 : false
    const cand = state.db
      .prepare('SELECT id FROM graph_candidates WHERE paper_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1')
      .get(paperId) as { id: number } | undefined
    progress({
      ...(cand ? { candidateId: cand.id } : {}),
      paperId,
      phase: queued ? 'parsing' : 'done',
      message: queued ? 'PDF 已复制，解析任务已排队' : 'PDF 已复制进数据目录'
    })
    if (queued) void state.runner?.drain()
  }))

  ipcMain.handle(IPC_CAND.pdfAttempts, h((_e, input: unknown) => {
    const { paperId } = PdfAttemptsInputSchema.parse(input)
    return listPdfAttempts(state.db, paperId)
  }))

  ipcMain.handle(IPC_CAND.getPdfSources, h((): PdfSources => getPdfSources(state.db, state.dataDir)))

  ipcMain.handle(IPC_CAND.setPdfSources, h((_e, input: unknown) => {
    const parsed = PdfSourcesSchema.parse(input)
    setPdfSources(state.db, parsed)
  }))

  // 注册结束就接线一次。启动后的 drain、以及 agent:candidateConfirm 直接入队，
  // 都走得到执行器。维护者已在 createRunner 注入时，上面的守卫直接返回。
  ensureExecutor()
}
