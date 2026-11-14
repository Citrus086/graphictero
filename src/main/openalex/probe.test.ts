import { afterEach, describe, expect, it, vi } from 'vitest'
import { openAlexBaseUrl, probeOpenAlex } from './probe'

const KEY = 'oa-dummy-key-zzzz'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('probeOpenAlex（stub，不回显 api_key）', () => {
  it('没 Key 不发请求', async () => {
    const fetchImpl = vi.fn()
    const view = await probeOpenAlex({ baseUrl: 'http://127.0.0.1:9', apiKey: null, fetchImpl })
    expect(view).toEqual({ ok: false, message: '未配置 API Key' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('200 为可用，消息不含 Key', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      void input
      return new Response('{}', { status: 200 })
    })
    const view = await probeOpenAlex({ baseUrl: 'http://127.0.0.1:9', apiKey: KEY, fetchImpl })
    expect(view).toEqual({ ok: true, message: '可用' })
    expect(view.message).not.toContain(KEY)
    const url = String(fetchImpl.mock.calls[0]?.[0])
    expect(url.startsWith('http://127.0.0.1:9/works')).toBe(true)
    expect(url).toContain('api_key=')
  })

  it('401 / 403 为 Key 无效，其它失败为网络不可用', async () => {
    const denied = await probeOpenAlex({
      baseUrl: 'http://127.0.0.1:9',
      apiKey: KEY,
      fetchImpl: async () => new Response('no', { status: 401 })
    })
    expect(denied).toEqual({ ok: false, message: 'Key 无效' })
    const forbidden = await probeOpenAlex({
      baseUrl: 'http://127.0.0.1:9',
      apiKey: KEY,
      fetchImpl: async () => new Response('no', { status: 403 })
    })
    expect(forbidden.message).toBe('Key 无效')
    const down = await probeOpenAlex({
      baseUrl: 'http://127.0.0.1:9',
      apiKey: KEY,
      fetchImpl: async () => {
        throw new Error(`failed ${KEY}`)
      }
    })
    expect(down).toEqual({ ok: false, message: '网络不可用' })
    expect(down.message).not.toContain(KEY)
  })

  it('base URL 读 GRAPHICTERO_OPENALEX_BASE_URL', () => {
    vi.stubEnv('GRAPHICTERO_OPENALEX_BASE_URL', 'http://127.0.0.1:9')
    expect(openAlexBaseUrl()).toBe('http://127.0.0.1:9')
  })
})
