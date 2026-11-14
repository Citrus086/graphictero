// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement as h } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphDetail, PaperSummary, RelationView } from '../../../shared/ipc'
import { NotifyContext } from '../lib/notify'
import { clearCanvasFocuses, clearCanvasViews } from '../lib/subgraphRestore'
import { clearSessionTypeFilters } from '../lib/canvasFocus'

const flow = vi.hoisted(() => ({
  props: null as any,
  fitView: vi.fn(),
  setViewport: vi.fn(),
  viewport: { x: 12, y: 24, zoom: 0.8 }
}))

vi.mock('@xyflow/react', async () => {
  const React = await import('react')
  function ReactFlowStub(props: any) {
    flow.props = props
    React.useEffect(() => {
      props.onInit?.({
        fitView: flow.fitView,
        setViewport: flow.setViewport,
        getViewport: () => ({ ...flow.viewport }),
        screenToFlowPosition: (p: unknown) => p
      })
    }, [props.onInit])
    const choose = (e: MouseEvent, n: any): void => {
      if (n.selectable === false) return
      const current = (props.nodes ?? []).filter((x: any) => x.selected)
      let next = current
      if (e.metaKey || e.ctrlKey || e.shiftKey) {
        next = current.some((x: any) => x.id === n.id) ? current.filter((x: any) => x.id !== n.id) : [...current, n]
      } else next = [n]
      props.onSelectionChange?.({ nodes: next, edges: [] })
    }
    return React.createElement(
      'div',
      { 'data-testid': 'rf' },
      (props.nodes ?? []).map((n: any) =>
        React.createElement('div', {
          key: n.id,
          'data-testid': 'rf-node',
          'data-id': n.id,
          'data-x': String(n.position.x),
          'data-y': String(n.position.y),
          'data-selected': String(!!n.selected),
          'data-selectable': String(n.selectable !== false),
          'data-hidden': String(!!n.hidden),
          className: `react-flow__node react-flow__node-paper ${n.selected ? 'sel ' : ''}${n.className ?? ''}`,
          style: n.hidden ? { display: 'none' } : undefined,
          onMouseEnter: (e: MouseEvent) => props.onNodeMouseEnter?.(e, n),
          onMouseLeave: (e: MouseEvent) => props.onNodeMouseLeave?.(e, n),
          onClick: (e: MouseEvent) => {
            choose(e, n)
            props.onNodeClick?.(e, n)
          },
          onDoubleClick: (e: MouseEvent) => props.onNodeDoubleClick?.(e, n),
          onContextMenu: (e: MouseEvent) => props.onNodeContextMenu?.(e, n)
        })
      ),
      (props.edges ?? []).map((e: any) =>
        React.createElement('div', {
          key: e.id,
          'data-testid': 'rf-edge',
          'data-id': e.id,
          'data-source': e.source,
          'data-target': e.target,
          'data-hidden': String(!!e.hidden),
          className: `react-flow__edge ${e.className ?? ''}`,
          style: e.hidden ? { display: 'none' } : undefined
        })
      )
    )
  }
  return {
    ReactFlow: ReactFlowStub,
    Background: () => null,
    Controls: () => null,
    BackgroundVariant: { Dots: 'dots' },
    MarkerType: { ArrowClosed: 'arrowclosed' },
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
    applyNodeChanges: (_changes: unknown[], ns: unknown[]) => ns
  }
})

const gt = vi.hoisted(() => ({
  getGraph: vi.fn(), listLibrary: vi.fn(), getPapersStatus: vi.fn(), getJobsOverview: vi.fn(), getWaitingCount: vi.fn(),
  getMineruStatus: vi.fn(), installMineru: vi.fn(), startMineru: vi.fn(), relationsStatus: vi.fn(), listCandidates: vi.fn(),
  setNodePosition: vi.fn(), removePaperFromGraph: vi.fn(), addPapersToGraph: vi.fn(), restoreRelation: vi.fn(),
  restorePaperProgress: vi.fn(), restoreRemovedPaper: vi.fn(), restoreGraphUpdatedAt: vi.fn(), undoGraphRemoval: vi.fn(), deletePaperFromLibrary: vi.fn(), moveCandidate: vi.fn(), relationDetail: vi.fn(),
  paperRelationStats: vi.fn(),
  onGenerateProgress: vi.fn(() => () => {}), onParseProgress: vi.fn(() => () => {}), onMineruStatus: vi.fn(() => () => {}),
  onLibraryChanged: vi.fn(() => () => {}), onAgentCandidates: vi.fn(() => () => {}), onCandProgress: vi.fn(() => () => {})
}))

let GraphPage: typeof import('./GraphPage').GraphPage
let notify: (msg: string) => void
let onOpenPaper: (paperId: number) => void
let onAddPaperChips: (paperIds: number[]) => void
let onChatDragHover: (active: boolean) => void

beforeAll(async () => {
  ;(window as unknown as { graphictero: unknown }).graphictero = gt
  GraphPage = (await import('./GraphPage')).GraphPage
})

function paper(id: number): PaperSummary {
  return { id, title: `论文${id}`, firstAuthor: 'A', year: 2026, hasPdf: true } as never
}
function rel(id: number, low: number, high: number): RelationView {
  return {
    id, paperLow: low, paperHigh: high, srcPaper: low, statement: '', llmTypes: ['based_on'], autoTypes: [], createdAt: '',
    sourceType: 'job', sourceJobId: 1, sourceSessionId: null, model: 'm', promptVersion: 'v', editedAt: null,
    noRefBasis: false, updatedAt: '2026-10-28T00:00:00Z'
  }
}

const store: { detail: GraphDetail } = {
  detail: {
    graph: { id: 1, name: 'uat7', createdAt: '', updatedAt: '', paperCount: 4, relationCount: 4 },
    members: [1, 2, 3, 4].map((id) => ({ paper: paper(id), x: id * 100, y: id * 20 })),
    relations: [rel(101, 1, 2), rel(102, 2, 3), rel(103, 3, 4), rel(104, 1, 3)]
  }
}
function fresh(): GraphDetail {
  return JSON.parse(JSON.stringify(store.detail)) as GraphDetail
}

