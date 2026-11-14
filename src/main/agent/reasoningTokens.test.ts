import { describe, expect, it } from 'vitest'
import { reasoningTokensFromStep } from './runtime'

/**
 * uat7b S6(d)：SDK 报 0 且没有 raw 证据时 reasoning_tokens 落 NULL（未记录），
 * 有 raw 且明确为 0 才写 0。只影响展示，不进 costCny（pricing.ts 不变）。
 */

describe('reasoningTokensFromStep（uat7b S6(d)）', () => {
  it('SDK 缺字段 → undefined（落 NULL）', () => {
    expect(reasoningTokensFromStep({})).toBeUndefined()
    expect(reasoningTokensFromStep({ outputTokenDetails: {} })).toBeUndefined()
  })

  it('SDK 报正数 → 直接采用', () => {
    expect(reasoningTokensFromStep({ outputTokenDetails: { reasoningTokens: 321 } })).toBe(321)
  })

  it('SDK 报 0 且无 raw（缺失被 SDK 规范化成 0）→ undefined（未记录，不落 0）', () => {
    expect(reasoningTokensFromStep({ outputTokenDetails: { reasoningTokens: 0 } })).toBeUndefined()
  })

  it('SDK 报 0 且 raw 显式为 0 → 0', () => {
    expect(
      reasoningTokensFromStep({
        outputTokenDetails: { reasoningTokens: 0 },
        raw: { completion_tokens_details: { reasoning_tokens: 0 } }
      })
    ).toBe(0)
  })

  it('SDK 报 0 且 raw 有值 → raw 的值（以源响应为准）', () => {
    expect(
      reasoningTokensFromStep({
        outputTokenDetails: { reasoningTokens: 0 },
        raw: { completion_tokens_details: { reasoning_tokens: 15 } }
      })
    ).toBe(15)
  })

  it('raw 在但字段为 null → undefined（落 NULL）', () => {
    expect(
      reasoningTokensFromStep({
        outputTokenDetails: { reasoningTokens: 0 },
        raw: { completion_tokens_details: { reasoning_tokens: null } }
      })
    ).toBeUndefined()
    expect(
      reasoningTokensFromStep({
        outputTokenDetails: { reasoningTokens: 0 },
        raw: { completion_tokens_details: null }
      })
    ).toBeUndefined()
  })
})
