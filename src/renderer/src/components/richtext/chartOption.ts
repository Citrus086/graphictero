/**
 * M4 lane/render：data-chart 的 ECharts option 安全校验（D19 适配层职责）。
 *
 * 原则：option 只是数据（JSON 语义），绝不 eval、绝不执行模型/用户给的代码。
 * 校验口径（保守、宁可拒）：
 * - 整个 option 必须可 JSON 序列化：拒绝 function / symbol / bigint / 循环引用；
 * - 单字符串 ≤ 10_000 字符、嵌套深度 ≤ 20、序列化后 ≤ 200 KB；
 * - undefined 字段直接丢弃（JSON 语义）；function / symbol / bigint 直接拒绝整个 option
 *   （宁可不渲染，也不给「悄悄丢掉一段代码」的错觉）。
 */

export const CHART_MAX_STRING = 10_000
export const CHART_MAX_DEPTH = 20
export const CHART_MAX_BYTES = 200 * 1024

export type ChartOptionResult =
  | { ok: true; option: Record<string, unknown> }
  | { ok: false; reason: string }

export function sanitizeChartOption(input: unknown): ChartOptionResult {
  const seen = new Set<object>()
  const walk = (v: unknown, depth: number, path: string): { value: unknown; drop: boolean } | { error: string } => {
    if (depth > CHART_MAX_DEPTH) return { error: `嵌套过深（>${CHART_MAX_DEPTH} 层）：${path}` }
    if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') {
      return { error: `包含可执行/非法值类型（${typeof v}）：${path}` }
    }
    if (typeof v === 'undefined') return { drop: true, value: undefined } // 丢字段（JSON 语义），不算错
    if (typeof v === 'string') {
      if (v.length > CHART_MAX_STRING) return { error: `字符串超长（>${CHART_MAX_STRING}）：${path}` }
      return { value: v, drop: false }
    }
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) return { value: v, drop: false }
    if (Array.isArray(v)) {
      if (seen.has(v)) return { error: `循环引用：${path}` }
      seen.add(v)
      const out: unknown[] = []
      for (let i = 0; i < v.length; i++) {
        const r = walk(v[i], depth + 1, `${path}[${i}]`)
        if ('error' in r) return r
        if (!r.drop) out.push(r.value)
      }
      seen.delete(v)
      return { value: out, drop: false }
    }
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return { error: `循环引用：${path}` }
      seen.add(v)
      const proto = Object.getPrototypeOf(v)
      if (proto !== Object.prototype && proto !== null) return { error: `非纯对象（class 实例）：${path}` }
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v)) {
        const r = walk(val, depth + 1, path ? `${path}.${k}` : k)
        if ('error' in r) return r
        if (!r.drop) out[k] = r.value
      }
      seen.delete(v)
      return { value: out, drop: false }
    }
    return { error: `不支持的值类型：${path}` }
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, reason: 'option 必须是对象' }
  }
  const r = walk(input, 0, '')
  if ('error' in r) return { ok: false, reason: r.error }
  const option = r.value as Record<string, unknown>
  try {
    if (JSON.stringify(option).length > CHART_MAX_BYTES) {
      return { ok: false, reason: `option 超过 ${CHART_MAX_BYTES / 1024} KB` }
    }
  } catch {
    return { ok: false, reason: 'option 无法序列化' }
  }
  return { ok: true, option }
}
