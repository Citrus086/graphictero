import { describe, expect, it } from 'vitest'
import { placeNewNodes, type ExistingNode } from './placement'

/**
 * M1 终审建议修 1：加论文后旧节点坐标不变、新节点不与已有节点重叠。
 * placeNewNodes 是纯函数：只为新节点算坐标，已有节点不返回（调用方不回写）。
 */

const W = 200
const H = 64

function noOverlap(positions: Array<{ x: number; y: number }>, existing: ExistingNode[]): void {
  const all = [
    ...existing.map((n) => ({ id: n.id, x: n.x, y: n.y })),
    ...positions.map((p, i) => ({ id: `new${i}`, ...p }))
  ]
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i]
      const b = all[j]
      const hit = a.x < b.x + W && b.x < a.x + W && a.y < b.y + H && b.y < a.y + H
      expect(hit, `${a.id} 与 ${b.id} 重叠`).toBe(false)
    }
  }
}

describe('placeNewNodes（加论文增量定位，终审建议修 1）', () => {
  it('空图：从 padding 起网格排布，坐标非负、互不重叠', () => {
    const ids = ['a', 'b', 'c', 'd', 'e']
    const pos = placeNewNodes([], ids, { width: W, height: H })
    expect([...pos.keys()].sort()).toEqual(ids.sort())
    for (const p of pos.values()) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeGreaterThanOrEqual(0)
    }
    noOverlap([...pos.values()], [])
  })

  it('有已有节点：新节点全部在包围盒右侧，不与任何已有节点重叠', () => {
    const existing: ExistingNode[] = [
      { id: 'old1', x: 12, y: 12 },
      { id: 'old2', x: 12, y: 300 },
      { id: 'old3', x: 500, y: 150 }
    ]
    const pos = placeNewNodes(existing, ['n1', 'n2', 'n3'], { width: W, height: H })
    const maxRight = Math.max(...existing.map((n) => n.x + W))
    for (const p of pos.values()) expect(p.x).toBeGreaterThanOrEqual(maxRight)
    noOverlap([...pos.values()], existing)
  })

  it('只返回新节点坐标：已有节点坐标不在结果里（调用方无从回写）', () => {
    const existing: ExistingNode[] = [{ id: 'old1', x: 96, y: 26 }]
    const pos = placeNewNodes(existing, ['n1'], { width: W, height: H })
    expect(pos.has('old1')).toBe(false)
    expect(pos.size).toBe(1)
  })

  it('新节点数量超过一列容量时换列，仍互不重叠', () => {
    const existing: ExistingNode[] = [{ id: 'old1', x: 0, y: 0 }]
    const ids = Array.from({ length: 9 }, (_, i) => `n${i}`)
    const pos = placeNewNodes(existing, ids, { width: W, height: H })
    noOverlap([...pos.values()], existing)
    expect(pos.size).toBe(9)
  })

  it('空新增列表返回空 Map', () => {
    expect(placeNewNodes([{ id: 'a', x: 0, y: 0 }], []).size).toBe(0)
  })
})
