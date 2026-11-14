// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { createElement as h } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphDetail, PaperSummary, RelationView } from '../../../shared/ipc'

/**
 * uat4 画布组：
 *  - 建议修10：冷启动边渲染回归——首次挂载（mock getGraph 一次返回节点+关系）
 *    边数即等于关系数，不依赖第二次挂载或重新进入；shouldRetryColdStartEdges 兜底判定。
 *  - 建议修12：新节点放置 placeNewNode——黄金角螺旋避开所有既有节点包围盒，
 *    连续添加互不相交，已有节点坐标不变。
 *
 * ReactFlow 用轻量 stub 替换（真实 xyflow 在 jsdom 下依赖 ResizeObserver 测量），
 * 只保留 GraphPage 关心的契约：nodes/edges 原样渲染、onInit 回调。
 */

vi.mock('@xyflow/react', async () => {
  const React = await import('react')
  function ReactFlowStub(props: {
    nodes: Array<{ id: string; position: { x: number; y: number } }>
    edges: Array<{ id: string; source: string; target: string; label?: string }>
    onInit?: (inst: unknown) => void
  }) {
    React.useEffect(() => {
      props.onInit?.({ fitView: async () => true, screenToFlowPosition: (p: { x: number; y: number }) => p })
    }, [props.onInit])
    return React.createElement(
      'div',
      { className: 'react-flow-stub', 'data-testid': 'rf' },
      (props.nodes ?? []).map((n) =>
        React.createElement('div', {
          key: n.id,
          'data-testid': 'rf-node',
          'data-id': n.id,
          'data-x': String(n.position.x),
          'data-y': String(n.position.y)
        })
      ),
      (props.edges ?? []).map((e) =>
        React.createElement('div', { key: e.id, 'data-testid': 'rf-edge', 'data-id': e.id, 'data-source': e.source, 'data-target': e.target }, e.label ?? null)
      )
    )
  }
  return {
    ReactFlow: ReactFlowStub,
    Background: () => null,
    Controls: () => null,
    BackgroundVariant: { Dots: 'dots', Lines: 'lines', Cross: 'cross' },
    MarkerType: { ArrowClosed: 'arrowclosed' },
    // uat6 S5：flowNodes.paperNodeDeclarative 模块内引用 Position.*（uat6 M1 起），stub 需给出
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
    applyNodeChanges: (_changes: unknown[], ns: unknown[]) => ns
  }
})

afterEach(cleanup)

/** uat6 S5：ELK 布局 mock——确定性坐标（与整理前必然不同），避免 jsdom 拉 elkjs */
vi.mock('../../../shared/layout/elk', () => ({
  computeElkLayout: vi.fn(async (nodes: Array<{ id: string }>) => ({
    positions: new Map(nodes.map((n, i) => [n.id, { x: 1000 + i * 300, y: 500 }])),
    edges: []
  }))
}))

/** 模块级 api mock（GraphPage 顶层捕获 window.graphictero，必须先装好再 import） */
const gt = vi.hoisted(() => ({
  getGraph: vi.fn(),
  listLibrary: vi.fn(),
  getPapersStatus: vi.fn(),
  getJobsOverview: vi.fn(),
  getWaitingCount: vi.fn(),
  getMineruStatus: vi.fn(),
  installMineru: vi.fn(),
  startMineru: vi.fn(),
  relationsStatus: vi.fn(),
  listCandidates: vi.fn(),
  setNodePosition: vi.fn(),
  onGenerateProgress: vi.fn(() => () => {}),
  onParseProgress: vi.fn(() => () => {}),
  onMineruStatus: vi.fn(() => () => {}),
  onLibraryChanged: vi.fn(() => () => {}),
  onAgentCandidates: vi.fn(() => () => {}),
  onCandProgress: vi.fn(() => () => {})
}))

let GraphPage: typeof import('./GraphPage').GraphPage
let placeNewNode: typeof import('./GraphPage').placeNewNode
let shouldRetryColdStartEdges: typeof import('./GraphPage').shouldRetryColdStartEdges

