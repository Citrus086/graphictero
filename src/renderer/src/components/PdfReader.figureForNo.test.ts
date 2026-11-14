// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { FigureView } from '../../../shared/ipc/pdf'
import { figureForNo } from './PdfReader'

/**
 * 图号 → 图块映射（uat2 起按论文自身图号寻址：图注里的 Figure N / 图 N）：
 * data-figure 的 figureNo 与图注解析结果同口径；找不到 / 越界 / 非整数 / 缺省 → null
 * （正常打开不跳、不崩，绝不跳到错的图）。纯函数单测，不渲染阅读器。
 */

const FIGS: FigureView[] = [
  { page: 0, bbox: [0.1, 0.1, 0.5, 0.3], caption: 'Figure 1 总览', imageSource: null, figureNo: 1 },
  { page: 1, bbox: [0.2, 0.2, 0.6, 0.5], caption: 'Figure 3 细节', imageSource: 'images/p1.jpg', figureNo: 3 },
  { page: 2, bbox: [0.0, 0.0, 0.4, 0.4], caption: '无编号附图', imageSource: null, figureNo: null }
]

describe('figureForNo（图号 → 图块，按论文自身图号）', () => {
  it('按图注图号寻址：1 → 第一块，3 → 第二块（不再按列表下标）', () => {
    expect(figureForNo(FIGS, 1)).toBe(FIGS[0])
    expect(figureForNo(FIGS, 3)).toBe(FIGS[1])
  })
  it('找不到对应图号 → null（图 2 不存在；无图注块不顶替）', () => {
    expect(figureForNo(FIGS, 2)).toBeNull() // 绝不按顺序把第三块错当成图 2
    expect(figureForNo(FIGS, 99)).toBeNull()
  })
  it('非整数 / 缺省 / 空列表 → null（正常打开不跳）', () => {
    expect(figureForNo(FIGS, 0)).toBeNull()
    expect(figureForNo(FIGS, 1.5)).toBeNull()
    expect(figureForNo(FIGS, -1)).toBeNull()
    expect(figureForNo(FIGS, undefined)).toBeNull()
    expect(figureForNo([], 1)).toBeNull()
  })
})
