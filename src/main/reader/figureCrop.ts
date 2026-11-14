import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { figureNormUnion, type FigureView } from '../../shared/ipc/pdf'
import {
  figureCropCachePayload,
  figureCropRelPath,
  isMultiPanelFigure
} from '../../shared/figureCrop'
import type { PdfCropRequest } from './pdfiumCrop'

/**
 * uat8a D189：多面板图卡按并集从 PDF 裁出整张图，缓存到
 * `<dataDir>/cache/figure-crops/<paperId>/<figureNo>-<hash>.png`。
 * 单面板、PDF 缺失、渲染失败都返回 mineru，由渲染层继续用编号块自己的裁图。
 */

export interface PdfRectRenderer {
  renderCrop(input: PdfCropRequest): Promise<Uint8Array>
}

export type FigureCardImage = { mode: 'mineru' } | { mode: 'crop'; relPath: string }

const inflight = new Map<string, Promise<Uint8Array>>()

export function figureCropHash(payload: string): string {
  return createHash('sha256').update(payload).digest('hex').slice(0, 20)
}

export function removeFigureCropCache(dataDir: string, paperId: unknown): void {
  if (typeof paperId !== 'number' || !Number.isInteger(paperId) || paperId <= 0) return
  if (!dataDir) return
  try {
    rmSync(join(dataDir, 'cache', 'figure-crops', String(paperId)), { recursive: true, force: true })
  } catch {
    // 目录被占用或权限问题时不挡软删
  }
}

function pdfStamp(pdfPath: string): string | null {
  try {
    const st = statSync(pdfPath)
    if (!st.isFile() || st.size <= 0) return null
    return `${st.size}:${Math.round(st.mtimeMs)}`
  } catch {
    return null
  }
}

function isCachedPng(abs: string): boolean {
  let fd = -1
  try {
    const st = statSync(abs)
    if (!st.isFile() || st.size < 32) return false
    fd = openSync(abs, 'r')
    const buf = Buffer.alloc(8)
    if (readSync(fd, buf, 0, 8, 0) < 8) return false
    return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  } catch {
    return false
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

async function defaultRenderCrop(input: PdfCropRequest): Promise<Uint8Array> {
  const { pdfiumRenderCrop } = await import('./pdfiumCrop')
  return pdfiumRenderCrop(input)
}

function absFromRel(dataDir: string, relPath: string): string {
  return join(dataDir, ...relPath.split('/'))
}

export async function resolveFigureCardImage(input: {
  dataDir: string
  paperId: number
  figureNo: number
  figure: Pick<FigureView, 'bbox' | 'subBboxes' | 'subCaptionBboxes' | 'page'>
  renderer?: PdfRectRenderer
}): Promise<FigureCardImage> {
  if (!isMultiPanelFigure(input.figure)) return { mode: 'mineru' }
  if (!Number.isInteger(input.paperId) || input.paperId <= 0) return { mode: 'mineru' }
  if (!Number.isInteger(input.figureNo) || input.figureNo < 1) return { mode: 'mineru' }

  const pdfPath = join(input.dataDir, 'papers', String(input.paperId), 'paper.pdf')
  const stamp = pdfStamp(pdfPath)
  if (!stamp) return { mode: 'mineru' }

  const union = figureNormUnion(input.figure)
  const payload = figureCropCachePayload({
    paperId: input.paperId,
    figureNo: input.figureNo,
    page: input.figure.page,
    bbox: union,
    pdfStamp: stamp
  })
  const relPath = figureCropRelPath(input.paperId, input.figureNo, figureCropHash(payload))
  const abs = absFromRel(input.dataDir, relPath)
  if (isCachedPng(abs)) return { mode: 'crop', relPath }

  const render = input.renderer?.renderCrop ?? defaultRenderCrop
  let pending = inflight.get(payload)
  if (!pending) {
    // 缓存未命中也不在主进程同步读整份 PDF；读取与渲染共用同一个 inflight Promise。
    pending = (async () => {
      const pdf = await readFile(pdfPath)
      return render({
        pdf: new Uint8Array(pdf.buffer, pdf.byteOffset, pdf.byteLength),
        pageIndex: input.figure.page,
        normBbox: union
      })
    })()
    inflight.set(payload, pending)
  }
  try {
    const png = await pending
    if (png.byteLength < 32 || png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) {
      return { mode: 'mineru' }
    }
    if (isCachedPng(abs)) return { mode: 'crop', relPath }
    mkdirSync(dirname(abs), { recursive: true })
    const tmp = `${abs}.${process.pid}.tmp`
    try {
      writeFileSync(tmp, png)
      renameSync(tmp, abs)
    } catch (err) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        // 临时文件清不掉也不把错误抛给图卡
      }
      throw err
    }
    return { mode: 'crop', relPath }
  } catch {
    return { mode: 'mineru' }
  } finally {
    if (inflight.get(payload) === pending) inflight.delete(payload)
  }
}
