import type { RelationView } from '../../../shared/ipc'

/** 论文节点的 React Flow id；候选与乐观临时节点一律不属于可选择论文。 */
export function paperNodeId(id: string): number | null {
  if (!/^[1-9]\d*$/.test(id)) return null
  const n = Number(id)
  return Number.isSafeInteger(n) ? n : null
}

/** 选择变化只翻 `selected`。内容不变时返回原数组，避免整批换节点对象。 */
export function withPaperSelection<T extends { id: string; selected?: boolean }>(
  nodes: readonly T[],
  selected: ReadonlySet<number>
): readonly T[] {
  let changed = false
  const next = nodes.map((node) => {
    const paperId = paperNodeId(node.id)
    const want = paperId != null && selected.has(paperId)
    if (!!node.selected === want) return node
    changed = true
    return { ...node, selected: want }
  })
  return changed ? next : nodes
}

/** 两个论文 id 集合内容相同。选择回写必须用它挡掉新 Set，否则会和 xyflow 的 onSelectionChange 互踢。 */
export function samePaperIdSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}

/** reload / 外部改图后，选择只保留仍在本图中的论文。内容不变时返回原集合。 */
export function prunePaperSelection(selected: ReadonlySet<number>, memberIds: ReadonlySet<number>): Set<number> {
  const next = new Set([...selected].filter((id) => memberIds.has(id)))
  return samePaperIdSet(selected, next) ? (selected as Set<number>) : next
}

/** detail 刷新只剔除确实已不在图中的子图成员；成员都活着时保留原集合与子图横幅。 */
export function pruneSubgraphSelection(subgraph: ReadonlySet<number> | null, memberIds: ReadonlySet<number>): Set<number> | null {
  if (!subgraph) return null
  const next = prunePaperSelection(subgraph, memberIds)
  return next.size >= 2 ? next : null
}

/** 子图里 pane click / xyflow resetSelectedElements 不得改应用侧或受控节点选择。 */
export function selectionAfterPaneClick(selected: ReadonlySet<number>, subgraphOpen: boolean): Set<number> {
  if (subgraphOpen || selected.size === 0) return selected as Set<number>
  return new Set()
}

export function filterCanvasNodeChanges<T extends { type: string }>(changes: readonly T[], subgraphOpen: boolean): T[] {
  return changes.filter((change) => change.type !== 'remove' && !(subgraphOpen && change.type === 'select'))
}

/** ⌘/Ctrl/Shift-click 的切换语义；普通单击由 xyflow 的替换选择处理。 */
export function togglePaperSelection(selected: ReadonlySet<number>, paperId: number): Set<number> {
  const next = new Set(selected)
  if (next.has(paperId)) next.delete(paperId)
  else next.add(paperId)
  return next
}

/** uat7b M1：子图里该节点是否暗化（不可交互）。候选 / 乐观临时节点在子图里一律暗化。 */
export function isSubgraphDimNode(subgraph: ReadonlySet<number> | null, nodeId: string): boolean {
  if (subgraph == null) return false
  const id = paperNodeId(nodeId)
  return id == null || !subgraph.has(id)
}

/** 子图里该边是否暗化：两端都必须高亮（候选不在数据模型里，边只连真实论文）。 */
export function isSubgraphDimEdge(subgraph: ReadonlySet<number> | null, edge: { source: string; target: string }): boolean {
  if (subgraph == null) return false
  const src = paperNodeId(edge.source)
  const dst = paperNodeId(edge.target)
  return src == null || dst == null || !subgraph.has(src) || !subgraph.has(dst)
}

/** 子图只高亮两端都在冻结集合内的关系；候选节点不在这个数据模型里。 */
export function subgraphRelationIds(relations: readonly RelationView[], selected: ReadonlySet<number>): Set<number> {
  return new Set(
    relations.filter((r) => selected.has(r.paperLow) && selected.has(r.paperHigh)).map((r) => r.id)
  )
}

/** 批量移除的边快照按关系 id 去重（共享边只恢复一次）。 */
export function removalRelationSnapshots(relations: readonly RelationView[], paperIds: ReadonlySet<number>): RelationView[] {
  const byId = new Map<number, RelationView>()
  for (const r of relations) {
    if (paperIds.has(r.paperLow) || paperIds.has(r.paperHigh)) byId.set(r.id, r)
  }
  return [...byId.values()]
}

export interface DragPositionNode {
  id: string
  position: { x: number; y: number }
}

/** 只收集真正移动的论文节点；候选与未移动的选中节点不写库。 */
export function movedPaperPositions(
  origin: ReadonlyMap<string, { x: number; y: number }>,
  dragged: readonly DragPositionNode[]
): DragPositionNode[] {
  return dragged.filter((n) => {
    if (paperNodeId(n.id) == null) return false
    const before = origin.get(n.id)
    return before != null && (before.x !== n.position.x || before.y !== n.position.y)
  })
}

export function pointerClientPoint(e: MouseEvent | TouchEvent): { x: number; y: number } | null {
  if ('clientX' in e) return { x: e.clientX, y: e.clientY }
  const touch = e.changedTouches[0] ?? e.touches[0]
  return touch ? { x: touch.clientX, y: touch.clientY } : null
}

/** xyflow 拖拽是 pointer 事件而非 HTML5 DnD：用指针下的 DOM 判定是否落在抽屉内。 */
export function isChatDrawerPoint(e: MouseEvent | TouchEvent, doc: Document = document): boolean {
  const point = pointerClientPoint(e)
  if (!point) return false
  return doc.elementFromPoint(point.x, point.y)?.closest('[data-testid="chat-drawer"]') != null
}

export type CanvasEscAction = 'input' | 'modal' | 'menu' | 'external-layer' | 'focus' | 'subgraph' | 'clear-selection' | 'none'

export interface CanvasEscState {
  inputFocused: boolean
  modalOpen: boolean
  menuOpen: boolean
  /** 状态弹层、对话 + / 会话菜单等由宿主自己关闭的弹层 */
  externalLayerOpen: boolean
  focusOpen: boolean
  subgraphOpen: boolean
  hasSelection: boolean
}

/** D176：一次 Esc 只处理一层；input/external-layer 均由对应控件或宿主处理。 */
export function canvasEscAction(s: CanvasEscState): CanvasEscAction {
  if (s.inputFocused) return 'input'
  if (s.modalOpen) return 'modal'
  if (s.menuOpen) return 'menu'
  if (s.externalLayerOpen) return 'external-layer'
  if (s.focusOpen) return 'focus'
  if (s.subgraphOpen) return 'subgraph'
  if (s.hasSelection) return 'clear-selection'
  return 'none'
}
