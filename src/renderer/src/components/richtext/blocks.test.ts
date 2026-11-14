// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import type { ChartPart, FigurePart, ImagePart, MermaidPart } from '../../../../shared/parts'
import { FigureBlock } from './FigureBlock'
import { ImageBlock } from './ImageBlock'
import { PartsHostContext, type PartsHost } from './PartsHostContext'

// ECharts 在 jsdom 无 canvas：mock 初始化模块，断言「校验后 setOption、绝不 eval」
const initChart = vi.fn(() => ({ resize: () => {}, dispose: () => {} }))
vi.mock('./echartsSetup', () => ({ initChart: (...args: unknown[]) => initChart(...(args as [])) }))

// mermaid 懒加载：mock 模块
const mermaidRender = vi.fn(async () => ({ svg: '<svg data-mock="mmd"><text>图</text></svg>', bindFunctions: () => {} }))
vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), render: (...args: unknown[]) => mermaidRender(...(args as [])) }
}))

import { ChartBlock } from './ChartBlock'
import { MermaidBlock } from './MermaidBlock'

afterEach(cleanup)

function hostWrap(node: ReactNode, host: PartsHost): ReactNode {
  return createElement(PartsHostContext.Provider, { value: host }, node)
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as unknown as { graphictero: unknown }).graphictero = {
    listFigures: vi.fn(async () => [{ page: 2, bbox: [0.1, 0.1, 0.5, 0.5], caption: '缓存里的图注', imageSource: 'images/p0.jpg', figureNo: 1 }])
  }
})

describe('FigureBlock（pdf:listFigures 解析 + D109 本地缓存）', () => {
  const part: FigurePart = { type: 'data-figure', id: 'f1', status: 'done', figureNo: 1, caption: '快照图注' }

  it('解析成功：渲染本地缓存图（gt-asset://，D115）、页码、缓存图注优先', async () => {
    render(hostWrap(createElement(FigureBlock, { part, onOpenFigure: () => {} }), { paperId: 7}))
    const img = await screen.findByRole('img')
    expect(img.getAttribute('src')).toBe('gt-asset://data/papers/7/mineru/images/p0.jpg')
    expect(screen.getByTestId('part-figure').textContent).toContain('p.3')
    expect(screen.getByTestId('part-figure').textContent).toContain('缓存里的图注')
  })

  it('图号不存在 → 「图 N 未找到」占位', async () => {
    render(hostWrap(createElement(FigureBlock, { part: { ...part, figureNo: 9 } }), { paperId: 7}))
    const missing = await screen.findByTestId('figure-missing')
    expect(missing.textContent).toContain('图 9 未找到')
  })

  it('uat2：图注图号与文档顺序错位时仍按图号寻址（列表第二块是图 1 → 渲染它）', async () => {
    ;(window as unknown as { graphictero: { listFigures: unknown } }).graphictero = {
      listFigures: vi.fn(async () => [
        { page: 0, bbox: [0, 0, 1, 1], caption: 'Figure S1 附录', imageSource: null, figureNo: null },
        { page: 1, bbox: [0, 0, 1, 1], caption: 'Figure 1 正文', imageSource: 'images/p1.jpg', figureNo: 1 }
      ])
    }
    render(hostWrap(createElement(FigureBlock, { part }), { paperId: 7 }))
    const img = await screen.findByRole('img')
    expect(img.getAttribute('src')).toBe('gt-asset://data/papers/7/mineru/images/p1.jpg')
    expect(screen.getByTestId('part-figure').textContent).toContain('Figure 1 正文')
  })

  it('imageSource 路径穿越（../）被拦截 → 无 img，显示占位文字', async () => {
    ;(window as unknown as { graphictero: { listFigures: unknown } }).graphictero = {
      listFigures: vi.fn(async () => [{ page: 0, bbox: [0, 0, 1, 1], caption: null, imageSource: '../../etc/passwd', figureNo: 1 }])
    }
    render(hostWrap(createElement(FigureBlock, { part }), { paperId: 7}))
    await screen.findByTestId('part-figure')
    expect(document.querySelector('img')).toBeNull()
  })

  it('宿主未提供 paperId → 图注快照 + 提示，不请求 IPC', () => {
    const listFigures = vi.fn()
    ;(window as unknown as { graphictero: { listFigures: unknown } }).graphictero = { listFigures }
    render(createElement(FigureBlock, { part }))
    expect(screen.getByTestId('part-figure').textContent).toContain('宿主未提供 paperId')
    expect(listFigures).not.toHaveBeenCalled()
  })
})

