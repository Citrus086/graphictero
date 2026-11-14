import { describe, expect, it } from 'vitest'
import { costCny, fetchBalance, FLASH_PRICE, isPeakHour } from './cost.mjs'

/**
 * D96 探针计价（不联网，0 token）：
 * 人民币价目（2026-10-26 核实的中文官方定价页）峰/谷换算 + 余额接口解析。
 * 余额接口本身免费，但这里仍用假 fetch，不碰真实 API。
 */

describe('isPeakHour（高峰 = 北京 9–12、14–18 = UTC 周一至周五 1–4、6–10）', () => {
  it('周一 UTC 02:00 高峰、UTC 05:00 空闲、周六空闲', () => {
    expect(isPeakHour(new Date('2026-10-26T02:00:00Z'))).toBe(true) // 周一
    expect(isPeakHour(new Date('2026-10-26T05:00:00Z'))).toBe(false)
    expect(isPeakHour(new Date('2026-10-24T02:00:00Z'))).toBe(false) // 周六
  })
})

describe('costCny（D96：人民币价目直接计费，空闲半价）', () => {
  const peakAt = new Date('2026-10-26T02:00:00Z')
  const offAt = new Date('2026-10-26T12:00:00Z')

  it('官方价目常量（¥/1M tokens）：高峰 2/0.04/8，空闲 1/0.02/4', () => {
    expect(FLASH_PRICE).toEqual({
      inputCacheMiss: { peak: 2, offPeak: 1 },
      inputCacheHit: { peak: 0.04, offPeak: 0.02 },
      output: { peak: 8, offPeak: 4 }
    })
  })

  it('高峰：cache miss/hit 输入与输出分别计价（OpenAI 格式 usage）', () => {
    const usage = { prompt_tokens: 1_000_000, prompt_cache_hit_tokens: 200_000, completion_tokens: 500_000 }
    expect(costCny(usage, peakAt)).toBeCloseTo(0.8 * 2 + 0.2 * 0.04 + 0.5 * 8, 10) // ¥5.608
  })

  it('空闲半价：同一 usage 空闲费用恰为高峰一半', () => {
    const usage = { prompt_tokens: 500_000, prompt_cache_hit_tokens: 100_000, completion_tokens: 100_000 }
    expect(costCny(usage, offAt)).toBeCloseTo(costCny(usage, peakAt) / 2, 10)
  })
})

describe('fetchBalance（D96 对账：/user/balance，CNY；假 fetch，不碰真实 API）', () => {
  const okFetch = async () =>
    ({ ok: true, status: 200, json: async () => ({ balance_infos: [{ currency: 'CNY', total_balance: '98.76' }] }) })

  it('解析 balance_infos[0] 为 { total, currency }', async () => {
    expect(await fetchBalance('https://api.deepseek.com', 'k', okFetch)).toEqual({ total: 98.76, currency: 'CNY' })
  })

  it('HTTP 错误抛中文错误（探针记录后不影响主流程）', async () => {
    const failFetch = async () => ({ ok: false, status: 401, json: async () => ({}) })
    await expect(fetchBalance('https://api.deepseek.com', 'k', failFetch)).rejects.toThrow('查询余额失败（HTTP 401）')
  })

  it('响应格式不认识时抛错', async () => {
    const badFetch = async () => ({ ok: true, status: 200, json: async () => ({}) })
    await expect(fetchBalance('https://api.deepseek.com', 'k', badFetch)).rejects.toThrow('余额响应格式不认识')
  })
})
