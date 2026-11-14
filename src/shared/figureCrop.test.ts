import { describe, expect, it } from 'vitest'
import {
  FIGURE_CROP_EPS,
  FIGURE_CROP_MAX_EDGE,
  figureCropCachePayload,
  figureCropScale,
  isMultiPanelFigure,
  quantizeNormBbox
} from './figureCrop'

/**
 * uat8a D189：多面板判定与裁图参数。纯函数。
 */

describe('isMultiPanelFigure（D189）', () => {
  it('没有子块、或子块都在自身 bbox 内：单面板', () => {
    expect(isMultiPanelFigure({ bbox: [0.1, 0.2, 0.9, 0.7] })).toBe(false)
    expect(isMultiPanelFigure({ bbox: [0.1, 0.2, 0.9, 0.7], subBboxes: [] })).toBe(false)
    expect(
      isMultiPanelFigure({
        bbox: [0.1, 0.2, 0.9, 0.7],
        subBboxes: [[0.2, 0.3, 0.5, 0.6]]
      })
    ).toBe(false)
  })

  it('并集任一边超出自身 bbox 超过容差：多面板', () => {
    expect(
      isMultiPanelFigure({
        bbox: [0.1, 0.2, 0.9, 0.7],
        subBboxes: [[0.1, 0.2 - FIGURE_CROP_EPS * 3, 0.4, 0.3]]
      })
    ).toBe(true)
    expect(
      isMultiPanelFigure({
        bbox: [0.2, 0.2, 0.6, 0.6],
        subBboxes: [
          [0.05, 0.2, 0.2, 0.4],
          [0.6, 0.2, 0.95, 0.8]
        ]
      })
    ).toBe(true)
  })

  it('uat9：子图标题超出编号块时也触发现裁，而不是沿用缺标题的旧 MinerU 图', () => {
    expect(isMultiPanelFigure({
      bbox: [0.1, 0.2, 0.9, 0.7],
      subBboxes: [[0.2, 0.3, 0.5, 0.6]],
      subCaptionBboxes: [[0.2, 0.705, 0.5, 0.73]]
    })).toBe(true)
  })

  it('超出量不超过容差仍算单面板', () => {
    expect(
      isMultiPanelFigure({
        bbox: [0.1, 0.2, 0.9, 0.7],
        subBboxes: [[0.1, 0.2 - FIGURE_CROP_EPS / 10, 0.4, 0.3]]
      })
    ).toBe(false)
  })
})

describe('figureCropScale / 缓存键原文（D189）', () => {
  it('按显示宽 2× 取比例，长边超过 2000 时缩小', () => {
    expect(figureCropScale(100, 50)).toBeCloseTo(8.4, 5)
    expect(figureCropScale(10, 10_000)).toBeCloseTo(FIGURE_CROP_MAX_EDGE / 10_000, 5)
  })

  it('归一化 bbox 量化到四位小数；量化结果相同则键相同', () => {
    expect(quantizeNormBbox([0.10004, 0.2, 0.3, 0.4])).toEqual([1000, 2000, 3000, 4000])
    const a = figureCropCachePayload({
      paperId: 5,
      figureNo: 2,
      page: 3,
      bbox: [0.10004, 0.2, 0.3, 0.4],
      pdfStamp: '12:34'
    })
    const b = figureCropCachePayload({
      paperId: 5,
      figureNo: 2,
      page: 3,
      bbox: [0.100049, 0.2, 0.3, 0.4],
      pdfStamp: '12:34'
    })
    const c = figureCropCachePayload({
      paperId: 5,
      figureNo: 2,
      page: 4,
      bbox: [0.10004, 0.2, 0.3, 0.4],
      pdfStamp: '12:34'
    })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a.startsWith('v2|5|2|p3|')).toBe(true)
    // uat9：旧 v1 裁剪没有子图标题；同论文 / 图号 / bbox 也不能再命中旧缓存。
    expect(a).not.toBe(a.replace(/^v2\|/, 'v1|'))
  })
})