beforeEach(() => {
  for (const fn of Object.values(gt)) fn.mockClear()
  gt.getGraph.mockImplementation(async () => fresh())
  gt.listLibrary.mockImplementation(async () => fresh().members.map((m) => ({ ...m.paper, inGraph: true })))
  gt.getPapersStatus.mockResolvedValue([])
  gt.getJobsOverview.mockResolvedValue({ queued: 0, running: 0, waitingNetwork: 0, waitingKey: 0, failedRetryable: 0, failedAction: 0, pauseSummary: null, failed: [] })
  gt.getWaitingCount.mockResolvedValue(0)
  gt.getMineruStatus.mockResolvedValue({ state: 'ready' })
  gt.installMineru.mockResolvedValue({})
  gt.startMineru.mockResolvedValue({})
  gt.relationsStatus.mockResolvedValue({ running: false })
  gt.listCandidates.mockResolvedValue([])
  gt.setNodePosition.mockResolvedValue(undefined)
  // uat7b S1：返回移除前原时间戳（added_at / doneAt / graphs.updated_at）
  gt.removePaperFromGraph.mockImplementation(async (_g: number, id: number) => ({
    hadProgress: id === 1,
    addedAt: `2026-10-0${id}T00:00:00.000Z`,
    doneAt: id === 1 ? '2026-10-02T00:00:00.000Z' : null,
    graphUpdatedAt: '2026-10-01T12:00:00.000Z'
  }))
  gt.addPapersToGraph.mockResolvedValue([1, 2])
  gt.restoreRelation.mockResolvedValue(1)
  gt.restorePaperProgress.mockResolvedValue(undefined)
  gt.restoreRemovedPaper.mockResolvedValue(undefined)
  gt.restoreGraphUpdatedAt.mockResolvedValue(undefined)
  gt.undoGraphRemoval.mockImplementation(async (input: { papers: Array<{ paperId: number }> }) => ({
    restored: input.papers.length,
    skipped: 0,
    applied: input.papers.length > 0,
    restoredIds: input.papers.map((p) => p.paperId)
  }))
  gt.deletePaperFromLibrary.mockResolvedValue(undefined)
  gt.moveCandidate.mockResolvedValue(undefined)
  gt.paperRelationStats.mockResolvedValue({ count: 5, graphCount: 2 })
  gt.relationDetail.mockResolvedValue({
    id: 101, graphId: 1, paperLow: 1, paperHigh: 2, srcPaper: 1, statement: '', llmTypes: ['based_on'], autoTypes: [],
    sourceType: 'job', sourceJobId: 1, sourceSessionId: null, model: 'm', promptVersion: 'v', editedAt: null,
    noRefBasis: false, createdAt: '', updatedAt: ''
  })
  flow.props = null
  flow.fitView.mockClear()
  flow.setViewport.mockClear()
  notify = vi.fn()
  onOpenPaper = vi.fn()
  onAddPaperChips = vi.fn()
  onChatDragHover = vi.fn()
  store.detail = {
    graph: { id: 1, name: 'uat7', createdAt: '', updatedAt: '', paperCount: 4, relationCount: 4 },
    members: [1, 2, 3, 4].map((id) => ({ paper: paper(id), x: id * 100, y: id * 20 })),
    relations: [rel(101, 1, 2), rel(102, 2, 3), rel(103, 3, 4), rel(104, 1, 3)]
  }
  document.elementFromPoint = vi.fn(() => null)
})

afterEach(() => {
  cleanup()
  // uat7b M1：卸载会暂存子图视图状态，测试间要清掉，避免跨用例恢复
  clearCanvasViews()
  clearCanvasFocuses()
  clearSessionTypeFilters()
  document.querySelectorAll('[data-testid="chat-drawer"], #uat7-input, #uat7b-input').forEach((el) => el.remove())
})

function mount() {
  return render(
    h(NotifyContext.Provider, { value: notify },
      h(GraphPage, {
        graphId: 1, onHome: () => {}, onOpenSettings: () => {}, onOpenParseSettings: () => {},
        onOpenPaper, chatOpen: true, onAddPaperChips, onChatDragHover
      })
    )
  )
}
const nodes = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="rf-node"]'))
const node = (id: number): HTMLElement => document.querySelector<HTMLElement>(`[data-testid="rf-node"][data-id="${id}"]`)!
const selected = (): string[] => nodes().filter((n) => n.dataset.selected === 'true').map((n) => n.dataset.id!)
const esc = async (target: HTMLElement | Window = window): Promise<void> => {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
}

