// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createElement as h } from 'react'
import { render } from '@testing-library/react'
import { ReactFlowProvider, type NodeProps } from '@xyflow/react'
import type { PaperSummary } from '../../../shared/ipc'
import { PaperNode, type PaperNodeType } from './PaperNode'

/**
 * uat2：画布节点的处理中蓝点 / 排队中口径 / 失败红点（原型 v45_02：
 * 蓝点 .edot.pr + 「处理中」npt 文字；失败红点 .edot）。
 */

const paper: PaperSummary = {
  id: 1,
  title: '测试论文',
  firstAuthor: 'Zhang',
  year: 2026,
  hasPdf: true,
  doi: null,
  arxivId: null,
  source: 'zotero',
  inGraph: true
}

function nodeProps(data: Partial<PaperNodeType['data']>): NodeProps<PaperNodeType> {
  return { id: '1', type: 'paper', data: { paper, ...data } } as unknown as NodeProps<PaperNodeType>
}

function renderNode(data: Partial<PaperNodeType['data']>): ReturnType<typeof render> {
  return render(h(ReactFlowProvider, null, h(PaperNode, nodeProps(data))))
}
describe('PaperNode 处理中/失败标记（uat2，原型 v45_02）', () => {
  it('running：右上角蓝点 + 元信息行「处理中」', () => {
    const { container, unmount } = renderNode({ proc: 'running' })
    expect(container.querySelector('[data-testid="node-proc"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="node-proc"]')!.className).toContain('procdot')
    expect(container.querySelector('[data-testid="node-proc-tag"]')!.textContent).toBe('处理中')
    unmount()
  })

  it('queued：串行队列未轮到 = 「排队中」（产品决定），蓝点仍在', () => {
    const { container, unmount } = renderNode({ proc: 'queued' })
    expect(container.querySelector('[data-testid="node-proc"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="node-proc-tag"]')!.textContent).toBe('排队中')
    unmount()
  })

  it('无处理状态：无蓝点无标记', () => {
    const { container, unmount } = renderNode({})
    expect(container.querySelector('[data-testid="node-proc"]')).toBeNull()
    expect(container.querySelector('[data-testid="node-proc-tag"]')).toBeNull()
    unmount()
  })

  it('失败红点（建议修 1）：failTitle 给出时右上角红点，处理中与失败互斥', () => {
    const { container, unmount } = renderNode({ failTitle: '解析失败' })
    expect(container.querySelector('[data-testid="node-fail"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="node-proc"]')).toBeNull()
    unmount()
  })
})

describe('uat7b D184-② 子图选中描边（数据层驱动）', () => {
  it('selected=false 但 subSelected=true 时仍有 .pnode.sel（xyflow 点空白清内部 selected 后圈仍在）', () => {
    const { container, unmount } = renderNode({ subSelected: true })
    const el = container.querySelector('.pnode')!
    expect(el.className).toContain('sel')
    unmount()
  })

  it('selected=false 且无 subSelected：无选中圈', () => {
    const { container, unmount } = renderNode({})
    expect(container.querySelector('.pnode')!.className).not.toContain('sel')
    unmount()
  })
})
