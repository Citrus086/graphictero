import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentApi,
  AgentStreamEvent,
  ChatMessageView,
  ContextRef,
  SessionCostBreakdown,
  SessionEntryType,
  SessionSummary
} from '../../../shared/ipc/agent'
import type { DetailPart } from '../../../shared/parts'
import { createSmokeAgentMock } from '../components/chat/smokeAgentMock'
import { dispatchGraphChangedIfNeeded } from './graphChanged'

/**
 * M5 lane/chat：会话宿主 hook（D30 对话抽屉的数据面）。批 2 重构：状态按会话分桶，
 * 与「当前选中会话」解耦（评审必须修 #1）。批 3：hook 上提 App 级常驻（评审批 2 必须修 1）——
 * graphId/entry 可空（无宿主时静默），换入口/抽屉隐藏期间订阅不断、三个桶不清，回来运行态
 * 与流式原样恢复；流式增量只写在「有在跑回合」的会话上（隐藏期间的 delta 不污染已完成消息）。
 *
 * - 订阅 `event:agent:stream`（D118 事件桥），事件按**事件自带 sessionId** 写入对应会话桶
 *   （msgsBySession / turns / costBySession），运行中切会话再切回，运行态与流式内容都在；
 *   running = turns.has(当前会话)，stop 停当前会话；运行中删除会话先尽力 stop 再删。
 * - part 级增量归并（口径 A，维护者 cf64e3b）：part-delta 的 partId='text' 为保留字，
 *   追加到当前最后一个 text part；防御：无 text part 时自动补建空 text part，不丢增量。
 * - 回合结束 / 出错 / 停止后回源 `getMessages` 拿权威历史（D28 界面完整历史）；
 *   turn-end.costCny = 到本回合为止的会话累计（口径 B）；trace part 落库（口径 C）、
 *   stopped/error 落库（口径 D）由产出端（lane/agent）保证，mock 同口径。
 * - 冒烟开关：?smoke=1 时用渲染层内存 mock（smokeAgentMock）接管；真实环境走
 *   window.graphictero（preload agentApi）。
 */

/** 会话入口对象（02 图谱 / 03 论文 / 06 关系；07 阅读器走 paper 入口，D105-①） */
export type ChatEntry =
  | { type: 'graph' }
  | { type: 'paper'; paperId: number }
  | { type: 'relation'; relationId: number }

export function chatEntryOf(entry: ChatEntry): { entryType: SessionEntryType; entryId: number | null } {
  switch (entry.type) {
    case 'graph':
      return { entryType: 'graph', entryId: null }
    case 'paper':
      return { entryType: 'paper', entryId: entry.paperId }
    case 'relation':
      return { entryType: 'relation', entryId: entry.relationId }
  }
}

export interface UseAgentSessionOptions {
  /** 宿主为空（抽屉未开过/已关闭且无状态）时不发任何 IPC，订阅保持 */
  graphId: number | null
  entry: ChatEntry | null
  /** 测试注入专用；缺省按 smoke 开关 / window.graphictero 解析 */
  api?: AgentApi
}

const SMOKE_MODE = new URLSearchParams(window.location.search).has('smoke')

let smokeMock: AgentApi | null = null

function resolveApi(override?: AgentApi): AgentApi {
  if (override) return override
  if (SMOKE_MODE) {
    smokeMock ??= createSmokeAgentMock()
    // uat7 smoke 费用对账：与 cand/export/mineru 一样显式暴露同一 mock，
    // 避免在 smoke 脚本里遍历 React fiber 或误调真实 preload IPC。
    ;(window as unknown as { __gtSmokeAgent?: AgentApi }).__gtSmokeAgent = smokeMock
    return smokeMock
  }
  return window.graphictero
}

/**
 * 渲染层统一的 agent API 访问点：会话 hook、候选画布（GraphPage）、候选卡片（ChatDrawer）
 * 都必须经这里拿——smoke 模式下与 hook 共享同一个内存 mock（状态两处同步的前提）。
 */
export function agentApi(): AgentApi {
  return resolveApi(undefined)
}

/** 流式期间本地临时消息 id（负值，turn-end 后由 getMessages 权威历史替换） */
let localMsgSeq = 0
const nextLocalMsgId = (): number => --localMsgSeq

/**
 * part-delta 归并（口径 A）：带 id 的 part 按 id 匹配；partId='text' 落到最后一个 text part；
 * 防御——消息里还没有 text part 时自动补建（产出端跳过 part-start 也不丢增量）。
 */
