import { pruneMessages, type ModelMessage } from 'ai'
import type Database from 'better-sqlite3'
import { estimateTokens } from '../relations/context'
import { streamChat, type LlmClientDeps } from '../llm/client'
import { recordUsage } from '../llm/usage'
import { addObservation, deleteAllObservations, listObservations, type HistoryEntry } from './sessionStore'

/**
 * M5 lane/agent：长会话压缩（D28）。spike 结论（ai 7.0.153）：`pruneMessages`
 * 从 'ai' 直接导出；切档归档在**回合起始**做（按 DB seq 高水位增量归档，跨回合
 * 不重复），prepareStep 只负责回合内工具结果膨胀的轻量 prune。
 *
 * 口径（设计文档 D28 740-756/1096 行 + 评审 2 必须修 1 / 建议修 2）：
 * - 「模型看到『观察日志 + 最近原文』」：存在归档高水位（或观察日志非空）时，
 *   把本会话观察日志要点作为固定前缀拼进 instructions，随最近原文一起发给模型；
 * - 会话级高水位 = session_archives 的 MAX(seq_to)（真实 session_messages seq，
 *   零新迁移）；每回合只发送 seq > 高水位的原文，只归档增量、不重复摘要计费；
 * - 超阈值（默认 12 万 token 估算）：归档最老前缀（保留最近 6 条）→ 原文进
 *   session_archives（seq_from/seq_to 为真实 DB seq）→ LLM 提炼要点追加
 *   session_observations（实时计费 category chat，D96-② 含压缩摘要调用）→
 *   观察日志超 8k 再反思压缩成一条；LLM 失败降级机械摘录（不中断、不计费）；
 * - 回合内（工具循环每步重发历史）：prepareStep 估算超阈值时 pruneMessages 清
 *   旧工具结果/reasoning（留最后一条），不再归档、不计费；
 * - 压缩不动 session_messages：界面始终显示完整历史（D28）。
 */

export const COMPRESS_THRESHOLD_TOKENS = 120_000
export const OBSERVATION_LIMIT_TOKENS = 8_000
export const KEEP_RECENT_MESSAGES = 6

export interface CompressorLlm {
  baseUrl: string
  apiKey: string
  model: string
}

export interface TurnCompressorOptions {
  db: Database.Database
  sessionId: number
  llm: () => CompressorLlm
  /** 测试可注入：覆盖阈值/保留条数/摘要实现 */
  thresholdTokens?: number
  keepRecent?: number
  summarize?: (text: string) => Promise<string>
}

const OBSERVATIONS_HEADER = '【本会话早期要点（早期原文已压缩归档，需要旧细节时用 recallHistory 工具回查）】'

const SUMMARIZE_PROMPT =
  '把下面这段对话历史压缩成要点清单（每条一行，中文，合计不超过 120 字），保留论文名、' +
  '结论、已执行的改图动作等关键信息，去掉客套与重复。只输出要点清单：\n\n'

const REFLECT_PROMPT =
  '把下面这份观察日志浓缩成不超过 10 条要点（每条一行，中文），合并重复、保留最新结论。' +
  '只输出要点清单：\n\n'

/** 会话级归档高水位：session_archives 的 MAX(seq_to)（真实 DB seq；无归档为 0）。 */
export function archivedWatermark(db: Database.Database, sessionId: number): number {
  const r = db.prepare('SELECT COALESCE(MAX(seq_to), 0) AS w FROM session_archives WHERE session_id = ?').get(sessionId) as { w: number }
  return r.w
}

/** 观察日志要点前缀（稳定格式，利 DeepSeek 缓存命中）；无观察日志返回 null。 */
export function buildObservationsPrefix(db: Database.Database, sessionId: number): string | null {
  const obs = listObservations(db, sessionId)
  if (obs.length === 0) return null
  return `${OBSERVATIONS_HEADER}\n${obs.map((o) => `- ${o.content.replace(/\n+/g, '；')}`).join('\n')}`
}

function estimateText(text: string): number {
  return estimateTokens(text)
}

export interface TurnCompressor {
  /**
   * 回合起始压缩：输入本会话全部历史条目（含本回合新 user 消息），返回应发给
   * 模型的条目（seq > 高水位，超阈值时增量归档并更新高水位）+ 是否发生归档。
   */
  compressHistory(entries: HistoryEntry[]): Promise<{ entries: HistoryEntry[]; archived: number }>
  /** 观察日志前缀（拼进 instructions；无则 null） */
  observationsPrefix(): string | null
  /** 回合内 prepareStep：只 prune 工具结果/reasoning 膨胀，不归档不计费 */
  prepareStep(options: { messages: ModelMessage[]; stepNumber: number }): { messages: ModelMessage[] } | undefined
  /** 本回合归档次数（测试观察用） */
  readonly compressions: number
}

