// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createElement } from 'react'
import type { DetailPart } from '../../../../shared/parts'
import { PartsView } from './PartsView'
import { PartsHostContext } from './PartsHostContext'

afterEach(cleanup)

const HOST = { paperId: 7 }

function renderParts(parts: Parameters<typeof PartsView>[0]['parts'], onOpenFigure?: (n: number) => void) {
  return render(
    createElement(PartsHostContext.Provider, { value: HOST }, createElement(PartsView, { parts, onOpenFigure }))
  )
}

function mockFigures(figs: unknown[]): void {
  ;(window as unknown as { graphictero: unknown }).graphictero = {
    listFigures: vi.fn(async () => figs)
  }
}

const sixParts: DetailPart[] = [
  { type: 'text', text: '正文 **加粗**' },
  { type: 'source', section: '3.2 方法', quote: '原文引用句' },
  { type: 'data-figure', id: 'f1', status: 'done', figureNo: 1, caption: '图注快照' },
  {
    type: 'data-image',
    id: 'i1',
    status: 'done',
    url: 'https://example.com/x.png',
    localPath: 'papers/7/images/x.png',
    alt: '示意图',
    sourceUrl: 'https://example.com/page'
  },
  {
    type: 'data-chart',
    id: 'c1',
    status: 'done',
    title: '准确率',
    option: { series: [] },
    dataSource: '表 2（本文）'
  },
  { type: 'data-mermaid', id: 'm1', status: 'done', title: '流程', code: 'graph TD; A-->B' }
]