beforeAll(async () => {
  if (!window.requestAnimationFrame) {
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0) as unknown as number
    window.cancelAnimationFrame = (id) => clearTimeout(id)
  }
  ;(window as unknown as { graphictero: unknown }).graphictero = gt
  const mod = await import('./GraphPage')
  GraphPage = mod.GraphPage
  placeNewNode = mod.placeNewNode
  shouldRetryColdStartEdges = mod.shouldRetryColdStartEdges
})

beforeEach(() => {
  gt.getGraph.mockReset()
  gt.listLibrary.mockReset().mockResolvedValue([])
  gt.getPapersStatus.mockReset().mockResolvedValue([])
  gt.getJobsOverview.mockReset().mockResolvedValue({
    queued: 0,
    running: 0,
    waitingNetwork: 0,
    waitingKey: 0,
    failedRetryable: 0,
    failedAction: 0,
    pauseSummary: null,
    failed: []
  })
  gt.getWaitingCount.mockReset().mockResolvedValue(0)
  gt.getMineruStatus.mockReset().mockResolvedValue({ state: 'ready', version: '1', port: 1, pid: 1, error: null, installProgress: null, modelsPath: null, modelsReady: true })
  gt.installMineru.mockReset().mockResolvedValue({})
  gt.startMineru.mockReset().mockResolvedValue({})
  gt.relationsStatus.mockReset().mockResolvedValue({ running: false })
  gt.listCandidates.mockReset().mockResolvedValue([])
  gt.setNodePosition.mockReset().mockResolvedValue(undefined)
})

function paper(id: number, title: string): PaperSummary {
  return { id, title, firstAuthor: 'X', year: 2020, hasPdf: true } as never
}

function rel(id: number, paperLow: number, paperHigh: number, llmTypes: RelationView['llmTypes'] = ['based_on']): RelationView {
  return {
    id,
    paperLow,
    paperHigh,
    srcPaper: paperLow,
    statement: '',
    llmTypes,
    autoTypes: [],
    createdAt: '',
    sourceType: 'job',
    sourceJobId: 1,
    sourceSessionId: null,
    model: 'deepseek-flash',
    promptVersion: 'v1',
    editedAt: null,
    noRefBasis: false,
    updatedAt: '2026-10-27T00:00:00Z'
  }
}

/** 3 篇成员 + 4 条关系（含一条对称类型），对应 uat2 复测「顶栏有计数、画布无边」的场景 */
const DETAIL: GraphDetail = {
  graph: { id: 1, name: '冷启动图', createdAt: '', updatedAt: '', paperCount: 3, relationCount: 4 },
  members: [
    { paper: paper(11, '论文甲'), x: 0, y: 0 },
    { paper: paper(22, '论文乙'), x: 300, y: 0 },
    { paper: paper(33, '论文丙'), x: 0, y: 200 }
  ],
  relations: [rel(101, 11, 22), rel(102, 22, 33), rel(103, 11, 33), rel(104, 22, 33, ['compares'])]
}

