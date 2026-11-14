import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { IPC_PDF } from '../../shared/ipc/pdf'
import * as svc from '../appService'
import { UnavailableParser } from '../jobs/mineru'
import type { AppState, IpcWrap } from './types'

/** uat2：向所有窗口广播（同 main/index.ts broadcast 口径） */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/** Zotero（D26/D61/D62/D75/D82）：Local API 优先，403/未运行走 sqlite 副本兜底 */
export function registerZoteroIpc(state: AppState, h: IpcWrap): void {
  ipcMain.handle(IPC.zoteroStatus, h(() => svc.probeZoteroStatus()))
  ipcMain.handle(IPC.zoteroDisplay, h(() => svc.zoteroDisplayStatus()))
  ipcMain.handle(IPC.zoteroListCollections, h(() => svc.listZoteroCollections()))
  // uat13（D207-③）：分类内条目预览（只读；Local API 优先，sqlite 副本兜底，与导入同探测）
  // uat14（D209）：带本机库 db，按 Zotero key 标「已导入」
  ipcMain.handle(IPC.zoteroCollectionItems, h((_e, collectionKey: string) => svc.listZoteroCollectionItems(collectionKey, {}, state.db)))
  ipcMain.handle(IPC.zoteroImport, async (event, collectionKey: string, graphId: number) => {
    const sender = event.sender
    const summary = await svc.importZoteroCollection(state.db, state.dataDir, graphId, collectionKey, (p) => {
      if (!sender.isDestroyed()) sender.send(IPC.eventZoteroImportProgress, p)
    }, {}, state.parser ?? new UnavailableParser(), // D95：无解析器按「不可用」处理，不入队
    // uat2：重新导入补齐 PDF → 广播 event:pdf:libraryChanged，图谱/论文库即时刷新
    (pdfAddedIds) => broadcast(IPC_PDF.eventLibraryChanged, { pdfAddedIds }))
    void state.runner?.drain() // 导入即后台处理（D35/D67）
    return summary
  })
  // uat14（D209）：只导入所选 item keys（与整分类导入同款编排：来源探测/去重/进度/PDF/入图谱）
  ipcMain.handle(IPC.zoteroImportItems, async (event, collectionKey: string, itemKeys: string[], graphId: number) => {
    const sender = event.sender
    const summary = await svc.importZoteroItemsByKeys(state.db, state.dataDir, graphId, collectionKey, itemKeys, (p) => {
      if (!sender.isDestroyed()) sender.send(IPC.eventZoteroImportProgress, p)
    }, {}, state.parser ?? new UnavailableParser(), // D95：无解析器按「不可用」处理，不入队
    (pdfAddedIds) => broadcast(IPC_PDF.eventLibraryChanged, { pdfAddedIds }))
    void state.runner?.drain() // 导入即后台处理（D35/D67）
    return summary
  })
}
