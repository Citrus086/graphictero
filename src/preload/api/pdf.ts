import { ipcRenderer } from 'electron'
import {
  IPC_PDF,
  type AnnotationColor,
  type AnnotationInput,
  type LibraryChangedEvent,
  type MineruStatusView,
  type ParseProgressEvent,
  type PdfApi
} from '../../shared/ipc/pdf'

/** lane/pdf 车道的 preload 片段（对齐 core.ts 的 on/off 封装口径，返回取消订阅函数） */
export const pdfApi: PdfApi = {
  getMineruStatus: () => ipcRenderer.invoke(IPC_PDF.sidecarStatus),
  startMineru: () => ipcRenderer.invoke(IPC_PDF.sidecarStart),
  installMineru: () => ipcRenderer.invoke(IPC_PDF.sidecarInstall),
  stopMineru: () => ipcRenderer.invoke(IPC_PDF.sidecarStop),
  reinstallMineru: () => ipcRenderer.invoke(IPC_PDF.sidecarReinstall),
  getPapersStatus: (paperIds) => ipcRenderer.invoke(IPC_PDF.papersStatus, paperIds),
  getPdfDocument: (paperId) => ipcRenderer.invoke(IPC_PDF.getDocument, paperId),
  listAnnotations: (paperId) => ipcRenderer.invoke(IPC_PDF.listAnnotations, paperId),
  createAnnotation: (paperId, input: AnnotationInput) => ipcRenderer.invoke(IPC_PDF.createAnnotation, paperId, input),
  updateAnnotation: (id, patch: { note?: string | null; color?: AnnotationColor }) =>
    ipcRenderer.invoke(IPC_PDF.updateAnnotation, id, patch),
  deleteAnnotation: (id) => ipcRenderer.invoke(IPC_PDF.deleteAnnotation, id),
  listFigures: (paperId) => ipcRenderer.invoke(IPC_PDF.listFigures, paperId),
  getFigureCrop: (paperId, figureNo) => ipcRenderer.invoke(IPC_PDF.figureCrop, paperId, figureNo),
  getLastParse: () => ipcRenderer.invoke(IPC_PDF.lastParse),
  getModelDirSize: () => ipcRenderer.invoke(IPC_PDF.modelSize),
  getWaitingCount: () => ipcRenderer.invoke(IPC_PDF.waitingCount),
  onMineruStatus: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, s: MineruStatusView): void => cb(s)
    ipcRenderer.on(IPC_PDF.eventSidecar, listener)
    return () => ipcRenderer.removeListener(IPC_PDF.eventSidecar, listener)
  },
  onParseProgress: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, p: ParseProgressEvent): void => cb(p)
    ipcRenderer.on(IPC_PDF.eventParseProgress, listener)
    return () => ipcRenderer.removeListener(IPC_PDF.eventParseProgress, listener)
  },
  onLibraryChanged: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, e: LibraryChangedEvent): void => cb(e)
    ipcRenderer.on(IPC_PDF.eventLibraryChanged, listener)
    return () => ipcRenderer.removeListener(IPC_PDF.eventLibraryChanged, listener)
  }
}