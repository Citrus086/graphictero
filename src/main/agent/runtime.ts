import { ToolLoopAgent, APICallError, type ModelMessage } from 'ai'
import { createDeepSeek } from '@ai-sdk/deepseek'
import type Database from 'better-sqlite3'
import type { AgentStreamEvent, ContextRef, SendInput } from '../../shared/ipc/agent'
import type { DetailPart, GraphChangePart, PaperCardPart, TracePart } from '../../shared/parts'
import { AGENT_PROMPT } from '../llm/prompts'
import { DEEPSEEK_FLASH_MAX_OUTPUT, DEEPSEEK_THINKING_ENABLED, DEEPSEEK_THINKING_PROVIDER_OPTIONS } from '../llm/client'
import { recordUsage } from '../llm/usage'
import { MissingKeyError } from '../llm/errors'
import { buildEntryPointer } from './context'
import { createTurnCompressor } from './compress'
import type { OpenAlexClient } from '../openalex/client'
import { createAgentTools, type ToolContext } from './tools'
import {
  addTrace,
  appendMessage,
  deleteMessage,
  getMessageEntries,
  getMessages,
  getSession,
  sessionCost,
  setMessageCost,
  turnCost,
  updateMessage
} from './sessionStore'

/**
 * M5 lane/agent：Agent 运行时（D24/D118/D53/D96）。
 *
 * - LLM 通道 = AI SDK ToolLoopAgent + @ai-sdk/deepseek（D24；D92 thinking 开——
 *   deepseek provider 默认 enabled；D100 maxOutputTokens=393216）；自写薄客户端
 *   继续只管一次性生成，不加 tool calls（Q-M5-2 口径）；
 * - 流事件统一信封 AgentStreamEvent 经 broadcast 推给全部窗口（D118 事件桥；
 *   ~50ms 节流合批，M5 计划 §8 风险 2）；send 的 resolve = 已受理，回合结果走事件；
 * - 停止 = AbortController abort（保留已生成内容，回合标记 stopped 非错误，D53）；
 * - 出错保留已生成内容、错误挂消息上（D53 ⑧-4），03f 经 retryMessage 重发；
 * - 每次 LLM 调用流式结束拿到 usage 立刻按 D96-② 实时计费（category='chat'），
 *   turn-end 的 costCny = 到本回合为止的会话累计费用（sessionCost，口径 B）。
 */

export interface AgentLlmConfig {
  baseUrl: string
  apiKey: string
  model: string
}

export interface AgentRuntimeDeps {
  db: Database.Database
  dataDir: string
  /** 取当前 LLM 配置；未配置 Key 抛 MissingKeyError（D53：inline 提示去设置） */
  llm: () => AgentLlmConfig
  broadcast: (e: AgentStreamEvent) => void
  /** 候选落库后广播 event:agent:candidates（载荷组装归 IPC 层，D117 画布实时虚线节点） */
  onCandidates?: (graphId: number, sessionId: number | null) => void
  /**
   * 候选元数据回填用的 OpenAlex 客户端。只在生产 IPC 注入。
   * 单测 / runtime 测试 / 冒烟不传，proposeCandidate 就不访问网络。
   */
  openAlex?: () => OpenAlexClient
  /** 测试可注入的 D28 压缩阈值覆盖（生产用默认 120k/留 6 条） */
  compressorOverrides?: { thresholdTokens?: number; keepRecent?: number }
}

type EventBody<T> = T extends unknown ? Omit<T, 'sessionId' | 'turnId'> : never

type TurnEventBody = EventBody<AgentStreamEvent>

/** ~50ms 节流合批：queue 保序，定时整批 flush（turn 边界 close 立即 flush）。 */
class EventBatcher {
  private q: AgentStreamEvent[] = []
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private emit: (e: AgentStreamEvent) => void,
    private windowMs = 50
  ) {}

  push(e: AgentStreamEvent): void {
    this.q.push(e)
    if (this.timer == null) {
      this.timer = setInterval(() => this.flush(), this.windowMs)
      if (typeof this.timer.unref === 'function') this.timer.unref()
    }
  }

  flush(): void {
    const q = this.q
    this.q = []
    for (const e of q) this.emit(e)
  }

  close(): void {
    if (this.timer != null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.flush()
  }
}

