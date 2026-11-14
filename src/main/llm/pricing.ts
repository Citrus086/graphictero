/**
 * DeepSeek 计价与高峰/空闲判定（D96，2026-10-26 起替换 D58/D79 的美元×7.1 折算）。
 *
 * 作者的 DeepSeek 是国内账号、人民币计费（D96）：价目直接用官方人民币价，
 * 不再做美元×汇率换算。
 *
 * 价目来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * 2026-10-26 核实，deepseek-flash（DeepSeek-V4.1-Flash-1017），单位 ¥/1M tokens：
 *   输入 cache miss：高峰 ¥2 / 空闲 ¥1
 *   输入 cache hit： 高峰 ¥0.04 / 空闲 ¥0.02
 *   输出：           高峰 ¥8 / 空闲 ¥4
 * 高峰时段（官方定义）：北京时间周一至周五 9:00–12:00、14:00–18:00（官方另排除
 * 中国法定节假日，本地不做节假日判断，按工作日区间近似）；其余含周末全部空闲。
 * 实现用等价的 UTC 区间（周一至周五 01:00–04:00 和 06:00–10:00）。
 * 不设任何读取上限，也不做大调用提醒（D58）。
 */

export interface PriceEntry {
  peak: number
  offPeak: number
}

export interface ModelPrice {
  inputCacheMiss: PriceEntry
  inputCacheHit: PriceEntry
  output: PriceEntry
}

/** deepseek-flash 价目（来源与日期见文件头注释；改价只需改这里） */
export const FLASH_PRICE: ModelPrice = {
  inputCacheMiss: { peak: 2, offPeak: 1 },
  inputCacheHit: { peak: 0.04, offPeak: 0.02 },
  output: { peak: 8, offPeak: 4 }
}

/** 周一至周五 UTC 01:00–04:00 / 06:00–10:00（= 北京时间 9–12 / 14–18） */
const PEAK_RANGES_UTC: Array<[number, number]> = [
  [1, 4],
  [6, 10]
]

export function isPeakHour(at: Date = new Date()): boolean {
  const day = at.getUTCDay()
  if (day === 0 || day === 6) return false // 周末全部空闲
  const h = at.getUTCHours() + at.getUTCMinutes() / 60
  return PEAK_RANGES_UTC.some(([s, e]) => h >= s && h < e)
}

export interface TokenUsage {
  inputTokens: number
  cacheHitTokens: number
  outputTokens: number
  /** D180：推理 token 是输出 token 的子集，仅统计；未知时缺省，不改变计价公式。 */
  reasoningTokens?: number
}

/** 按请求发生时刻的高峰/空闲人民币价计费（D96：价目本身就是人民币，直接求和） */
export function costCny(usage: TokenUsage, at: Date = new Date(), price: ModelPrice = FLASH_PRICE): number {
  const p = isPeakHour(at) ? 'peak' : 'offPeak'
  const hit = Math.max(0, usage.cacheHitTokens)
  const miss = Math.max(0, usage.inputTokens - hit)
  return (
    (miss / 1e6) * price.inputCacheMiss[p] +
    (hit / 1e6) * price.inputCacheHit[p] +
    (usage.outputTokens / 1e6) * price.output[p]
  )
}
