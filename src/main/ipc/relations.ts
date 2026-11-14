import { ipcMain, BrowserWindow, net } from 'electron'
import { IPC_REL, type RefsFetchView, type RelStatusView, type RelationDetailView, type RelationRestoreInput, type UndoGraphRemovalInput } from '../../shared/ipc/relations'
import { RelationGenEngine } from '../relations/engine'
import { restoreRelation, relationDetail } from '../relations/restore'
import { restoreSnapshot } from '../relations/snapshots'
import { fetchReferencesView } from '../relations/refsFetch'
import { processedPaperIds, restorePaperProgress, restoreRemovedPaper, restoreGraphUpdatedAt } from '../relations/progress'
import { undoGraphRemoval } from '../relations/undoRemoval'
import { findRelatedPapers } from '../relations/generator'
import { readOpenAlexSettings } from '../openalex/env'
import { createOpenAlexClient } from '../openalex/client'
import { bumpOpenAlexDailyCount } from '../openalex/search'
import { getLlmSettings, readApiKey, providerBaseUrl } from '../llm/config'
import { MissingKeyError } from '../llm/errors'
import type { LlmClientDeps } from '../llm/client'
import type { AppState, IpcWrap } from './types'

/**
 * lane/relations 车道的 IPC 注册模块。
 *
 * 注册 rel:* 通道；关系生成任务由本车道自带的 RelationGenEngine 执行
 * （runner.ts 不在本车道名单，relation_gen 未收编进 JobRunner，见引擎文件头
 * 注释）。进度经 event:rel:generateProgress 推给全部窗口。
 * handler 一律经 h 包装（参数透传，评审必须修 1 的口径）。
 * 返回引擎实例句柄：合并回 main 时维护者接线
 * `startRelationsBackground({ db: () => state.db, engine })` 直接用返回值（评审报告
 * 「startRelationsBackground 与合并接线清单」第 2 条）。
 */

export function registerRelationsIpc(state: AppState, h: IpcWrap): RelationGenEngine {
  const llm = (): LlmClientDeps => {
    const s = getLlmSettings(state.db, state.dataDir)
    const key = readApiKey(state.dataDir, s.provider)
    if (!key) throw new MissingKeyError()
    return { baseUrl: providerBaseUrl(s.provider), apiKey: key, model: s.model }
  }

  const engine = new RelationGenEngine({
    db: () => state.db,
    dataDir: state.dataDir,
    llm,
    openAlex: () => {
      const s = readOpenAlexSettings(state.dataDir)
      return createOpenAlexClient({
        apiKey: s.apiKey,
        mailto: s.mailto,
        onBillable: () => bumpOpenAlexDailyCount(state.db)
      })
    },
    // 评审建议修（rel3）3：配置指纹变化（改 mailto / 加 OpenAlex Key）时引擎重建客户端
    openAlexFingerprint: () => JSON.stringify(readOpenAlexSettings(state.dataDir)),
    hasLlmKey: () => {
      try {
        const s = getLlmSettings(state.db, state.dataDir)
        return readApiKey(state.dataDir, s.provider) != null
      } catch {
        return false
      }
    },
    isOnline: () => net.isOnline(), // D70：离线判定（electron net，与 runner 同口径）
    onProgress: (p) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC_REL.eventGenerateProgress, p)
      }
    }
  })

  ipcMain.handle(IPC_REL.generate, h((_e, graphId: number, paperIds?: number[]) => engine.enqueue(graphId, paperIds)))
  ipcMain.handle(IPC_REL.regenerate, h((_e, graphId: number) => engine.enqueueRegenerate(graphId)))
  ipcMain.handle(IPC_REL.restore, h((_e, input: RelationRestoreInput) => restoreRelation(state.db, input)))
  ipcMain.handle(IPC_REL.restoreSnapshot, h((_e, snapshotId: number) => restoreSnapshot(state.db, snapshotId)))
  // uat2-fix1 必须修 3：D148 撤销「从图谱移除」恢复进度行（仅当原来有，渲染层凭 hadProgress 调）
  // uat7b S1：可带原 doneAt，恢复成移除前的值（渲染层从 removePaperFromGraph 的返回值取）
  ipcMain.handle(IPC_REL.restoreProgress, h((_e, graphId: number, paperId: number, doneAt?: string) => restorePaperProgress(state.db, graphId, paperId, doneAt)))
  // uat7b S1：撤销恢复成员原 added_at + 进度原 doneAt（无进度行不插）
  ipcMain.handle(IPC_REL.restoreRemovedPaper, h((_e, graphId: number, paperId: number, meta: { addedAt: string; doneAt: string | null }) => restoreRemovedPaper(state.db, graphId, paperId, meta)))
  // uat7b S1：撤销一批后把 graphs.updated_at 写回移除前原值
  ipcMain.handle(IPC_REL.restoreGraphUpdatedAt, h((_e, graphId: number, updatedAt: string) => restoreGraphUpdatedAt(state.db, graphId, updatedAt)))
  // uat8b B5：一次撤销「从图谱移除」；已软删论文跳过，全跳过不写 graphs.updated_at
  ipcMain.handle(IPC_REL.undoGraphRemoval, h((_e, input: UndoGraphRemovalInput) => undoGraphRemoval(state.db, input)))
  ipcMain.handle(IPC_REL.detail, h((_e, relationId: number): RelationDetailView => relationDetail(state.db, relationId)))
  ipcMain.handle(IPC_REL.status, h((_e, graphId: number): RelStatusView => {
    const active = state.db
      .prepare(
        `SELECT id, status, current_step, error FROM jobs
         WHERE kind = 'relation_gen' AND graph_id = ? AND status IN ('queued','running','waiting_network','waiting_key')
         ORDER BY id DESC LIMIT 1`
      )
      .get(graphId) as { id: number; status: string; current_step: string | null; error: string | null } | undefined
    const total = (
      state.db
        .prepare(
          `SELECT COUNT(*) AS n FROM graph_members m JOIN papers p ON p.id = m.paper_id
           WHERE m.graph_id = ? AND p.deleted_at IS NULL AND p.has_pdf = 1`
        )
        .get(graphId) as { n: number }
    ).n
    return {
      running: active != null,
      activeJob: active ? { id: active.id, status: active.status, currentStep: active.current_step, error: active.error } : null,
      processedCount: processedPaperIds(state.db, graphId).size,
      totalCount: total
    }
  }))

  ipcMain.handle(IPC_REL.findRelated, h((_e, graphId: number, paperId: number) => findRelatedPapers(state.db, graphId, paperId)))

  ipcMain.handle(IPC_REL.fetchReferences, h(async (_e, paperId: number): Promise<RefsFetchView> => {
    const s = readOpenAlexSettings(state.dataDir)
    const client = createOpenAlexClient({
      apiKey: s.apiKey,
      mailto: s.mailto,
      onBillable: () => bumpOpenAlexDailyCount(state.db)
    })
    return fetchReferencesView({ db: state.db, dataDir: state.dataDir, paperId, client, llm })
  }))

  return engine
}
