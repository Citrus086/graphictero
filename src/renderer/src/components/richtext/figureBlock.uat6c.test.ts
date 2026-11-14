// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement as h } from 'react'
import type { FigureView } from '../../../../shared/ipc/pdf'
import type { FigurePart } from '../../../../shared/parts'
import { PartsHostContext } from './PartsHostContext'

/**
 * uat6c S5：详情图卡 caption 的行内 $…$ LaTeX 走现有富文本数学管道（KaTeX），
 * 不再显示原始 LaTeX 源码；「子图注 + 主图注」合并注已由主进程截到主图注起头。
 */

afterEach(cleanup)

let FigureBlock: typeof import('./FigureBlock').FigureBlock

const FIG: FigureView = {
  page: 3,
  bbox: [0.1, 0.2, 0.9, 0.7],
  caption: 'Figure 2: Adaptive stopping with target error rate $( \\alpha _ { t } )$ across rounds.',
  imageSource: 'images/fig2.jpg',
  figureNo: 2,
  subBboxes: [
    [0.1, 0.05, 0.5, 0.2],
    [0.5, 0.05, 0.9, 0.2]
  ]
}

beforeAll(async () => {
  ;(window as unknown as { graphictero: unknown }).graphictero = {
    listFigures: vi.fn(async () => [FIG])
  }
  FigureBlock = (await import('./FigureBlock')).FigureBlock
})

describe('FigureBlock（uat6c S5：caption 数学渲染）', () => {
  it('caption 里的行内 $…$ 经 KaTeX 渲染（出现 .katex），不再裸露原始 LaTeX 文本', async () => {
    const part: FigurePart = { type: 'data-figure', id: 'fig-1', status: 'done', figureNo: 2, caption: '快照' }
    render(
      h(PartsHostContext.Provider, { value: { paperId: 5 } }, h(FigureBlock, { part }))
    )
    const card = await screen.findByTestId('part-figure')
    await waitFor(() => expect(card.querySelector('.katex')).not.toBeNull())
    expect(card.textContent).toContain('Figure 2:')
    expect(card.textContent).toContain('Adaptive stopping')
    // 可见渲染部分（.katex-html）不再裸露原始 LaTeX 记号；MathML annotation
    // 里的原始 TeX 是 KaTeX 无障碍输出，站点既有行为（TextBlock 同）
    expect(card.querySelector('.gt-figure-caption .katex-html')!.textContent).not.toContain('$(')
    expect(card.querySelector('.gt-figure-caption .katex-html')!.textContent).not.toContain('\\alpha')
  })
})