describe('D176 单击 / 双击 / 多选 / 删除键 / reload', () => {
  it('单击只选择并关面板，双击才打开详情且禁双击缩放', async () => {
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    fireEvent.click(node(1))
    await vi.waitFor(() => expect(selected()).toEqual(['1']))
    expect(onOpenPaper).not.toHaveBeenCalled()
    fireEvent.doubleClick(node(1))
    expect(onOpenPaper).toHaveBeenCalledTimes(1)
    expect(onOpenPaper).toHaveBeenCalledWith(1)
    expect(flow.props.zoomOnDoubleClick).toBe(false)
  })

  it('⌘/Ctrl/Shift-click 切换，点空白清空', async () => {
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    fireEvent.click(node(1))
    fireEvent.click(node(2), { metaKey: true })
    fireEvent.click(node(3), { shiftKey: true })
    await vi.waitFor(() => expect(selected()).toEqual(['1', '2', '3']))
    fireEvent.click(node(3), { ctrlKey: true })
    await vi.waitFor(() => expect(selected()).toEqual(['1', '2']))
    expect(flow.props.multiSelectionKeyCode).toEqual(['Meta', 'Control', 'Shift'])
    await act(async () => flow.props.onPaneClick())
    await vi.waitFor(() => expect(selected()).toEqual([]))
  })

  it('框选选择变化接入同一事实源；reload 保留，移除成员自动出选择', async () => {
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    await act(async () => flow.props.onSelectionChange({ nodes: [flow.props.nodes[0], flow.props.nodes[1]], edges: [] }))
    await vi.waitFor(() => expect(selected()).toEqual(['1', '2']))
    await act(async () => window.dispatchEvent(new CustomEvent('gt:graph-changed')))
    await vi.waitFor(() => expect(gt.getGraph).toHaveBeenCalledTimes(2))
    expect(selected()).toEqual(['1', '2'])
    store.detail.members = store.detail.members.filter((m) => m.paper.id !== 2)
    store.detail.relations = store.detail.relations.filter((r) => r.paperLow !== 2 && r.paperHigh !== 2)
    await act(async () => window.dispatchEvent(new CustomEvent('gt:graph-changed')))
    await vi.waitFor(() => expect(nodes()).toHaveLength(3))
    expect(selected()).toEqual(['1'])
  })

  it('候选节点 selectable=false；deleteKeyCode=null 且 remove change 被忽略', async () => {
    gt.listCandidates.mockResolvedValue([{ id: 9, graphId: 1, title: '候选', authors: [], x: 0, y: 0, status: 'pending' }])
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(5))
    const candidate = document.querySelector<HTMLElement>('[data-id="cand-9"]')!
    expect(candidate.dataset.selectable).toBe('false')
    fireEvent.click(candidate)
    expect(selected()).toEqual([])
    expect(flow.props.deleteKeyCode).toBeNull()
    const before = nodes().length
    await act(async () => flow.props.onNodesChange([{ type: 'remove', id: '1' }]))
    expect(nodes()).toHaveLength(before)
    expect(gt.removePaperFromGraph).not.toHaveBeenCalled()
  })
})

describe('D176 多选拖动与拖入对话', () => {
  function dragTwo(toDrawer: boolean): void {
    const origin1 = { ...flow.props.nodes.find((n: any) => n.id === '1') }
    const origin2 = { ...flow.props.nodes.find((n: any) => n.id === '2') }
    const event = new MouseEvent('pointerup', { clientX: 500, clientY: 300 })
    flow.props.onNodeDragStart(event, origin1, [origin1, origin2])
    if (toDrawer) flow.props.onNodeDrag(event, origin1, [origin1, origin2])
    flow.props.onNodeDragStop(
      event,
      { ...origin1, position: { x: 999, y: 888 } },
      [
        { ...origin1, position: { x: 999, y: 888 } },
        { ...origin2, position: { x: 777, y: 666 } },
        { id: 'cand-9', type: 'candidate', position: { x: 1, y: 2 } }
      ]
    )
  }

  it('拖动一个已选节点，全部已选且实际移动的节点一起写库', async () => {
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    fireEvent.click(node(1))
    fireEvent.click(node(2), { metaKey: true })
    await vi.waitFor(() => expect(selected()).toEqual(['1', '2']))
    dragTwo(false)
    expect(gt.setNodePosition).toHaveBeenCalledWith(1, 1, 999, 888)
    expect(gt.setNodePosition).toHaveBeenCalledWith(1, 2, 777, 666)
    expect(gt.setNodePosition).toHaveBeenCalledTimes(2)
  })

  it('拖到抽屉：全部已选成为 chip，位置回滚、不写库、不进撤销栈', async () => {
    const drawer = document.createElement('div')
    drawer.dataset.testid = 'chat-drawer'
    document.body.appendChild(drawer)
    document.elementFromPoint = vi.fn(() => drawer)
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    fireEvent.click(node(1))
    fireEvent.click(node(2), { metaKey: true })
    await vi.waitFor(() => expect(selected()).toEqual(['1', '2']))
    dragTwo(true)
    expect(onAddPaperChips).toHaveBeenCalledWith([1, 2])
    expect(onChatDragHover).toHaveBeenCalledWith(true)
    expect(onChatDragHover).toHaveBeenLastCalledWith(false)
    expect(gt.setNodePosition).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(node(1).dataset.x).toBe('100'))
    expect(node(2).dataset.x).toBe('200')
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true })))
    expect(notify).toHaveBeenCalledWith('没有可撤销的操作')
    expect(gt.restoreRelation).not.toHaveBeenCalled()
  })

  it('B3：未选中的节点拖到抽屉也成为 chip，不写坐标；别的已选节点不跟着走', async () => {
    const drawer = document.createElement('div')
    drawer.dataset.testid = 'chat-drawer'
    document.body.appendChild(drawer)
    document.elementFromPoint = vi.fn(() => drawer)
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    fireEvent.click(node(2))
    await vi.waitFor(() => expect(selected()).toEqual(['2']))
    const origin1 = { ...flow.props.nodes.find((n: any) => n.id === '1') }
    const event = new MouseEvent('pointerup', { clientX: 500, clientY: 300 })
    flow.props.onNodeDragStart(event, origin1, [origin1])
    // 模拟真实 xyflow：拖起未选节点会触发默认选择；落抽屉后必须恢复快照 ['2']。
    await act(async () => flow.props.onSelectionChange({ nodes: [{ ...origin1, selected: true }], edges: [] }))
    await vi.waitFor(() => expect(selected()).toEqual(['1']))
    flow.props.onNodeDrag(event, origin1, [origin1])
    flow.props.onNodeDragStop(event, { ...origin1, position: { x: 2778, y: 1528 } }, [{ ...origin1, position: { x: 2778, y: 1528 } }])
    expect(onAddPaperChips).toHaveBeenCalledWith([1])
    expect(gt.setNodePosition).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(node(1).dataset.x).toBe('100'))
    await vi.waitFor(() => expect(selected()).toEqual(['2']))
  })
})

