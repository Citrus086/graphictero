/**
 * 边交叉数统计（D80 验收：App 用 ELK 整理后的交叉数不多于原型 dagre）。
 *
 * 方法：把每条边表示成折线（曲线先按原型同款竖直贝塞尔采样成折线），
 * 两两统计交叉：①严格跨立的线段对；②某条折线的内部顶点落在另一条的
 * 线段上且前后异号（覆盖「交点恰好是采样顶点」的退化情形）。
 * 曲线端点（共享节点的扇形展开）不参与判定。
 * 原型与 App 的边用同一套采样/统计逻辑，保证可比。
 */

export type Polyline = Array<[number, number]>

const EPS = 1e-9

/** 与原型 curve() 相同：相邻点间用竖直中点的三次贝塞尔。采样成折线。 */
export function sampleCurve(pts: Polyline, samplesPerSeg = 24): Polyline {
  if (pts.length < 2) return pts.slice()
  const out: Polyline = [pts[0]]
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[i + 1]
    const my = (y0 + y1) / 2
    // 三次贝塞尔：P0=(x0,y0) C1=(x0,my) C2=(x1,my) P1=(x1,y1)
    for (let s = 1; s <= samplesPerSeg; s++) {
      const t = s / samplesPerSeg
      const u = 1 - t
      const x = u * u * u * x0 + 3 * u * u * t * x0 + 3 * u * t * t * x1 + t * t * t * x1
      const y = u * u * u * y0 + 3 * u * u * t * my + 3 * u * t * t * my + t * t * t * y1
      out.push([x, y])
    }
  }
  return out
}

/** (p-o)×(q-o) 的行列式值（>0 表示 q 在 o→p 的左侧） */
function orient(o: [number, number], p: [number, number], q: [number, number]): number {
  return (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
}

/** 严格跨立：两线段在各自内部穿过（共享端点相触不算）。 */
function segmentsCrossStrict(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  const d1 = orient(c, d, a)
  const d2 = orient(c, d, b)
  const d3 = orient(a, b, c)
  const d4 = orient(a, b, d)
  return ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))
}

/** p 是否在线段 xy 上（含端点，容差 EPS）。 */
function pointOnSegment(p: [number, number], x: [number, number], y: [number, number]): boolean {
  if (Math.abs(orient(x, y, p)) > EPS * 100) return false
  return (
    p[0] >= Math.min(x[0], y[0]) - EPS * 100 &&
    p[0] <= Math.max(x[0], y[0]) + EPS * 100 &&
    p[1] >= Math.min(x[1], y[1]) - EPS * 100 &&
    p[1] <= Math.max(x[1], y[1]) + EPS * 100
  )
}

/** 退化判定：折线 poly 的内部顶点 v（索引 k）落在线段 xy 上，且 v 前后两点异号 → 穿越。 */
function interiorVertexCrosses(poly: Polyline, x: [number, number], y: [number, number]): boolean {
  for (let k = 1; k < poly.length - 1; k++) {
    const v = poly[k]
    if (!pointOnSegment(v, x, y)) continue
    const before = orient(x, y, poly[k - 1])
    const after = orient(x, y, poly[k + 1])
    if (before * after < -EPS) return true
  }
  return false
}

/** 两条折线是否交叉（端点相触不算；内部顶点穿越算）。 */
export function polylinesCross(pa: Polyline, pb: Polyline): boolean {
  for (let i = 0; i < pa.length - 1; i++) {
    for (let j = 0; j < pb.length - 1; j++) {
      if (segmentsCrossStrict(pa[i], pa[i + 1], pb[j], pb[j + 1])) return true
    }
  }
  for (let j = 0; j < pb.length - 1; j++) {
    if (interiorVertexCrosses(pa, pb[j], pb[j + 1])) return true
  }
  for (let i = 0; i < pa.length - 1; i++) {
    if (interiorVertexCrosses(pb, pa[i], pa[i + 1])) return true
  }
  return false
}

/** 统计边集合的交叉总数。 */
export function countCrossings(edges: Array<{ points: Polyline; source: string; target: string }>): number {
  const sampled = edges.map((e) => sampleCurve(e.points))
  let total = 0
  for (let i = 0; i < sampled.length; i++) {
    for (let j = i + 1; j < sampled.length; j++) {
      if (polylinesCross(sampled[i], sampled[j])) total++
    }
  }
  return total
}
