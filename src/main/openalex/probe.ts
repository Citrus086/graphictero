/**
 * OpenAlex「测试连接」（uat8c）。
 * 不走 createOpenAlexClient：那个把响应体（可能含请求 URL 上的 api_key）写进错误文案。
 * 这里只看 HTTP 状态，消息只有「可用 / Key 无效 / 网络不可用 / 未配置 API Key」。
 */

export interface ConnectionTestView {
  ok: boolean
  message: string
}

export interface OpenAlexProbeDeps {
  baseUrl: string
  apiKey: string | null
  fetchImpl?: typeof fetch
}

export function openAlexBaseUrl(): string {
  return process.env.GRAPHICTERO_OPENALEX_BASE_URL || 'https://api.openalex.org'
}

export async function probeOpenAlex(deps: OpenAlexProbeDeps): Promise<ConnectionTestView> {
  if (!deps.apiKey) return { ok: false, message: '未配置 API Key' }
  const root = deps.baseUrl.replace(/\/$/, '')
  let url: URL
  try {
    url = new URL(`${root}/works`)
  } catch {
    return { ok: false, message: '网络不可用' }
  }
  url.searchParams.set('per-page', '1')
  url.searchParams.set('api_key', deps.apiKey)
  const fetchImpl = deps.fetchImpl ?? fetch
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) })
    if (res.ok) return { ok: true, message: '可用' }
    if (res.status === 401 || res.status === 403) return { ok: false, message: 'Key 无效' }
    return { ok: false, message: '网络不可用' }
  } catch {
    return { ok: false, message: '网络不可用' }
  }
}
