import { ipcMain, shell } from 'electron'
import { IPC, type RelationInput } from '../../shared/ipc'
import * as svc from '../appService'
import { searchSidebar } from '../librarySearch'
import { removeFigureCropCache } from '../reader/figureCrop'
import type { AppState, IpcWrap } from './types'

/** 图谱 / 论文库 / 手工关系（M1 第三批起的接线；业务逻辑在 appService.ts） */
export function registerCoreIpc(state: AppState, h: IpcWrap): void {
  ipcMain.handle(IPC.graphsList, h(() => svc.listGraphs(state.db)))
  ipcMain.handle(IPC.graphsCreate, h((_e, name: string) => svc.createGraph(state.db, name)))
  ipcMain.handle(IPC.graphGet, h((_e, id: number) => svc.getGraphDetail(state.db, id)))
  ipcMain.handle(IPC.libraryList, h((_e, graphId?: number) => svc.listLibrary(state.db, graphId)))
  ipcMain.handle(IPC.libraryDeletePaper, h((_e, paperId: number) => {
    svc.softDeletePaper(state.db, paperId)
    // D189：裁图缓存按论文清掉。清理失败不挡软删（removeFigureCropCache 自己吞掉）。
    removeFigureCropCache(state.dataDir, paperId)
  }))
  ipcMain.handle(IPC.librarySearchSidebar, h((_e, graphId: number, query: string) => searchSidebar(state.db, graphId, query)))
  ipcMain.handle(IPC.libraryPaperRelationStats, h((_e, paperId: number) => svc.paperRelationStats(state.db, paperId)))
  ipcMain.handle(IPC.graphAddPapers, h((_e, graphId: number, paperIds: number[]) => svc.addPapersToGraph(state.db, graphId, paperIds)))
  ipcMain.handle(IPC.graphRemovePaper, h((_e, graphId: number, paperId: number) => svc.removePaperFromGraph(state.db, graphId, paperId)))
  ipcMain.handle(IPC.graphSetPosition, h((_e, graphId: number, paperId: number, x: number, y: number) => svc.setNodePosition(state.db, graphId, paperId, x, y)))
  ipcMain.handle(IPC.relationCreate, h((_e, input: RelationInput) => svc.createRelation(state.db, input)))
  ipcMain.handle(IPC.relationDelete, h((_e, id: number) => svc.deleteRelationById(state.db, id)))
  ipcMain.handle(
    IPC.openExternal,
    h(async (_e, raw: unknown) => {
      if (typeof raw !== 'string') throw new Error('链接无效')
      let url: URL
      try {
        url = new URL(raw)
      } catch {
        throw new Error('链接无效')
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只打开 http 或 https 链接')
      await shell.openExternal(url.toString())
    })
  )
}
