import { ipcRenderer } from 'electron'
import type { DetailApi, DetailView, PaperMetaView } from '../../shared/ipc/detail'
import { IPC_DETAIL } from '../../shared/ipc/detail'

/**
 * lane/detail 车道的 preload 片段（M4）。
 * 新方法：通道与类型加在 src/shared/ipc/detail.ts，这里 invoke 实现；不改 src/preload/index.ts。
 */
export const detailApi: DetailApi = {
  getDetail: (paperId: number) => ipcRenderer.invoke(IPC_DETAIL.get, paperId) as Promise<DetailView | null>,
  getPaperMeta: (paperId: number) => ipcRenderer.invoke(IPC_DETAIL.getMeta, paperId) as Promise<PaperMetaView | null>,
  regenerateDetail: (paperId: number) => ipcRenderer.invoke(IPC_DETAIL.regenerate, paperId) as Promise<number>,
  onDetailUpdated: (cb: (paperId: number) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, paperId: number): void => cb(paperId)
    ipcRenderer.on(IPC_DETAIL.eventUpdated, listener)
    return () => {
      ipcRenderer.removeListener(IPC_DETAIL.eventUpdated, listener)
    }
  }
}
