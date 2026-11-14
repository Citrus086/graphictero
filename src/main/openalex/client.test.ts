import { describe, expect, it } from 'vitest'
import { createOpenAlexClient, parseWork, widOf } from './client'
import { BadRequestLlmError, NetworkLlmError, RetryableLlmError } from '../llm/errors'

/**
 * OpenAlex 薄客户端测试：全部用假 fetchImpl，不做任何真实请求。
 * 覆盖：字段解析、mailto/api_key、限速间隔、429 遵守 Retry-After、5xx 重试、断网。
 */

const WORK_JSON = {
  id: 'https://openalex.org/W2962883861',
  doi: 'https://doi.org/10.1145/3442188.3445922',
  title: 'On the Opportunities and Risks of Foundation Models',
  publication_year: 2021,
  authorships: [{ author: { display_name: 'Rishi Bommasani' } }],
  referenced_works: ['https://openalex.org/W1', 'https://openalex.org/W2']
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers })
}

type Call = { url: string }

function fakeFetch(handler: (url: string) => Response | Promise<Response>): {
  fetchImpl: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const fetchImpl = (async (url: string | URL): Promise<Response> => {
    calls.push({ url: String(url) })
    return handler(String(url))
  }) as typeof fetch
  return { fetchImpl, calls }
}

const noSleep = (): Promise<void> => Promise.resolve()

describe('widOf / parseWork', () => {
  it('从 id URL 取裸 W-ID；大小写归一', () => {
    expect(widOf('https://openalex.org/W2962883861')).toBe('W2962883861')
    expect(widOf('https://openalex.org/w123')).toBe('W123')
    expect(widOf(null)).toBeNull()
    expect(widOf('not-a-url')).toBeNull()
  })

  it('解析 work：DOI 去 resolver 前缀、referenced_works 取裸 W-ID', () => {
    const w = parseWork(WORK_JSON)
    expect(w.wid).toBe('W2962883861')
    expect(w.doi).toBe('10.1145/3442188.3445922')
    expect(w.title).toContain('Foundation Models')
    expect(w.publicationYear).toBe(2021)
    expect(w.firstAuthorSurname).toBe('bommasani')
    expect(w.referencedWorks).toEqual(['W1', 'W2'])
  })
})

