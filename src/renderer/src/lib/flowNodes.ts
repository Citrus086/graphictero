/**
 * uat3b 4.1：GraphDetail → React Flow 节点重建时保留 xyflow 的测量字段。
 *
 * 根因：candProg / papersStatus 变化触发整批 setNodes 全新对象，丢掉 `measured`
 * （及运行态），xyflow v12 视为未测量节点（UAT：11 个节点 visibility:hidden，
 * 确认入库后画布全空）。这里按 id 把旧节点的 `measured` 合并进新节点对象；
 * 位置仍以库里的坐标为准（detail.members / 候选坐标），只保留测量运行态。
 */

export interface MeasuredLike {
  width?: number
  height?: number
}

export interface FlowNodeLike {
  id: string
  measured?: MeasuredLike
}

/** 按 id 保留旧节点的 measured（纯函数，可测） */
export function preserveMeasured<T extends FlowNodeLike>(prev: T[], next: T[]): T[] {
  if (prev.length === 0) return next
  const byId = new Map(prev.map((n) => [n.id, n]))
  return next.map((n) => {
    const old = byId.get(n.id)
    return old?.measured ? { ...n, measured: old.measured } : n
  })
}

/**
 * uat6 M1 根因修复：论文节点声明式尺寸 + 连接点（handles）。
 *
 * 根因：xyflow v12 只有当两端节点都「初始化」
 * （internals.handleBounds + 任一尺寸字段，见 @xyflow/system isNodeInitialized）时才渲染
 * 边；handleBounds 只能来自异步 DOM 测量（ResizeObserver → updateNodeInternals），其
 * 中有多条静默 no-op 路径（viewport 未挂载 / 测量时节点 0 尺寸 / internals 重建后
 * RO 不再补发），一旦踩中，边永远 0 条且任何 state 更新都无法恢复——re-adoption 时
 * parseHandles 只会从旧 internals 复制 handleBounds，绝不会重新量 DOM。UAT 现场
 * （retest_uat4/03：节点可见、21 条关系顶栏有数、画布 0 边、视口未 fit）即「store 内
 * 节点从未被测量」的完整形态；重开图谱重挂 ReactFlow 才恢复。
 *
 * 修复：paper 节点固定 200×64（styles.css .pnode），把尺寸（initialWidth/Height）与
 * 连接点（上 target / 下 source，8px 圆点居中对齐 .pnode-handle 的 DOM 位置）以数据
 * 声明——adoptUserNodes 同步从 userNode.handles 构建 handleBounds，边在首次 store
 * 同步后即可计算，完全不依赖测量时序；RO 后续的真实测量仍会修正 DOM 句柄位置。
 */
import { Position } from '@xyflow/react'

export const PAPER_NODE_W = 200
export const PAPER_NODE_H = 64
/** 与 .pnode-handle 一致的 8px 连接点 */
const HANDLE_SIZE = 8

export interface DeclarativeHandle {
  id: null
  nodeId: string
  type: 'source' | 'target'
  position: Position
  x: number
  y: number
  width: number
  height: number
}

/** 论文节点的声明式尺寸 + 连接点（M1：边渲染不依赖异步测量） */
export function paperNodeDeclarative(id: string): {
  initialWidth: number
  initialHeight: number
  handles: DeclarativeHandle[]
} {
  const cx = PAPER_NODE_W / 2 - HANDLE_SIZE / 2
  return {
    initialWidth: PAPER_NODE_W,
    initialHeight: PAPER_NODE_H,
    handles: [
      // target：上边缘中点（DOM 句柄 translate(-50%,-50%) 居中于 y=0 → bounds y=-4）
      { id: null, nodeId: id, type: 'target', position: Position.Top, x: cx, y: -HANDLE_SIZE / 2, width: HANDLE_SIZE, height: HANDLE_SIZE },
      // source：下边缘中点（居中于 y=64 → bounds y=60）
      { id: null, nodeId: id, type: 'source', position: Position.Bottom, x: cx, y: PAPER_NODE_H - HANDLE_SIZE / 2, width: HANDLE_SIZE, height: HANDLE_SIZE }
    ]
  }
}
