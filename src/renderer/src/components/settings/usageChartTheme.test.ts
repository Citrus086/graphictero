// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { DARK_FALLBACK_USAGE_PALETTE, FALLBACK_USAGE_PALETTE, readUsagePalette } from './usageChart'

afterEach(() => {
  delete document.documentElement.dataset.theme
})

describe('用量图主题 fallback（uat8-fix1 S6）', () => {
  it('CSS 变量不可读时按 data-theme 选深色或浅色调色板', () => {
    expect(readUsagePalette()).toEqual(FALLBACK_USAGE_PALETTE)
    document.documentElement.dataset.theme = 'dark'
    expect(readUsagePalette()).toEqual(DARK_FALLBACK_USAGE_PALETTE)
  })
})
