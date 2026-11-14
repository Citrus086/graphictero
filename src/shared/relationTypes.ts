/**
 * 关系类型（D84/D89）：固定五种原子类型，主进程存英文 key，
 * 界面显示中文标签。边上只显示类型组合短标签（如「基于 · 对比」）。
 * 主进程（src/main/db/relations.ts 的 RELATION_TYPES）与渲染进程共用本定义，
 * 避免两处漂移。
 */

export const RELATION_TYPES = ['based_on', 'implements', 'compares', 'cites', 'same_author'] as const
export type RelationType = (typeof RELATION_TYPES)[number]

/** D89：只能由程序自动附加的类型 */
export const AUTO_RELATION_TYPES: readonly RelationType[] = ['cites', 'same_author']

export const RELATION_TYPE_LABELS: Record<RelationType, string> = {
  based_on: '基于/改进',
  implements: '具体实现',
  compares: '对比',
  cites: '引用',
  same_author: '同一作者'
}

/** 按 RELATION_TYPES 的固定顺序输出，保证标签稳定（LLM/auto 分开传入） */
export function relationTypeLabel(types: readonly RelationType[]): string {
  const set = new Set(types)
  const ordered = RELATION_TYPES.filter((t) => set.has(t))
  return ordered.map((t) => RELATION_TYPE_LABELS[t]).join(' · ')
}

export function isRelationType(v: string): v is RelationType {
  return (RELATION_TYPES as readonly string[]).includes(v)
}

/** B7：addRelation 入参接受中文类型名或英文 id，内部统一转 id（D86 口径） */
export function relationTypeFromInput(v: string): RelationType | null {
  if (isRelationType(v)) return v
  const t = v.trim()
  if (isRelationType(t)) return t
  for (const id of RELATION_TYPES) {
    if (RELATION_TYPE_LABELS[id] === t) return id
  }
  return null
}
