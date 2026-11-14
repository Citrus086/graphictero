import { z } from 'zod'
import type { DetailPart, TracePart } from '../parts'

/**
 * M5 lane/agent 车道的 IPC 契约（会话与 Agent，D7/D24/D30）。
 *
 * 通道名一律 `agent:` 前缀；推送事件 `event:agent:*`。骨架由 M5 预备提交建立，
 * 主进程实现归 lane/agent（src/main/ipc/agent.ts），渲染层消费归 lane/chat；
 * 签名变更走维护者同步两车道（M4 先例）。
 *
 * - 会话属图谱、挂入口对象（graph / paper / relation，表 001 已建）；M5 不新增 job kind
 *   （agent 会话是交互式流，不进 jobs 表，D120）。
 * - 流式经 `event:agent:stream` 自定义事件桥转发（D118，不用 useChat 的 HTTP 传输）；
 *   主进程按 ~50ms 节流合批（见 M5 计划 §8 风险 2）。
 * - 每次调用按 D96-② 实时计费（category='chat'）。D142：抽屉显示「对话 ¥ · 后台 ¥」。
 *   `agent:sessionCost` 仍返回合计（number）。新增 `agent:sessionCostBreakdown`
 *   → `{ chat, background, total }`（chat = chat+web，background = card+detail+overview+relation，D160）。
 */
export const IPC_AGENT = {
  /** 某图谱某入口对象的会话列表（按 updatedAt 倒序，会话下拉） */
  listSessions: 'agent:listSessions',
  /** 新建会话（graph / paper / relation 入口） */
  createSession: 'agent:createSession',
  renameSession: 'agent:renameSession',
  /** D122：物理删除 + 级联（消息/trace/观察日志/archives）；usage_records 保留仅 session_id 置空 */
  deleteSession: 'agent:deleteSession',
  /** 会话消息（seq 保序；界面始终显示完整历史，D28） */
  getMessages: 'agent:getMessages',
  /** 发起一回合：入参 + 上下文标签（@ 选论文 / 画布拖入 / 阅读器选中文字）；回包走流事件 */
  send: 'agent:send',
  /** 停止当前回合（abort，保留已生成内容；回合标记 stopped 非错误） */
  stop: 'agent:stop',
  /** 03f 出错重试：从失败消息重发 */
  retryMessage: 'agent:retryMessage',
  /** 候选确认（pending → confirmed；「已在库中」走加入图谱，D117） */
  candidateConfirm: 'agent:candidateConfirm',
  candidateIgnore: 'agent:candidateIgnore',
  /** 某图谱的候选列表（画布虚线节点 + 卡片同步） */
  listCandidates: 'agent:listCandidates',
  /** uat8b D191：旧卡片按当前库状态批量刷新（只读，不改消息） */
  cardLiveStates: 'agent:cardLiveStates',
  /** 拖动画布候选节点后写回坐标（论文节点仍走 graph:setPosition） */
  moveCandidate: 'agent:moveCandidate',
  /** 本会话累计费用（usage_records 全部类别合计，D96-②；人民币） */
  sessionCost: 'agent:sessionCost',
  /** D142：对话 / 后台分项。旧客户端可继续只调 sessionCost */
  sessionCostBreakdown: 'agent:sessionCostBreakdown',
  /** 名片 / 详情 / 概览落账后让该会话再拉一次分项 */
  eventSessionCost: 'event:agent:sessionCost',
  /** uat5 D172：撤销本轮改动等系统记录（不作用户消息，入下轮上下文） */
  appendSystemNote: 'agent:appendSystemNote',
  /** 流事件（统一信封 AgentStreamEvent） */
  eventStream: 'event:agent:stream',
  /** 候选状态变化（画布与卡片两处同步） */
  eventCandidates: 'event:agent:candidates'
} as const

/** 会话入口对象（sessions.entry_type，表 001：graph | paper | relation） */
export const SESSION_ENTRY_TYPES = ['graph', 'paper', 'relation'] as const
export type SessionEntryType = (typeof SESSION_ENTRY_TYPES)[number]

export interface SessionSummary {
  id: number
  graphId: number
  entryType: SessionEntryType
  /** 入口对象 id：paper / relation 入口为对应 id；graph 入口为 null（表列可空） */
  entryId: number | null
  name: string
  updatedAt: string
}

export interface ChatMessageView {
  id: number
  /** uat5 D172：system = 系统记录（灰行展示，不作用户消息） */
  role: 'user' | 'assistant' | 'system'
  parts: DetailPart[]
  createdAt: string
  /** 03f：回合出错保留已生成内容，错误挂消息上（重试入口用） */
  error?: string
  /** 本回合费用（assistant 消息；usage_records 汇总，D96-②） */
  costCny?: number
}

