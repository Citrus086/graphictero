import { NetworkLlmError, RetryableLlmError } from '../llm/errors'
import { pdfSrcBase } from './arxiv'
import { isUsablePdfLocation } from './download'

/**
 * lane/fetch 批 1：Unpaywall 来源（D131 内建链第三环；免费 API，每次请求必须带
 * 联系邮箱）。best_oa_location.url_for_pdf 优先，退回落地页 url（交给下载端
 * 校验 `%PDF-`，是网页就记 error 继续下一来源）。
 */

const DEFAULT_TIMEOUT_MS = 15_000

export async function unpaywallOaUrl(
  doi: string,
  email: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<string | null> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const url = `${pdfSrcBase('https://api.unpaywall.org')}/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`
  let res: Response
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) })
  } catch (e) {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new RetryableLlmError('Unpaywall 请求超时')
    }
    throw new NetworkLlmError(`Unpaywall 网络错误：${e instanceof Error ? e.message : String(e)}`)
  }
  if (res.status === 404) return null // DOI 未收录：合法 not_found
  if (!res.ok) throw new RetryableLlmError(`Unpaywall 错误（HTTP ${res.status}）`, res.status)
  const body = (await res.json()) as { best_oa_location?: { url_for_pdf?: string | null; url?: string | null } | null }
  const best = body.best_oa_location
  const pdf = typeof best?.url_for_pdf === 'string' && best.url_for_pdf ? best.url_for_pdf : null
  const landing = typeof best?.url === 'string' && best.url ? best.url : null
  if (pdf && isUsablePdfLocation(pdf)) return pdf
  if (landing && isUsablePdfLocation(landing)) return landing
  return null
}