function applyPartDelta(parts: DetailPart[], partId: string, delta: string): DetailPart[] {
  const byId = parts.findIndex((p) => 'id' in p && p.id === partId)
  if (byId >= 0) {
    return parts.map((p, i) => (i === byId && p.type === 'text' ? { ...p, text: p.text + delta } : p))
  }
  let target = -1
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].type === 'text') {
      target = i
      break
    }
  }
  if (target < 0) return [...parts, { type: 'text', text: delta }]
  return parts.map((p, i) => (i === target && p.type === 'text' ? { ...p, text: p.text + delta } : p))
}

function lastAssistantIndex(msgs: ChatMessageView[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant') return i
  }
  return -1
}

/** 对最后一条 assistant 消息应用 parts 变换（流式事件都挂在该会话当前回合的 assistant 消息上） */
function mapLastAssistant(msgs: ChatMessageView[], fn: (parts: DetailPart[]) => DetailPart[]): ChatMessageView[] {
  const i = lastAssistantIndex(msgs)
  if (i < 0) return msgs
  const m = msgs[i]
  return [...msgs.slice(0, i), { ...m, parts: fn(m.parts) }, ...msgs.slice(i + 1)]
}

/** part-done 的 text 定稿：替换最后一个 text part（保留 text/trace 交错结构） */
function finalizeTextPart(parts: DetailPart[], part: DetailPart): DetailPart[] {
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].type === 'text') {
      return [...parts.slice(0, i), part, ...parts.slice(i + 1)]
    }
  }
  return [...parts, part]
}

/** 抽屉宿主状态形状（App.tsx 的 ChatHostState 同构；抽出来便于纯函数测试） */
export interface ChatHostLike {
  open: boolean
  graphId: number
  entry: ChatEntry
}

export type ChatRouteLike =
  | { page: 'home' }
  | { page: 'graph'; graphId: number }
  | { page: 'settings' }
  | { page: 'paper'; paperId: number; graphId?: number }

/**
 * 抽屉显示条件（评审必须修 #2）：
 * 仅 02（graph，含 06 关系面板场景）/ 03（paper，07 阅读器是其 modal）且入口对象与
 * 当前页匹配；Home/设置页不显示；切图谱（graphId 不符）即隐藏。数据面不受显隐影响。
 */
export function chatVisibleOnRoute(chat: ChatHostLike | null, route: ChatRouteLike, lastGraphId: number | null): boolean {
  if (!chat || !chat.open) return false
  if (route.page === 'graph') {
    return chat.graphId === route.graphId && (chat.entry.type === 'graph' || chat.entry.type === 'relation')
  }
  if (route.page === 'paper') {
    const gid = route.graphId ?? lastGraphId
    return chat.entry.type === 'paper' && chat.entry.paperId === route.paperId && chat.graphId === gid
  }
  return false
}

/** 悬空空 assistant 判定：无 parts，或只有空 text part（lane/agent 可能发空 text 块的 part-start） */
function isDanglingEmptyAssistant(m: ChatMessageView): boolean {
  if (m.role !== 'assistant' || m.error) return false
  return m.parts.length === 0 || m.parts.every((p) => p.type === 'text' && p.text === '')
}

/** 回合边界清理：从尾部移除上一个未收尾回合留下的悬空空 assistant（不碰有内容的） */
function dropDanglingEmptyAssistant(ms: ChatMessageView[]): ChatMessageView[] {
  let end = ms.length
  while (end > 0 && isDanglingEmptyAssistant(ms[end - 1])) end--
  return end === ms.length ? ms : ms.slice(0, end)
}

const EMPTY_MSGS: ChatMessageView[] = []

export interface AgentSession {
  sessions: SessionSummary[]
  current: SessionSummary | null
  currentId: number | null
  /** 当前会话消息（完整历史；切走再切回由按会话缓存恢复） */
  messages: ChatMessageView[]
  /** 当前会话是否有回合在跑（每个会话各自记录，互不影响） */
  running: boolean
  /** 任一会话有回合在跑（App 级：Agent 运行中禁 ⌘Z / 撤销组入口，D77/D88） */
  anyRunning: boolean
  /** 发送期校验失败（busy/invalid 等无 turn-start 前导的 error 事件）；消费后清空 */
  sendError: { message: string } | null
  clearSendError(): void
  /** 本会话累计费用（口径 B：turn-end.costCny 为会话累计；D96-② 人民币） */
  costCny: number
  /** D142：对话项。还没拉到分项时等于 costCny */
  costChat: number
  /** D142/D160：后台项（名片 / 详情 / 导出概览 / 关系生成） */
  costBackground: number
  selectSession(id: number): void
  createSession(): Promise<number | null>
  renameSession(id: number, name: string): Promise<void>
  /** D122 物理删除；若该会话有回合在跑先尽力 stop（评审必须修 #1） */
  deleteSession(id: number): Promise<void>
  /** 失败时回滚乐观 user 消息并抛给调用方（建议修 #3） */
  send(text: string, contextRefs?: ContextRef[]): Promise<void>
  /** 停当前正在跑的会话（当前会话没在跑则 no-op） */
  stop(): Promise<void>
  /** 03f：重发出错消息；失败抛给调用方 */
  retryMessage(messageId: number): Promise<void>
}