describe('ImageBlock（D109：仅本地缓存，无网络请求）', () => {
  const base: ImagePart = {
    type: 'data-image',
    id: 'i1',
    status: 'done',
    url: 'https://example.com/x.png',
    alt: '说明文字',
    sourceUrl: 'https://example.com/page',
    sourceTitle: '示例来源'
  }

  it('数据目录内相对 localPath → gt-asset:// 本地图（D115）', () => {
    render(hostWrap(createElement(ImageBlock, { part: { ...base, localPath: 'images/x.png' } }), {}))
    const img = screen.getByRole('img')
    expect(img.getAttribute('src')).toBe('gt-asset://data/images/x.png')
    expect(img.getAttribute('src')).not.toContain('http')
  })

  it('localPath 绝对路径 / 穿越（防穿越）→ alt + 来源链接，不发网络请求', () => {
    render(hostWrap(createElement(ImageBlock, { part: { ...base, localPath: '/etc/passwd' } }), {}))
    expect(screen.queryByRole('img')).toBeNull()
    cleanup()
    render(hostWrap(createElement(ImageBlock, { part: { ...base, localPath: '../../etc/passwd' } }), {}))
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByTestId('image-fallback').textContent).toContain('说明文字')
    const a = document.querySelector('.gt-image-src a')!
    expect(a.getAttribute('href')).toBe('https://example.com/page')
    expect(a.textContent).toBe('示例来源')
  })

  it('无 localPath → alt + 来源展示', () => {
    render(hostWrap(createElement(ImageBlock, { part: base }), {}))
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByTestId('image-fallback').textContent).toContain('说明文字')
  })

  it('本地图加载失败（onError）→ 降级 alt + 来源', () => {
    render(hostWrap(createElement(ImageBlock, { part: { ...base, localPath: 'images/x.png' } }), {}))
    fireEvent.error(screen.getByRole('img'))
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByTestId('image-fallback').textContent).toContain('说明文字')
  })

  it('来源链接点击不导航（preventDefault，M4 只展示）', () => {
    render(hostWrap(createElement(ImageBlock, { part: base }), {}))
    const a = document.querySelector('.gt-image-src a')!
    fireEvent.click(a)
    // href 仍在但默认行为被拦——jsdom 不导航即通过（无异常、地址不变）
    expect(a.getAttribute('href')).toBe('https://example.com/page')
  })
})

describe('ChartBlock（option 白名单校验后交 ECharts，不 eval）', () => {
  const base: ChartPart = { type: 'data-chart', id: 'c1', status: 'done', title: '表 A', option: { series: [] }, dataSource: '表 2' }

  it('合法 option → initChart 收到净化后的 JSON；标题与数据来源必显', () => {
    render(createElement(ChartBlock, { part: base }))
    expect(initChart).toHaveBeenCalledTimes(1)
    expect((initChart.mock.calls[0] as unknown[])[1]).toEqual({ series: [] })
    const el = screen.getByTestId('part-chart')
    expect(el.textContent).toContain('表 A')
    expect(el.textContent).toContain('数据来源：表 2')
  })

  it('恶意 option（函数字段）→ 灰色降级块「图表配置无效」，不初始化图表', () => {
    const evil = { series: [], evil: () => 'x' }
    render(createElement(ChartBlock, { part: { ...base, option: evil } }))
    const bad = screen.getByTestId('chart-invalid')
    expect(bad.textContent).toContain('图表配置无效')
    expect(bad.textContent).toContain('function')
    expect(initChart).not.toHaveBeenCalled()
    expect(screen.queryByTestId('chart-box')).toBeNull()
    // 数据来源仍必显
    expect(screen.getByTestId('part-chart').textContent).toContain('数据来源：表 2')
  })

  it('超长字符串 option → 拒绝', () => {
    render(createElement(ChartBlock, { part: { ...base, option: { s: 'x'.repeat(20_000) } } }))
    expect(screen.getByTestId('chart-invalid').textContent).toContain('超长')
    expect(initChart).not.toHaveBeenCalled()
  })
})

describe('MermaidBlock（懒加载 + strict；失败显示源码）', () => {
  const part: MermaidPart = { type: 'data-mermaid', id: 'm1', status: 'done', title: '流程', code: 'graph TD; A-->B' }

  it('渲染成功 → 注入 mermaid SVG', async () => {
    render(createElement(MermaidBlock, { part }))
    const box = await screen.findByTestId('mermaid-svg')
    expect(box.querySelector('svg')).toBeTruthy()
    expect(mermaidRender).toHaveBeenCalledWith(expect.stringMatching(/^gt-mmd-\d+$/), part.code)
  })

  it('渲染失败 → 显示源码块，不崩', async () => {
    mermaidRender.mockRejectedValueOnce(new Error('parse error'))
    render(createElement(MermaidBlock, { part }))
    const pre = await screen.findByTestId('mermaid-fallback')
    expect(pre.textContent).toContain('graph TD; A-->B')
  })
})