describe('D176 子图与 Esc 层级', () => {
  async function selectTwoAndOpenMenu(): Promise<void> {
    fireEvent.click(node(1))
    fireEvent.click(node(2), { metaKey: true })
    await vi.waitFor(() => expect(selected()).toEqual(['1', '2']))
    fireEvent.contextMenu(node(1), { clientX: 100, clientY: 100 })
    await screen.findByTestId('selection-menu')
  }

  it('右键进子图：仅两端已选边高亮，其余节点边淡化；Esc 两层退出', async () => {
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    await selectTwoAndOpenMenu()
    fireEvent.click(screen.getByTestId('menu-subgraph'))
    const banner = await screen.findByTestId('subgraph-banner')
    expect(banner.textContent).toContain('子图 · 2 篇 · 1 条关系')
    expect(node(1).className).toContain('gt-sub-hi')
    expect(node(3).className).toContain('gt-sub-dim')
    expect(document.querySelector('[data-testid="rf-edge"][data-id="101"]')!.className).toContain('gt-sub-hi')
    expect(document.querySelector('[data-testid="rf-edge"][data-id="102"]')!.className).toContain('gt-sub-dim')
    expect(flow.props.selectionKeyCode).toBeNull()
    await esc()
    expect(screen.queryByTestId('subgraph-banner')).toBeNull()
    expect(selected()).toEqual(['1', '2'])
    await esc()
    expect(selected()).toEqual([])
  })

  it('菜单开着时 Esc 只关菜单；输入框 Esc 不动子图或选择', async () => {
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    await selectTwoAndOpenMenu()
    await esc()
    expect(screen.queryByTestId('selection-menu')).toBeNull()
    expect(selected()).toEqual(['1', '2'])
    fireEvent.contextMenu(node(1))
    fireEvent.click(await screen.findByTestId('menu-subgraph'))
    const input = document.createElement('textarea')
    input.id = 'uat7-input'
    document.body.appendChild(input)
    await esc(input)
    expect(screen.getByTestId('subgraph-banner')).toBeTruthy()
    expect(selected()).toEqual(['1', '2'])
  })
})

describe('D179 右键菜单、批量移除与侧栏从库删除', () => {
  it('单节点菜单无「从库删除」；多选批量移除只压一条撤销，共享边只恢复一次', async () => {
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    fireEvent.contextMenu(node(3))
    const single = await screen.findByTestId('paper-menu')
    expect(single.textContent).toContain('从图谱移除')
    expect(single.textContent).not.toContain('从库删除')
    await esc()
    fireEvent.click(node(1))
    fireEvent.click(node(2), { metaKey: true })
    fireEvent.contextMenu(node(1))
    const multi = await screen.findByTestId('selection-menu')
    expect(multi.textContent).toContain('查看所选子图')
    expect(multi.textContent).toContain('从图谱移除所选 2 篇')
    expect(multi.textContent).not.toContain('从库删除')
    fireEvent.click(screen.getByTestId('menu-remove-graph'))
    await vi.waitFor(() => expect(gt.removePaperFromGraph).toHaveBeenCalledTimes(2))
    expect(notify).toHaveBeenCalledWith('已从图谱移除 2 篇 · 可用 ⌘Z 撤销')
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true })))
    // uat8b B5：撤销改走一次 undoGraphRemoval（时间戳与坐标在载荷里，主进程写回）。
    expect(gt.addPapersToGraph).not.toHaveBeenCalled()
    expect(gt.restoreRemovedPaper).not.toHaveBeenCalled()
    expect(gt.restoreRelation).not.toHaveBeenCalled()
    expect(gt.restoreGraphUpdatedAt).not.toHaveBeenCalled()
    expect(gt.undoGraphRemoval).toHaveBeenCalledTimes(1)
    const undoInput = gt.undoGraphRemoval.mock.calls[0][0]
    expect(undoInput.graphUpdatedAt).toBe('2026-10-01T12:00:00.000Z')
    expect(undoInput.papers).toEqual([
      { paperId: 1, x: 100, y: 20, addedAt: '2026-10-01T00:00:00.000Z', doneAt: '2026-10-02T00:00:00.000Z' },
      { paperId: 2, x: 200, y: 40, addedAt: '2026-10-02T00:00:00.000Z', doneAt: null }
    ])
    expect(undoInput.relations.map((r: { id: number }) => r.id)).toEqual([101, 102, 104])
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('已撤销：从图谱移除 2 篇'))
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true })))
    await vi.waitFor(() => expect(gt.removePaperFromGraph).toHaveBeenCalledTimes(4))
  })

  it('部分失败也只为成功批次压一条撤销', async () => {
    gt.removePaperFromGraph.mockImplementation(async (_g: number, id: number) => {
      if (id === 2) throw new Error('fixture failure')
      return { hadProgress: true, addedAt: '2026-10-01T00:00:00.000Z', doneAt: '2026-10-02T00:00:00.000Z', graphUpdatedAt: '2026-10-01T12:00:00.000Z' }
    })
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    fireEvent.click(node(1))
    fireEvent.click(node(2), { metaKey: true })
    fireEvent.contextMenu(node(1))
    fireEvent.click(await screen.findByTestId('menu-remove-graph'))
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('已移除 1 / 2 篇，其余失败 · 可用 ⌘Z 撤销'))
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true })))
    expect(gt.addPapersToGraph).not.toHaveBeenCalled()
    const undoInput = gt.undoGraphRemoval.mock.calls[0][0]
    expect(undoInput.papers).toEqual([
      { paperId: 1, x: 100, y: 20, addedAt: '2026-10-01T00:00:00.000Z', doneAt: '2026-10-02T00:00:00.000Z' }
    ])
    expect(undoInput.relations.map((r: { id: number }) => r.id)).toEqual([101, 104])
  })

  it('全部已软删：撤销不报错，提示无法恢复，重做不再移除', async () => {
    gt.undoGraphRemoval.mockResolvedValue({ restored: 0, skipped: 1, applied: false, restoredIds: [] })
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    fireEvent.contextMenu(node(3))
    fireEvent.click(await screen.findByTestId('menu-remove-graph'))
    await vi.waitFor(() => expect(gt.removePaperFromGraph).toHaveBeenCalledTimes(1))
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true })))
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('论文已从论文库删除，无法恢复'))
    expect(notify).not.toHaveBeenCalledWith('已撤销：从图谱移除')
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true })))
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('已重做：从图谱移除'))
    expect(gt.removePaperFromGraph).toHaveBeenCalledTimes(1)
  })

  it('部分软删：提示已恢复 N 篇，重做只再移除恢复回去的论文', async () => {
    gt.undoGraphRemoval.mockResolvedValue({ restored: 1, skipped: 1, applied: true, restoredIds: [1] })
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    fireEvent.click(node(1))
    fireEvent.click(node(2), { metaKey: true })
    fireEvent.contextMenu(node(1))
    fireEvent.click(await screen.findByTestId('menu-remove-graph'))
    await vi.waitFor(() => expect(gt.removePaperFromGraph).toHaveBeenCalledTimes(2))
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true })))
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('已恢复 1 篇，1 篇已从论文库删除'))
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true })))
    await vi.waitFor(() => expect(gt.removePaperFromGraph).toHaveBeenCalledTimes(3))
    expect(gt.removePaperFromGraph.mock.calls[2]).toEqual([1, 1])
  })

  it('侧栏论文行右键才有「从库删除…」，确认调一次；取消不调', async () => {
    mount()
    await screen.findAllByTestId('side-member-row')
    const row = screen.getAllByTestId('side-member-row')[0]
    fireEvent.contextMenu(row)
    fireEvent.click(await screen.findByTestId('menu-delete-library'))
    fireEvent.click(screen.getByText('取消'))
    expect(gt.deletePaperFromLibrary).not.toHaveBeenCalled()
    fireEvent.contextMenu(row)
    fireEvent.click(await screen.findByTestId('menu-delete-library'))
    fireEvent.click(screen.getByRole('button', { name: '从库删除' }))
    await vi.waitFor(() => expect(gt.deletePaperFromLibrary).toHaveBeenCalledWith(1))
    expect(gt.deletePaperFromLibrary).toHaveBeenCalledTimes(1)
  })
})

