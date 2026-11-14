import { figureNormUnion, type FigureView } from './ipc/pdf'

/**
 * uat8a D189：详情图卡是否改走 PDF 并集裁图。
 *
 * 多面板 = 有兄弟子块，且 figureNormUnion 在任一边严格超出编号块自身 bbox
 * （容差 FIGURE_CROP_EPS）。子块都落在自身 bbox 里时，MinerU 裁图已经盖住区域，
 * 仍用原图，不渲染 PDF。没有 subBboxes 一律单面板。
 */

export const FIGURE_CROP_EPS = 1e-4
/** 图卡 max-width（.gt-figure-card）约 420px，裁图像素按 2×。 */
export const FIGURE_CROP_DISPLAY_WIDTH = 420
export const FIGURE_CROP_PIXEL_RATIO = 2
export const FIGURE_CROP_MAX_EDGE = 2000
/** 改渲染参数或并集口径时递增，缓存键随之失效（2 = 纳入子图标题）。 */
export const FIGURE_CROP_RENDER_VERSION = 2
export const FIGURE_CROP_MIN_SCALE = 0.05
/** 归一化 bbox 量化：四位小数（round(n * 10000)）。 */
export const FIGURE_CROP_BBOX_QUANT = 10000

export function isMultiPanelFigure(fig: Pick<FigureView, 'bbox' | 'subBboxes' | 'subCaptionBboxes'>): boolean {
  if (!fig.subBboxes || fig.subBboxes.length === 0) return false
  const union = figureNormUnion(fig)
  const own = fig.bbox
  return (
    own[0] - union[0] > FIGURE_CROP_EPS ||
    own[1] - union[1] > FIGURE_CROP_EPS ||
    union[2] - own[2] > FIGURE_CROP_EPS ||
    union[3] - own[3] > FIGURE_CROP_EPS
  )
}

export function quantizeNormBbox(bbox: [number, number, number, number]): [number, number, number, number] {
  const q = (n: number): number => Math.round(n * FIGURE_CROP_BBOX_QUANT)
  return [q(bbox[0]), q(bbox[1]), q(bbox[2]), q(bbox[3])]
}

/**
 * 裁图长宽是 PDF 点。目标宽 = 显示宽 × 2；长边超过 MAX_EDGE 时缩小。
 * 返回 pdfium scaleFactor（dpr 固定 1）。
 */
export function figureCropScale(widthPt: number, heightPt: number): number {
  const w = Math.max(widthPt, 0.01)
  const h = Math.max(heightPt, 0.01)
  let scale = (FIGURE_CROP_DISPLAY_WIDTH * FIGURE_CROP_PIXEL_RATIO) / w
  if (Math.max(w, h) * scale > FIGURE_CROP_MAX_EDGE) scale = FIGURE_CROP_MAX_EDGE / Math.max(w, h)
  return Math.max(FIGURE_CROP_MIN_SCALE, scale)
}

/**
 * 缓存键原文（主进程再 sha256）。含渲染参数常量，改了不必只记得 bump 版本。
 * pdfStamp 是 PDF 字节长度 + mtime，文件被替换时不复用旧裁图；不含页点尺寸
 * （点尺寸要打开 PDF 才知道，缓存命中不能依赖渲染器）。
 */
export function figureCropCachePayload(input: {
  paperId: number
  figureNo: number
  page: number
  bbox: [number, number, number, number]
  pdfStamp: string
}): string {
  const q = quantizeNormBbox(input.bbox)
  return [
    `v${FIGURE_CROP_RENDER_VERSION}`,
    input.paperId,
    input.figureNo,
    `p${input.page}`,
    q.join(','),
    FIGURE_CROP_DISPLAY_WIDTH,
    FIGURE_CROP_PIXEL_RATIO,
    FIGURE_CROP_MAX_EDGE,
    input.pdfStamp
  ].join('|')
}

export function figureCropRelPath(paperId: number, figureNo: number, hash: string): string {
  return `cache/figure-crops/${paperId}/${figureNo}-${hash}.png`
}
