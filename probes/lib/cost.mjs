/**
 * DeepSeek 计价（D96：作者是国内账号、人民币计费，替换 D58/D79 的美元×7.1 折算）。
 * 价目来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * 2026-10-26 核实，deepseek-flash（DeepSeek-V4.1-Flash-1017），单位 ¥/1M tokens：
 *   输入 cache miss：高峰 ¥2 / 空闲 ¥1
 *   输入 cache hit： 高峰 ¥0.04 / 空闲 ¥0.02
 *   输出：           高峰 ¥8 / 空闲 ¥4
 * 高峰时段（官方定义）：北京时间周一至周五 9:00–12:00、14:00–18:00；其余含周末全部空闲
 * （官方另排除中国法定节假日，本地不判断节假日）。实现用等价 UTC 区间（周一至周五 1–4、6–10）。
 */

export const FLASH_PRICE = {
  inputCacheMiss: { peak: 2, offPeak: 1 },
  inputCacheHit: { peak: 0.04, offPeak: 0.02 },
  output: { peak: 8, offPeak: 4 }
}

const PEAK_RANGES_UTC = [
  [1, 4],
  [6, 10]
] // 周一至周五，小时（UTC）

export function isPeakHour(date = new Date()) {
  const day = date.getUTCDay()
  if (day === 0 || day === 6) return false // 周末全部空闲
  const h = date.getUTCHours() + date.getUTCMinutes() / 60
  return PEAK_RANGES_UTC.some(([s, e]) => h >= s && h < e)
}

/** usage: { prompt_tokens, completion_tokens, prompt_cache_hit_tokens }（OpenAI 格式）→ 人民币费用 */
export function costCny(usage, at = new Date()) {
  const p = isPeakHour(at) ? 'peak' : 'offPeak'
  const hit = Math.max(0, usage.prompt_cache_hit_tokens ?? 0)
  const miss = Math.max(0, (usage.prompt_tokens ?? 0) - hit)
  return (
    (miss / 1e6) * FLASH_PRICE.inputCacheMiss[p] +
    (hit / 1e6) * FLASH_PRICE.inputCacheHit[p] +
    ((usage.completion_tokens ?? 0) / 1e6) * FLASH_PRICE.output[p]
  )
}

/**
 * 账户余额（D96 对账口径，查询免费）：GET {baseUrl}/user/balance。
 * 返回 { total: number, currency: string }（DeepSeek 国内账号为 CNY）。
 */
export async function fetchBalance(baseUrl, apiKey, fetchImpl = fetch) {
  const res = await fetchImpl(`${baseUrl}/user/balance`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  })
  if (!res.ok) throw new Error(`查询余额失败（HTTP ${res.status}）`)
  const j = await res.json()
  const info = j.balance_infos?.[0]
  if (info == null || info.total_balance == null) throw new Error('余额响应格式不认识')
  return { total: Number(info.total_balance), currency: info.currency ?? 'CNY' }
}