describe('createOpenAlexClient', () => {
  it('按 DOI 查单篇：带 mailto/api_key，解析返回', async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse(WORK_JSON))
    const c = createOpenAlexClient({ fetchImpl, apiKey: 'SECRET', mailto: 'p@example.com', sleep: noSleep, minIntervalMs: 0 })
    const w = await c.fetchWorkByDoi('10.1145/3442188.3445922')
    expect(w?.wid).toBe('W2962883861')
    const url = new URL(calls[0].url)
    expect(url.pathname).toBe('/works/doi:10.1145%2F3442188.3445922')
    expect(url.searchParams.get('mailto')).toBe('p@example.com')
    expect(url.searchParams.get('api_key')).toBe('SECRET')
  })

  it('没有 mailto 时不带占位邮箱', async () => {
    let ua = ''
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      ua = new Headers(init?.headers).get('user-agent') ?? ''
      expect(String(url)).not.toContain('mailto=')
      expect(String(url)).not.toContain('example.com')
      return jsonResponse(WORK_JSON)
    }) as typeof fetch
    const c = createOpenAlexClient({ fetchImpl, sleep: noSleep, minIntervalMs: 0 })
    expect((await c.fetchWorkByDoi('10.1/x'))?.wid).toBe('W2962883861')
    expect(ua).toBe('Graphictero')
    expect(ua).not.toContain('example.com')
  })

  it('2xx 计一次，404 与额度用尽不计、额度用尽不重试', async () => {
    let billed = 0
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse(WORK_JSON))
    const c = createOpenAlexClient({ fetchImpl, sleep: noSleep, minIntervalMs: 0, onBillable: () => { billed += 1 } })
    await c.fetchWorkByDoi('10.1/x')
    expect(billed).toBe(1)
    expect(calls).toHaveLength(1)

    billed = 0
    const missing = createOpenAlexClient({
      fetchImpl: fakeFetch(() => jsonResponse({ error: 'not found' }, 404)).fetchImpl,
      sleep: noSleep,
      minIntervalMs: 0,
      onBillable: () => { billed += 1 }
    })
    expect(await missing.fetchWorkByWid('W0')).toBeNull()
    expect(billed).toBe(0)

    let quotaCalls = 0
    const quota = createOpenAlexClient({
      fetchImpl: fakeFetch(() => {
        quotaCalls += 1
        return jsonResponse({ error: 'daily quota exceeded' }, 429)
      }).fetchImpl,
      sleep: noSleep,
      minIntervalMs: 0,
      maxRetries: 3,
      onBillable: () => { billed += 1 }
    })
    await expect(quota.fetchWorkByDoi('10.1/x')).rejects.toBeInstanceOf(BadRequestLlmError)
    expect(quotaCalls).toBe(1)
    expect(billed).toBe(0)
  })

  it('404 返回 null（单篇不存在是合法结果）', async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse({ error: 'not found' }, 404))
    const c = createOpenAlexClient({ fetchImpl, sleep: noSleep, minIntervalMs: 0 })
    expect(await c.fetchWorkByWid('W1')).toBeNull()
    expect(calls).toHaveLength(1) // 不重试
  })

  it('标题搜索：search 参数 + per_page', async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse({ results: [WORK_JSON] }))
    const c = createOpenAlexClient({ fetchImpl, sleep: noSleep, minIntervalMs: 0 })
    const rs = await c.searchWorksByTitle('Foundation Models: Opportunities')
    expect(rs).toHaveLength(1)
    const url = new URL(calls[0].url)
    expect(url.pathname).toBe('/works')
    expect(url.searchParams.get('search')).toBe('Foundation Models Opportunities')
    expect(url.searchParams.get('per_page')).toBe('5')
  })

  it('429 遵守 Retry-After 重试后成功', async () => {
    let n = 0
    const { fetchImpl, calls } = fakeFetch((_url) => {
      n++
      return n === 1
        ? jsonResponse({ error: {} }, 429, { 'Retry-After': '0' })
        : jsonResponse(WORK_JSON)
    })
    const c = createOpenAlexClient({ fetchImpl, sleep: noSleep, minIntervalMs: 0 })
    const w = await c.fetchWorkByDoi('10.1/x')
    expect(w?.wid).toBe('W2962883861')
    expect(calls).toHaveLength(2)
  })

  it('429 重试耗尽抛 RetryableLlmError（带 retryAfterMs）', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse({ error: {} }, 429, { 'Retry-After': '7' }))
    const c = createOpenAlexClient({ fetchImpl, sleep: noSleep, minIntervalMs: 0, maxRetries: 2 })
    await expect(c.fetchWorkByDoi('10.1/x')).rejects.toBeInstanceOf(RetryableLlmError)
    try {
      await c.fetchWorkByDoi('10.1/x')
    } catch (e) {
      expect((e as RetryableLlmError).retryAfterMs).toBe(7000)
    }
  })

  it('5xx 退避重试后成功；持续 5xx 抛 RetryableLlmError', async () => {
    let n = 0
    const { fetchImpl } = fakeFetch(() => {
      n++
      return n <= 2 ? jsonResponse({ error: {} }, 500) : jsonResponse(WORK_JSON)
    })
    const c = createOpenAlexClient({ fetchImpl, sleep: noSleep, minIntervalMs: 0 })
    expect((await c.fetchWorkByWid('W1'))?.wid).toBe('W2962883861')

    const always500 = createOpenAlexClient({
      fetchImpl: fakeFetch(() => jsonResponse({}, 503)).fetchImpl,
      sleep: noSleep,
      minIntervalMs: 0,
      maxRetries: 1
    })
    await expect(always500.fetchWorkByWid('W1')).rejects.toBeInstanceOf(RetryableLlmError)
  })

  it('400/403 抛 BadRequestLlmError（评审建议 9：不重试）', async () => {
    // 假 fetch 只应被调用一次——抛错前不得进入重试循环
    let calls = 0
    const { fetchImpl } = fakeFetch(() => {
      calls++
      return jsonResponse({ error: { message: 'bad request' } }, 403)
    })
    const c = createOpenAlexClient({ fetchImpl, sleep: noSleep, minIntervalMs: 0, maxRetries: 3 })
    await expect(c.fetchWorkByDoi('10.1/x')).rejects.toBeInstanceOf(BadRequestLlmError)
    expect(calls).toBe(1)
  })

  it('断网抛 NetworkLlmError', async () => {
    const { fetchImpl } = fakeFetch(() => {
      throw new TypeError('fetch failed')
    })
    const c = createOpenAlexClient({ fetchImpl, sleep: noSleep, minIntervalMs: 0, maxRetries: 0 })
    await expect(c.fetchWorkByDoi('10.1/x')).rejects.toBeInstanceOf(NetworkLlmError)
  })

  it('请求间隔小于 minIntervalMs 时等待（限速）', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse(WORK_JSON))
    const sleeps: number[] = []
    const c = createOpenAlexClient({
      fetchImpl,
      minIntervalMs: 1000,
      sleep: (ms) => {
        sleeps.push(ms)
        return Promise.resolve()
      }
    })
    await c.fetchWorkByDoi('10.1/a')
    await c.fetchWorkByDoi('10.1/b') // 紧接着的第二请求必须等
    expect(sleeps.length).toBeGreaterThanOrEqual(1)
    expect(sleeps[0]).toBeGreaterThanOrEqual(900) // Date.now 精度容差
  })

  it('uat6b M2：fetchWorksByWids 用 filter=openalex:W…|W…（裸 W id），>50 分批，且不再含 openalex.id', async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse({ results: [WORK_JSON] }))
    const c = createOpenAlexClient({ fetchImpl, sleep: noSleep, minIntervalMs: 0 })
    const wids = Array.from({ length: 60 }, (_, i) => `W${i + 1}`)
    await c.fetchWorksByWids(wids)
    expect(calls).toHaveLength(2)
    const f1 = new URL(calls[0].url).searchParams.get('filter') ?? ''
    expect(f1.startsWith('openalex:W1|')).toBe(true)
    expect(f1).not.toContain('openalex.id')
    expect(f1).not.toContain('https://')
    expect(f1.split('|')).toHaveLength(50)
  })
})
