import { describe, expect, it } from 'vitest'
import { costCny, FLASH_PRICE, isPeakHour } from './pricing'

/**
 * 计价（D96：官方人民币价目直接计费，替换 D58/D79 的美元×7.1 折算）：
 * 价目常量的峰/谷换算、缓存命中价、高峰判定。
 * 价目来源与日期见 pricing.ts 头注释（2026-10-26 核实的中文官方定价页）。
 */

describe('isPeakHour（高峰 = 北京时间 9–12、14–18 = UTC 周一至周五 1–4、6–10）', () => {
  it('周一 UTC 02:00（北京 10:00）= 高峰', () => {
    expect(isPeakHour(new Date('2026-10-26T02:00:00Z'))).toBe(true) // 周一
  })
  it('周一 UTC 05:00（北京 13:00）= 空闲', () => {
    expect(isPeakHour(new Date('2026-10-26T05:00:00Z'))).toBe(false)
  })
  it('周一 UTC 07:00（北京 15:00）= 高峰', () => {
    expect(isPeakHour(new Date('2026-10-26T07:00:00Z'))).toBe(true)
  })
  it('周六全天空闲', () => {
    expect(isPeakHour(new Date('2026-10-24T02:00:00Z'))).toBe(false) // 周六
  })
})

describe('costCny（D96：人民币价目直接计费，空闲半价）', () => {
  const peakAt = new Date('2026-10-26T02:00:00Z') // 高峰
  const offAt = new Date('2026-10-26T12:00:00Z') // 空闲（北京 20:00）

  it('高峰价：cache miss 输入 + cache hit 输入 + 输出分别计价（¥/1M tokens）', () => {
    const u = { inputTokens: 1_000_000, cacheHitTokens: 200_000, outputTokens: 500_000 }
    const expected =
      0.8 * FLASH_PRICE.inputCacheMiss.peak + 0.2 * FLASH_PRICE.inputCacheHit.peak + 0.5 * FLASH_PRICE.output.peak
    expect(costCny(u, peakAt)).toBeCloseTo(expected, 10)
    // 对照官方价目（2026-10-26）：0.8×¥2 + 0.2×¥0.04 + 0.5×¥8 = ¥5.608
    expect(costCny(u, peakAt)).toBeCloseTo(5.608, 10)
  })

  it('空闲半价：同一 usage 空闲时段费用恰为高峰一半', () => {
    const u = { inputTokens: 500_000, cacheHitTokens: 100_000, outputTokens: 100_000 }
    expect(costCny(u, offAt)).toBeCloseTo(costCny(u, peakAt) / 2, 10)
  })

  it('D180：reasoningTokens 是输出子集，不重复计价', () => {
    const u = { inputTokens: 1_000_000, cacheHitTokens: 200_000, outputTokens: 500_000 }
    expect(costCny({ ...u, reasoningTokens: 400_000 }, peakAt)).toBeCloseTo(costCny(u, peakAt), 10)
  })

  it('cacheHit 超过 input 的脏数据不产出负费用', () => {
    const u = { inputTokens: 10, cacheHitTokens: 100, outputTokens: 0 }
    expect(costCny(u, peakAt)).toBeGreaterThanOrEqual(0)
  })

  it('官方价目常量（人民币，¥/1M tokens）', () => {
    expect(FLASH_PRICE).toEqual({
      inputCacheMiss: { peak: 2, offPeak: 1 },
      inputCacheHit: { peak: 0.04, offPeak: 0.02 },
      output: { peak: 8, offPeak: 4 }
    })
  })
})
