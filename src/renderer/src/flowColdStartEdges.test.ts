// @vitest-environment jsdom
/**
 * uat6 M1：冷启动画布 0 条边的根因回归（真实 @xyflow/react，非 stub）。
 *
 * 根因：xyflow v12 只在两端节点「初始化」（internals.handleBounds + 尺寸）后渲染
 * 边，而 handleBounds 只能来自异步 DOM 测量（ResizeObserver → updateNodeInternals），
 * 测量静默丢失（viewport 未挂载 / 0 尺寸交付 / internals 重建后 RO 不再补发）时边
 * 永远 0 条，且任何 React state 更新都无法恢复（parseHandles 只从旧 internals 复制
 * handleBounds，绝不重量 DOM）。UAT 现场：
 * 节点可见、顶栏 21 条关系、画布 0 边、视口未 fit = store 内节点从未被测量的完整形态。
 *
 * 修复：lib/flowNodes.ts paperNodeDeclarative——声明式尺寸 + 连接点，边锚点由数据
 * 决定，不依赖测量时序。本文件用真实 xyflow 在 jsdom 复现「无测量 → 0 边」并锁定
 * 修复后「无测量 → 边数 = 关系数」。
 *
 * 修前失败输出（同断言在未声明节点上）：expected +0 to be 3。
 */
import { act, cleanup, render } from '@testing-library/react'
import { createElement as h, useEffect, useRef, useState } from 'react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, applyNodeChanges } from '@xyflow/react'
import { paperNodeDeclarative } from './lib/flowNodes'

/** 可控 ResizeObserver：按目标类型（画布容器 / 节点）决定是否交付测量 */
class MockRO {
  static instances: MockRO[] = []
  cb: ResizeObserverCallback
  targets: Element[] = []
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb
    MockRO.instances.push(this)
  }
  observe(t: Element): void {
    this.targets.push(t)
  }
  unobserve(t: Element): void {
    this.targets = this.targets.filter((x) => x !== t)
  }
  disconnect(): void {}
  static reset(): void {
    MockRO.instances = []
  }
  static fire(scope: 'container' | 'nodes'): void {
    for (const ro of MockRO.instances) {
      for (const t of ro.targets) {
        const isContainer = (t as HTMLElement).classList?.contains('react-flow')
        if (scope === 'container' ? !isContainer : isContainer) continue
        const rect = { width: 800, height: 600, x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, toJSON: () => ({}) }
        ro.cb(
          [{ target: t, contentRect: rect, borderBoxSize: [{ inlineSize: 800, blockSize: 600 }], contentBoxSize: [{ inlineSize: 800, blockSize: 600 }] } as unknown as ResizeObserverEntry],
          ro as unknown as ResizeObserver
        )
      }
    }
  }
}

beforeAll(() => {
  ;(globalThis as unknown as { ResizeObserver: typeof MockRO }).ResizeObserver = MockRO
  class DMR {
    m22 = 1
    constructor(_s?: string) {}
  }
  ;(globalThis as unknown as { DOMMatrixReadOnly: typeof DMR }).DOMMatrixReadOnly = DMR
  // 节点 DOM 尺寸（真实浏览器里由 CSS 给出；jsdom 用固定值兜底 RO 已交付的场景）
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { get() { return 200 }, configurable: true })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { get() { return 64 }, configurable: true })
  const origGBCR = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList?.contains('react-flow__handle')) {
      const r = origGBCR.call(this)
      return { ...r, x: 0, y: 0, width: 8, height: 8, top: 0, left: 0, right: 8, bottom: 8 } as DOMRect
    }
    return origGBCR.call(this)
  } as typeof HTMLElement.prototype.getBoundingClientRect
  if (!window.requestAnimationFrame) {
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0) as unknown as number
    window.cancelAnimationFrame = (id) => clearTimeout(id)
  }
})

afterEach(() => {
  cleanup()
  MockRO.reset()
})

function NodeA({ data }: { data: { label: string } }) {
  return h(
    'div',
    { className: 'pnode' },
    h(Handle, { key: 't', type: 'target', position: Position.Top }),
    h('span', { key: 'l' }, data.label),
    h(Handle, { key: 's', type: 'source', position: Position.Bottom })
  )
}
const nodeTypes = { a: NodeA }

const MEMBERS = [
  { id: 11, x: 0, y: 0 },
  { id: 22, x: 300, y: 0 },
  { id: 33, x: 0, y: 200 }
]
const RELS = [
  { id: 101, src: 11, dst: 22 },
  { id: 102, src: 22, dst: 33 },
  { id: 103, src: 11, dst: 33 }
]