describe('uat7b S2 从库删除确认文案', () => {
  it('成员行：显示跨图谱关系数与涉及图谱数，并给出「从图谱移除」建议', async () => {
    mount()
    await screen.findAllByTestId('side-member-row')
    fireEvent.contextMenu(screen.getAllByTestId('side-member-row')[0])
    fireEvent.click(await screen.findByTestId('menu-delete-library'))
    await vi.waitFor(() => expect(screen.getByText(/所有图谱里和它相连的 5 条关系/)).toBeTruthy())
    const dialog = document.querySelector('.modal.cfm')!
    expect(dialog.textContent).toContain('涉及 2 个图谱')
    expect(dialog.textContent).toContain('从图谱移除')
  })

  it('论文库·其他行（非成员）：显示跨图谱计数，但不给「从图谱移除」建议', async () => {
    gt.listLibrary.mockImplementation(async () => [
      ...fresh().members.map((m) => ({ ...m.paper, inGraph: true })),
      { ...paper(99), inGraph: false }
    ])
    mount()
    await screen.findAllByTestId('side-library-row')
    fireEvent.contextMenu(screen.getAllByTestId('side-library-row')[0])
    fireEvent.click(await screen.findByTestId('menu-delete-library'))
    await vi.waitFor(() => expect(screen.getByText(/所有图谱里和它相连的 5 条关系/)).toBeTruthy())
    const dialog = document.querySelector('.modal.cfm')!
    expect(dialog.textContent).not.toContain('从图谱移除')
  })
})

describe('uat7b M3 拖出画布不自动平移', () => {
  it('ReactFlow 渲染 props 带 autoPanOnNodeDrag=false', async () => {
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    expect(flow.props.autoPanOnNodeDrag).toBe(false)
  })
})