/** D53 ⑧-4 错误分类：映射成面向用户的中文提示（401/402/429/5xx/断网/缺 Key）。 */
export function classifyAgentError(err: unknown, aborted: boolean): { stopped: boolean; message: string } {
  if (aborted || (err instanceof Error && err.name === 'AbortError')) {
    return { stopped: true, message: '' }
  }
  // AI SDK 会把流中途断连/网络错误包装成 APICallError（无状态码）：先剥 cause 判网络
  const inner = (err as { cause?: unknown } | null)?.cause
  if (inner != null && inner !== err) {
    const innerMsg = inner instanceof Error ? inner.message : String(inner)
    const innerCode = (inner as { cause?: { code?: string } } | null)?.cause?.code
    if (innerCode === 'ENOTFOUND' || innerCode === 'ECONNREFUSED' || innerCode === 'ECONNRESET' || /fetch failed|network|socket|terminated|process successful response/i.test(innerMsg)) {
      return { stopped: false, message: '网络连接失败，请检查网络后重试' }
    }
  }
  if (err instanceof APICallError) {
    const status = err.statusCode
    if (status == null) {
      if (/fetch failed|network|socket|terminated|process successful response/i.test(err.message)) {
        return { stopped: false, message: '网络连接失败，请检查网络后重试' }
      }
      return { stopped: false, message: err.message }
    }
    if (status === 401) return { stopped: false, message: 'API Key 无效或已失效（401），请到设置页检查' }
    if (status === 402) return { stopped: false, message: '账户余额不足（402），请到设置页充值' }
    if (status === 429) return { stopped: false, message: '请求过于频繁（429），请稍后重试' }
    if (status != null && status >= 500) return { stopped: false, message: `模型服务暂时不可用（${status}），请稍后重试` }
    if (status === 400) return { stopped: false, message: `请求被模型服务拒绝（400）：${err.message}` }
    return { stopped: false, message: err.message }
  }
  if (err instanceof MissingKeyError) {
    return { stopped: false, message: '尚未配置 DeepSeek API Key，请到设置页填写后再试' }
  }
  const cause = (err as { cause?: { code?: string } } | null)?.cause
  if (cause?.code === 'ENOTFOUND' || cause?.code === 'ECONNREFUSED' || cause?.code === 'ECONNRESET') {
    return { stopped: false, message: '网络连接失败，请检查网络后重试' }
  }
  if (err instanceof Error && /fetch failed|network|socket|process successful response|terminated/i.test(err.message)) {
    return { stopped: false, message: '网络连接失败，请检查网络后重试' }
  }
  return { stopped: false, message: err instanceof Error ? err.message : String(err) }
}

function contextRefLine(ref: ContextRef): string {
  if (ref.kind === 'paper') return `[上下文论文 #${ref.paperId}]`
  const page = ref.page != null ? `第 ${ref.page + 1} 页` : ''
  return `[引文 #${ref.paperId}${page ? ` ${page}` : ''}] ${ref.text}`
}

function messageText(parts: DetailPart[]): string {
  return parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
}

/** D180/uat7b S6(d)：AI SDK 的推理 token 明细；缺字段必须保持未知，不能落库成 0。
 *  口径：SDK 报正数 → 直接采用；SDK 报 0 且 raw 能证明是显式 0 → 0；
 *  SDK 报 0（或缺字段）且没有 raw 证据 → undefined（落 NULL，未记录）；
 *  raw 在但 reasoning_tokens 字段为 null → undefined（NULL）。 */
export function reasoningTokensFromStep(usage: {
  outputTokenDetails?: { reasoningTokens?: number }
  raw?: unknown
}): number | undefined {
  const value = usage.outputTokenDetails?.reasoningTokens
  if (value == null) return undefined
  if (value !== 0) return value
  // value === 0：@ai-sdk/deepseek 会把源响应缺失的 reasoning_tokens 规范化成 0，
  // 只有 raw 能区分「未上报」与「显式上报 0」；raw 缺失一律按未记录处理。
  if (usage.raw == null) return undefined
  const raw = usage.raw as { completion_tokens_details?: { reasoning_tokens?: number | null } | null }
  return raw.completion_tokens_details?.reasoning_tokens ?? undefined
}

