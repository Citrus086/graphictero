/**
 * uat6c M1：候选 reason 的显示层守卫——状态与理由分开存（in_graph 等状态走独立
 * 列 / 徽标），reason 只放人写 / Agent 写的理由。迁移 087 曾把状态码 'in_graph'
 * 直接写进 reason 覆盖了原中文理由（uat6c 迁移 089 恢复 / 置空收口）；这里在
 * **所有渲染出口**（聊天卡片 PaperCardBlock、画布候选节点、主进程出卡）统一过滤，
 * 已知内部枚举永不当正文显示，空 / NULL 不显示理由行。
 *
 * 放 shared：主进程（agent/tools.ts 出卡）与渲染层（PaperCardBlock / GraphPage）
 * 共用同一份白名单，避免再次漏出。新增内部状态码时同步维护 CANDIDATE_REASON_STATUS_CODES。
 */

/** 不允许当候选理由正文显示的内部状态码（小写集合，比较前 trim + toLowerCase）。 */
export const CANDIDATE_REASON_STATUS_CODES: ReadonlySet<string> = new Set([
  'in_graph',
  'dismissed',
  'pending',
  'confirmed',
  'ignored',
  'pair_has_relation'
])

/**
 * 候选理由的显示值：空 / NULL / 已知内部状态码 → null（不显示理由行）；
 * 其余原样返回。主进程出卡与渲染端渲染都走这一处。
 */
export function displayCandidateReason(reason: string | null | undefined): string | null {
  const t = reason?.trim()
  if (!t) return null
  if (CANDIDATE_REASON_STATUS_CODES.has(t.toLowerCase())) return null
  return t
}