describe('uat7b M1 子图暗化节点 handler 守卫（不依赖 CSS）', () => {
  async function openSubgraph(): Promise<void> {
    fireEvent.click(node(1))
    fireEvent.click(node(2), { metaKey: true })
    await vi.waitFor(() => expect(selected()).toEqual(['1', '2']))
    fireEvent.contextMenu(node(1))
    fireEvent.click(await screen.findByTestId('menu-subgraph'))
    await screen.findByTestId('subgraph-banner')
  }

  it('暗化节点单击/双击/右键全部忽略；高亮节点双击仍开详情', async () => {
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    await openSubgraph()
    // 暗化节点 3：单击不改选择、双击不开详情、右键不出菜单（handler 层断言，与 CSS 无关）
    fireEvent.click(node(3))
    expect(selected()).toEqual(['1', '2'])
    fireEvent.doubleClick(node(3))
    expect(onOpenPaper).not.toHaveBeenCalled()
    fireEvent.contextMenu(node(3))
    expect(screen.queryByTestId('paper-menu')).toBeNull()
    expect(screen.queryByTestId('selection-menu')).toBeNull()
    // 高亮已选节点双击照常开详情（D176 不变）
    fireEvent.doubleClick(node(1))
    expect(onOpenPaper).toHaveBeenCalledWith(1)
  })

  it('暗化节点拖动不产生对话 chip、不写库、不改选择', async () => {
    const drawer = document.createElement('div')
    drawer.dataset.testid = 'chat-drawer'
    document.body.appendChild(drawer)
    document.elementFromPoint = vi.fn(() => drawer)
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    await openSubgraph()
    const dim = flow.props.nodes.find((n: any) => n.id === '3')
    const event = new MouseEvent('pointerup', { clientX: 500, clientY: 300 })
    flow.props.onNodeDragStart(event, dim, [dim])
    flow.props.onNodeDrag(event, dim, [dim])
    flow.props.onNodeDragStop(event, { ...dim, position: { x: 999, y: 888 } }, [{ ...dim, position: { x: 999, y: 888 } }])
    expect(onAddPaperChips).not.toHaveBeenCalled()
    expect(gt.setNodePosition).not.toHaveBeenCalled()
    expect(selected()).toEqual(['1', '2'])
    // 暗化节点的生成属性：不可拖 / 不可选 / 不可连线 / 不可聚焦
    expect(dim.draggable).toBe(false)
    expect(dim.selectable).toBe(false)
    expect(dim.connectable).toBe(false)
    expect(dim.focusable).toBe(false)
    // 高亮节点保持可拖（D176 子图内拖动写位置不变）
    const hi = flow.props.nodes.find((n: any) => n.id === '1')
    expect(hi.draggable).toBe(true)
  })

  it('暗化边点击不开关系面板（按子图成员判定，不靠 className）', async () => {
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    await openSubgraph()
    const dimEdge = flow.props.edges.find((e: any) => e.id === '102') // 2–3：一端暗化
    const hiEdge = flow.props.edges.find((e: any) => e.id === '101') // 1–2：两端高亮
    flow.props.onEdgeClick(new MouseEvent('click'), dimEdge)
    expect(flow.props.edges.find((e: any) => e.id === '102').selected).not.toBe(true)
    flow.props.onEdgeClick(new MouseEvent('click'), hiEdge)
    await vi.waitFor(() => expect(flow.props.edges.find((e: any) => e.id === '101').selected).toBe(true))
  })

  it('从子图双击高亮节点进详情，卸载重挂后子图与选择恢复', async () => {
    const first = mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    await openSubgraph()
    fireEvent.doubleClick(node(1))
    expect(onOpenPaper).toHaveBeenCalledWith(1)
    first.unmount() // 模拟路由切到详情页：GraphPage 卸载，暂存子图视图
    mount() // 返回同图谱：恢复
    await vi.waitFor(() => expect(nodes()).toHaveLength(4)) // 等 reload 后节点重建
    expect(screen.getByTestId('subgraph-banner')).toBeTruthy()
    expect(selected()).toEqual(['1', '2'])
    expect(node(1).className).toContain('gt-sub-hi')
    expect(node(3).className).toContain('gt-sub-dim')
  })

  it('暂存只对本图谱生效：换 graphId 挂载不恢复', async () => {
    const first = mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    await openSubgraph()
    first.unmount()
    render(
      h(NotifyContext.Provider, { value: notify },
        h(GraphPage, {
          graphId: 2, onHome: () => {}, onOpenSettings: () => {}, onOpenParseSettings: () => {},
          onOpenPaper, chatOpen: true, onAddPaperChips, onChatDragHover
        })
      )
    )
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    expect(screen.queryByTestId('subgraph-banner')).toBeNull()
    expect(selected()).toEqual([])
  })

  it('恢复时剔除已移除论文；剩余不足 2 篇不进子图、只恢复选择', async () => {
    const first = mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    await openSubgraph()
    first.unmount()
    // 详情页期间论文 2 被移出图谱
    store.detail.members = store.detail.members.filter((m) => m.paper.id !== 2)
    store.detail.relations = store.detail.relations.filter((r) => r.paperLow !== 2 && r.paperHigh !== 2)
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(3))
    await vi.waitFor(() => expect(screen.queryByTestId('subgraph-banner')).toBeNull())
    expect(selected()).toEqual(['1'])
  })
})

