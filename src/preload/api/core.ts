import { ipcRenderer } from 'electron'
import { IPC, type CoreApi, type ImportProgress, type ThemeView } from '../../shared/ipc'

/** 核心方法的 preload 片段（原 src/preload/index.ts 的内联实现，M1 第三批起） */
export const coreApi: CoreApi = {
  listGraphs: () => ipcRenderer.invoke(IPC.graphsList),
  createGraph: (name) => ipcRenderer.invoke(IPC.graphsCreate, name),
  getGraph: (id) => ipcRenderer.invoke(IPC.graphGet, id),
  listLibrary: (graphId) => ipcRenderer.invoke(IPC.libraryList, graphId),
  deletePaperFromLibrary: (paperId) => ipcRenderer.invoke(IPC.libraryDeletePaper, paperId),
  searchSidebar: (graphId, query) => ipcRenderer.invoke(IPC.librarySearchSidebar, graphId, query),
  paperRelationStats: (paperId) => ipcRenderer.invoke(IPC.libraryPaperRelationStats, paperId),
  addPapersToGraph: (graphId, paperIds) => ipcRenderer.invoke(IPC.graphAddPapers, graphId, paperIds),
  removePaperFromGraph: (graphId, paperId) => ipcRenderer.invoke(IPC.graphRemovePaper, graphId, paperId),
  setNodePosition: (graphId, paperId, x, y) => ipcRenderer.invoke(IPC.graphSetPosition, graphId, paperId, x, y),
  createRelation: (input) => ipcRenderer.invoke(IPC.relationCreate, input),
  deleteRelation: (id) => ipcRenderer.invoke(IPC.relationDelete, id),
  getDataInfo: () => ipcRenderer.invoke(IPC.dataInfo),
  chooseDataRoot: () => ipcRenderer.invoke(IPC.dataChooseRoot),
  exportBackup: () => ipcRenderer.invoke(IPC.dataExportBackup),
  restoreBackup: () => ipcRenderer.invoke(IPC.dataRestoreBackup),
  getZoteroStatus: () => ipcRenderer.invoke(IPC.zoteroStatus),
  listZoteroCollections: () => ipcRenderer.invoke(IPC.zoteroListCollections),
  // uat13（D207-③）：分类内条目预览（只读）
  listZoteroCollectionItems: (collectionKey) => ipcRenderer.invoke(IPC.zoteroCollectionItems, collectionKey),
  importZoteroCollection: (collectionKey, graphId) =>
    ipcRenderer.invoke(IPC.zoteroImport, collectionKey, graphId),
  // uat14（D209）：只导入分类内所选条目
  importZoteroItems: (collectionKey, itemKeys, graphId) =>
    ipcRenderer.invoke(IPC.zoteroImportItems, collectionKey, itemKeys, graphId),
  onZoteroImportProgress: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, p: ImportProgress): void => cb(p)
    ipcRenderer.on(IPC.eventZoteroImportProgress, listener)
    return () => ipcRenderer.removeListener(IPC.eventZoteroImportProgress, listener)
  },
  // M2 第一批：LLM 设置 / 用量 / 任务
  getLlmSettings: () => ipcRenderer.invoke(IPC.settingsGetLlm),
  setLlmSettings: (provider, model) => ipcRenderer.invoke(IPC.settingsSetLlm, provider, model),
  setApiKey: (key) => ipcRenderer.invoke(IPC.settingsSetApiKey, key),
  clearApiKey: () => ipcRenderer.invoke(IPC.settingsClearApiKey),
  testLlmConnection: () => ipcRenderer.invoke(IPC.settingsTestLlm),
  getOpenAlexKey: () => ipcRenderer.invoke(IPC.settingsGetOpenAlex),
  setOpenAlexKey: (key) => ipcRenderer.invoke(IPC.settingsSetOpenAlexKey, key),
  clearOpenAlexKey: () => ipcRenderer.invoke(IPC.settingsClearOpenAlexKey),
  testOpenAlex: () => ipcRenderer.invoke(IPC.settingsTestOpenAlex),
  getTheme: () => ipcRenderer.invoke(IPC.settingsGetTheme),
  setTheme: (pref) => ipcRenderer.invoke(IPC.settingsSetTheme, pref),
  onTheme: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, view: ThemeView): void => cb(view)
    ipcRenderer.on(IPC.eventTheme, listener)
    return () => ipcRenderer.removeListener(IPC.eventTheme, listener)
  },
  getAppVersion: () => ipcRenderer.invoke(IPC.appVersion),
  getLastSnapshot: () => ipcRenderer.invoke(IPC.dataLastSnapshot),
  getLastImport: () => ipcRenderer.invoke(IPC.dataLastImport),
  getZoteroDisplay: () => ipcRenderer.invoke(IPC.zoteroDisplay),
  getUsageSummary: (month?: string) => ipcRenderer.invoke(IPC.settingsUsageSummary, month),
  getUsageSeries: (input) => ipcRenderer.invoke(IPC.settingsUsageSeries, input),
  getUsageBySession: (input) => ipcRenderer.invoke(IPC.settingsUsageBySession, input),
  getUsageByPeriod: (input) => ipcRenderer.invoke(IPC.settingsUsageByPeriod, input),
  getRecentUsage: (input) => ipcRenderer.invoke(IPC.settingsUsageRecent, input),
  getBalance: () => ipcRenderer.invoke(IPC.settingsBalance),
  getJobsOverview: () => ipcRenderer.invoke(IPC.jobsOverview),
  retryJob: (jobId) => ipcRenderer.invoke(IPC.jobsRetry, jobId),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url)
}