export function createTurnCompressor(opts: TurnCompressorOptions): TurnCompressor {
  const threshold = opts.thresholdTokens ?? COMPRESS_THRESHOLD_TOKENS
  const keepRecent = opts.keepRecent ?? KEEP_RECENT_MESSAGES
  let compressions = 0

  const defaultSummarize = async (text: string): Promise<string> => {
    const cfg = opts.llm()
    const r = await streamChat(
      { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model } satisfies LlmClientDeps,
      [{ role: 'user', content: `${SUMMARIZE_PROMPT}${text.slice(0, 20_000)}` }]
    )
    // D96-②：摘要调用实时计费（category chat，含压缩摘要调用口径）
    recordUsage(opts.db, { category: 'chat', model: cfg.model, sessionId: opts.sessionId, at: new Date(), thinking: true, usage: r.usage })
    return r.text.trim() || '（摘要为空）'
  }

  const summarize = opts.summarize ?? defaultSummarize

  /** LLM 失败时的机械摘录降级（不计费、不中断回合）。 */
  const mechanicalSummary = (entries: HistoryEntry[]): string =>
    entries.map((e) => `${e.role === 'user' ? '问' : e.role === 'system' ? '系统' : '答'}：${e.text.slice(0, 200)}`).join('\n')

  const summarizeSafely = async (text: string, fallback: () => string): Promise<string> => {
    try {
      return await summarize(text)
    } catch {
      return fallback()
    }
  }

  /** 观察日志过长 → 反思压缩（全部浓缩成一条替换，D28「观察日志过长再反思压缩」）。 */
  const reflectIfNeeded = async (): Promise<void> => {
    const obs = listObservations(opts.db, opts.sessionId)
    const total = obs.reduce((sum, o) => sum + estimateText(o.content), 0)
    if (total <= OBSERVATION_LIMIT_TOKENS || obs.length === 0) return
    const condensed = await summarizeSafely(
      obs.map((o) => o.content).join('\n'),
      () => obs.slice(0, 10).map((o) => o.content).join('\n')
    )
    deleteAllObservations(opts.db, opts.sessionId)
    addObservation(opts.db, opts.sessionId, `【观察日志反思压缩】\n${condensed}`, 1)
  }

  return {
    get compressions() {
      return compressions
    },

    observationsPrefix: () => buildObservationsPrefix(opts.db, opts.sessionId),

    async compressHistory(entries) {
      const watermark = archivedWatermark(opts.db, opts.sessionId)
      let visible = entries.filter((e) => e.seq > watermark)
      const prefix = buildObservationsPrefix(opts.db, opts.sessionId)
      const total = visible.reduce((sum, e) => sum + estimateText(e.text), 0) + (prefix ? estimateText(prefix) : 0)
      if (total < threshold) return { entries: visible, archived: 0 }

      // 超阈值：归档最老前缀（保留最近 keepRecent 条），只此增量
      const toArchive = visible.slice(0, Math.max(0, visible.length - keepRecent))
      if (toArchive.length === 0) return { entries: visible, archived: 0 }
      compressions++

      const now = new Date().toISOString()
      opts.db
        .prepare('INSERT INTO session_archives (session_id, seq_from, seq_to, parts, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(
          opts.sessionId,
          toArchive[0].seq,
          toArchive[toArchive.length - 1].seq,
          JSON.stringify(toArchive.map((e) => ({ type: 'text', text: `${e.role}: ${e.text}` }))),
          now
        )
      const date = now.slice(0, 10)
      const points = await summarizeSafely(
        toArchive.map((e) => `${e.role}: ${e.text}`).join('\n---\n'),
        () => mechanicalSummary(toArchive)
      )
      addObservation(opts.db, opts.sessionId, `【${date} 压缩归档要点】\n${points}`, 1)
      await reflectIfNeeded()

      visible = visible.slice(toArchive.length)
      return { entries: visible, archived: toArchive.length }
    },

    prepareStep({ messages }) {
      // 回合内只处理工具结果/reasoning 膨胀（有 tool 消息才值得 prune）；不归档不计费
      if (!messages.some((m) => m.role === 'tool')) return undefined
      const total = messages.reduce((sum, m) => sum + estimateText(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)), 0)
      if (total < threshold) return undefined
      const pruned = pruneMessages({
        messages,
        reasoning: 'before-last-message',
        toolCalls: [{ type: 'before-last-message' }]
      })
      return { messages: pruned }
    }
  }
}