export class AgentRuntime {
  private controllers = new Map<number, AbortController>()
  private running = new Set<number>()

  constructor(private deps: AgentRuntimeDeps) {}

  /** 回合是否在跑（IPC 层与 UI 可用；同一会话同时只允许一个回合）。 */
  isRunning(sessionId: number): boolean {
    return this.running.has(sessionId)
  }

  /**
   * 发起一回合：立即返回（已受理），结果经 broadcast 流事件推送。
   * 参数已在 IPC 层过 zod；这里再兜会话存在性。
   */
  startTurn(input: SendInput): void {
    const session = getSession(this.deps.db, input.sessionId)
    if (!session) {
      this.deps.broadcast({ sessionId: input.sessionId, turnId: 'invalid', kind: 'error', message: `会话 ${input.sessionId} 不存在` })
      return
    }
    if (this.running.has(input.sessionId)) {
      this.deps.broadcast({ sessionId: input.sessionId, turnId: 'busy', kind: 'error', message: '该会话已有回合在进行中，请等待完成或先停止' })
      return
    }
    this.running.add(input.sessionId)
    void this.runTurn(input, true).finally(() => {
      this.running.delete(input.sessionId)
      this.controllers.delete(input.sessionId)
    })
  }

  /** 停止当前回合（abort；保留已生成内容，回合标记 stopped）。 */
  stop(sessionId: number): void {
    this.controllers.get(sessionId)?.abort()
  }

