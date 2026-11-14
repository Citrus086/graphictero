import { describe, expect, it } from 'vitest'
import dagre from 'dagre'
import { countCrossings, type Polyline } from './crossings'
import { computeElkLayout } from './elk'

/**
 * D80 验收：同一批数据（原型 app.js 的 7 节点 8 边）下，App 的 ELK 布局
 * 交叉数不多于原型的 dagre 布局。
 *
 * dagre 侧完整复刻原型的布局与走线逻辑（app.js 的 layout()：network-simplex、
 * 端口扇出展开、竖直贝塞尔），ELK 侧用 src/shared/layout/elk.ts 的真实实现；
 * 两边用同一个 countCrossings 统计，保证可比。
 */

const NW = 200
const NH = 64

// 原型 app.js S.edges 里的 8 条手工/示例边（含示例陈述，布局只用 s/t）
const EDGES = [
  { s: 'A', t: 'C' },
  { s: 'C', t: 'D' },
  { s: 'B', t: 'D' }, // 原型注释：这条最后加入，dagre ordering 避免一次交叉
  { s: 'G', t: 'D' },
  { s: 'E', t: 'F' },
  { s: 'F', t: 'G' },
  { s: 'B', t: 'E' },
  { s: 'A', t: 'G' }
]
const NODES = ['A', 'B', 'C', 'D', 'E', 'F', 'G']

/** 原型 app.js layout() 的 TS 复刻（含「B→D 最后加边」的顺序技巧）。 */
function prototypeDagreLayout(): Map<string, Polyline> {
  const g = new dagre.graphlib.Graph({ multigraph: true })
  g.setGraph({
    rankdir: 'TB',
    nodesep: 56,
    ranksep: 72,
    edgesep: 24,
    marginx: 0,
    marginy: 0,
    ranker: 'network-simplex'
  })
  g.setDefaultEdgeLabel(() => ({}))
  NODES.forEach((k) => g.setNode(k, { width: NW, height: NH }))
  const LE = EDGES.map((e, i) => ({ ...e, key: 'e' + i, idx: i }))
  LE.filter((e) => e.idx !== 2)
    .concat(LE.filter((e) => e.idx === 2))
    .forEach((e) => g.setEdge(e.s, e.t, {}, e.key))
  dagre.layout(g)

  const pos: Record<string, [number, number]> = {}
  g.nodes().forEach((k) => {
    const n = g.node(k)
    pos[k] = [n.x - NW / 2, n.y - NH / 2]
  })
  const raw: Record<string, { v: string; w: string; pts: Polyline }> = {}
  g.edges().forEach((o) => {
    if (o.name == null) return
    raw[o.name] = { v: o.v, w: o.w, pts: g.edge(o).points.map((p) => [p.x, p.y] as [number, number]) }
  })
  const out: Record<string, string[]> = {}
  const inn: Record<string, string[]> = {}
  Object.entries(raw).forEach(([k, r]) => {
    ;(out[r.v] = out[r.v] || []).push(k)
    ;(inn[r.w] = inn[r.w] || []).push(k)
  })
  const port: Record<string, { s?: number; t?: number }> = {}
  const spread = (lst: string[], which: 's' | 't'): void => {
    lst.sort((a, b) => {
      const pa = raw[a].pts
      const pb = raw[b].pts
      const xa = which === 's' ? pa[1][0] : pa[pa.length - 2][0]
      const xb = which === 's' ? pb[1][0] : pb[pb.length - 2][0]
      return xa - xb
    })
    lst.forEach((k, i) => {
      ;(port[k] = port[k] || {})[which] = (i - (lst.length - 1) / 2) * Math.min(44, NW / (lst.length + 1))
    })
  }
  Object.values(out).forEach((l) => spread(l, 's'))
  Object.values(inn).forEach((l) => spread(l, 't'))

  const routes = new Map<string, Polyline>()
  Object.entries(raw).forEach(([k, r]) => {
    const a = pos[r.v]
    const b = pos[r.w]
    const st: [number, number] = [a[0] + NW / 2 + port[k].s!, a[1] + NH]
    const en: [number, number] = [b[0] + NW / 2 + port[k].t!, b[1]]
    routes.set(k, [
      st,
      ...r.pts.slice(1, -1).filter((p) => p[1] > st[1] + 20 && p[1] < en[1] - 20),
      en
    ])
  })
  return routes
}

describe('D80：ELK 交叉数不多于原型 dagre（同一批数据）', () => {
  it('原型 dagre 布局零交叉（基准对齐原型「整理」效果）', () => {
    const routes = prototypeDagreLayout()
    const dagreCrossings = countCrossings(
      [...routes.entries()].map(([id, points]) => {
        const e = EDGES[Number(id.slice(1))]
        return { points, source: e.s, target: e.t }
      })
    )
    expect(dagreCrossings).toBe(0)
  })

  it('ELK（App「整理」同款参数）交叉数 ≤ 原型 dagre', async () => {
    const dagreRoutes = prototypeDagreLayout()
    const dagreCrossings = countCrossings(
      [...dagreRoutes.entries()].map(([id, points]) => {
        const e = EDGES[Number(id.slice(1))]
        return { points, source: e.s, target: e.t }
      })
    )

    const elk = await computeElkLayout(
      NODES.map((id) => ({ id, width: NW, height: NH })),
      EDGES.map((e, i) => ({ id: 'e' + i, source: e.s, target: e.t }))
    )
    const elkCrossings = countCrossings(
      elk.edges.map((e) => ({ points: e.points, source: e.source, target: e.target }))
    )
    expect(elkCrossings).toBeLessThanOrEqual(dagreCrossings)
  })

  it('ELK 返回的是节点左上角坐标（评审建 5）：直接用，不减 w/2、h/2，坐标非负', async () => {
    const { positions } = await computeElkLayout(
      NODES.map((id) => ({ id, width: NW, height: NH })),
      EDGES.map((e, i) => ({ id: 'e' + i, source: e.s, target: e.t }))
    )
    // 旧实现误当中心坐标统一减 (w/2, h/2)，首个节点会落到 (-88, -8) 这类负值；
    // 正确语义下所有节点左上角都在画布非负象限（首节点 = ELK padding）
    for (const p of positions.values()) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeGreaterThanOrEqual(0)
    }
    const xs = [...positions.values()].map((p) => p.x)
    expect(Math.min(...xs)).toBeLessThan(NW / 2) // 首节点 x 就是 padding（≪ 节点半宽）
  })

  it('countCrossings：X 形两线计 1 次交叉；共享端点的扇形不算', () => {
    expect(
      countCrossings([
        { source: 'a', target: 'b', points: [[0, 0], [10, 10]] },
        { source: 'c', target: 'd', points: [[0, 10], [10, 0]] }
      ])
    ).toBe(1)
    expect(
      countCrossings([
        { source: 'a', target: 'b', points: [[0, 0], [5, 5]] },
        { source: 'a', target: 'c', points: [[0, 0], [5, 6]] }
      ])
    ).toBe(0)
  })
})
