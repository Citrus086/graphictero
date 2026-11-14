import { ipcMain } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC_PDF, resolveFigureByNo, type AnnotationInput, type AnnotationColor, type FigureCropView, type MineruStatusView } from '../../shared/ipc/pdf'
import { getLastParseInfo, getPapersProcessStatus } from '../parser/paperStatus'
import { countWaitingPapers } from '../appService'
import { appMineruModelsDir, measureModelDir } from '../sidecar/modelSize'
import { createAnnotation, deleteAnnotation, listAnnotations, updateAnnotation } from '../reader/annotations'
import { listFigures } from '../reader/figures'
import { resolveFigureCardImage } from '../reader/figureCrop'
import type { AppState, IpcWrap } from './types'

/** 评审必 1：renderer 参数拼路径前的统一校验（IPC 是被攻破渲染进程的唯一边界，
 *  字符串/负数/小数一律拒，防路径穿越读 dataDir 之外的同名文件） */
function requirePaperId(paperId: unknown): number {
  if (!Number.isInteger(paperId) || (paperId as number) <= 0) throw new Error(`论文 ID 不合法（${String(paperId)}）`)
  return paperId as number
}

/** PDF 字节读取前的口径校验：存在且未软删（对齐 createAnnotation） */
function requireExistingPaper(db: AppState['db'], paperId: number): void {
  const row = db.prepare('SELECT id FROM papers WHERE id = ? AND deleted_at IS NULL').get(paperId)
  if (!row) throw new Error(`论文 ${paperId} 不存在或已删除`)
}

/** lane/pdf 车道的 IPC 注册（通道契约在 src/shared/ipc/pdf.ts，只改本文件与契约/preload） */
export function registerPdfIpc(state: AppState, h: IpcWrap): void {
  const status = (): MineruStatusView =>
    state.sidecar?.status() ?? {
      state: 'unavailable',
      version: null,
      port: null,
      pid: null,
      error: null,
      installProgress: null,
      modelsPath: null,
      modelsReady: false
    }

  ipcMain.handle(IPC_PDF.sidecarStatus, h(() => status()))
  ipcMain.handle(IPC_PDF.sidecarStart, h(async () => {
    await state.sidecar?.start()
    return status()
  }))
  // uat1-fix1：安装 / 重试安装并起服务到 ready——走 start()（未安装先 install 再拉服务），
  // 成功终态 ready，只经 ready 事件触发 D95 补排一次（不重开第二条补排路径）
  ipcMain.handle(IPC_PDF.sidecarInstall, h(async () => {
    await state.sidecar?.start()
    return status()
  }))
  ipcMain.handle(IPC_PDF.sidecarStop, h(async () => {
    await state.sidecar?.stop()
    return status()
  }))
  ipcMain.handle(IPC_PDF.sidecarReinstall, h(async () => {
    await state.sidecar?.reinstall()
    return status()
  }))
  // 失败标记数据通路：图谱节点 / 库列表按 id 批量取处理状态与失败原因（D48/D85）
  ipcMain.handle(IPC_PDF.papersStatus, h((_e, paperIds: number[]) => getPapersProcessStatus(state.db, paperIds)))

  // ── 阅读器（D27）：PDF 字节 + 标注 CRUD ──
  // 必 1：paperId 先校验整数正数 + 查 papers 表，再拼路径（防字符串路径穿越）
  ipcMain.handle(IPC_PDF.getDocument, h((_e, paperId: number) => {
    const id = requirePaperId(paperId)
    requireExistingPaper(state.db, id)
    const pdfPath = join(state.dataDir, 'papers', String(id), 'paper.pdf')
    let bytes: Buffer
    try {
      bytes = readFileSync(pdfPath)
    } catch {
      throw new Error(`找不到 PDF 文件（papers/${id}/paper.pdf）`)
    }
    return new Uint8Array(bytes) // IPC 结构化克隆传 TypedArray
  }))
  ipcMain.handle(IPC_PDF.listAnnotations, h((_e, paperId: number) => listAnnotations(state.db, paperId)))
  ipcMain.handle(IPC_PDF.createAnnotation, h((_e, paperId: number, input: AnnotationInput) => createAnnotation(state.db, paperId, input)))
  ipcMain.handle(IPC_PDF.updateAnnotation, h((_e, id: number, patch: { note?: string | null; color?: AnnotationColor }) => updateAnnotation(state.db, id, patch)))
  ipcMain.handle(IPC_PDF.deleteAnnotation, h((_e, id: number) => deleteAnnotation(state.db, id)))
  ipcMain.handle(IPC_PDF.listFigures, h((_e, paperId: number) => listFigures(state.dataDir, requirePaperId(paperId))))
  // D189：多面板并集裁图。非法 paperId 仍抛（与 listFigures 同一边界）；其余失败回 mineru。
  ipcMain.handle(IPC_PDF.figureCrop, h(async (_e, paperId: number, figureNo: number): Promise<FigureCropView> => {
    const id = requirePaperId(paperId)
    const mineru: FigureCropView = { mode: 'mineru', relPath: null }
    if (!Number.isInteger(figureNo) || figureNo < 1) return mineru
    const row = state.db.prepare('SELECT id FROM papers WHERE id = ? AND deleted_at IS NULL').get(id)
    if (!row) return mineru
    try {
      const fig = resolveFigureByNo(listFigures(state.dataDir, id), figureNo)
      if (!fig) return mineru
      const image = await resolveFigureCardImage({
        dataDir: state.dataDir,
        paperId: id,
        figureNo,
        figure: fig
      })
      if (image.mode === 'crop') return { mode: 'crop', relPath: image.relPath }
      return mineru
    } catch {
      return mineru
    }
  }))
  // 设置页「最近一次解析」（只读）
  ipcMain.handle(IPC_PDF.lastParse, h(() => getLastParseInfo(state.db)))
  ipcMain.handle(IPC_PDF.modelSize, h(() => measureModelDir(appMineruModelsDir(state.dataDir))))
  // uat1b D144：等待解析组件的论文数（顶栏弹层「解析组件不可用 · 影响 N 篇」的 N）
  ipcMain.handle(IPC_PDF.waitingCount, h(() => countWaitingPapers(state.db)))
}
