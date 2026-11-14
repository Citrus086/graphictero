import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installFetchGuard, startFixtureHttp, type FetchGuard, type FixtureHttp } from '../testing/fixtureHttp'
import { AuthLlmError, NetworkLlmError, RetryableLlmError } from '../llm/errors'
import { webFetchPage, webSearch } from './client'

/**
 * webSearch / webFetch：只打本地 fixture，不调用 DeepSeek。
 */

let fixture: FixtureHttp
let guard: FetchGuard

beforeEach(async () => {
  guard = installFetchGuard()
})

afterEach(async () => {
  await fixture?.close()
  for (const url of guard.urls) expect(new URL(url).hostname).toBe('127.0.0.1')
  guard.restore()
})

async function boot(web: NonNullable<Parameters<typeof startFixtureHttp>[0]>['web']): Promise<void> {
  fixture = await startFixtureHttp({ web })
}

describe('web client', () => {
  it('搜索有结果可记账，空结果不记账', async () => {
    await boot({ search: 'ok', fetch: 'empty' })
    const deps = { apiKey: 'k', baseUrl: fixture.baseUrl }
    const found = await webSearch(deps, '探针')
    expect(found.billable).toBe(true)
    expect(found.results[0]?.title).toBe('Fixture Page')
    const empty = await webFetchPage(deps, 'https://example.com/a')
    expect(empty.billable).toBe(false)
    expect(empty.page.content ?? '').toBe('')
    expect(fixture.requests.map((r) => r.url)).toEqual(['/v1/tools/search', '/v1/tools/fetch'])
  })

  it('429 是可重试，402 是余额不足，断网是 NetworkLlmError', async () => {
    await boot({ search: '429', fetch: '402' })
    const deps = { apiKey: 'k', baseUrl: fixture.baseUrl }
    await expect(webSearch(deps, 'q')).rejects.toBeInstanceOf(RetryableLlmError)
    await expect(webFetchPage(deps, 'https://example.com/a')).rejects.toBeInstanceOf(AuthLlmError)

    await fixture.close()
    await expect(webSearch(deps, 'q')).rejects.toBeInstanceOf(NetworkLlmError)
  })

  it('挂起的 fetch 在超时后变成可重试错误', async () => {
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) {
          reject(new Error('postJson 没有传 AbortSignal'))
          return
        }
        const fail = (): void => {
          const reason = signal.reason
          reject(reason instanceof Error ? reason : Object.assign(new Error('timeout'), { name: 'TimeoutError' }))
        }
        if (signal.aborted) {
          fail()
          return
        }
        signal.addEventListener('abort', fail, { once: true })
      })
    await expect(
      webSearch({ apiKey: 'k', baseUrl: 'http://127.0.0.1:9', fetchImpl, timeoutMs: 30 }, 'q')
    ).rejects.toThrow('网页工具请求超时')
  }, 2000)
})
