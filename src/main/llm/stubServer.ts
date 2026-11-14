import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * 仅测试用：本地 LLM HTTP stub。模拟 DeepSeek 兼容端点：
 * - POST /chat/completions：流式 SSE（reasoning_content 增量 = thinking、content
 *   增量、末块 usage 含 prompt_cache_hit_tokens、[DONE]）；可按队列返回
 *   429（带 Retry-After）/ 5xx / 401 / 402 / 400；
 * - GET /user/balance：余额（D58 设置页）。
 * 绝不访问真实 deepseek/OpenAlex——所有 LLM 相关测试都走这个 stub。
 */

export interface StubRequest {
  path: string
  body: Record<string, unknown> | null
  authorization: string | null
}

export interface StubUsage {
  prompt_tokens: number
  completion_tokens: number
  prompt_cache_hit_tokens?: number
}

/** M5 lane/agent：一次 tool-call 流式脚本中的一个工具调用（OpenAI 格式分片）。 */
export interface StubScriptCall {
  id: string
  name: string
  /** 完整 arguments JSON 字符串 */
  arguments?: string
  /** 提供时把 arguments 按数组分段分片发送（模拟真实流式增量）；否则一次发全 */
  argChunks?: string[]
}

/**
 * M5 lane/agent：多步 tool-call 流式脚本。
 * 一个行为可覆盖整个工具循环的多次请求：rounds[i] 是第 i 个工具步（正文增量 →
 * tool_calls 增量（OpenAI 格式：index/id/name/arguments 分片）→ finish_reason
 * 'tool_calls'）；轮次按「请求历史里带 tool_calls 的 assistant 消息数」选取，
 * 与每步并行调用数无关；rounds 用完后回 finalText（finish 'stop'）→ usage → [DONE]。
 * 单回合纯文本：rounds: [] + finalText（等价旧 ok）。abort/429/401/402/断网仍用
 * 独立的 abort/status 行为，按请求消费。
 */
export interface StubScriptRound {
  reasoning?: string
  /** 本步正文增量（分两段写） */
  text?: string
  calls?: StubScriptCall[]
  /** 提供时：服务本轮前先等这么久（模拟真实网络延迟——e2e 停止/删除竞态回合需要
   *  拉长回合窗口；不提供则立即响应，与既有行为一致） */
  delayMs?: number
}

export interface StubScriptBehavior {
  kind: 'script'
  rounds?: StubScriptRound[]
  /** 工具步走完后的总结正文 */
  finalText?: string
  usage?: StubUsage
  finishReason?: string
  delayMs?: number
}

export type StubBehavior =
  | { kind: 'ok'; text?: string; reasoning?: string; usage?: StubUsage; finishReason?: string; delayMs?: number }
  | StubScriptBehavior
  | { kind: 'status'; status: number; body?: unknown; retryAfter?: number }
  /** 建 4：流中途断连（写完第一个增量后销毁 socket），模拟断网 */
  | { kind: 'abort' }

export interface StubLlm {
  baseUrl: string
  requests: StubRequest[]
  close: () => Promise<void>
}

