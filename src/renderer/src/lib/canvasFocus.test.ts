import { beforeEach, describe, expect, it } from 'vitest'
import type { RelationView } from '../../../shared/ipc'
import {
  buildRelationAdjacency,
  clearSessionTypeFilters,
  focusNeighborhood,
  neighborhoodEmphasis,
  readSessionTypeFilter,
  relationTypeCounts,
  shouldRunFocusShortcut,
  toggleHiddenRelationType,
  visibleRelationsByType,
  writeSessionTypeFilter
} from './canvasFocus'

function rel(id: number, low: number, high: number, llmTypes: RelationView['llmTypes'] = ['based_on'], autoTypes: RelationView['autoTypes'] = []): RelationView {
  return { id, paperLow: low, paperHigh: high, srcPaper: low, llmTypes, autoTypes } as RelationView
}

beforeEach(() => clearSessionTypeFilters())

describe('D212 关系类型过滤', () => {
  it('类型开关、无类型边、多类型边、计数与重置', () => {
    const relations = [
      rel(1, 1, 2, ['based_on']),
      rel(2, 2, 3, ['compares'], ['cites']),
      rel(3, 3, 4, []),
      rel(4, 4, 5, ['based_on'], ['same_author'])
    ]
    expect(relationTypeCounts(relations)).toEqual({ based_on: 2, implements: 0, compares: 1, cites: 1, same_author: 1 })
    const hidden = toggleHiddenRelationType(new Set(), 'based_on')
    expect(visibleRelationsByType(relations, hidden).map((r) => r.id)).toEqual([2, 3, 4])
    expect(visibleRelationsByType(relations, toggleHiddenRelationType(hidden, 'based_on')).map((r) => r.id)).toEqual([1, 2, 3, 4])
    expect(visibleRelationsByType(relations, new Set(['based_on', 'cites'])).map((r) => r.id)).toEqual([2, 3, 4])
  })

  it('按图谱读写会话过滤，空集合即重置且不影响其它图谱', () => {
    writeSessionTypeFilter(1, new Set(['cites']))
    writeSessionTypeFilter(2, new Set(['compares']))
    expect([...readSessionTypeFilter(1)]).toEqual(['cites'])
    expect([...readSessionTypeFilter(2)]).toEqual(['compares'])
    const read = readSessionTypeFilter(1)
    read.add('based_on')
    expect([...readSessionTypeFilter(1)]).toEqual(['cites'])
    writeSessionTypeFilter(1, new Set())
    expect(readSessionTypeFilter(1).size).toBe(0)
    expect([...readSessionTypeFilter(2)]).toEqual(['compares'])
  })
})

describe('D212 聚焦邻域', () => {
  const relations = [
    rel(1, 1, 2),
    rel(2, 2, 3, ['cites']),
    rel(3, 3, 4, ['compares']),
    rel(4, 1, 1),
    rel(5, 1, 2),
    rel(6, 2, 4)
  ]

  it('1 跳含直接邻居与其内部边，2 跳继续扩展；自环和重复边安全', () => {
    const adjacency = buildRelationAdjacency(relations)
    const one = focusNeighborhood(relations, 1, 1, adjacency)
    expect([...one.paperIds].sort()).toEqual([1, 2])
    expect([...one.relationIds].sort()).toEqual([1, 4, 5])
    const two = focusNeighborhood(relations, 1, 2, adjacency)
    expect([...two.paperIds].sort()).toEqual([1, 2, 3, 4])
    expect([...two.relationIds].sort()).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('邻域按过滤后的边计算，隐藏边不再把论文带入聚焦', () => {
    const visible = visibleRelationsByType(relations, new Set(['cites']))
    const two = focusNeighborhood(visible, 1, 2)
    expect([...two.paperIds].sort()).toEqual([1, 2, 4])
    expect([...two.relationIds].sort()).toEqual([1, 4, 5, 6])
  })

  it('孤立节点得到单节点邻域；根的自环不会误增节点', () => {
    const isolated = focusNeighborhood(relations, 99, 2)
    expect([...isolated.paperIds]).toEqual([99])
    expect(isolated.relationIds.size).toBe(0)
    expect([...buildRelationAdjacency([rel(7, 8, 8)]).get(8)!]).toEqual([8])
  })
})

describe('D212 按需强调与快捷键', () => {
  const relations = [rel(1, 1, 2), rel(2, 2, 3), rel(3, 3, 4)]

  it('hover 优先于选择，多选取并集，清除后恢复无强调', () => {
    const selected = neighborhoodEmphasis(relations, null, new Set([1, 4]))
    expect([...selected.paperIds].sort()).toEqual([1, 2, 3, 4])
    expect([...selected.relationIds].sort()).toEqual([1, 2, 3])
    const hovered = neighborhoodEmphasis(relations, 2, new Set([1, 4]))
    expect([...hovered.paperIds].sort()).toEqual([1, 2, 3])
    expect([...hovered.relationIds].sort()).toEqual([1, 2])
    const cleared = neighborhoodEmphasis(relations, null, new Set())
    expect(cleared).toEqual({ active: false, paperIds: new Set(), relationIds: new Set() })
  })

  it('邻居之间的弦边为 hi，出邻域的边为 dim（hover 与多选同口径）', () => {
    const chord = [rel(1, 1, 2), rel(2, 2, 3), rel(4, 1, 3), rel(3, 3, 4)]
    const hovered = neighborhoodEmphasis(chord, 1, new Set())
    expect([...hovered.paperIds].sort()).toEqual([1, 2, 3])
    expect([...hovered.relationIds].sort()).toEqual([1, 2, 4]) // 2（2–3）是弦，3（3–4）出邻域
    const selected = neighborhoodEmphasis(chord, null, new Set([1]))
    expect([...selected.relationIds].sort()).toEqual([1, 2, 4])
    const dim = neighborhoodEmphasis(chord, null, new Set([4]))
    expect([...dim.paperIds].sort()).toEqual([3, 4])
    expect([...dim.relationIds].sort()).toEqual([3])
  })

  it('选中孤立节点仍强调自身', () => {
    const state = neighborhoodEmphasis([], 7, new Set([1]))
    expect(state.active).toBe(true)
    expect([...state.paperIds]).toEqual([7])
    expect(state.relationIds.size).toBe(0)
  })

  it('F 只接受单选裸键；输入框、修饰键、IME、无选中均忽略', () => {
    const base = { key: 'f', inputFocused: false, selectedCount: 1 }
    expect(shouldRunFocusShortcut(base)).toBe(true)
    expect(shouldRunFocusShortcut({ ...base, key: 'F' })).toBe(true)
    expect(shouldRunFocusShortcut({ ...base, inputFocused: true })).toBe(false)
    expect(shouldRunFocusShortcut({ ...base, selectedCount: 0 })).toBe(false)
    expect(shouldRunFocusShortcut({ ...base, selectedCount: 2 })).toBe(false)
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'isComposing'] as const) {
      expect(shouldRunFocusShortcut({ ...base, [modifier]: true })).toBe(false)
    }
    expect(shouldRunFocusShortcut({ ...base, key: 'x' })).toBe(false)
  })
})
