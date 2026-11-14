import type { BalanceView } from '../../shared/ipc'
import {
  AuthLlmError,
  BadRequestLlmError,
  NetworkLlmError,
  RetryableLlmError
} from './errors'
import type { TokenUsage } from './pricing'

/**
 * DeepSeek（OpenAI 兼容）流式聊天客户端（D12/D25/D92）。
 *
 * - D92：所有 LLM 调用统一开启 thinking（请求体 thinking:{type:'enabled'}）
 *   并统一流式输出（stream:true，SSE）；思考增量走 reasoning_content；
 * - 用量取自流末块的 usage（stream_options.include_usage），含缓存命中
 *   token（prompt_cache_hit_tokens），供 D58 记账；
 * - 输出上限：D100 统一 DEEPSEEK_FLASH_MAX_OUTPUT（393216 = 384k，deepseek-flash
 *   最大输出），所有 LLM 调用（关系/名片/详情/D40 兜底）一律显式传满，不设
 *   8192/32k 等低固定上限（20 篇探针实测 8192 被 thinking 吃满 → 0 条输出）；
 *   finish_reason=length 记 truncated（截断续跑由 M3 关系生成使用）；
 * - fetch / baseUrl 可注入：测试指向本地 HTTP stub，不碰真实 API。
 */

/** D100：deepseek-flash 最大输出 384k（393216），所有 LLM 调用统一口径 */
export const DEEPSEEK_FLASH_MAX_OUTPUT = 393_216

/**
 * D92/B8：thinking 显式开启的统一配置（@ai-sdk/deepseek providerOptions 与请求体
 * 同一常量，usage_records.thinking 也从这里取——不再一处写死）。
 */
export const DEEPSEEK_THINKING_ENABLED = true
export const DEEPSEEK_THINKING_REQUEST = { type: 'enabled' } as const
/** AI SDK 调用侧的 providerOptions（ToolLoopAgent stream 传它） */
export const DEEPSEEK_THINKING_PROVIDER_OPTIONS = { deepseek: { thinking: { type: 'enabled' as const } } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmStreamResult {
  text: string
  /** thinking 内容（D92 统一开启；stub 里对应 reasoning_content 增量） */
  reasoning: string
  usage: TokenUsage
  /** finish_reason === 'length'（D86：输出被截断） */
  truncated: boolean
}

export interface LlmClientDeps {
  baseUrl: string
  apiKey: string
  model: string
  fetchImpl?: typeof fetch
  /** D100：显式设置，默认 DEEPSEEK_FLASH_MAX_OUTPUT（384k） */
  maxOutputTokens?: number
  timeoutMs?: number
}

const DEFAULT_MAX_OUTPUT_TOKENS = DEEPSEEK_FLASH_MAX_OUTPUT
const DEFAULT_TIMEOUT_MS = 120_000

interface SseDelta {
  choices?: Array<{
    delta?: { content?: string; reasoning_content?: string }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
    completion_tokens_details?: { reasoning_tokens?: number | null } | null
  }
}

/**
 * 流式聊天：thinking 开 + SSE。onDelta 回调正文增量（进度显示用，可为空）。
 * 错误分类见 errors.ts（D53/D70）。
 */
export async function streamChat(
  deps: LlmClientDeps,
  messages: ChatMessage[],
  onDelta?: (text: string) => void
): Promise<LlmStreamResult> {
  const fetchImpl = deps.fetchImpl ?? fetch
  let res: Response
  try {
    res = await fetchImpl(`${deps.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${deps.apiKey}`
      },
      body: JSON.stringify({
        model: deps.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: deps.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        thinking: DEEPSEEK_THINKING_REQUEST // D92/B8：统一开启 thinking（同一常量）
      }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    })
  } catch (e) {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new RetryableLlmError('请求超时')
    }
    throw new NetworkLlmError(e instanceof Error ? e.message : String(e))
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '')
    const msg = extractErrorMessage(bodyText) ?? `HTTP ${res.status}`
    if (res.status === 401 || res.status === 402) {
      throw new AuthLlmError(res.status === 401 ? 'API Key 无效' : '余额不足', res.status)
    }
    if (res.status === 429) {
      throw new RetryableLlmError(`请求被限流（429）`, 429, parseRetryAfter(res.headers.get('retry-after')))
    }
    if (res.status >= 500) throw new RetryableLlmError(`服务端错误（${res.status}）：${msg}`, res.status)
    throw new BadRequestLlmError(msg, res.status)
  }

  // SSE 解析：data: {...} 逐行；[DONE] 结束
  const reader = res.body?.getReader()
  if (!reader) throw new RetryableLlmError('响应没有流式 body')
  const decoder = new TextDecoder()
  let buf = ''
  let text = ''
  let reasoning = ''
  let truncated = false
  let usage: TokenUsage = { inputTokens: 0, cacheHitTokens: 0, outputTokens: 0 }

  const handleData = (payload: string): void => {
    if (payload === '[DONE]') return
    let chunk: SseDelta
    try {
      chunk = JSON.parse(payload) as SseDelta
    } catch {
      return // 忽略坏行
    }
    const choice = chunk.choices?.[0]
    if (choice?.delta?.reasoning_content) reasoning += choice.delta.reasoning_content
    if (choice?.delta?.content) {
      text += choice.delta.content
      onDelta?.(choice.delta.content)
    }
    if (choice?.finish_reason === 'length') truncated = true
    if (chunk.usage) {
      const reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens
      usage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        cacheHitTokens: chunk.usage.prompt_cache_hit_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
        // D180：源响应没给推理字段时保持缺省，recordUsage 落库为 NULL（未知而非 0）。
        ...(reasoningTokens == null ? {} : { reasoningTokens })
      }
    }
  }

  for (;;) {
    // 建 4：读循环的错误分类与初始 fetch 一致——流中途断网/超时不得落进
    // 「未知错误」白烧自动重试（断网由调度器结合 isOnline 进 waiting_network）
    let chunk: ReadableStreamReadResult<Uint8Array>
    try {
      chunk = await reader.read()
    } catch (e) {
      if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        throw new RetryableLlmError('读取响应超时')
      }
      throw new NetworkLlmError(e instanceof Error ? e.message : String(e))
    }
    const { done, value } = chunk
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (line.startsWith('data:')) handleData(line.slice(5).trim())
    }
  }
  const tail = buf.trim()
  if (tail.startsWith('data:')) handleData(tail.slice(5).trim())

  return { text, reasoning, usage, truncated }
}