/** behaviors：按请求顺序消费；队列空了之后默认回 ok。 */
export async function startStubLlm(behaviors: StubBehavior[] = []): Promise<StubLlm> {
  const requests: StubRequest[] = []
  const queue = [...behaviors]

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const pathOnly = (req.url ?? '').split('?')[0]
      if (pathOnly === '/v1/tools/search' || pathOnly === '/v1/tools/fetch') {
        // 空结果：不消耗聊天行为队列，也不记账（调用方看到空内容）
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(pathOnly.endsWith('/search') ? JSON.stringify({ results: [] }) : JSON.stringify({ title: '', url: '', content: '' }))
        return
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: Record<string, unknown> | null = null
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
      } catch {
        body = null
      }
      requests.push({ path: req.url ?? '', body, authorization: req.headers.authorization ?? null })
      // script 行为可服务多次请求（工具循环多轮）：rounds 未用完前不移出队列
      const peek = queue[0]
      const isActiveScript =
        peek != null &&
        (peek as { kind: string }).kind === 'script' &&
        Array.isArray(body?.messages) &&
        (body!.messages as Array<{ role?: string; tool_calls?: unknown[] }>).filter(
          (m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0
        ).length < ((peek as { rounds?: unknown[] }).rounds?.length ?? 0)
      const behavior = isActiveScript ? peek! : queue.length > 0 ? queue.shift()! : { kind: 'ok' as const }

      if (req.url === '/user/balance') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ balance_infos: [{ currency: 'CNY', total_balance: '12.34' }] }))
        return
      }

      if (behavior.kind === 'script') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const chunk = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
        const defaultUsage: StubUsage = { prompt_tokens: 120, completion_tokens: 30, prompt_cache_hit_tokens: 80 }
        const roundIdx = Array.isArray(body?.messages)
          ? (body!.messages as Array<{ role?: string; tool_calls?: unknown[] }>).filter(
              (m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0
            ).length
          : 0
        const rounds = behavior.rounds ?? []
        const writeText = (text: string, finishReason: string, usage: StubUsage): void => {
          const mid = Math.ceil(text.length / 2)
          res.write(chunk({ choices: [{ delta: { content: text.slice(0, mid) } }] }))
          res.write(chunk({ choices: [{ delta: { content: text.slice(mid) }, finish_reason: finishReason }] }))
          res.write(chunk({ choices: [], usage }))
          res.write('data: [DONE]\n\n')
          res.end()
        }
        const serveRound = (r: StubScriptRound): void => {
          if (r.reasoning) {
            res.write(chunk({ choices: [{ delta: { reasoning_content: r.reasoning } }] }))
          }
          const text = r.text ?? ''
          if (text) {
            const mid = Math.ceil(text.length / 2)
            res.write(chunk({ choices: [{ delta: { content: text.slice(0, mid) } }] }))
            res.write(chunk({ choices: [{ delta: { content: text.slice(mid) } }] }))
          }
          for (const call of r.calls ?? []) {
            const args = call.arguments ?? '{}'
            const pieces = call.argChunks ?? [args]
            res.write(
              chunk({
                choices: [
                  {
                    delta: {
                      role: 'assistant',
                      tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: pieces[0] ?? '' } }]
                    }
                  }
                ]
              })
            )
            for (const piece of pieces.slice(1)) {
              res.write(
                chunk({
                  choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] } }]
                })
              )
            }
          }
          res.write(chunk({ choices: [{ delta: {}, finish_reason: r.calls?.length ? 'tool_calls' : 'stop' }] }))
        }
        if (roundIdx >= rounds.length) {
          // 工具步已走完（或无工具步）：总结正文
          writeText(behavior.finalText ?? 'stub 工具已执行', behavior.finishReason ?? 'stop', behavior.usage ?? defaultUsage)
          return
        }
        const finishRound = (): void => {
          serveRound(rounds[roundIdx])
          res.write(chunk({ choices: [], usage: behavior.usage ?? defaultUsage }))
          res.write('data: [DONE]\n\n')
          res.end()
        }
        const delay = rounds[roundIdx].delayMs
        if (delay != null && delay > 0) setTimeout(finishRound, delay)
        else finishRound()
        return
      }

      if (behavior.kind === 'abort') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '半句话' } }] })}\n\n`)
        setTimeout(() => res.socket?.destroy(), 30)
        return
      }

      if (behavior.kind === 'status') {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (behavior.retryAfter != null) headers['Retry-After'] = String(behavior.retryAfter)
        res.writeHead(behavior.status, headers)
        res.end(JSON.stringify(behavior.body ?? { error: { message: `stub status ${behavior.status}` } }))
        return
      }

      const text = behavior.text ?? 'stub 回答'
      const reasoning = behavior.reasoning ?? 'stub 思考'
      const usage = behavior.usage ?? { prompt_tokens: 120, completion_tokens: 30, prompt_cache_hit_tokens: 80 }
      const send = (): void => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const chunk = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
        res.write(chunk({ choices: [{ delta: { reasoning_content: reasoning } }] }))
        // 正文分两段写，模拟真实流式增量
        const mid = Math.ceil(text.length / 2)
        res.write(chunk({ choices: [{ delta: { content: text.slice(0, mid) } }] }))
        res.write(chunk({ choices: [{ delta: { content: text.slice(mid) }, finish_reason: behavior.finishReason ?? 'stop' }] }))
        res.write(chunk({ choices: [], usage }))
        res.write('data: [DONE]\n\n')
        res.end()
      }
      if (behavior.delayMs) setTimeout(send, behavior.delayMs)
      else send()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}