export function useAgentSession({ graphId, entry, api }: UseAgentSessionOptions): AgentSession {
  const agent = useMemo(() => resolveApi(api), [api])
  const { entryType, entryId } = chatEntryOf(entry ?? { type: 'graph' })
  const entryKey = entry == null ? '' : `${entry.type}:${entry.type === 'paper' ? entry.paperId : entry.type === 'relation' ? entry.relationId : ''}`

  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionId, setSessionId] = useState<number | null>(null)
  /** 按会话分桶（评审必须修 #1）：流事件按事件自带 sessionId 写桶，与选中会话解耦。
   *  批 3：桶常驻——graphId/entry 变化（换入口/抽屉隐藏重挂）不再清空 */
  const [msgsBySession, setMsgsBySession] = useState<Map<number, ChatMessageView[]>>(new Map())
  const [turns, setTurns] = useState<Map<number, string>>(new Map())
  const [costBySession, setCostBySession] = useState<Map<number, number>>(new Map())
  const [splitBySession, setSplitBySession] = useState<Map<number, { chat: number; background: number }>>(new Map())
  const [sendError, setSendError] = useState<{ message: string } | null>(null)
  const sessionIdRef = useRef<number | null>(null)
  sessionIdRef.current = sessionId
  /** 分项请求代次：后返回的旧分项不能盖住更新的一次 */
  const costGen = useRef(new Map<number, number>())

  const patchMsgs = useCallback((sid: number, fn: (msgs: ChatMessageView[]) => ChatMessageView[]): void => {
    setMsgsBySession((m) => {
      const next = new Map(m)
      next.set(sid, fn(next.get(sid) ?? []))
      return next
    })
  }, [])

  const refreshCost = useCallback(
    (sid: number): void => {
      const gen = (costGen.current.get(sid) ?? 0) + 1
      costGen.current.set(sid, gen)
      const current = (): boolean => costGen.current.get(sid) === gen
      agent
        .sessionCost(sid)
        .then((c) => {
          if (!current()) return
          const breakdown = agent.sessionCostBreakdown
          if (typeof breakdown !== 'function') {
            setCostBySession((m) => new Map(m).set(sid, c))
            setSplitBySession((m) => new Map(m).set(sid, { chat: c, background: 0 }))
            return
          }
          breakdown(sid)
            .then((b: SessionCostBreakdown) => {
              if (!current()) return
              setCostBySession((m) => new Map(m).set(sid, b.total))
              setSplitBySession((m) => new Map(m).set(sid, { chat: b.chat, background: b.background }))
            })
            .catch(() => {
              if (!current()) return
              setCostBySession((m) => new Map(m).set(sid, c))
              setSplitBySession((m) => new Map(m).set(sid, { chat: c, background: 0 }))
            })
        })
        .catch(() => {})
    },
    [agent]
  )

  const refreshMessages = useCallback(
    (sid: number): void => {
      agent
        .getMessages(sid)
        .then((ms) => {
          setMsgsBySession((m) => new Map(m).set(sid, ms))
        })
        .catch(() => {})
      refreshCost(sid)
    },
    [agent, refreshCost]
  )

  // 会话列表：按 updatedAt 倒序（契约口径），默认选中最近的会话。
  // 批 3：宿主（graphId/entry）为空时静默；换入口只换列表与选中，不清三个常驻桶
  useEffect(() => {
    let disposed = false
    setSessions([])
    setSessionId(null)
    if (graphId == null || entry == null) return
    agent
      .listSessions(graphId, entryType, entryId)
      .then((list) => {
        if (disposed) return
        setSessions(list)
        if (list.length > 0) setSessionId(list[0].id)
      })
      .catch(() => {
        // 列表加载失败：抽屉显示空态，不崩
      })
    return () => {
      disposed = true
    }
    // entry 对象引用每次渲染可能变（内联字面量），依赖用其派生的 entryType/entryId/entryKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, graphId, entryType, entryId, entryKey])

  // 切会话：若无缓存则拉权威历史 + 费用
  useEffect(() => {
    if (sessionId == null) return
    if (!msgsBySession.has(sessionId)) refreshMessages(sessionId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, sessionId])

  // 流事件订阅（App 级常驻，一次订阅）：全部按 e.sessionId 写对应会话桶，不按选中会话过滤。
  // 防御（评审批 3 必须修 1 附带）：流式增量只落在「有在跑回合」的会话上——隐藏/重挂期间
  // 的 part-delta 不会写到已完成的旧 assistant 消息；error 可无 turn-start 前导（busy/invalid），
  // 此时不挂旧消息、不回源（回源会冲掉乐观 user 消息），改为 sendError 由宿主恢复输入 + 提示。
  const turnsRef = useRef(turns)
  turnsRef.current = turns
  useEffect(() => {
    const unsub = agent.onAgentStream((e: AgentStreamEvent) => {
      const sid = e.sessionId
      switch (e.kind) {
        case 'turn-start':
          setTurns((m) => new Map(m).set(sid, e.turnId))
          patchMsgs(sid, (ms) => {
            // 回合边界清理：上个未收尾回合留下的悬空空 assistant（含空 text 块）先移除
            const cleaned = dropDanglingEmptyAssistant(ms)
            return [...cleaned, { id: nextLocalMsgId(), role: 'assistant', parts: [], createdAt: new Date().toISOString() }]
          })
          break
        case 'part-start': {
          if (!turnsRef.current.has(sid)) break
          const started = e.part
          patchMsgs(sid, (ms) =>
            mapLastAssistant(ms, (parts) =>
              'id' in started && parts.some((p) => 'id' in p && p.id === started.id) ? parts : [...parts, started]
            )
          )
          break
        }
        case 'part-delta':
          if (!turnsRef.current.has(sid)) break
          patchMsgs(sid, (ms) => mapLastAssistant(ms, (parts) => applyPartDelta(parts, e.partId, e.delta)))
          break
        case 'part-done': {
          // uat8-fix1 S2：改图小结即使在消息早退路径也要刷新；纯文本/卡片/trace 不派发。
          // 这样无需在每个 turn-end 重建画布，也覆盖 part-done 晚于 turn-end 的乱序。
          dispatchGraphChangedIfNeeded(e)
          if (!turnsRef.current.has(sid)) break
          const done = e.part
          patchMsgs(sid, (ms) =>
            mapLastAssistant(ms, (parts) =>
              'id' in done ? parts.map((p) => ('id' in p && p.id === done.id ? done : p)) : finalizeTextPart(parts, done)
            )
          )
          break
        }
        case 'trace':
          if (!turnsRef.current.has(sid)) break
          patchMsgs(sid, (ms) => mapLastAssistant(ms, (parts) => [...parts, e.trace]))
          break
        case 'turn-end':
          setTurns((m) => {
            const next = new Map(m)
            next.delete(sid)
            return next
          })
          // 合计先跟上会话累计。分项等 sessionCostBreakdown，不用「累计 − 旧后台」，
          // 否则本回合刚记上的后台会先显示在对话里。后台含关系生成（D160）。
          setCostBySession((m) => new Map(m).set(sid, e.costCny))
          refreshMessages(sid)
          break
        case 'error': {
          const hadTurn = turnsRef.current.has(sid)
          setTurns((m) => {
            const next = new Map(m)
            next.delete(sid)
            return next
          })
          if (!hadTurn) {
            // 发送期校验失败（turnId 为 'busy'/'invalid' 字面量）：保留乐观 user 消息，
            // 交给宿主恢复输入 + toast
            setSendError({ message: e.message })
            break
          }
          patchMsgs(sid, (ms) => {
            const i = lastAssistantIndex(ms)
            return i < 0 ? ms : [...ms.slice(0, i), { ...ms[i], error: e.message }, ...ms.slice(i + 1)]
          })
          refreshMessages(sid)
          break
        }
        case 'stopped':
          setTurns((m) => {
            const next = new Map(m)
            next.delete(sid)
            return next
          })
          refreshMessages(sid)
          break
      }
    })
    return unsub
  }, [agent, patchMsgs, refreshMessages])

  // 回合已经结束后才跑完的名片 / 详情 / 概览：落账后再拉一次分项
  useEffect(() => {
    const listen = agent.onSessionCost
    if (typeof listen !== 'function') return
    return listen((e) => {
      if (e.sessionId > 0) refreshCost(e.sessionId)
    })
  }, [agent, refreshCost])

  const selectSession = useCallback((id: number) => setSessionId(id), [])

  const createSession = useCallback(async (): Promise<number | null> => {
    if (graphId == null || entry == null) return null
    const created = await agent.createSession({ graphId, entryType, entryId })
    const list = await agent.listSessions(graphId, entryType, entryId).catch(() => [created])
    setSessions(list)
    sessionIdRef.current = created.id
    setSessionId(created.id)
    setMsgsBySession((m) => new Map(m).set(created.id, []))
    return created.id
  }, [agent, graphId, entry, entryType, entryId])

  const renameSession = useCallback(
    async (id: number, name: string): Promise<void> => {
      await agent.renameSession(id, name.trim())
      setSessions((ss) => ss.map((s) => (s.id === id ? { ...s, name: name.trim() } : s)))
    },
    [agent]
  )

  const deleteSession = useCallback(
    async (id: number): Promise<void> => {
      if (graphId == null || entry == null) return
      // 运行中删除：先尽力 stop（停止回合收尾），再删除（评审必须修 #1）
      if (turns.has(id)) await agent.stop(id).catch(() => {})
      await agent.deleteSession(id)
      // 评审建 7：listSessions 失败时保留旧列表，不清空
      const list = await agent.listSessions(graphId, entryType, entryId).catch(() => null)
      if (list) setSessions(list)
      setMsgsBySession((m) => {
        const next = new Map(m)
        next.delete(id)
        return next
      })
      setTurns((m) => {
        const next = new Map(m)
        next.delete(id)
        return next
      })
      setCostBySession((m) => {
        const next = new Map(m)
        next.delete(id)
        return next
      })
      setSplitBySession((m) => {
        const next = new Map(m)
        next.delete(id)
        return next
      })
      if (sessionIdRef.current === id) {
        setSessionId(list ? (list[0]?.id ?? null) : (sessions.find((s) => s.id !== id)?.id ?? null))
      }
    },
    [agent, graphId, entryType, entryId, turns, sessions]
  )

  const send = useCallback(
    async (text: string, contextRefs: ContextRef[] = []): Promise<void> => {
      let sid = sessionIdRef.current
      const t = text.trim()
      if (!t) return
      if (sid == null) {
        sid = await createSession()
        if (sid == null) return
      }
      // await 之后闭包不再收窄 let；用常量，避免渲染把 ref 写回 null
      const sessionId = sid
      const tempId = nextLocalMsgId()
      setMsgsBySession((m) => {
        const list = m.get(sessionId) ?? []
        const next = new Map(m)
        next.set(sessionId, [...list, { id: tempId, role: 'user' as const, parts: [{ type: 'text' as const, text: t }], createdAt: new Date().toISOString() }])
        return next
      })
      try {
        await agent.send({ sessionId, text: t, contextRefs })
      } catch (err) {
        // 发送失败：回滚乐观 user 消息（建议修 #3），由调用方恢复输入原文
        setMsgsBySession((m) => {
          const next = new Map(m)
          next.set(sessionId, (next.get(sessionId) ?? []).filter((msg) => msg.id !== tempId))
          return next
        })
        throw err
      }
    },
    [agent, createSession]
  )

  // 评审建 6：当前会话没在跑则不调 IPC、直接返回（与注释语义一致；真后端 stop 幂等空转）
  const stop = useCallback(async (): Promise<void> => {
    const sid = sessionIdRef.current
    if (sid == null || !turnsRef.current.has(sid)) return
    await agent.stop(sid)
  }, [agent])

  const retryMessage = useCallback(
    async (messageId: number): Promise<void> => {
      const sid = sessionIdRef.current
      if (sid == null) return
      await agent.retryMessage(sid, messageId)
    },
    [agent]
  )

  const clearSendError = useCallback(() => setSendError(null), [])

  return {
    sessions,
    current: sessions.find((s) => s.id === sessionId) ?? null,
    currentId: sessionId,
    messages: (sessionId != null && msgsBySession.get(sessionId)) || EMPTY_MSGS,
    running: sessionId != null && turns.has(sessionId),
    anyRunning: turns.size > 0,
    sendError,
    clearSendError,
    costCny: (sessionId != null && costBySession.get(sessionId)) || 0,
    costChat: sessionId == null ? 0 : (splitBySession.get(sessionId)?.chat ?? costBySession.get(sessionId) ?? 0),
    costBackground: sessionId == null ? 0 : (splitBySession.get(sessionId)?.background ?? 0),
    selectSession,
    createSession,
    renameSession,
    deleteSession,
    send,
    stop,
    retryMessage
  }
}
