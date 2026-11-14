// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createElement as h } from 'react'
import type { GraphChangePart } from '../../../../shared/parts'
import { PartsHostContext } from './PartsHostContext'
import { GraphChangeBlock } from './GraphChangeBlock'

/** uat5 建议修 5：改图小结里的 P0x 显示时替换为《短标题》（只展示不写库）。 */

const PART: GraphChangePart = {
  type: 'data-graph-change',
  id: 'g1',
  status: 'done',
  changeType: 'addRelation',
  relationIds: [7],
  paperIds: [11, 22],
  summary: '新增关系：P01 → P02（对比）：两篇都讨论检索增强'
}

const replace = (text: string): string => text.replace(/P01/g, '《甲论文》').replace(/P02/g, '《乙论文》')

afterEach(cleanup)

describe('GraphChangeBlock（uat5 建议修 5：P0x 显示层替换）', () => {
  it('宿主注入 replaceShortIdsForDisplay 时：小结显示《短标题》，无 P0x', () => {
    render(
      h(PartsHostContext.Provider, { value: { replaceShortIdsForDisplay: replace } }, h(GraphChangeBlock, { part: PART }))
    )
    const el = screen.getByTestId('part-graph-change')
    expect(el.textContent).toContain('《甲论文》')
    expect(el.textContent).toContain('《乙论文》')
    expect(el.textContent).not.toContain('P01')
    expect(el.textContent).not.toContain('P02')
    // part 数据本身不被改写
    expect(PART.summary).toContain('P01')
  })

  it('宿主不传时：原样显示（优雅降级）', () => {
    render(h(GraphChangeBlock, { part: PART }))
    expect(screen.getByTestId('part-graph-change').textContent).toContain('P01 → P02')
  })
})