describe('uat7b D184 子图 Esc 分层与点空白', () => {
  async function openSubgraph(): Promise<HTMLTextAreaElement> {
    fireEvent.click(node(1))
    fireEvent.click(node(2), { metaKey: true })
    await vi.waitFor(() => expect(selected()).toEqual(['1', '2']))
    fireEvent.contextMenu(node(1))
    fireEvent.click(await screen.findByTestId('menu-subgraph'))
    await screen.findByTestId('subgraph-banner')
    const input = document.createElement('textarea')
    input.id = 'uat7b-input'
    input.value = '草稿内容'
    document.body.appendChild(input)
    input.focus()
    return input
  }

  it('子图 + 输入框有草稿：Esc① 只 blur 留草稿，Esc② 退子图留选择，Esc③ 清空选择', async () => {
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    const input = await openSubgraph()
    expect(document.activeElement).toBe(input)
    await esc(input)
    expect(document.activeElement).not.toBe(input) // ① 失焦
    expect(input.value).toBe('草稿内容') // 草稿保留
    expect(screen.getByTestId('subgraph-banner')).toBeTruthy() // 子图不动
    expect(selected()).toEqual(['1', '2'])
    await esc() // ② 退子图（保留选择）
    expect(screen.queryByTestId('subgraph-banner')).toBeNull()
    expect(selected()).toEqual(['1', '2'])
    await esc() // ③ 清空选择
    expect(selected()).toEqual([])
    input.remove()
  })

  it('Esc 事件 target 落到 window 时仍按当前输入框先 blur', async () => {
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    const input = await openSubgraph()
    await esc(window)
    expect(document.activeElement).not.toBe(input)
    expect(input.value).toBe('草稿内容')
    expect(screen.getByTestId('subgraph-banner')).toBeTruthy()
    expect(selected()).toEqual(['1', '2'])
    input.remove()
  })

  it('子图打开时 gt:graph-changed reload 保留横幅、选择与冻结集合', async () => {
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    const input = await openSubgraph()
    const before = gt.getGraph.mock.calls.length
    await act(async () => {
      window.dispatchEvent(new CustomEvent('gt:graph-changed'))
    })
    await vi.waitFor(() => expect(gt.getGraph.mock.calls.length).toBeGreaterThan(before))
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    expect(screen.getByTestId('subgraph-banner')).toBeTruthy()
    expect(selected()).toEqual(['1', '2'])
    input.remove()
  })

  it('子图里点空白不清选择，高亮节点保留 sel 描边类', async () => {
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    fireEvent.click(node(1))
    fireEvent.click(node(2), { metaKey: true })
    await vi.waitFor(() => expect(selected()).toEqual(['1', '2']))
    fireEvent.contextMenu(node(1))
    fireEvent.click(await screen.findByTestId('menu-subgraph'))
    await screen.findByTestId('subgraph-banner')
    await act(async () => flow.props.onPaneClick())
    expect(selected()).toEqual(['1', '2']) // 子图外点空白才清空（D176 不变）
    expect(node(1).className).toContain('sel')
    expect(node(2).className).toContain('sel')
    // D184-② 数据层真源：高亮已选节点带 subSelected（xyflow 清内部 selected 后描边仍在）
    expect(flow.props.nodes.find((n: any) => n.id === '1').data.subSelected).toBe(true)
    expect(flow.props.nodes.find((n: any) => n.id === '3').data.subSelected).toBe(false)
  })

  it('子图里点空白被 canvas-wrap capture 拦截：不传给 xyflow、选择不变；子图外不拦', async () => {
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    fireEvent.click(node(1))
    fireEvent.click(node(2), { metaKey: true })
    await vi.waitFor(() => expect(selected()).toEqual(['1', '2']))
    fireEvent.contextMenu(node(1))
    fireEvent.click(await screen.findByTestId('menu-subgraph'))
    await screen.findByTestId('subgraph-banner')
    const rf = screen.getByTestId('rf')
    const spy = vi.fn()
    rf.addEventListener('click', spy)
    fireEvent.click(rf) // 模拟点画布空白：capture 层 stopPropagation
    expect(spy).not.toHaveBeenCalled() // 事件没到下层（xyflow 收不到，不清它的内部选择）
    expect(selected()).toEqual(['1', '2']) // D184-②：选择集合不动
    await esc() // 退出子图
    fireEvent.click(rf)
    expect(spy).toHaveBeenCalledTimes(1) // 子图外不拦
    rf.removeEventListener('click', spy)
  })

  it('uat7b-fix1 S-a：子图里点空白同时关掉筛选 / 右键菜单，选择仍不动', async () => {
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    fireEvent.click(node(1))
    fireEvent.click(node(2), { metaKey: true })
    await vi.waitFor(() => expect(selected()).toEqual(['1', '2']))
    fireEvent.contextMenu(node(1))
    fireEvent.click(await screen.findByTestId('menu-subgraph'))
    await screen.findByTestId('subgraph-banner')
    // 子图里打开「筛选」浮层，然后点空白：capture 拦截并自行关浮层
    fireEvent.click(document.querySelector('.toolbar button[title="按关系类型筛选"]') as HTMLElement)
    expect(document.querySelector('.fpop')).toBeTruthy()
    const rf = screen.getByTestId('rf')
    fireEvent.click(rf)
    expect(document.querySelector('.fpop')).toBeNull()
    expect(selected()).toEqual(['1', '2'])
    expect(screen.getByTestId('subgraph-banner')).toBeTruthy()
    // 右键菜单同理
    fireEvent.contextMenu(node(1))
    await screen.findByTestId('selection-menu')
    fireEvent.click(rf)
    expect(screen.queryByTestId('selection-menu')).toBeNull()
    expect(selected()).toEqual(['1', '2'])
  })

  it('子图里点空白不清选择，子图外点空白清空（onPaneClick 语义不变）', async () => {
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    fireEvent.click(node(1))
    fireEvent.click(node(2), { metaKey: true })
    await vi.waitFor(() => expect(selected()).toEqual(['1', '2']))
    await esc() // 退出子图后（xyflow onPaneClick 路径）：点空白清空选择
    await act(async () => flow.props.onPaneClick())
    expect(selected()).toEqual([])
  })
})


