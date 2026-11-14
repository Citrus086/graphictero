import { ipcRenderer } from 'electron'
import type {
  RelApi,
  RefsFetchView,
  RelatedCandidateView,
  RelGenerateProgress,
  RelationDetailView,
  RelationRestoreInput,
  RelStatusView,
  UndoGraphRemovalInput,
  UndoGraphRemovalResult
} from '../../shared/ipc/relations'
import { IPC_REL } from '../../shared/ipc/relations'

/**
 * lane/relations 车道的 preload 片段。
 *
 * REL 车道新增暴露给渲染进程的方法时：通道名与类型加在 src/shared/ipc/relations.ts
 * （IPC_REL / RelApi），这里用 ipcRenderer.invoke(IPC_REL.xxx, args) 实现并加进
 * relApi；不改 src/preload/index.ts。事件（进度推送）用 on/off 封装并返回取消
 * 订阅函数（对齐 core.ts 的 onZoteroImportProgress 口径）。
 */
export const relApi: RelApi = {
  generateRelations: (graphId: number, paperIds?: number[]) =>
    ipcRenderer.invoke(IPC_REL.generate, graphId, paperIds) as Promise<number>,
  regenerateRelations: (graphId: number) => ipcRenderer.invoke(IPC_REL.regenerate, graphId) as Promise<number>,
  relationsStatus: (graphId: number) => ipcRenderer.invoke(IPC_REL.status, graphId) as Promise<RelStatusView>,
  findRelated: (graphId: number, paperId: number) =>
    ipcRenderer.invoke(IPC_REL.findRelated, graphId, paperId) as Promise<RelatedCandidateView[]>,
  fetchReferences: (paperId: number) => ipcRenderer.invoke(IPC_REL.fetchReferences, paperId) as Promise<RefsFetchView>,
  restoreRelation: (input: RelationRestoreInput) => ipcRenderer.invoke(IPC_REL.restore, input) as Promise<number>,
  restoreRelationSnapshot: (snapshotId: number) => ipcRenderer.invoke(IPC_REL.restoreSnapshot, snapshotId) as Promise<number>,
  restorePaperProgress: (graphId: number, paperId: number, doneAt?: string) =>
    ipcRenderer.invoke(IPC_REL.restoreProgress, graphId, paperId, doneAt) as Promise<void>,
  restoreRemovedPaper: (graphId: number, paperId: number, meta: { addedAt: string; doneAt: string | null }) =>
    ipcRenderer.invoke(IPC_REL.restoreRemovedPaper, graphId, paperId, meta) as Promise<void>,
  restoreGraphUpdatedAt: (graphId: number, updatedAt: string) =>
    ipcRenderer.invoke(IPC_REL.restoreGraphUpdatedAt, graphId, updatedAt) as Promise<void>,
  undoGraphRemoval: (input: UndoGraphRemovalInput) =>
    ipcRenderer.invoke(IPC_REL.undoGraphRemoval, input) as Promise<UndoGraphRemovalResult>,
  relationDetail: (relationId: number) => ipcRenderer.invoke(IPC_REL.detail, relationId) as Promise<RelationDetailView>,
  onGenerateProgress: (cb: (p: RelGenerateProgress) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, p: RelGenerateProgress): void => cb(p)
    ipcRenderer.on(IPC_REL.eventGenerateProgress, listener)
    return () => {
      ipcRenderer.removeListener(IPC_REL.eventGenerateProgress, listener)
    }
  }
}
