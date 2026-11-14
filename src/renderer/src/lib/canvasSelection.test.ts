import { describe, expect, it } from 'vitest'
import type { RelationView } from '../../../shared/ipc'
import {
  canvasEscAction,
  filterCanvasNodeChanges,
  movedPaperPositions,
  paperNodeId,
  prunePaperSelection,
  pruneSubgraphSelection,
  selectionAfterPaneClick,
  removalRelationSnapshots,
  withPaperSelection,
  subgraphRelationIds,
  togglePaperSelection
} from './canvasSelection'

function rel(id: number, low: number, high: number): RelationView {
  return { id, paperLow: low, paperHigh: high, srcPaper: low } as RelationView
}

describe('D176 选择与子图纯函数', () => {
  it('只认真实论文节点 id，候选与临时节点不可选', () => {
    expect(paperNodeId('12')).toBe(12)
    expect(paperNodeId('cand-12')).toBeNull()
    expect(paperNodeId('tmp-cand-12')).toBeNull()
    expect(paperNodeId('0')).toBeNull()
  })

  it('⌘/Ctrl/Shift 切换、reload 保留并 prune 已移除成员', () => {
    let selected = new Set([1])
    selected = togglePaperSelection(selected, 2)
    selected = togglePaperSelection(selected, 3)
    expect([...selected]).toEqual([1, 2, 3])
    expect([...togglePaperSelection(selected, 3)]).toEqual([1, 2])
    expect([...prunePaperSelection(selected, new Set([1, 3, 9]))]).toEqual([1, 3])
    const kept = new Set([1, 3])
    expect(prunePaperSelection(kept, new Set([1, 3, 9]))).toBe(kept)
  })

  it('detail 刷新不清仍有成员的子图；不足两篇才退出', () => {
    const subgraph = new Set([1, 2, 3])
    expect(pruneSubgraphSelection(subgraph, new Set([1, 2, 3, 4]))).toBe(subgraph)
    expect([...pruneSubgraphSelection(subgraph, new Set([1, 2]))!]).toEqual([1, 2])
    expect(pruneSubgraphSelection(subgraph, new Set([1]))).toBeNull()
    expect(pruneSubgraphSelection(null, new Set([1, 2]))).toBeNull()
  })

  it('子图 pane click 与 xyflow select:false 都不改冻结选择', () => {
    const selected = new Set([1, 2])
    expect(selectionAfterPaneClick(selected, true)).toBe(selected)
    expect([...selectionAfterPaneClick(selected, false)]).toEqual([])
    const changes = [
      { type: 'select', id: '1', selected: false },
      { type: 'position', id: '1' },
      { type: 'remove', id: '1' }
    ]
    expect(filterCanvasNodeChanges(changes, true)).toEqual([{ type: 'position', id: '1' }])
    expect(filterCanvasNodeChanges(changes, false)).toEqual([
      { type: 'select', id: '1', selected: false },
      { type: 'position', id: '1' }
    ])
  })

  it('选择只翻变化的节点，未变化时保持原数组', () => {
    const nodes = [
      { id: '1', selected: true },
      { id: '2', selected: false },
      { id: 'cand-9', selected: false }
    ]
    expect(withPaperSelection(nodes, new Set([1]))).toBe(nodes)
    const next = withPaperSelection(nodes, new Set([2]))
    expect(next).not.toBe(nodes)
    expect(next[0]).toEqual({ id: '1', selected: false })
    expect(next[1]).toEqual({ id: '2', selected: true })
    expect(next[2]).toBe(nodes[2])
  })

  it('子图只高亮两端都选中的关系；单端选中的边淡化', () => {
    const relations = [rel(1, 1, 2), rel(2, 2, 3), rel(3, 3, 4), rel(4, 1, 3)]
    expect([...subgraphRelationIds(relations, new Set([1, 2]))]).toEqual([1])
    expect([...subgraphRelationIds(relations, new Set([1, 2, 3]))].sort()).toEqual([1, 2, 4])
  })

  it('批量移除的共享边快照按关系 id 去重', () => {
    const snapshots = removalRelationSnapshots([rel(1, 1, 2), rel(2, 2, 3), rel(3, 3, 4)], new Set([1, 2]))
    expect(snapshots.map((r) => r.id)).toEqual([1, 2])
  })

  it('多选拖动只返回位置真正变化的论文，候选与静止节点不写库', () => {
    const origin = new Map([
      ['1', { x: 0, y: 0 }],
      ['2', { x: 10, y: 10 }],
      ['cand-3', { x: 0, y: 0 }]
    ])
    const moved = movedPaperPositions(origin, [
      { id: '1', position: { x: 5, y: 6 } },
      { id: '2', position: { x: 10, y: 10 } },
      { id: 'cand-3', position: { x: 8, y: 8 } }
    ])
    expect(moved).toEqual([{ id: '1', position: { x: 5, y: 6 } }])
  })
})

describe('D176 Esc 层级（一次一层）', () => {
  const base = { inputFocused: false, modalOpen: false, menuOpen: false, externalLayerOpen: false, focusOpen: false, subgraphOpen: false, hasSelection: false }
  it('输入框 / 笔记草稿优先，画布不动作', () => {
    expect(canvasEscAction({ ...base, inputFocused: true, modalOpen: true, menuOpen: true, subgraphOpen: true, hasSelection: true })).toBe('input')
  })
  it('对话框先于弹层', () => {
    expect(canvasEscAction({ ...base, modalOpen: true, menuOpen: true, subgraphOpen: true, hasSelection: true })).toBe('modal')
  })
  it('弹层先于外部弹层、子图与选择', () => {
    expect(canvasEscAction({ ...base, menuOpen: true, externalLayerOpen: true, subgraphOpen: true, hasSelection: true })).toBe('menu')
    expect(canvasEscAction({ ...base, externalLayerOpen: true, subgraphOpen: true, hasSelection: true })).toBe('external-layer')
  })
  it('弹层先关闭且聚焦保留；下一次 Esc 才退聚焦', () => {
    expect(canvasEscAction({ ...base, menuOpen: true, focusOpen: true, hasSelection: true })).toBe('menu')
    expect(canvasEscAction({ ...base, externalLayerOpen: true, focusOpen: true, hasSelection: true })).toBe('external-layer')
    expect(canvasEscAction({ ...base, focusOpen: true, hasSelection: true })).toBe('focus')
  })
  it('聚焦先于子图与选择，退出后仍保留选择', () => {
    expect(canvasEscAction({ ...base, focusOpen: true, subgraphOpen: true, hasSelection: true })).toBe('focus')
    expect(canvasEscAction({ ...base, subgraphOpen: true, hasSelection: true })).toBe('subgraph')
    expect(canvasEscAction({ ...base, hasSelection: true })).toBe('clear-selection')
    expect(canvasEscAction(base)).toBe('none')
  })
})
