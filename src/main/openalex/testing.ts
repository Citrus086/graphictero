import type { OpenAlexClient } from './client'

/**
 * 测试辅助：假 OpenAlex 客户端（默认全部「查不到」，引擎测试按用例覆写）。
 * 独立成非 .test 文件，避免测试文件互相 import 导致用例被重复注册。
 */
export function makeFakeOpenAlex(overrides: Partial<OpenAlexClient> = {}): OpenAlexClient & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async fetchWorkByDoi() {
      calls.push('doi')
      return null
    },
    async fetchWorkByWid() {
      calls.push('wid')
      return null
    },
    async searchWorksByTitle() {
      calls.push('search')
      return []
    },
    async fetchWorksByWids() {
      calls.push('wids')
      return []
    },
    async searchWorksFull() {
      calls.push('searchFull')
      return []
    },
    async fetchCitingWorksByWid() {
      calls.push('cites')
      return []
    },
    async fetchWorkFullByDoi() {
      calls.push('fullDoi')
      return null
    },
    async fetchWorkFullByWid() {
      calls.push('fullWid')
      return null
    },
    ...overrides
  }
}