describe('D212 关系图降噪', () => {
  const press = async (key: string, target: HTMLElement | Window = window, init: KeyboardEventInit = {}): Promise<void> => {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
    })
  }
  const hiddenNodes = (): string[] => nodes().filter((n) => n.dataset.hidden === 'true').map((n) => n.dataset.id!)
  const edge = (id: number): HTMLElement => document.querySelector<HTMLElement>(`[data-testid="rf-edge"][data-id="${id}"]`)!

  it('hover 强调直接邻域并优先于选择，leave 与清除选择后恢复', async () => {
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    fireEvent.click(node(4))
    await vi.waitFor(() => expect(node(2).className).toContain('gt-neighbor-dim'))
    fireEvent.mouseEnter(node(1))
    await vi.waitFor(() => expect(node(2).className).toContain('gt-neighbor-hi'))
    expect(node(1).className).toContain('gt-neighbor-hi')
    expect(node(3).className).toContain('gt-neighbor-hi')
    expect(node(4).className).toContain('gt-neighbor-dim')
    expect(edge(101).className).toContain('gt-neighbor-hi')
    expect(edge(104).className).toContain('gt-neighbor-hi')
    expect(edge(102).className).toContain('gt-neighbor-hi') // 2–3 邻居间弦边（uat17b 建议修 1）
    expect(edge(103).className).toContain('gt-neighbor-dim') // 3–4 出邻域
    fireEvent.mouseLeave(node(1))
    await vi.waitFor(() => expect(node(2).className).toContain('gt-neighbor-dim'))
    await act(async () => flow.props.onPaneClick())
    await vi.waitFor(() => expect(nodes().every((n) => !n.className.includes('gt-neighbor-dim'))).toBe(true))
  })

  it('类型过滤显示真实计数，关闭后边不渲染、节点保留，全部显示重置', async () => {
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    fireEvent.click(screen.getByTestId('relation-filter'))
    expect(screen.getByTestId('filter-count-based_on').textContent).toBe('4')
    expect(screen.getByTestId('filter-count-cites').textContent).toBe('0')
    const checkbox = document.querySelector<HTMLInputElement>('.fpop .frow input')!
    fireEvent.click(checkbox)
    await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="rf-edge"]')).toHaveLength(0))
    expect(nodes()).toHaveLength(4)
    expect(screen.getByTestId('filter-active').textContent).toContain('已过滤')
    fireEvent.click(screen.getByTitle('重置关系类型筛选'))
    await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="rf-edge"]')).toHaveLength(4))
    expect(screen.queryByTestId('filter-active')).toBeNull()
  })

  it('右键聚焦 1/2 跳、Esc 恢复原视口，双击仍打开详情', async () => {
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    fireEvent.contextMenu(node(1))
    fireEvent.click(await screen.findByTestId('menu-focus-paper'))
    await screen.findByTestId('focus-banner')
    await vi.waitFor(() => expect(hiddenNodes()).toEqual(['4']))
    expect(screen.getByTestId('focus-banner').textContent).toContain('聚焦：论文1')
    fireEvent.doubleClick(node(1))
    expect(onOpenPaper).toHaveBeenCalledWith(1)
    fireEvent.click(screen.getByTestId('focus-depth-2'))
    await vi.waitFor(() => expect(hiddenNodes()).toEqual([]))
    expect(screen.getByTestId('focus-depth-2').getAttribute('aria-pressed')).toBe('true')
    await esc()
    await vi.waitFor(() => expect(screen.queryByTestId('focus-banner')).toBeNull())
    await vi.waitFor(() => expect(flow.setViewport).toHaveBeenCalledWith(flow.viewport, expect.objectContaining({ duration: expect.any(Number) })))
    expect(selected()).toEqual(['1'])
  })

  it('筛选弹层的 Esc 先关弹层，下一次才退聚焦', async () => {
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    fireEvent.click(node(1))
    await press('f')
    await screen.findByTestId('focus-banner')
    fireEvent.click(screen.getByTestId('relation-filter'))
    expect(document.querySelector('.fpop')).toBeTruthy()
    await esc()
    expect(document.querySelector('.fpop')).toBeNull()
    expect(screen.getByTestId('focus-banner')).toBeTruthy()
    expect(flow.setViewport).not.toHaveBeenCalled()
    await esc()
    await vi.waitFor(() => expect(screen.queryByTestId('focus-banner')).toBeNull())
    await vi.waitFor(() => expect(flow.setViewport).toHaveBeenCalledTimes(1))
  })

  it('F 快捷键守住无选择、多选、输入框、修饰键与 IME', async () => {
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    await press('f')
    expect(screen.queryByTestId('focus-banner')).toBeNull()
    fireEvent.click(node(1))
    fireEvent.click(node(2), { metaKey: true })
    await press('f')
    expect(screen.queryByTestId('focus-banner')).toBeNull()
    fireEvent.click(node(1))
    const input = document.createElement('input')
    input.id = 'uat17-input'
    document.body.appendChild(input)
    input.focus()
    await press('f', input)
    await press('f', window, { metaKey: true })
    await press('f', window, { shiftKey: true })
    await press('f', window, { isComposing: true })
    expect(screen.queryByTestId('focus-banner')).toBeNull()
    input.blur()
    input.remove()
    await press('F')
    await screen.findByTestId('focus-banner')
    expect(hiddenNodes()).toEqual(['4'])
  })

  it('聚焦中进详情再返回：指示条、邻域隐藏与取景恢复，Esc 退回进入前视口', async () => {
    const first = mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    fireEvent.click(node(1))
    await press('f')
    await screen.findByTestId('focus-banner')
    expect(hiddenNodes()).toEqual(['4'])
    fireEvent.doubleClick(node(1))
    expect(onOpenPaper).toHaveBeenCalledWith(1)
    first.unmount() // 模拟路由切到详情页：聚焦暂存（消费一次语义）
    mount() // 返回同图谱：聚焦恢复
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    expect(screen.getByTestId('focus-banner').textContent).toContain('聚焦：论文1')
    await vi.waitFor(() => expect(hiddenNodes()).toEqual(['4']))
    // 视口回到聚焦态：首帧取景取邻域 1/2/3，而不是退回全图
    await vi.waitFor(() =>
      expect(flow.fitView).toHaveBeenCalledWith(
        expect.objectContaining({ nodes: [{ id: '1' }, { id: '2' }, { id: '3' }], padding: 0.2 })
      )
    )
    await esc()
    await vi.waitFor(() => expect(screen.queryByTestId('focus-banner')).toBeNull())
    await vi.waitFor(() =>
      expect(flow.setViewport).toHaveBeenCalledWith(flow.viewport, expect.objectContaining({ duration: expect.any(Number) }))
    )
  })

  it('Esc 退出聚焦后再进详情返回：不恢复聚焦，仍是全图', async () => {
    const first = mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    fireEvent.click(node(1))
    await press('f')
    await screen.findByTestId('focus-banner')
    await esc()
    await vi.waitFor(() => expect(screen.queryByTestId('focus-banner')).toBeNull())
    fireEvent.doubleClick(node(1))
    expect(onOpenPaper).toHaveBeenCalledWith(1)
    first.unmount()
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    expect(screen.queryByTestId('focus-banner')).toBeNull()
    expect(hiddenNodes()).toEqual([])
  })

  it('恢复时聚焦根已不在图谱：不恢复聚焦', async () => {
    const first = mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    fireEvent.click(node(1))
    await press('f')
    await screen.findByTestId('focus-banner')
    fireEvent.doubleClick(node(1))
    first.unmount()
    // 详情页期间论文 1 被移出图谱
    store.detail.members = store.detail.members.filter((m) => m.paper.id !== 1)
    store.detail.relations = store.detail.relations.filter((r) => r.paperLow !== 1 && r.paperHigh !== 1)
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(3))
    await vi.waitFor(() => expect(screen.queryByTestId('focus-banner')).toBeNull())
    expect(hiddenNodes()).toEqual([])
  })

  it('聚焦根被移出图谱时自动退出，不回拽旧视口', async () => {
    mount()
    await vi.waitFor(() => expect(nodes()).toHaveLength(4))
    fireEvent.click(node(1))
    await press('f')
    await screen.findByTestId('focus-banner')
    store.detail.members = store.detail.members.filter((m) => m.paper.id !== 1)
    store.detail.relations = store.detail.relations.filter((r) => r.paperLow !== 1 && r.paperHigh !== 1)
    await act(async () => window.dispatchEvent(new CustomEvent('gt:graph-changed')))
    await vi.waitFor(() => expect(screen.queryByTestId('focus-banner')).toBeNull())
    expect(hiddenNodes()).toEqual([])
    expect(flow.setViewport).not.toHaveBeenCalled()
  })
})