  /**
   * 03f 重试：找到失败的 assistant 消息与它前面的 user 消息，物理删掉失败消息，
   * 用原 user 文本重跑一回合（不重复追加 user 消息）。
   */
  retryMessage(sessionId: number, messageId: number): void {
    if (this.running.has(sessionId)) throw new Error('该会话已有回合在进行中，无法重试')
    const db = this.deps.db
    const msgs = getMessages(db, sessionId)
    const idx = msgs.findIndex((m) => m.id === messageId)
    if (idx < 0 || msgs[idx].role !== 'assistant') {
      throw new Error(`消息 ${messageId} 不存在或不是助手消息`)
    }
    if (!msgs[idx].error) throw new Error('这条消息没有错误，不需要重试')
    let userText = ''
    for (let i = idx - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        userText = messageText(msgs[i].parts)
        break
      }
    }
    if (!userText) throw new Error('找不到对应的用户消息，无法重试')
    deleteMessage(db, messageId)
    this.running.add(sessionId)
    void this.runTurn({ sessionId, text: userText, contextRefs: [] }, false, true).finally(() => {
      this.running.delete(sessionId)
      this.controllers.delete(sessionId)
    })
  }

    /**
   * @param appendUser 是否新追加 user 消息（send=true；retry=false 复用已有那条）
   * @param excludeLastUser 构造模型历史时排除最后一条 user 消息（retry 用，避免模型看到重复提问）
   */
  private async runTurn(input: SendInput, appendUser: boolean, excludeLastUser = false): Promise<void> {
    const { db, broadcast } = this.deps
    const session = getSession(db, input.sessionId)!
    const turnId = `${session.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const batcher = new EventBatcher(broadcast)
    const turnStart = new Date().toISOString()
    const ev = (e: TurnEventBody): void => {
      batcher.push({ ...e, sessionId: session.id, turnId } as AgentStreamEvent)
    }

    // 用户消息（上下文标签内联进文本；retry 时复用已有 user 消息）
    let userText = input.text
    if (input.contextRefs.length > 0) {
      userText = `${input.text}\n\n${input.contextRefs.map(contextRefLine).join('\n')}`
    }
    const prior = getMessages(db, session.id)
    if (appendUser) {
      const part: DetailPart = { type: 'text', text: userText }
      appendMessage(db, session.id, 'user', [part])
    }
    const assistantMsg = appendMessage(db, session.id, 'assistant', [])

    const controller = new AbortController()
    this.controllers.set(session.id, controller)
    ev({ kind: 'turn-start' })

    // 历史 → 带 seq 的条目（压缩高水位按真实 DB seq，评审 2 建议修 2）。
    // 最后一条非空文本条目即本回合 user 消息（appendUser 时）——模型消息单独追加，
    // 这里剔除避免重复；retry 同样剔除被复用的那条（避免模型看到重复提问，评审必须修 6）。
    let allEntries = getMessageEntries(db, session.id)
    if ((appendUser || excludeLastUser) && allEntries.length > 0 && allEntries[allEntries.length - 1].role === 'user') {
      allEntries = allEntries.slice(0, -1)
    }
    const entries = allEntries

    const changes: GraphChangePart[] = []
    const paperCards: PaperCardPart[] = []
    const toolCtx: ToolContext = {
      db,
      dataDir: this.deps.dataDir,
      sessionId: session.id,
      graphId: session.graphId,
      turnId, // M6 前置 2a：改动前快照绑本回合（跨回合守卫，D129）
      model: '',
      promptVersion: AGENT_PROMPT.version,
      emitTrace: (t) => {
        try {
          const trace = addTrace(db, session.id, t)
          parts.push(trace) // 口径 C：data-trace part 同时写进 assistant 消息 parts JSON
          ev({ kind: 'trace', trace })
        } catch {
          // 会话运行中被删除（FK）：trace 丢失可接受，回合继续收尾
        }
      },
      onGraphChange: (c) => {
        // 合并批 ③（review_lane_chat4 §六-5）：改图 part id 会话内唯一——以本回合
        // assistant 消息 id 为前缀（session_messages.id 全库自增），跨回合不复用 g1，
        // 防未来按 id 寻址的消费方踩跨回合撞车（chat 侧 resolveTurnStart 已改最新匹配，
        // 此为纵深防御；不改契约语义，id 仍是任意字符串）。
        // M6 前置 2a：snapshotIds 一并进 part（修改/删除可经快照还原，D129/D143）。
        changes.push({ type: 'data-graph-change', id: `g${assistantMsg.id}-${changes.length + 1}`, status: 'done', ...c })
      },
      onPaperCard: (card) => {
        paperCards.push(card)
      },
      emitCandidates: () => {
        // 候选落库即广播（graphId + 来源会话；载荷由 IPC 层 listCandidates 组装）
        this.deps.onCandidates?.(session.graphId, session.id)
      },
      ...(this.deps.openAlex ? { openAlex: this.deps.openAlex() } : {})
    }

    let llm: AgentLlmConfig
    try {
      llm = this.deps.llm()
    } catch (e) {
      const { message } = classifyAgentError(e, false)
      updateMessage(db, assistantMsg.id, [], message)
      ev({ kind: 'error', message })
      batcher.close()
      return
    }
    toolCtx.model = llm.model

    const pointer = buildEntryPointer(db, session)
    // D28：回合起始压缩（DB seq 高水位增量归档）+ 观察日志前缀（模型看到「观察日志 + 最近原文」）
    const compressor = createTurnCompressor({ db, sessionId: session.id, llm: this.deps.llm, ...this.deps.compressorOverrides })
    let compressed
    try {
      compressed = await compressor.compressHistory(entries)
    } catch {
      compressed = { entries, archived: 0 } // 压缩失败不阻断回合
    }
    // uat5 D172：system 记录（撤销通知等）模型下一轮要可见——AI SDK 不允许 system
    // 出现在 messages 里（DeepSeek chat 口径），降级映射为带【系统记录】标头的 user 行；
    // DB 与界面仍是 role='system'，只有进模型的这一处降级。
    const history: ModelMessage[] = compressed.entries.map((e) =>
      e.role === 'system' ? { role: 'user' as const, content: `【系统记录】${e.text}` } : { role: e.role, content: e.text }
    )
    const observationsPrefix = compressor.observationsPrefix()
    const agent = new ToolLoopAgent({
      model: createDeepSeek({ baseURL: llm.baseUrl, apiKey: llm.apiKey }).chat(llm.model),
      instructions:
        `${AGENT_PROMPT.system}\n\n${pointer.text}` + (observationsPrefix ? `\n\n${observationsPrefix}` : ''),
      tools: createAgentTools(toolCtx),
      maxOutputTokens: DEEPSEEK_FLASH_MAX_OUTPUT, // D100
      // B8（D92）：DeepSeek thinking 经 prepareStep 逐步显式开启（ToolLoopAgent 的
      // stream 不收 providerOptions；prepareStep 结果逐步生效）。请求体可见，stub 断言。
      prepareStep: async (stepOpts) => {
        const prepared = await compressor.prepareStep(stepOpts)
        return { ...prepared, providerOptions: DEEPSEEK_THINKING_PROVIDER_OPTIONS }
      }
    })

    const parts: DetailPart[] = []
    // 口径 A：text 按块生命周期——首个 delta 前 part-start，块结束（text-end/收尾）part-done 定稿；
    // part-delta 用保留字 partId 'text'；trace 交错后新块重新 part-start；空块不落库。
    let openText: { buf: string; announced: boolean } | null = null
    const closeTextBlock = (): void => {
      if (!openText) return
      const buf = openText.buf
      openText = null
      if (!buf) return // 空块零事件（建议修 3）
      const part: DetailPart = { type: 'text', text: buf }
      parts.push(part)
      ev({ kind: 'part-done', part })
    }
    let aborted = false
    let failed = false
    let failMessage = ''
    let truncated = false

    try {
      const result = await agent.stream({
        messages: [...history, { role: 'user' as const, content: userText }],
        abortSignal: controller.signal
      })
      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-start':
            closeTextBlock() // 防御：上一个块未关先定稿
            openText = { buf: '', announced: false } // part-start 延迟到首个 delta（建议修 3）
            break
          case 'text-delta':
            if (!openText) openText = { buf: '', announced: false }
            if (!openText.announced) {
              openText.announced = true
              ev({ kind: 'part-start', part: { type: 'text', text: '' } }) // 契约 A：首个 delta 前必发
            }
            openText.buf += part.text
            ev({ kind: 'part-delta', partId: 'text', delta: part.text })
            break
          case 'text-end':
            closeTextBlock()
            break
          case 'abort':
            aborted = true
            break
          case 'error':
            throw part.error
          case 'finish-step':
            // D96-②：每次 LLM 调用（step）结束立刻按调用时刻实时计费（category chat，D92 thinking）
            recordUsage(db, {
              category: 'chat',
              model: llm.model,
              sessionId: session.id,
              at: new Date(),
              thinking: DEEPSEEK_THINKING_ENABLED, // B8：与请求体同一常量，不再写死
              usage: {
                inputTokens: part.usage.inputTokens ?? 0,
                outputTokens: part.usage.outputTokens ?? 0,
                cacheHitTokens: part.usage.inputTokenDetails?.cacheReadTokens ?? 0, // ai 7.0.153：cachedInputTokens 不存在
                reasoningTokens: reasoningTokensFromStep(part.usage)
              }
            })
            break
          case 'finish':
            if (part.finishReason === 'length') truncated = true
            break
          default:
            break // tool-call / tool-result / reasoning / step 事件：trace 与改图在工具内处理
        }
        if (aborted) break
      }
    } catch (e) {
      const c = classifyAgentError(e, controller.signal.aborted)
      if (c.stopped) aborted = true
      else {
        failed = true
        failMessage = c.message
      }
    }

    // 收尾：已生成内容一律保留（D53 ⑧-4），未关的 text 块定稿
    closeTextBlock()
    for (const c of changes) {
      parts.push(c)
      ev({ kind: 'part-done', part: c })
    }
    for (const card of paperCards) {
      parts.push(card)
      ev({ kind: 'part-done', part: card })
    }
    if (truncated && !failed) failMessage = '模型输出达到长度上限被截断，内容可能不完整'
    updateMessage(db, assistantMsg.id, parts, failMessage || null)
    // B6（D96-②）：本回合费用写进 assistant 消息——出错/停止的回合也记已发生的费用；
    // 重开会话 getMessages 仍返回每回合 costCny（turn-end 的会话累计口径 B 不变）
    setMessageCost(db, assistantMsg.id, turnCost(db, session.id, turnStart))

    if (aborted) {
      ev({ kind: 'stopped' })
    } else if (failMessage) {
      // D53 ⑧-4：已生成内容已落库保留；失败只发 error（不带 turn-end，前端按 error 渲染重试）
      ev({ kind: 'error', message: failMessage })
    } else {
      ev({ kind: 'turn-end', costCny: sessionCost(db, session.id) }) // 口径 B：到本回合为止的会话累计
    }
    batcher.close()
  }
}
