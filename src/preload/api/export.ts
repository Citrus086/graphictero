import { ipcRenderer } from 'electron'
import type { ExportApi, ExportOptions } from '../../shared/ipc/export'
import { IPC_EXPORT } from '../../shared/ipc/export'

/**
 * M6 lane/fetch 的 preload 片段（预备提交骨架，实装归车道批 2；通道/签名冻结）。
 */

export const exportApi: ExportApi = {
  preview: (options: ExportOptions) => ipcRenderer.invoke(IPC_EXPORT.preview, options) as Promise<string>,
  save: (options: ExportOptions) => ipcRenderer.invoke(IPC_EXPORT.save, options) as Promise<string | null>,
  overview: (options: ExportOptions) =>
    ipcRenderer.invoke(IPC_EXPORT.overview, options) as Promise<{ text: string; cached: boolean }>,
  peekOverview: (graphId: number) =>
    ipcRenderer.invoke(IPC_EXPORT.peekOverview, graphId) as Promise<{ cached: boolean }>
}
