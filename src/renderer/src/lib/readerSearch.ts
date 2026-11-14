import type { SearchResult } from '@embedpdf/models'

/**
 * 阅读器内搜索（uat3 必须修 7）：命中匹配与计数用引擎 searchAllPages（PdfEngine 自带，
 * pdfium FPDFText 搜索，跨行/大小写由引擎处理），本模块只做 UI 层的纯函数：
 * 上/下一个循环取命中、按页分组渲染命中高亮。
 */

/** 循环取下一个/上一个命中下标（total=0 时返回 -1） */
export function cycleHit(current: number, total: number, delta: 1 | -1): number {
  if (total <= 0) return -1
  return (current + delta + total) % total
}

export interface SearchMark {
  rects: Array<[number, number, number, number]>
  current: boolean
}

/**
 * 把引擎命中结果按页分组为可渲染的高亮块（PDF 页面坐标 Quad）。
 * rectsPerPage: pageIndex → 该页每条命中的矩形列表（已换算成 Quad）。
 */
export function groupSearchMarks(rectsPerPage: Map<number, Array<Array<[number, number, number, number]>>>, activeIndex: number): Map<number, SearchMark[]> {
  const out = new Map<number, SearchMark[]>()
  let flat = -1
  for (const [page, hitRects] of [...rectsPerPage.entries()].sort((a, b) => a[0] - b[0])) {
    const marks: SearchMark[] = []
    for (const rects of hitRects) {
      flat += 1
      marks.push({ rects, current: flat === activeIndex })
    }
    if (marks.length) out.set(page, marks)
  }
  return out
}

/** 引擎 SearchResult.rects（Rect 对象）→ Quad [x,y,w,h]（PDF 页面坐标） */
export function searchResultQuads(r: SearchResult): Array<[number, number, number, number]> {
  return r.rects.map((rc) => [rc.origin.x, rc.origin.y, rc.size.width, rc.size.height])
}
