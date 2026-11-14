import { ipcRenderer } from 'electron'
import type {
  AttachPdfInput,
  CandApi,
  CandProgressEvent,
  ImportConfirmInput,
  ImportConfirmView,
  PdfAttemptsInput,
  PdfAttemptView,
  PdfSources,
  RetryFindPdfInput
} from '../../shared/ipc/cand'
import { IPC_CAND } from '../../shared/ipc/cand'

/**
 * M6 lane/fetch 的 preload 片段（预备提交骨架，实装归车道批 1；通道/签名冻结）。
 */

export const candApi: CandApi = {
  importConfirm: (input: ImportConfirmInput) => ipcRenderer.invoke(IPC_CAND.importConfirm, input) as Promise<ImportConfirmView>,
  retryFindPdf: (input: RetryFindPdfInput) => ipcRenderer.invoke(IPC_CAND.retryFindPdf, input) as Promise<void>,
  attachPdf: (input: AttachPdfInput) => ipcRenderer.invoke(IPC_CAND.attachPdf, input) as Promise<void>,
  pdfAttempts: (input: PdfAttemptsInput) => ipcRenderer.invoke(IPC_CAND.pdfAttempts, input) as Promise<PdfAttemptView[]>,
  getPdfSources: () => ipcRenderer.invoke(IPC_CAND.getPdfSources) as Promise<PdfSources>,
  setPdfSources: (input: PdfSources) => ipcRenderer.invoke(IPC_CAND.setPdfSources, input) as Promise<void>,
  onCandProgress: (cb: (e: CandProgressEvent) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, p: CandProgressEvent): void => cb(p)
    ipcRenderer.on(IPC_CAND.eventProgress, listener)
    return () => {
      ipcRenderer.removeListener(IPC_CAND.eventProgress, listener)
    }
  }
}
