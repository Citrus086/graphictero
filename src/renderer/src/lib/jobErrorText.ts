/** uat8b B2：任务失败原因给人看的中文。原文（打码后）留给 title / 详情。 */

export interface JobErrorText {
  summary: string
  detail: string
}

const QUERY_SECRET = /((?:api_key|apikey|api-key|mailto)=)[^&\s"'<>]*/gi
const JSON_SECRET = /("(?:api_key|apikey|api-key|mailto)"\s*:\s*")[^"]*/gi

export function redactJobError(raw: string): string {
  return raw.replace(QUERY_SECRET, '$1***').replace(JSON_SECRET, '$1***')
}

export function humanizeJobError(raw: string | null | undefined): JobErrorText {
  const detail = redactJobError(raw ?? '')
  const text = detail.trim()
  if (!text) return { summary: '请求失败', detail: '' }
  const fromOpenAlex = /openalex/i.test(text)
  if (fromOpenAlex && /额度|quota|credit/i.test(text)) return { summary: 'OpenAlex 当日免费额度已用完', detail }
  if (fromOpenAlex && /429|限流|请求过多|too many requests/i.test(text)) return { summary: 'OpenAlex 请求失败（429 请求过多）', detail }
  // 不把任意英文里的 network 子串都当成断网；只认中文明示与常见网络错误码。
  if (/网络不可用|网络错误|\b(?:enotfound|econnrefused|econnreset|etimedout|enetunreach|eai_again)\b|fetch failed/i.test(text)) {
    return { summary: '网络不可用', detail }
  }
  if (/超时|timed?\s*out|timeout/i.test(text)) return { summary: '请求超时', detail }
  if (/未找到|404|not found/i.test(text)) return { summary: '未找到论文', detail }
  if (/密钥无效|unauthorized|\b401\b|无效的\s*api\s*key/i.test(text)) return { summary: 'API Key 无效', detail }
  // uat10（评审建议 2）：HTTP 400 判断先于「短中文原样显示」早退——「OpenAlex 错误（400）」
  // 这类无 JSON / URL 的短句也换成人话；非状态数字（「论文 400 的标题…」）各 400 正则都不匹配，
  // 仍走下面的短中文早退原样显示。
  const http400 = /\bHTTP\s*400\b/i.test(text) ||
    /\bstatus(?:\s+code)?\s*400\b/i.test(text) ||
    /\bOpenAlex\b[^\n]{0,40}\b400\b/i.test(text) ||
    /^\s*400\s*$/.test(text)
  if (http400) return { summary: '请求参数被服务拒绝（HTTP 400），请检查设置后重试', detail }
  if (text.length <= 48 && !/[{}[\]<>]/.test(text) && !/https?:\/\//i.test(text) && /[\u4e00-\u9fff]/.test(text)) {
    return { summary: text, detail }
  }
  return { summary: '请求失败', detail }
}