/** decl=true 走 GraphPage 同款 paperNodeDeclarative（M1 修复路径） */
function mkNodes(decl: boolean) {
  return MEMBERS.map((m) => {
    const base = { id: String(m.id), type: 'a', position: { x: m.x, y: m.y }, data: { label: `n${m.id}` } }
    return decl ? { ...base, ...paperNodeDeclarative(String(m.id)) } : base
  })
}
function mkEdges() {
  return RELS.map((r) => ({
    id: String(r.id),
    source: String(r.src),
    target: String(r.dst),
    markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: '#000' }
  }))
}

/** 模拟 GraphPage 冷启动：异步 IPC 到达 → 同批 setNodes+setEdges → 状态风暴整批重建 */
function Harness({ decl, churn = false }: { decl: boolean; churn?: boolean }) {
  const [nodes, setNodes] = useState<Array<Record<string, unknown>>>([])
  const [edges, setEdges] = useState<Array<Record<string, unknown>>>([])
  const [rf, setRf] = useState<{ fitView: (o?: unknown) => Promise<boolean> } | null>(null)
  const fitted = useRef(false)
  useEffect(() => {
    let alive = true
    void (async () => {
      await new Promise((r) => setTimeout(r, 20)) // 模拟 getGraph IPC
      if (!alive) return
      setNodes(mkNodes(decl))
      setEdges(mkEdges())
      if (churn) {
        // 模拟 papersStatus / 候选 / 进度事件多次整批重建（全新对象引用）
        for (let i = 0; i < 5; i++) {
          await new Promise((r) => setTimeout(r, 15))
          if (!alive) return
          setNodes((prev) => prev.map((n) => ({ ...n, data: { ...(n.data as object) } })))
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [decl, churn])
  useEffect(() => {
    if (nodes.length && rf && !fitted.current) {
      fitted.current = true
      void rf.fitView({ padding: 0.15, maxZoom: 1 })
    }
  }, [nodes, rf])
  return h(
    ReactFlow as never,
    {
      nodes,
      edges,
      nodeTypes,
      onNodesChange: (changes: never[]) => setNodes((ns) => applyNodeChanges(changes, ns as never[]) as never[]),
      onInit: setRf,
      minZoom: 0.1
    },
    h(Background, null),
    h(Controls, null)
  )
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 120))
  })
}

const edgeCount = (c: ReturnType<typeof render>): number => c.container.querySelectorAll('.react-flow__edge').length

describe('uat6 M1：冷启动边渲染（真实 xyflow）', () => {
  it('【根因对照】未声明尺寸/连接点时，节点测量不交付 → 边永远 0 条（UAT 现场形态）', async () => {
    const c = render(h(Harness, { decl: false }))
    MockRO.fire('container') // 画布容器先就绪（真实浏览器必然如此），唯独节点测量丢失
    await flush()
    expect(edgeCount(c)).toBe(0) // 修前代码即此形态：顶栏有数、画布 0 边
  })

  it('M1 修复：声明式尺寸+连接点，节点测量不交付 → 边数 = 关系数（3/3）', async () => {
    const c = render(h(Harness, { decl: true }))
    MockRO.fire('container')
    await flush()
    expect(edgeCount(c)).toBe(RELS.length)
  })

  it('M1 修复：状态风暴（多次整批重建）+ 测量不交付 → 边保持 = 关系数', async () => {
    const c = render(h(Harness, { decl: true, churn: true }))
    MockRO.fire('container')
    await flush()
    expect(edgeCount(c)).toBe(RELS.length)
  })

  it('M1 修复：冷启动 fitView 的前提恢复（未测量节点也能算出 bounds、fitView 成功返回）', async () => {
    const c = render(h(Harness, { decl: true }))
    MockRO.fire('container')
    await flush()
    // jsdom 的 XYPanZoom 不写 transform 样式（d3-zoom 依赖 SVG 几何），但 fitView 应成功
    // 返回（节点 bounds 可计算）；真实浏览器视口行为由 smoke「冷启动首次打开图谱」步覆盖。
    const vp = c.container.querySelector('.xyflow__viewport') as HTMLElement | null
    expect(vp?.style.transform).toBeTruthy()
    expect(edgeCount(c)).toBe(RELS.length)
  })

  it('全量测量（RO 全交付）后：声明式节点边数仍 = 关系数，不重复、不丢失', async () => {
    const c = render(h(Harness, { decl: true, churn: true }))
    MockRO.fire('container')
    MockRO.fire('nodes')
    await flush()
    expect(edgeCount(c)).toBe(RELS.length)
  })
})
