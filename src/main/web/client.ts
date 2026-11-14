import type { WebResult } from '../../shared/ipc/agent'
import { providerBaseUrl } from '../llm/config'
import { AuthLlmError, BadRequestLlmError, NetworkLlmError, RetryableLlmError } from '../llm/errors'

/**
 * DeepSeek 自家 Search / Fetch（D125）。同一把 Key，不新增依赖。
 *
 * 约定（计划未给出官方路径，写在 lane-fetch.md）：
 * POST {base}/v1/tools/search  { query } → { results: [{ title, url, snippet }] }
 * POST {base}/v1/tools/fetch   { url }   → { title, url, content }
 * base 优先 GRAPHICTERO_WEB_BASE_URL，否则与对话同一服务商地址。
 * 失败与空结果由调用方不记账。这里只分类错误。
 */

/** 网页工具默认超时。挂起的 Search/Fetch 要能走到 TimeoutError，而不是一直占着这次工具调用。 */
export const WEB_TIMEOUT_MS = 30_000

export interface WebClientDeps {
  apiKey: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  /** 测试注入短超时；生产用 WEB_TIMEOUT_MS */
  timeoutMs?: number
}

export function webBaseUrl(): string {
  return process.env.GRAPHICTERO_WEB_BASE_URL || providerBaseUrl('deepseek')
}

export interface WebSearchPayload {
  results: WebResult[]
  /** 非空成功才记账 */
  billable: boolean
}

export interface WebFetchPayload {
  page: WebResult
  billable: boolean
}

async function postJson(deps: WebClientDeps, path: string, body: unknown): Promise<unknown> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const base = (deps.baseUrl ?? webBaseUrl()).replace(/\/$/, '')
  let res: Response
  try {
    res = await fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(deps.timeoutMs ?? WEB_TIMEOUT_MS)
    })
  } catch (e) {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new RetryableLlmError('网页工具请求超时')
    }
    throw new NetworkLlmError(`网页工具网络错误：${e instanceof Error ? e.message : String(e)}`)
  }
  if (res.status === 401) throw new AuthLlmError('API Key 无效', 401)
  if (res.status === 402) throw new AuthLlmError('余额不足', 402)
  if (res.status === 429) throw new RetryableLlmError('网页工具被限流（429）', 429)
  if (res.status >= 500) throw new RetryableLlmError(`网页工具暂时失败（HTTP ${res.status}）`, res.status)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new BadRequestLlmError(`网页工具请求被拒绝（HTTP ${res.status}）：${text.slice(0, 200)}`, res.status)
  }
  return res.json()
}

function asResult(raw: unknown): WebResult {
  const row = (raw ?? {}) as Record<string, unknown>
  return {
    title: typeof row.title === 'string' ? row.title : '',
    url: typeof row.url === 'string' ? row.url : '',
    snippet: typeof row.snippet === 'string' ? row.snippet : '',
    ...(typeof row.content === 'string' ? { content: row.content } : {})
  }
}

export async function webSearch(deps: WebClientDeps, query: string): Promise<WebSearchPayload> {
  const body = (await postJson(deps, '/v1/tools/search', { query })) as { results?: unknown }
  const results = Array.isArray(body?.results) ? body.results.map(asResult) : []
  return { results, billable: results.length > 0 }
}

export async function webFetchPage(deps: WebClientDeps, url: string): Promise<WebFetchPayload> {
  const page = asResult(await postJson(deps, '/v1/tools/fetch', { url }))
  const billable = (page.content ?? '').trim().length > 0 || page.title.trim().length > 0
  return { page, billable }
}
