/**
 * 自动布局（D22/D78/D80）：ELK layered。纯函数模块，主进程测试与渲染进程共用。
 * D78 说放 Web Worker——M1 数据量小，渲染进程直接跑 elkjs（同步 bundled 版），
 * 量大再挪 Worker（见 PROGRESS 取舍）。
 */

import ELK, { type ElkExtendedEdge, type ElkNode } from 'elkjs/lib/elk.bundled.js'

export interface LayoutNode {
  id: string
  width: number
  height: number
}

export interface LayoutEdge {
  id: string
  source: string
  target: string
}

export interface Position {
  x: number
  y: number
}

/** ELK 输出的边折线/控制点（用于 D80 交叉数对比；单位与坐标同布局坐标系） */
export interface RoutedEdge {
  id: string
  source: string
  target: string
  /** 从源节点边界到目标节点边界的途经点（含首尾） */
  points: Array<[number, number]>
}

export interface LayoutResult {
  /** 节点左上角坐标 */
  positions: Map<string, Position>
  edges: RoutedEdge[]
}

/** 与原型 dagre 参数同量级（原型 nodesep 56 / ranksep 72 / TB） */
const ELK_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.spacing.nodeNode': '56',
  'elk.layered.spacing.nodeNodeBetweenLayers': '72',
  'elk.layered.spacing.edgeNodeBetweenLayers': '24',
  'elk.edgeRouting': 'SPLINES'
} as const

export async function computeElkLayout(nodes: LayoutNode[], edges: LayoutEdge[]): Promise<LayoutResult> {
  const elk = new ELK()
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: { ...ELK_OPTIONS },
    children: nodes.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })) satisfies ElkExtendedEdge[]
  }
  const result = await elk.layout(graph)
  const positions = new Map<string, Position>()
  for (const child of result.children ?? []) {
    // 评审建 5 实证（elkjs 0.12）：ELK 返回的 x/y 就是节点左上角坐标（首节点 = padding），
    // 与 graph_members 存的画布坐标同口径，直接用；旧实现误当中心坐标减 w/2、h/2，落库出负值
    positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 })
  }
  const routed: RoutedEdge[] = []
  for (const edge of result.edges ?? []) {
    const pts: Array<[number, number]> = []
    for (const section of edge.sections ?? []) {
      pts.push([section.startPoint.x, section.startPoint.y])
      for (const b of section.bendPoints ?? []) pts.push([b.x, b.y])
      pts.push([section.endPoint.x, section.endPoint.y])
    }
    const src = edges.find((e) => e.id === edge.id)
    if (src && pts.length >= 2) routed.push({ id: edge.id, source: src.source, target: src.target, points: pts })
  }
  return { positions, edges: routed }
}