describe('PartsView 适配层（D19/D20）', () => {
  it('六种白名单 part 各渲染对应块（stub 数据）', async () => {
    mockFigures([{ page: 0, bbox: [0, 0, 1, 1], caption: '缓存图注', imageSource: null, figureNo: 1 }])
    renderParts(sixParts)
    expect(screen.getByTestId('part-text').textContent).toContain('加粗')
    expect(screen.getByTestId('part-source').textContent).toContain('3.2 方法')
    expect(await screen.findByTestId('part-figure')).toBeTruthy()
    expect(screen.getByTestId('part-image')).toBeTruthy()
    expect(screen.getByTestId('part-chart')).toBeTruthy()
    expect(screen.getByTestId('part-mermaid')).toBeTruthy()
  })

  it('uat2 f：v3 固定小标题详情渲染出四个 h2 且顺序正确（原型 v45_03）', () => {
    renderParts([
      { type: 'text', text: '## 它在解决什么问题\n\n问题描述。' },
      { type: 'text', text: '## 方法\n\n方法描述。' },
      { type: 'text', text: '## 结论\n\n结论。' },
      { type: 'text', text: '## 局限\n\n局限。' }
    ])
    const h2s = Array.from(document.querySelectorAll('.gt-part-text h2')).map((el) => el.textContent)
    expect(h2s).toEqual(['它在解决什么问题', '方法', '结论', '局限'])
  })

  it('uat2 f：v1/v2 旧详情（无固定小标题）照常渲染，不崩', () => {
    renderParts([{ type: 'text', text: '旧版详情正文，没有固定小标题。' }])
    expect(screen.getByTestId('part-text').textContent).toContain('旧版详情正文')
    expect(document.querySelectorAll('.gt-part-text h2')).toHaveLength(0)
  })

  it('D211 data-interactive 分发到交互块；非法规格保留公式局部降级', () => {
    const good: DetailPart = {
      type: 'data-interactive',
      id: 'interactive-1',
      status: 'done',
      title: '平方探索',
      params: [{ id: 'n', label: 'n', control: 'number', min: 1, max: 10, step: 1, default: 2 }],
      expressions: [{ id: 'square', label: '平方', expr: 'n^2' }],
      sourceNote: '自造式 (1)'
    }
    renderParts([good])
    expect(screen.getByTestId('part-interactive').textContent).toContain('平方探索')
    expect(screen.getByTestId('interactive-value-square').textContent).toBe('4')
    expect(screen.queryByTestId('part-fallback')).toBeNull()
    cleanup()
    const bad = { ...good, expressions: [{ id: 'square', label: '平方', expr: 'missing + 1' }] } as DetailPart
    renderParts([bad])
    expect(screen.getByTestId('interactive-invalid').textContent).toContain('missing + 1')
    expect(screen.queryByTestId('part-fallback')).toBeNull()
  })

  it('未知类型 → 灰色降级块「不支持的块类型」，不崩', () => {
    const bad = { type: 'data-video', src: 'x' } as unknown as DetailPart
    renderParts([bad])
    const fb = screen.getByTestId('part-fallback')
    expect(fb.textContent).toContain('不支持的块类型')
    expect(fb.getAttribute('data-part-type')).toBe('data-video')
  })

  it('M5 新 part 分发（lane/chat：data-trace / paper-card / graph-change 全部落地）', () => {
    renderParts([
      { type: 'data-trace', toolName: 'readPaper', paperId: 3, summary: '读了 3.2 方法一节' },
      {
        type: 'data-paper-card',
        id: 'pc1',
        status: 'done',
        title: '候选论文',
        authors: ['张三'],
        reason: '相关',
        cardStatus: 'candidate'
      },
      {
        type: 'data-graph-change',
        id: 'gc1',
        status: 'done',
        changeType: 'addRelation',
        relationIds: [1],
        paperIds: [2, 3],
        summary: '新增 1 条关系'
      }
    ])
    // data-trace → 灰色读取记录行（chat/TraceRow；uat3b 建议修 5：可见标签中文，工具名留在 data-tool）
    const trace = screen.getByTestId('part-trace')
    expect(trace.textContent).toContain('读原文')
    expect(trace.getAttribute('data-tool')).toBe('readPaper')
    // data-paper-card → 候选卡片（PaperCardBlock，D117；详情页无宿主回调 = 按钮禁用）
    const card = screen.getByTestId('part-paper-card')
    expect(card.textContent).toContain('候选论文')
    expect((screen.getByTestId('card-confirm') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('card-ignore') as HTMLButtonElement).disabled).toBe(true)
    // data-graph-change → 小结行（GraphChangeBlock；无宿主回调 = 纯展示，无按钮）
    const gc = screen.getByTestId('part-graph-change')
    expect(gc.textContent).toContain('新增关系')
    expect(gc.textContent).toContain('新增 1 条关系')
    expect(screen.queryByTestId('gchange-locate')).toBeNull()
    expect(screen.queryByTestId('gchange-undo')).toBeNull()
    expect(screen.queryByTestId('part-fallback')).toBeNull()
  })

  it('白名单内但字段校验失败 → 降级块并注明「字段校验失败」', () => {
    const bad = { type: 'data-figure', id: 'f1', status: 'done', figureNo: '一' } as unknown as DetailPart
    renderParts([bad])
    const fb = screen.getByTestId('part-fallback')
    expect(fb.textContent).toContain('不支持的块类型')
    expect(fb.textContent).toContain('字段校验失败')
  })

  it('D20 同 id 后写覆盖先写，位置保持首次出现处', () => {
    const parts = [
      { type: 'text', text: '前' },
      { type: 'data-mermaid', id: 'm', status: 'done', title: '第一版', code: 'graph TD; A-->B' },
      { type: 'text', text: '中' },
      { type: 'data-mermaid', id: 'm', status: 'done', title: '第二版', code: 'graph TD; B-->C' }
    ] as DetailPart[]
    const { container } = renderParts(parts)
    const mermaids = container.querySelectorAll('[data-testid="part-mermaid"]')
    expect(mermaids.length).toBe(1)
    expect(mermaids[0].textContent).toContain('第二版')
    // 位置：仍夹在「前」「中」之后（首次出现处）
    const text = [...container.querySelectorAll('[data-testid="part-text"]')].map((e) => e.textContent)
    expect(text).toEqual(['前', '中'])
    expect(mermaids[0].compareDocumentPosition(container.querySelectorAll('[data-testid="part-text"]')[1])).toBeTruthy()
  })

  it('无 id 的 text/source 不去重，全部按序渲染', () => {
    const parts = [
      { type: 'text', text: '一' },
      { type: 'text', text: '二' },
      { type: 'source', section: 'S1' },
      { type: 'source', section: 'S2' }
    ] as DetailPart[]
    const { container } = renderParts(parts)
    expect(container.querySelectorAll('[data-testid="part-text"]').length).toBe(2)
    expect(container.querySelectorAll('[data-testid="part-source"]').length).toBe(2)
  })

  it('图块点击触发 onOpenFigure(figureNo)', async () => {
    mockFigures([{ page: 1, bbox: [0, 0, 1, 1], caption: null, imageSource: null, figureNo: 1 }])
    const onOpenFigure = vi.fn()
    renderParts([{ type: 'data-figure', id: 'f1', status: 'done', figureNo: 1 }], onOpenFigure)
    const card = await screen.findByTestId('part-figure')
    fireEvent.click(within(card).getByText('p.2').closest('button')!)
    expect(onOpenFigure).toHaveBeenCalledWith(1)
  })
})