function extractErrorMessage(bodyText: string): string | null {
  try {
    const j = JSON.parse(bodyText) as { error?: { message?: string } }
    return j.error?.message ?? null
  } catch {
    return bodyText.slice(0, 200) || null
  }
}

/** Retry-After 头（秒）→ 毫秒（D53：429 遵守 Retry-After） */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const sec = Number(header)
  return Number.isFinite(sec) ? Math.max(0, sec * 1000) : undefined
}

/**
 * 账户余额（设置页「用量与费用」，D58）：GET {baseUrl}/user/balance。
 * uat4：从 string 改结构化 BalanceView（元，数字）。DeepSeek 响应
 * balance_infos 含 granted_balance / topped_up_balance / total_balance；
 * 旧响应或缺字段时 granted / toppedUp 为 null（页面对应行显示「—」，仅
 * total_balance 为必需）。at = 响应解析完成时刻（ISO），页面显示「更新于 HH:MM」。
 */
export async function fetchBalance(deps: Pick<LlmClientDeps, 'baseUrl' | 'apiKey' | 'fetchImpl'>): Promise<BalanceView> {
  const fetchImpl = deps.fetchImpl ?? fetch
  let res: Response
  try {
    res = await fetchImpl(`${deps.baseUrl}/user/balance`, {
      headers: { Authorization: `Bearer ${deps.apiKey}` },
      signal: AbortSignal.timeout(30_000)
    })
  } catch (e) {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new RetryableLlmError('请求超时')
    throw new NetworkLlmError(e instanceof Error ? e.message : String(e))
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 402) throw new AuthLlmError(res.status === 401 ? 'API Key 无效' : '余额不足', res.status)
    throw new RetryableLlmError(`查询余额失败（HTTP ${res.status}）`, res.status)
  }
  const j = (await res.json()) as {
    balance_infos?: Array<{
      currency?: string
      total_balance?: string
      granted_balance?: string
      topped_up_balance?: string
    }>
  }
  const info = j.balance_infos?.[0]
  const total = Number(info?.total_balance)
  if (!info?.total_balance || !Number.isFinite(total)) throw new RetryableLlmError('余额响应格式不认识')
  // 赠送/充值字段缺失（旧格式响应）→ null，页面显示「—」
  const granted = info.granted_balance != null && Number.isFinite(Number(info.granted_balance)) ? Number(info.granted_balance) : null
  const toppedUp =
    info.topped_up_balance != null && Number.isFinite(Number(info.topped_up_balance)) ? Number(info.topped_up_balance) : null
  return { total, granted, toppedUp, currency: info.currency ?? 'CNY', at: new Date().toISOString() }
}