/** 上下文标签（D30 输入框上方 chip）：@ 选论文 / 画布拖入论文 / 阅读器选中文字（D105-①） */
export const ContextRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('paper'), paperId: z.number().int().positive() }),
  z.object({
    kind: z.literal('quote'),
    paperId: z.number().int().positive(),
    /** 0 基页码（阅读器口径） */
    page: z.number().int().min(0).optional(),
    text: z.string().min(1).max(5000)
  })
])
export type ContextRef = z.infer<typeof ContextRefSchema>

const sessionId = z.number().int().positive()
const sessionName = z.string().min(1).max(200)

export const CreateSessionInputSchema = z.object({
  graphId: z.number().int().positive(),
  entryType: z.enum(SESSION_ENTRY_TYPES),
  entryId: z.number().int().positive().nullable(),
  /** 缺省按入口对象生成默认名（如论文标题） */
  name: sessionName.optional()
})
export type CreateSessionInput = z.infer<typeof CreateSessionInputSchema>

export const SendInputSchema = z.object({
  sessionId,
  text: z.string().min(1).max(50000),
  contextRefs: z.array(ContextRefSchema).max(20).default([])
})
export type SendInput = z.infer<typeof SendInputSchema>

/**
 * 统一流事件信封（D118 事件桥）。turnId 是一回合的标识；part 增量按 partId 归并
 * （part 级 diff，渲染层按 id 覆盖，同 D20 语义）。
 *
 * 口径（维护者 2026-10-26，review_lane_chat1 §2.3，两车道必须一致）：
 * A. text part 寻址：partId='text' 为保留字（data part 的 id 禁止取 'text'）。产出端对
 *    **每个** text part（含 trace 交错后新起的）在首个 delta 前必须先发
 *    part-start {type:'text', text:''}；part-delta(partId='text') 追加到当前最后一个 text part；
 *    part-done(text) 定稿替换最后一个 text part。渲染层另做防御：无 text part 时自动补建。
 * B. turn-end.costCny = 到本回合为止的**会话累计**费用（不是单回合费用），D96-②。
 * C. trace 事件之外，data-trace part 必须同时写进该 assistant 消息的 parts JSON
 *    （session_messages），回源后读取记录行仍在。
 * D. stopped / error 时把已生成 parts 落库为 assistant 消息（error 挂在消息上），
 *    渲染层收到后 getMessages 回源依赖此。
 * E. error 事件可能没有 turn-start 前导：发送期校验失败（会话不存在 / busy）经
 *    startTurn 直接 broadcast error（turnId='invalid' / 'busy'，不受理回合），
 *    渲染层不能假设 error 前必有 turn-start；行为即现状，不改为 IPC reject。
 */
export type AgentStreamEvent =
  | { sessionId: number; turnId: string; kind: 'turn-start' }
  /** 新 part 开始流式（part.status='streaming'） */
  | { sessionId: number; turnId: string; kind: 'part-start'; part: DetailPart }
  /** 文本增量（仅 text part 追加） */
  | { sessionId: number; turnId: string; kind: 'part-delta'; partId: string; delta: string }
  /** part 定稿（status='done' 或 'error'） */
  | { sessionId: number; turnId: string; kind: 'part-done'; part: DetailPart }
  /** 灰色读取记录行（D8，写 session_traces 后推送） */
  | { sessionId: number; turnId: string; kind: 'trace'; trace: TracePart }
  /** 回合结束（costCny = 到本回合为止的会话累计，见口径 B，D96-②） */
  | { sessionId: number; turnId: string; kind: 'turn-end'; costCny: number }
  /** 回合出错（03f：已生成内容保留，前端显示错误 + 重试） */
  | { sessionId: number; turnId: string; kind: 'error'; message: string }
  /** 用户停止（保留已生成内容，非错误） */
  | { sessionId: number; turnId: string; kind: 'stopped' }

/** graph_candidates 行视图（表 001；列不足处由 lane/agent 的 040+ 迁移补，如 session_id） */
export interface CandidateView {
  id: number
  graphId: number
  title: string
  authors: string[]
  year: number | null
  doi: string | null
  arxivId: string | null
  /** D55 去重命中：已在库中的论文 id（「已在论文库中」→「加入图谱」，D117） */
  existingPaperId: number | null
  reason: string | null
  x: number
  y: number
  status: 'pending' | 'confirmed' | 'ignored' | 'dismissed'
  createdAt: string
  updatedAt: string
  /** 2b（M6 预备提交）：候选来源会话（040 列）；M5 代码不传即 undefined */
  sessionId?: number
  /** 2b：库外候选确认入库后的论文 id（061 列） */
  paperId?: number
  /** 2b：检索时拿到的期刊/会议名（061 列） */
  venue?: string
  /** 2b：检索时拿到的 best_oa_location 链接（061 列，PDF 查找链直接用） */
  oaUrl?: string
  /** D159：回填后的 OpenAlex W-ID（大写） */
  openalexWid?: string
  /** D159：只有规范化标题对上库中论文，不拦截、不设 existingPaperId */
  titleDup?: boolean
  /** D161：命中的论文已在本图谱。仍写候选行供卡片，不建画布节点 */
  inGraph?: boolean
  /** D161：同一 DOI/arXiv/wid 已有 pending，本次未新建 */
  duplicateOfId?: number
  /** uat5 必须修 2 / D168：OpenAlex 回填未通过核对（卡片低调显示「未核实」；无任何标识符时显示「未找到可核实的记录」） */
  unverified?: boolean
}