describe('uat4 建议修10：冷启动边渲染回归（首次挂载）', () => {
  it('第一次 render 后边数 = 关系数（4/4），端点方向正确，无需二次挂载或重新进入', async () => {
    gt.getGraph.mockResolvedValue(DETAIL)
    render(
      h(GraphPage, {
        graphId: 1,
        onHome: () => {},
        onOpenSettings: () => {},
        onOpenParseSettings: () => {},
        onOpenPaper: () => {}
      })
    )
    // 顶栏计数与画布边同一份数据源（症状：顶栏 18 条、画布 0 条）
    const header = await screen.findByText(/条关系/)
    expect(header.textContent).toContain('3 篇 · 4 条关系')
    const edgeEls = await screen.findAllByTestId('rf-edge')
    expect(edgeEls).toHaveLength(DETAIL.relations.length)
    // 只挂载了一次：不依赖 rerender / remount / 重新进入图谱
    expect(gt.getGraph).toHaveBeenCalledTimes(1)
    // 端点：source = srcPaper，target = 方向另一端（dstOf）
    const byId = new Map(edgeEls.map((e) => [e.dataset.id!, e]))
    expect(byId.get('101')!.dataset).toMatchObject({ source: '11', target: '22' })
    expect(byId.get('102')!.dataset).toMatchObject({ source: '22', target: '33' })
    expect(byId.get('103')!.dataset).toMatchObject({ source: '11', target: '33' })
    expect(byId.get('104')!.dataset).toMatchObject({ source: '22', target: '33' })
    // 节点也在同一批就绪（边不依赖节点第二次 setState）
    const nodeEls = await screen.findAllByTestId('rf-node')
    expect(nodeEls).toHaveLength(DETAIL.members.length)
  })

  it('0 条关系的图：首挂 0 边，不触发兜底重算（判定恒 false 路径）', async () => {
    gt.getGraph.mockResolvedValue({ ...DETAIL, relations: [] })
    render(
      h(GraphPage, {
        graphId: 1,
        onHome: () => {},
        onOpenSettings: () => {},
        onOpenParseSettings: () => {},
        onOpenPaper: () => {}
      })
    )
    await screen.findByText(/条关系/)
    await vi.waitFor(() => expect(screen.getAllByTestId('rf-node')).toHaveLength(3))
    expect(screen.queryAllByTestId('rf-edge')).toHaveLength(0)
    expect(gt.getGraph).toHaveBeenCalledTimes(1)
  })
})

describe('uat4-fix1 M1：显示替换绝不写库（D173）', () => {
  it('挂载后 getGraph 返回的陈述原文不被 GraphPage 改写（reload 不再做显示替换；替换只发生在面板展示层）', async () => {
    const detail: GraphDetail = {
      ...DETAIL,
      relations: [{ ...rel(101, 11, 22), statement: 'P01 的方法被 P02 改进。' }]
    }
    gt.getGraph.mockResolvedValue(detail)
    render(
      h(GraphPage, {
        graphId: 1,
        onHome: () => {},
        onOpenSettings: () => {},
        onOpenParseSettings: () => {},
        onOpenPaper: () => {}
      })
    )
    await screen.findAllByTestId('rf-edge')
    // M1：库内原文（RelationView.statement，快照/保存/调换方向/⌘Z 全用它）必须仍是 P0x 原文
    expect(detail.relations[0].statement).toBe('P01 的方法被 P02 改进。')
  })
})

describe('uat4 建议修10：shouldRetryColdStartEdges 兜底判定', () => {
  it('关系非空 + 节点就绪 + 边为空 + 未重试过 → 触发', () => {
    expect(shouldRetryColdStartEdges(18, 0, 11, false)).toBe(true)
  })
  it('边已渲染（边数=关系数）→ 不触发', () => {
    expect(shouldRetryColdStartEdges(18, 18, 11, false)).toBe(false)
  })
  it('关系为空 → 不触发（空图无线可画）', () => {
    expect(shouldRetryColdStartEdges(0, 0, 11, false)).toBe(false)
  })
  it('节点未就绪 → 不触发（等组装 effect 先跑）', () => {
    expect(shouldRetryColdStartEdges(18, 0, 0, false)).toBe(false)
  })
  it('已重试过 → 不触发（兜底至多一次）', () => {
    expect(shouldRetryColdStartEdges(18, 0, 11, true)).toBe(false)
  })
})

