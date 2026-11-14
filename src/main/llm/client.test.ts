import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEEPSEEK_FLASH_MAX_OUTPUT, fetchBalance, streamChat, type LlmClientDeps } from './client'
import { AuthLlmError, BadRequestLlmError, NetworkLlmError, RetryableLlmError } from './errors'
import { startStubLlm, type StubLlm, type StubUsage } from './stubServer'

/**
 * LLM 客户端测试：全部走本地 HTTP stub（流式 SSE / thinking / 429 / 5xx /
 * 401 / 402 / 断网），绝不调用真实 deepseek。
 */

let stub: StubLlm | null = null
afterEach(async () => {
  await stub?.close()
  stub = null
})

const deps = (baseUrl: string): LlmClientDeps => ({ baseUrl, apiKey: 'test-key', model: 'deepseek-flash' })

describe('streamChat（D92：thinking 开 + 流式）', () => {
  it('流式拼接正文与 reasoning，取末块 usage（含缓存命中），请求体 thinking 开 + stream', async () => {
    stub = await startStubLlm([{ kind: 'ok', text: '最终结果', reasoning: '先想再想', usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60 } }])
    const deltas: string[] = []
    const r = await streamChat(deps(stub.baseUrl), [{ role: 'user', content: 'hi' }], (d) => deltas.push(d))
    expect(r.text).toBe('最终结果')
    expect(r.reasoning).toBe('先想再想')
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheHitTokens: 60 })
    expect(r.usage.reasoningTokens).toBeUndefined() // D180：未上报 ≠ 0
    expect(r.truncated).toBe(false)
    expect(deltas.join('')).toBe('最终结果')

    const req = stub.requests[0]
    expect(req.path).toBe('/chat/completions')
    expect(req.authorization).toBe('Bearer test-key')
    expect(req.body).toMatchObject({
      model: 'deepseek-flash',
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: 'enabled' }
    })
    expect(req.body?.max_tokens).toBe(DEEPSEEK_FLASH_MAX_OUTPUT) // D100：默认 384k，不设低固定上限
  })

  it('D180：SSE completion_tokens_details.reasoning_tokens 映射到 TokenUsage', async () => {
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_cache_hit_tokens: 60,
      completion_tokens_details: { reasoning_tokens: 14 }
    } as StubUsage
    stub = await startStubLlm([{ kind: 'ok', text: '结果', usage }])
    const r = await streamChat(deps(stub.baseUrl), [{ role: 'user', content: 'hi' }])
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheHitTokens: 60, reasoningTokens: 14 })
  })

  it('finish_reason=length 记 truncated（D86 截断信号）', async () => {
    stub = await startStubLlm([{ kind: 'ok', text: '被截断', finishReason: 'length' }])
    const r = await streamChat(deps(stub.baseUrl), [{ role: 'user', content: 'hi' }])
    expect(r.truncated).toBe(true)
  })

  it('429 → RetryableLlmError 且带 Retry-After 毫秒（D53）', async () => {
    stub = await startStubLlm([{ kind: 'status', status: 429, retryAfter: 7 }])
    const err = await streamChat(deps(stub.baseUrl), [{ role: 'user', content: 'hi' }]).catch((e) => e)
    expect(err).toBeInstanceOf(RetryableLlmError)
    expect((err as RetryableLlmError).retryAfterMs).toBe(7000)
  })

  it('5xx → RetryableLlmError；400 → BadRequestLlmError（不自动重试）', async () => {
    stub = await startStubLlm([{ kind: 'status', status: 500 }, { kind: 'status', status: 400, body: { error: { message: '内容超长' } } }])
    const e1 = await streamChat(deps(stub.baseUrl), [{ role: 'user', content: 'a' }]).catch((e) => e)
    expect(e1).toBeInstanceOf(RetryableLlmError)
    const e2 = await streamChat(deps(stub.baseUrl), [{ role: 'user', content: 'b' }]).catch((e) => e)
    expect(e2).toBeInstanceOf(BadRequestLlmError)
    expect((e2 as Error).message).toContain('内容超长')
  })

  it('401 / 402 → AuthLlmError（API Key 无效 / 余额不足，D70）', async () => {
    stub = await startStubLlm([{ kind: 'status', status: 401 }, { kind: 'status', status: 402 }])
    const e1 = await streamChat(deps(stub.baseUrl), [{ role: 'user', content: 'a' }]).catch((e) => e)
    expect(e1).toBeInstanceOf(AuthLlmError)
    expect((e1 as Error).message).toBe('API Key 无效')
    const e2 = await streamChat(deps(stub.baseUrl), [{ role: 'user', content: 'b' }]).catch((e) => e)
    expect((e2 as AuthLlmError).status).toBe(402)
  })

  it('流中途断连 → NetworkLlmError（建 4：与初始 fetch 同分类，不烧自动重试）', async () => {
    stub = await startStubLlm([{ kind: 'abort' }])
    const err = await streamChat(deps(stub.baseUrl), [{ role: 'user', content: 'hi' }]).catch((e) => e)
    expect(err).toBeInstanceOf(NetworkLlmError)
  })

  it('网络不可达 → NetworkLlmError（调度器据此进 waiting_network）', async () => {
    // 指向一个没监听的端口
    const err = await streamChat(deps('http://127.0.0.1:1'), [{ role: 'user', content: 'hi' }]).catch((e) => e)
    expect(err).toBeInstanceOf(NetworkLlmError)
  })
})

describe('fetchBalance（D58 设置页余额；uat4 结构化三字段）', () => {
  const jsonFetch = (payload: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch

  it('旧格式（stub 只有 total_balance + currency）：total 解析、granted/toppedUp 为 null（兼容）', async () => {
    stub = await startStubLlm()
    const b = await fetchBalance(deps(stub.baseUrl))
    expect(b.total).toBe(12.34)
    expect(b.granted).toBeNull()
    expect(b.toppedUp).toBeNull()
    expect(b.currency).toBe('CNY')
    expect(Date.parse(b.at)).toBeGreaterThan(0) // 响应时刻（ISO）
  })

  it('三字段齐全：granted / toppedUp / total 均解析为元（数字）', async () => {
    const fetchImpl = jsonFetch({
      balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '2.50', topped_up_balance: '9.84' }]
    })
    const b = await fetchBalance({ baseUrl: 'http://stub.local', apiKey: 'k', fetchImpl })
    expect(b).toMatchObject({ total: 12.34, granted: 2.5, toppedUp: 9.84, currency: 'CNY' })
  })

  it('缺 topped_up_balance：该行 null；其余照常', async () => {
    const fetchImpl = jsonFetch({ balance_infos: [{ currency: 'CNY', total_balance: '5.00', granted_balance: '5.00' }] })
    const b = await fetchBalance({ baseUrl: 'http://stub.local', apiKey: 'k', fetchImpl })
    expect(b).toMatchObject({ total: 5, granted: 5, toppedUp: null })
  })

  it('total_balance 缺失 → RetryableLlmError（格式不认识）', async () => {
    const fetchImpl = jsonFetch({ balance_infos: [{ currency: 'CNY' }] })
    const err = await fetchBalance({ baseUrl: 'http://stub.local', apiKey: 'k', fetchImpl }).catch((e) => e)
    expect(err).toBeInstanceOf(RetryableLlmError)
  })
})
