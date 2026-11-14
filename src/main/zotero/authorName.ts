/**
 * 作者姓名规范化（D93「同一作者」自动关系的判等依据）。
 * 与 probes/lib/author-name.mjs 同一套规则，TS 版供主进程导入器使用。
 *
 * 规则（作者定，不做模糊匹配、不做缩写推断）：
 *   1. 转小写；
 *   2. 去重音（NFD 分解后去掉组合记号）；
 *   3. 去标点（标点视作空格）；
 *   4. 统一成「名 姓」顺序：带逗号的 "姓, 名" 形式翻转为 "名 姓"；
 *   5. 合并多余空格。
 * 规范化后字符串完全一致即算同一人。
 */
export function normalizeAuthorName(name: string): string {
  let s = String(name ?? '').trim()
  // "Family, Given" → "Given Family"（D93：统一成名 姓顺序）
  const commaParts = s.split(',')
  if (commaParts.length === 2 && commaParts.every((p) => p.trim())) {
    s = `${commaParts[1].trim()} ${commaParts[0].trim()}`
  }
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // 组合字符区间用 \u 转义，避免源码里的字面量被编辑器/复制破坏（评审建议修 6）
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/** 两组作者名单是否有共同作者（按 D93 规范化后精确比较）。 */
export function hasCommonAuthor(namesA: string[], namesB: string[]): boolean {
  const setB = new Set((namesB ?? []).map(normalizeAuthorName))
  return (namesA ?? []).some((n) => setB.has(normalizeAuthorName(n)))
}