describe('uat4 建议修12：placeNewNode 新节点放置', () => {
  const W = 200
  const H = 64
  const intersects = (a: { x: number; y: number }, b: { x: number; y: number }): boolean =>
    a.x < b.x + W && b.x < a.x + W && a.y < b.y + H && b.y < a.y + H

  it('空图：落在起始边距 (12, 12)', () => {
    expect(placeNewNode([], W, H)).toEqual({ x: 12, y: 12 })
  })

  it('单个既有节点：新位置与其包围盒不相交', () => {
    const existing = [{ x: 0, y: 0 }]
    const p = placeNewNode(existing, W, H)
    expect(intersects(p, existing[0])).toBe(false)
  })

  it('重叠风险布局（含同坐标堆叠）：与每个既有节点包围盒都不相交，且不改输入', () => {
    const existing = [
      { x: 0, y: 0 },
      { x: 50, y: 20 }, // 与 (0,0) 大面积重叠
      { x: 260, y: 10 },
      { x: 260, y: 10 }, // 完全同坐标
      { x: -300, y: 500 },
      { x: 1000, y: -200 },
      { x: 0, y: 300 }
    ]
    const snapshot = existing.map((n) => ({ ...n }))
    const p = placeNewNode(existing, W, H)
    for (const n of existing) expect(intersects(p, n)).toBe(false)
    expect(existing).toEqual(snapshot) // 已有节点坐标一律不动
  })

  it('连续添加 6 个：新位置之间与既有节点全部互不相交', () => {
    const obstacles = [
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 0, y: 200 }
    ]
    const placed: Array<{ x: number; y: number }> = []
    for (let i = 0; i < 6; i++) {
      const p = placeNewNode(obstacles, W, H)
      for (const n of obstacles) expect(intersects(p, n)).toBe(false)
      placed.push(p)
      obstacles.push(p)
    }
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++) expect(intersects(placed[i], placed[j])).toBe(false)
  })

  it('canvasW 给定时：新位置水平方向留在视口内', () => {
    const existing = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 400, y: 0 },
      { x: 600, y: 0 },
      { x: 800, y: 0 }
    ]
    const canvasW = 1000
    for (let i = 0; i < 5; i++) {
      const p = placeNewNode(existing, W, H, canvasW)
      expect(p.x).toBeGreaterThanOrEqual(12)
      expect(p.x + W).toBeLessThanOrEqual(canvasW - 12)
      for (const n of existing) expect(intersects(p, n)).toBe(false)
      existing.push(p)
    }
  })
})

describe('uat5-fix1 M2：画布「已在库中」确认成功后撤乐观节点（计数回成员数、无同 id 双节点）', () => {
  const CAND = {
    id: 42,
    graphId: 1,
    title: '库内候选',
    authors: ['A'],
    year: 2021,
    doi: '10.9/inlib',
    arxivId: null,
    existingPaperId: 22,
    reason: 'r',
    x: 600,
    y: 0,
    status: 'pending',
    createdAt: 't',
    updatedAt: 't'
  } as never

  function mount(graphId: number, members: Array<{ paper: PaperSummary; x: number; y: number }>, cands: unknown[]): ReturnType<typeof render> {
    gt.getGraph.mockResolvedValue({
      graph: { id: graphId, name: `图${graphId}`, createdAt: '', updatedAt: '', paperCount: members.length, relationCount: 0 },
      members,
      relations: []
    })
    gt.listCandidates.mockResolvedValue(cands)
    return render(
      h(GraphPage, { graphId, onHome: () => {}, onOpenSettings: () => {}, onOpenParseSettings: () => {}, onOpenPaper: () => {} })
    )
  }

  const sideCount = (c: ReturnType<typeof render>): number => Number(c.container.querySelector('span.cap')?.textContent?.match(/· (\d+)/)?.[1] ?? -1)
  const idCount = (c: ReturnType<typeof render>, id: string): number => c.container.querySelectorAll(`[data-id="${id}"]`).length

  it('乐观窗口计数 +1；确认成功重载后 Map 清空、计数回到成员数、同 id 节点只剩一套', async () => {
    const view = mount(1, [
      { paper: paper(11, '论文甲'), x: 0, y: 0 },
      { paper: paper(22, '论文乙'), x: 300, y: 0 }
    ], [CAND])
    await vi.waitFor(() => expect(view.container.querySelectorAll('[data-testid="rf-node"]')).toHaveLength(3)) // 2 成员 + 1 候选
    expect(sideCount(view)).toBe(2)
    // 「已在库中」确认点击的同一 tick：乐观占位（真实 paperId 22）顶上、计数 +1
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('gt:cand-confirm-start', {
          detail: { candidateId: 42, paperId: 22, title: '库内候选', authors: ['A'], year: 2021, x: 600, y: 0 }
        })
      )
    })
    await vi.waitFor(() => expect(sideCount(view)).toBe(3))
    // 确认成功：候选不再 pending，gt:graph-changed 重载后撤乐观占位
    gt.listCandidates.mockResolvedValue([])
    await act(async () => {
      window.dispatchEvent(new CustomEvent('gt:graph-changed'))
    })
    await vi.waitFor(() => expect(sideCount(view)).toBe(2))
    expect(idCount(view, '22')).toBe(1) // 不再有两套同 id 节点
    expect(idCount(view, 'cand-42')).toBe(0)
  })

  it('切换 graphId 清空乐观 Map（App 不按 graphId 设 key，组件不卸载）', async () => {
    const view = mount(1, [
      { paper: paper(11, '论文甲'), x: 0, y: 0 },
      { paper: paper(22, '论文乙'), x: 300, y: 0 }
    ], [CAND])
    await vi.waitFor(() => expect(view.container.querySelectorAll('[data-testid="rf-node"]')).toHaveLength(3))
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('gt:cand-confirm-start', {
          detail: { candidateId: 42, paperId: 22, title: '库内候选', authors: ['A'], year: 2021, x: 600, y: 0 }
        })
      )
    })
    await vi.waitFor(() => expect(sideCount(view)).toBe(3))
    // 切图谱：getGraph 返回 1 成员的图 2，乐观项必须清空（计数不再 +1）
    gt.getGraph.mockResolvedValue({
      graph: { id: 2, name: '图2', createdAt: '', updatedAt: '', paperCount: 1, relationCount: 0 },
      members: [{ paper: paper(99, '另一篇'), x: 0, y: 0 }],
      relations: []
    })
    gt.listCandidates.mockResolvedValue([])
    view.rerender(h(GraphPage, { graphId: 2, onHome: () => {}, onOpenSettings: () => {}, onOpenParseSettings: () => {}, onOpenPaper: () => {} }))
    await vi.waitFor(() => expect(sideCount(view)).toBe(1))
    expect(idCount(view, '99')).toBe(1)
  })
})