/** M6（lane/fetch 批 1 起填充）：webSearch / webFetch 的结构化结果 */
export interface WebResult {
  title: string
  url: string
  snippet: string
  /** webFetch 的正文（Markdown）；webSearch 通常没有 */
  content?: string
}

/** M6（lane/fetch 批 1 起填充）：searchPapers 的外部学术库命中 */
export interface PaperHit {
  title: string
  authors: string[]
  year: number | null
  doi?: string
  arxivId?: string
  venue?: string
  citedBy?: number
  abstract?: string
  /** best_oa_location（开放获取 PDF 落地链接） */
  oaUrl?: string
  /** D82 库内去重：命中库中论文的 id（卡片「已在论文库中」） */
  inLibraryPaperId?: number
}

/** uat8b D191：一张旧候选卡片要核对的键。 */
export interface CardLiveQuery {
  /** 渲染侧稳定键，通常是 part.id */
  key: string
  candidateId?: number | null
  paperId?: number | null
  doi?: string | null
  arxivId?: string | null
}

/** 当前库里的状态。unknown = 查不到，卡片保持消息快照。 */
export type CardLiveKind = 'pending' | 'in_graph' | 'in_library' | 'deleted' | 'ignored' | 'unknown'

export interface CardLiveState {
  key: string
  kind: CardLiveKind
  paperId: number | null
  candidateId: number | null
}

/** event:agent:candidates 载荷：候选状态变化后的最新列表（画布虚线节点与卡片两处同步） */
export interface AgentCandidatesEvent {
  graphId: number
  /** 候选所属会话（列补充前可空） */
  sessionId: number | null
  candidates: CandidateView[]
}

/** D142/D160：会话费用分项。chat = 对话 + 联网；background = 名片 + 详情 + 导出概览 + 关系生成。 */
export interface SessionCostBreakdown {
  chat: number
  background: number
  total: number
}

export interface AgentApi {
  /** 按图谱 + 入口对象列会话（无会话返回空数组） */
  listSessions(graphId: number, entryType: SessionEntryType, entryId: number | null): Promise<SessionSummary[]>
  createSession(input: CreateSessionInput): Promise<SessionSummary>
  renameSession(sessionId: number, name: string): Promise<void>
  deleteSession(sessionId: number): Promise<void>
  getMessages(sessionId: number): Promise<ChatMessageView[]>
  /** 发起一回合；流式回包经 onAgentStream 推送，resolve 即「已受理」（不等回合跑完） */
  send(input: SendInput): Promise<void>
  stop(sessionId: number): Promise<void>
  retryMessage(sessionId: number, messageId: number): Promise<void>
  candidateConfirm(candidateId: number): Promise<CandidateView>
  candidateIgnore(candidateId: number): Promise<CandidateView>
  listCandidates(graphId: number): Promise<CandidateView[]>
  /** uat8b D191：批量查卡片对应论文的当前状态（只读） */
  cardLiveStates(graphId: number, queries: CardLiveQuery[]): Promise<CardLiveState[]>
  /** 拖动候选节点后写回坐标 */
  moveCandidate(candidateId: number, x: number, y: number): Promise<void>
  /** 本会话累计费用（人民币，全部类别合计） */
  sessionCost(sessionId: number): Promise<number>
  /** D142/D160：对话（chat+web）与后台（card+detail+overview+relation）分项；total 与 sessionCost 相同 */
  sessionCostBreakdown(sessionId: number): Promise<SessionCostBreakdown>
  /** D172：撤销本轮改动等系统记录（不作用户消息，入下轮上下文） */
  appendSystemNote: (sessionId: number, text: string) => Promise<ChatMessageView>
  /** 后台类别落账（card / detail / overview，且有 sessionId）后推一次 */
  onSessionCost(cb: (e: { sessionId: number }) => void): () => void
  onAgentStream(cb: (e: AgentStreamEvent) => void): () => void
  onAgentCandidates(cb: (e: AgentCandidatesEvent) => void): () => void
}
