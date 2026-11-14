import type { RelationView } from '../../../shared/ipc'
import { RELATION_TYPES, type RelationType } from '../../../shared/relationTypes'

export function relationTypesOf(relation: Pick<RelationView, 'llmTypes' | 'autoTypes'>): Set<RelationType> {
  return new Set([...relation.llmTypes, ...relation.autoTypes])
}

/** 无类型边始终显示；多类型边只要还有一种可见类型就保留。 */
export function relationTypeVisible(
  relation: Pick<RelationView, 'llmTypes' | 'autoTypes'>,
  hiddenTypes: ReadonlySet<RelationType>
): boolean {
  const types = relationTypesOf(relation)
  return types.size === 0 || [...types].some((type) => !hiddenTypes.has(type))
}

export function visibleRelationsByType(
  relations: readonly RelationView[],
  hiddenTypes: ReadonlySet<RelationType>
): RelationView[] {
  return relations.filter((relation) => relationTypeVisible(relation, hiddenTypes))
}

/** 一条多类型边分别计入它实际具有的每个类型；同一字段重复不重复计数。 */
export function relationTypeCounts(relations: readonly RelationView[]): Record<RelationType, number> {
  const counts = Object.fromEntries(RELATION_TYPES.map((type) => [type, 0])) as Record<RelationType, number>
  for (const relation of relations) {
    for (const type of relationTypesOf(relation)) counts[type] += 1
  }
  return counts
}

export function toggleHiddenRelationType(
  hiddenTypes: ReadonlySet<RelationType>,
  type: RelationType
): Set<RelationType> {
  const next = new Set(hiddenTypes)
  if (next.has(type)) next.delete(type)
  else next.add(type)
  return next
}

export type RelationAdjacency = ReadonlyMap<number, ReadonlySet<number>>

/** 关系邻接按无向图处理；Set 自动吸收自环的重复遍历与平行边。 */
export function buildRelationAdjacency(relations: readonly RelationView[]): RelationAdjacency {
  const adjacency = new Map<number, Set<number>>()
  const add = (from: number, to: number): void => {
    let targets = adjacency.get(from)
    if (!targets) {
      targets = new Set()
      adjacency.set(from, targets)
    }
    targets.add(to)
  }
  for (const relation of relations) {
    add(relation.paperLow, relation.paperHigh)
    add(relation.paperHigh, relation.paperLow)
  }
  return adjacency
}

export interface FocusNeighborhood {
  paperIds: Set<number>
  relationIds: Set<number>
}

/**
 * 从 root 做限定深度的无向 BFS；边集合取邻域内所有可见边（含邻居之间的边）。
 * 调用方应传入类型过滤后的 relations；孤立 root 仍得到只含自己的邻域。
 */
export function focusNeighborhood(
  relations: readonly RelationView[],
  root: number,
  depth: 1 | 2,
  adjacency: RelationAdjacency = buildRelationAdjacency(relations)
): FocusNeighborhood {
  const paperIds = new Set<number>([root])
  let frontier = [root]
  for (let level = 0; level < depth; level += 1) {
    const next = new Set<number>()
    for (const paperId of frontier) {
      for (const neighbor of adjacency.get(paperId) ?? []) {
        if (!paperIds.has(neighbor)) next.add(neighbor)
        paperIds.add(neighbor)
      }
    }
    frontier = [...next]
  }
  const relationIds = new Set(
    relations.filter((relation) => paperIds.has(relation.paperLow) && paperIds.has(relation.paperHigh)).map((relation) => relation.id)
  )
  return { paperIds, relationIds }
}

export interface EmphasisState {
  active: boolean
  paperIds: Set<number>
  relationIds: Set<number>
}

/**
 * hover 优先；否则多选取并集。高亮根、直接邻居，以及两端都在 {根}∪直接邻居 内的关系
 * （含邻居之间的弦边，与 focusNeighborhood 同口径）；与邻域外节点相连的边不收录。
 */
export function neighborhoodEmphasis(
  relations: readonly RelationView[],
  hoveredPaperId: number | null,
  selectedPaperIds: ReadonlySet<number>
): EmphasisState {
  const roots = new Set(hoveredPaperId != null ? [hoveredPaperId] : [...selectedPaperIds])
  const paperIds = new Set<number>(roots)
  for (const relation of relations) {
    if (roots.has(relation.paperLow)) paperIds.add(relation.paperHigh)
    if (roots.has(relation.paperHigh)) paperIds.add(relation.paperLow)
  }
  const relationIds = new Set<number>()
  for (const relation of relations) {
    if (paperIds.has(relation.paperLow) && paperIds.has(relation.paperHigh)) relationIds.add(relation.id)
  }
  return { active: roots.size > 0, paperIds, relationIds }
}

export interface FocusShortcutState {
  key: string
  inputFocused: boolean
  selectedCount: number
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  isComposing?: boolean
}

/** 仅裸 F 且恰好选中一篇时触发；输入、IME 与所有修饰键均忽略。 */
export function shouldRunFocusShortcut(state: FocusShortcutState): boolean {
  return (
    state.key.toLowerCase() === 'f' &&
    state.selectedCount === 1 &&
    !state.inputFocused &&
    !state.ctrlKey &&
    !state.metaKey &&
    !state.altKey &&
    !state.shiftKey &&
    !state.isComposing
  )
}

/** 按图谱保存到本次渲染进程会话；不写 SQLite、不跨应用重启。 */
const sessionTypeFilters = new Map<number, Set<RelationType>>()

export function readSessionTypeFilter(graphId: number): Set<RelationType> {
  return new Set(sessionTypeFilters.get(graphId) ?? [])
}

export function writeSessionTypeFilter(graphId: number, hiddenTypes: ReadonlySet<RelationType>): void {
  if (hiddenTypes.size === 0) sessionTypeFilters.delete(graphId)
  else sessionTypeFilters.set(graphId, new Set(hiddenTypes))
}

export function clearSessionTypeFilters(): void {
  sessionTypeFilters.clear()
}