describe('uat6 S5：「整理」纳入 ⌘Z 撤销栈（撤销组写回库坐标）', () => {
  /** 可变坐标库：getGraph 从它读，setNodePosition 写它——模拟真实落库与 reload 回读 */
  const store = {
    members: [
      { paper: paper(11, '论文甲'), x: 0, y: 0 },
      { paper: paper(22, '论文乙'), x: 300, y: 0 }
    ]
  }

  function mount(): ReturnType<typeof render> {
    gt.getGraph.mockImplementation(async () => ({
      graph: { id: 1, name: '整理图', createdAt: '', updatedAt: '', paperCount: store.members.length, relationCount: 0 },
      // 返回深拷贝：真实 IPC 走序列化，detail 持有的旧坐标快照不被 setNodePosition 写库污染
      members: store.members.map((m) => ({ ...m })),
      relations: []
    }))
    gt.setNodePosition.mockImplementation(async (_g: number, id: number, x: number, y: number) => {
      const m = store.members.find((mm) => mm.paper.id === id)
      if (m) {
        m.x = x
        m.y = y
      }
    })
    return render(
      h(GraphPage, { graphId: 1, onHome: () => {}, onOpenSettings: () => {}, onOpenParseSettings: () => {}, onOpenPaper: () => {} })
    )
  }

  const node = (c: ReturnType<typeof render>, id: string): HTMLElement => c.container.querySelector<HTMLElement>(`[data-testid="rf-node"][data-id="${id}"]`)!
  const pressUndoKeys = async (shiftKey = false): Promise<void> => {
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey }))
    })
  }

  beforeEach(() => {
    store.members = [
      { paper: paper(11, '论文甲'), x: 0, y: 0 },
      { paper: paper(22, '论文乙'), x: 300, y: 0 }
    ]
  })

  it('点「整理」：ELK 新坐标写库（mock elk 返回 1000/1300,500），画布同步到新位置', async () => {
    const view = mount()
    await vi.waitFor(() => expect(view.container.querySelectorAll('[data-testid="rf-node"]')).toHaveLength(2))
    await act(async () => {
      screen.getByText('整理').click()
    })
    // 写库：新坐标（elk mock：成员按序 → (1000,500) / (1300,500)）
    await vi.waitFor(() => {
      expect(gt.setNodePosition).toHaveBeenCalledWith(1, 11, 1000, 500)
      expect(gt.setNodePosition).toHaveBeenCalledWith(1, 22, 1300, 500)
    })
    expect(store.members[0]).toMatchObject({ x: 1000, y: 500 })
    // 画布 state 同步（runUndo 前的乐观 setDetail 已在 arrange 内完成）
    await vi.waitFor(() => expect(node(view, '11').dataset.x).toBe('1000'))
    expect(node(view, '22').dataset.x).toBe('1300')
  })

  it('⌘Z 一次：撤销组把全部节点整理前坐标写回库，画布与库一起回到整理前', async () => {
    const view = mount()
    await vi.waitFor(() => expect(view.container.querySelectorAll('[data-testid="rf-node"]')).toHaveLength(2))
    await act(async () => {
      screen.getByText('整理').click()
    })
    await vi.waitFor(() => expect(store.members[0].x).toBe(1000))
    gt.setNodePosition.mockClear()
    await pressUndoKeys()
    // 撤销动作写库恢复旧坐标（不止画布 state）
    await vi.waitFor(() => {
      expect(gt.setNodePosition).toHaveBeenCalledWith(1, 11, 0, 0)
      expect(gt.setNodePosition).toHaveBeenCalledWith(1, 22, 300, 0)
    })
    expect(store.members[0]).toMatchObject({ x: 0, y: 0 })
    // reload 回读：画布回到整理前
    await vi.waitFor(() => expect(node(view, '11').dataset.x).toBe('0'))
    expect(node(view, '22').dataset.x).toBe('300')
  })

  it('⌘⇧Z：重做再应用整理后坐标（库与画布回到整理结果）', async () => {
    const view = mount()
    await vi.waitFor(() => expect(view.container.querySelectorAll('[data-testid="rf-node"]')).toHaveLength(2))
    await act(async () => {
      screen.getByText('整理').click()
    })
    await vi.waitFor(() => expect(store.members[0].x).toBe(1000))
    await pressUndoKeys()
    await vi.waitFor(() => expect(store.members[0].x).toBe(0))
    await pressUndoKeys(true) // ⌘⇧Z 重做
    await vi.waitFor(() => expect(store.members[0].x).toBe(1000))
    expect(gt.setNodePosition).toHaveBeenCalledWith(1, 11, 1000, 500)
    expect(store.members[1]).toMatchObject({ x: 1300, y: 500 })
    await vi.waitFor(() => expect(node(view, '11').dataset.x).toBe('1000'))
  })

  it('layoutUndoEntries 纯函数：坐标变化的成员才入组；undo 写回旧坐标，redo 写新坐标', async () => {
    const layoutUndoEntries = (await import('./GraphPage')).layoutUndoEntries
    const setNodePosition = gt.setNodePosition as ReturnType<typeof vi.fn>
    const entries = layoutUndoEntries(
      7,
      [
        { paperId: 1, x: 0, y: 0 },
        { paperId: 2, x: 300, y: 0 } // 整理后坐标不变 → 不入组
      ],
      [
        { paperId: 1, x: 500, y: 100 },
        { paperId: 2, x: 300, y: 0 }
      ]
    )
    expect(entries).toHaveLength(1) // 只有成员 1 位置变了
    await entries[0].undo()
    expect(setNodePosition).toHaveBeenCalledWith(7, 1, 0, 0)
    await entries[0].redo()
    expect(setNodePosition).toHaveBeenCalledWith(7, 1, 500, 100)
    // 全部无变化 → 空组（pushGroup 忽略，不进撤销栈）
    expect(
      layoutUndoEntries(
        7,
        [{ paperId: 1, x: 5, y: 5 }],
        [{ paperId: 1, x: 5, y: 5 }]
      )
    ).toHaveLength(0)
  })
})
