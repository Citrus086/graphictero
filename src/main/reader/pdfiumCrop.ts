import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mineruNormRectToPageRect } from '../../shared/ipc/pdf'
import { figureCropScale } from '../../shared/figureCrop'
import { encodeRgbaPng } from './pngEncode'

/**
 * uat8a D189：主进程用已有 @embedpdf/pdfium 把并集区域渲成 PNG。
 *
 * 放主进程的原因：PDF 字节和缓存都在数据目录，渲染层只拿 gt-asset URL（D109 不联网）；
 * fontFallback 必须为 null，否则 pdfium 会向 CDN 要字体。坐标与阅读器高亮相同：
 * mineruNormRectToPageRect 的左上原点、y 向下（probe 已核对 renderPageRect）。
 * wasm 调用串行，避免并发踩同一份模块内存。
 */

export interface PdfCropRequest {
  pdf: Uint8Array
  pageIndex: number
  normBbox: [number, number, number, number]
}

interface RawImage {
  data: Uint8ClampedArray
  width: number
  height: number
}

interface RawPage {
  size: { width: number; height: number }
}

interface RawDoc {
  pages: RawPage[]
}

interface RawEngine {
  openDocumentBuffer(file: { id: string; content: ArrayBuffer }): { toPromise(): Promise<RawDoc> }
  renderPageRect(
    doc: RawDoc,
    page: RawPage,
    rect: { origin: { x: number; y: number }; size: { width: number; height: number } },
    options?: { scaleFactor?: number; dpr?: number }
  ): { toPromise(): Promise<RawImage> }
  closeDocument(doc: RawDoc): { toPromise(): Promise<unknown> }
}

interface PdfiumInitMod {
  init(opts: { wasmBinary: Uint8Array }): Promise<{ PDFiumExt_Init?: () => void }>
}

let enginePromise: Promise<RawEngine> | null = null
let tail: Promise<void> = Promise.resolve()

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = tail.then(job, job)
  tail = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/** 打包后的主进程里 import.meta.url 可能指到 out/main；再退回进程工作目录。 */
function resolveSpec(spec: string): { req: NodeRequire; resolved: string } {
  const reqs: NodeRequire[] = []
  try {
    reqs.push(createRequire(import.meta.url))
  } catch {
    // 打包产物没有可用的 import.meta.url
  }
  try {
    reqs.push(createRequire(join(process.cwd(), 'package.json')))
  } catch {
    // cwd 不是项目根
  }
  let last: unknown = new Error(`无法解析 ${spec}`)
  for (const req of reqs) {
    try {
      return { req, resolved: req.resolve(spec) }
    } catch (err) {
      last = err
    }
  }
  throw last
}

function loadEngine(): Promise<RawEngine> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const { req, resolved: wasmPath } = resolveSpec('@embedpdf/pdfium/pdfium.wasm')
      const wasmBinary = readFileSync(wasmPath)
      const pdfium = req('@embedpdf/pdfium') as PdfiumInitMod
      const engines = req('@embedpdf/engines') as {
        PdfiumNative: new (mod: unknown, opts: { fontFallback: null }) => RawEngine
      }
      const mod = await pdfium.init({ wasmBinary })
      mod.PDFiumExt_Init?.()
      return new engines.PdfiumNative(mod, { fontFallback: null })
    })().catch((err: unknown) => {
      enginePromise = null
      throw err
    })
  }
  return enginePromise
}

function clampRect(
  x: number,
  y: number,
  w: number,
  h: number,
  pageW: number,
  pageH: number
): { origin: { x: number; y: number }; size: { width: number; height: number } } {
  const x0 = Math.min(Math.max(0, x), Math.max(0, pageW - 0.5))
  const y0 = Math.min(Math.max(0, y), Math.max(0, pageH - 0.5))
  return {
    origin: { x: x0, y: y0 },
    size: {
      width: Math.max(0.5, Math.min(w, pageW - x0)),
      height: Math.max(0.5, Math.min(h, pageH - y0))
    }
  }
}

async function renderNow(input: PdfCropRequest): Promise<Uint8Array> {
  const engine = await loadEngine()
  const content = new ArrayBuffer(input.pdf.byteLength)
  new Uint8Array(content).set(input.pdf)
  const doc = await engine.openDocumentBuffer({ id: `figcrop-${Date.now()}-${Math.random().toString(16).slice(2)}`, content }).toPromise()
  try {
    const page = doc.pages[input.pageIndex]
    if (!page) throw new Error(`PDF 没有第 ${input.pageIndex} 页`)
    const [x, y, w, h] = mineruNormRectToPageRect(input.normBbox, page.size.width, page.size.height)
    const rect = clampRect(x, y, w, h, page.size.width, page.size.height)
    const scale = figureCropScale(rect.size.width, rect.size.height)
    const image = await engine.renderPageRect(doc, page, rect, { scaleFactor: scale, dpr: 1 }).toPromise()
    if (image.width <= 0 || image.height <= 0) throw new Error('PDF 裁图为空')
    return encodeRgbaPng(image.width, image.height, image.data)
  } finally {
    await engine.closeDocument(doc).toPromise().catch(() => undefined)
  }
}

/** 串行渲染。调用方负责缓存；这里不写盘。 */
export function pdfiumRenderCrop(input: PdfCropRequest): Promise<Uint8Array> {
  return enqueue(() => renderNow(input))
}
