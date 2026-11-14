// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactElement } from 'react'
import type {
  AgentApi,
  AgentStreamEvent,
  CandidateView,
  ChatMessageView,
  CreateSessionInput,
  SendInput,
  SessionCostBreakdown,
  SessionSummary
} from '../../../../shared/ipc/agent'
import type { DetailPart, GraphChangePart, PaperCardPart } from '../../../../shared/parts'
import { PartsView } from '../richtext/PartsView'
import { undoGraphChange } from './graphChangeUndo'
import { resolveCandidate, resolveTurnStart } from './ChatDrawer'
import { chatVisibleOnRoute, useAgentSession } from '../../lib/useAgentSession'
import { MessageList } from './MessageList'
import { clockTime, SessionPicker } from './SessionPicker'
import { ChatDrawerWithSession, CHAT_MAX_W, CHAT_MIN_W } from './ChatDrawer'
import { addChip, removeChip, type ChatChip } from './ContextChips'

afterEach(cleanup)

/**
 * 可控假 AgentApi：send 默认只记录，测试手动经 emit 驱动流事件；
 * opts.failSend 模拟骨架期「未实现」发送失败。
 */
function fakeAgent(opts: { failSend?: boolean; /** 第 N 次之后的 listSessions 调用失败（评审建 7） */ listFailAfter?: number } = {}): AgentApi & {
  emit: (e: AgentStreamEvent) => void
  sessions: SessionSummary[]
  msgs: ChatMessageView[]
  lastSend: SendInput | null
  stops: number[]
  retryCalls: number[]
} {
  const listeners = new Set<(e: AgentStreamEvent) => void>()
  const sessions: SessionSummary[] = [
    { id: 1, graphId: 1, entryType: 'graph', entryId: null, name: '会话一', updatedAt: '2026-10-26T10:00:00.000Z' },
    { id: 2, graphId: 1, entryType: 'graph', entryId: null, name: '会话二', updatedAt: '2026-10-25T09:00:00.000Z' }
  ]
  const msgs: ChatMessageView[] = []
  let listCalls = 0
  const state = { lastSend: null as SendInput | null, stops: [] as number[], retryCalls: [] as number[] }
  const api = {
    emit: (e: AgentStreamEvent): void => listeners.forEach((cb) => cb(e)),
    sessions,
    msgs,
    get lastSend() {
      return state.lastSend
    },
    get stops() {
      return state.stops
    },
    get retryCalls() {
      return state.retryCalls
    },
    listSessions: async () => {
      listCalls += 1
      if (opts.listFailAfter != null && listCalls > opts.listFailAfter) throw new Error('listSessions 失败（评审建 7）')
      return [...sessions] // 返回副本，避免与内部数组共享引用
    },
    createSession: async (input: CreateSessionInput) => {
      const s: SessionSummary = {
        id: sessions.length + 1,
        graphId: input.graphId,
        entryType: input.entryType,
        entryId: input.entryId,
        name: input.name ?? '新会话',
        updatedAt: '2026-10-26T11:00:00.000Z'
      }
      sessions.unshift(s)
      return s
    },
    renameSession: async () => {},
    deleteSession: async (id: number) => {
      const i = sessions.findIndex((s) => s.id === id)
      if (i >= 0) sessions.splice(i, 1)
    },
    getMessages: async (sid: number) => msgs.filter((m) => (m as { sid?: number }).sid === sid),
    send: async (input: SendInput) => {
      state.lastSend = input
      if (opts.failSend) throw new Error('agent:send 未实现（骨架期）')
      msgs.push({ sid: input.sessionId, id: 100 + msgs.length, role: 'user', parts: [{ type: 'text', text: input.text }], createdAt: '' } as ChatMessageView & { sid: number })
    },
    stop: async (sid: number) => {
      state.stops.push(sid)
    },
    retryMessage: async (sid: number, mid: number) => {
      state.retryCalls.push(mid)
      const m = msgs.find((x) => x.id === mid)
      const turnId = 'retry-turn'
      listeners.forEach((cb) => cb({ sessionId: sid, turnId, kind: 'turn-start' }))
      listeners.forEach((cb) => cb({ sessionId: sid, turnId, kind: 'part-start', part: { type: 'text', text: '' } }))
      listeners.forEach((cb) => cb({ sessionId: sid, turnId, kind: 'part-delta', partId: 'text', delta: '重试后的回答' }))
      if (m) {
        m.error = undefined
        m.parts = [{ type: 'text', text: '重试后的回答' }]
      }
      listeners.forEach((cb) => cb({ sessionId: sid, turnId, kind: 'part-done', part: { type: 'text', text: '重试后的回答' } }))
      listeners.forEach((cb) => cb({ sessionId: sid, turnId, kind: 'turn-end', costCny: 0.08 }))
    },
    candidateConfirm: async () => {
      throw new Error('批 3 接入')
    },
    candidateIgnore: async () => {
      throw new Error('批 3 接入')
    },
    listCandidates: async () => [],
    cardLiveStates: async () => [],
    sessionCost: async () => 0.06,
    onAgentStream: (cb: (e: AgentStreamEvent) => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    onAgentCandidates: () => () => {}
  }
  return api as unknown as AgentApi & {
    emit: (e: AgentStreamEvent) => void
    sessions: SessionSummary[]
    msgs: ChatMessageView[]
    lastSend: SendInput | null
    stops: number[]
    retryCalls: number[]
  }
}

const h = (el: ReactElement): ReactElement => el

beforeEach(() => {
  ;(window as unknown as { graphictero: unknown }).graphictero = {
    getGraph: async () => ({ graph: { name: '测试图谱' }, members: [], relations: [] }),
    getPaperMeta: async () => ({ title: '测试论文' }),
    listLibrary: async () => [],
    listCandidates: async () => [],
    cardLiveStates: async () => [],
    candidateConfirm: async () => {
      throw new Error('候选确认（测试桩）')
    },
    candidateIgnore: async () => {
      throw new Error('候选忽略（测试桩）')
    },
    onAgentCandidates: () => () => {}
  }
  localStorage.clear()
})

describe('useAgentSession 流式归并（批 1 + 口径 A 防御）', () => {
  it('part 级 delta 追加、trace 行插入、turn-end 回源权威历史', async () => {
    const agent = fakeAgent()
    const { result } = renderHook(() => useAgentSession({ graphId: 1, entry: { type: 'graph' }, api: agent }))
    await waitFor(() => expect(result.current.current?.id).toBe(1))

    await act(async () => {
      await result.current.send('这张图谱有几篇论文？')
    })
    expect(result.current.messages.map((m) => m.role)).toEqual(['user'])

    act(() => agent.emit({ sessionId: 1, turnId: 't1', kind: 'turn-start' }))
    expect(result.current.running).toBe(true)
    act(() => agent.emit({ sessionId: 1, turnId: 't1', kind: 'part-start', part: { type: 'text', text: '' } }))
    act(() => agent.emit({ sessionId: 1, turnId: 't1', kind: 'part-delta', partId: 'text', delta: '冒烟' }))
    act(() => agent.emit({ sessionId: 1, turnId: 't1', kind: 'part-delta', partId: 'text', delta: '回答' }))
    let ai = result.current.messages[result.current.messages.length - 1]
    expect(ai.parts).toEqual([{ type: 'text', text: '冒烟回答' }])

    act(() =>
      agent.emit({
        sessionId: 1,
        turnId: 't1',
        kind: 'trace',
        trace: { type: 'data-trace', toolName: 'readPaper', paperId: 3, summary: '读取 §3 方法', excerpt: '原文片段内容' }
      })
    )
    ai = result.current.messages[result.current.messages.length - 1]
    expect(ai.parts.map((p) => p.type)).toEqual(['text', 'data-trace'])

    act(() => agent.emit({ sessionId: 1, turnId: 't1', kind: 'part-done', part: { type: 'text', text: '冒烟回答定稿' } }))
    ai = result.current.messages[result.current.messages.length - 1]
    expect(ai.parts.map((p) => p.type)).toEqual(['text', 'data-trace'])
    expect(ai.parts[0]).toEqual({ type: 'text', text: '冒烟回答定稿' })

    act(() => agent.emit({ sessionId: 1, turnId: 't1', kind: 'turn-end', costCny: 0.06 }))
    expect(result.current.running).toBe(false)
    expect(result.current.costCny).toBe(0.06)
    await waitFor(() => expect(result.current.messages.some((m) => m.id === 100)).toBe(true))
  })

  it('回合结束不把新后台算进对话；后台落账后再拉分项', async () => {
    const agent = fakeAgent()
    const api = agent as AgentApi & { emit: (e: AgentStreamEvent) => void }
    let n = 0
    let release: ((b: SessionCostBreakdown) => void) | null = null
    const listeners = new Set<(e: { sessionId: number }) => void>()
    api.sessionCost = async () => (n === 0 ? 0.05 : n === 1 ? 0.12 : 0.15)
    api.sessionCostBreakdown = () => {
      const i = n
      n += 1
      if (i === 0) return Promise.resolve({ chat: 0.02, background: 0.03, total: 0.05 })
      if (i === 1) return new Promise<SessionCostBreakdown>((resolve) => { release = resolve })
      return Promise.resolve({ chat: 0.04, background: 0.11, total: 0.15 })
    }
    api.onSessionCost = (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
    const { result } = renderHook(() => useAgentSession({ graphId: 1, entry: { type: 'graph' }, api }))
    await waitFor(() => {
      expect(result.current.costChat).toBe(0.02)
      expect(result.current.costBackground).toBe(0.03)
    })
    await act(async () => {
      api.emit({ sessionId: 1, turnId: 't1', kind: 'turn-end', costCny: 0.12 })
    })
    expect(result.current.costCny).toBe(0.12)
    // 累计 − 旧后台 = 0.09。分项必须等 breakdown，不能把本回合后台先画进对话。
    expect(result.current.costChat).toBe(0.02)
    expect(result.current.costBackground).toBe(0.03)
    await waitFor(() => expect(release).not.toBeNull())
    expect(result.current.costChat).toBe(0.02)
    await act(async () => {
      release?.({ chat: 0.04, background: 0.08, total: 0.12 })
    })
    await waitFor(() => {
      expect(result.current.costChat).toBe(0.04)
      expect(result.current.costBackground).toBe(0.08)
      expect(result.current.costCny).toBe(0.12)
    })
    await act(async () => {
      for (const cb of listeners) cb({ sessionId: 1 })
    })
    await waitFor(() => {
      expect(result.current.costChat).toBe(0.04)
      expect(result.current.costBackground).toBe(0.11)
      expect(result.current.costCny).toBe(0.15)
    })
  })

  it('口径 A 防御：没有 part-start 的 text delta 自动补建 text part，不丢增量', async () => {
    const agent = fakeAgent()
    const { result } = renderHook(() => useAgentSession({ graphId: 1, entry: { type: 'graph' }, api: agent }))
    await waitFor(() => expect(result.current.current?.id).toBe(1))
    act(() => agent.emit({ sessionId: 1, turnId: 't1', kind: 'turn-start' }))
    act(() => agent.emit({ sessionId: 1, turnId: 't1', kind: 'part-delta', partId: 'text', delta: '直接来的增量' }))
    const ai = result.current.messages[result.current.messages.length - 1]
    expect(ai.parts).toEqual([{ type: 'text', text: '直接来的增量' }])
  })
})

describe('useAgentSession 按会话运行态（评审必须修 #1）', () => {
  it('运行中切换会话：各自记录运行态，stop 停对应会话', async () => {
    const agent = fakeAgent()
    const { result } = renderHook(() => useAgentSession({ graphId: 1, entry: { type: 'graph' }, api: agent }))
    await waitFor(() => expect(result.current.current?.id).toBe(1))

    // 会话 1 回合开跑
    await act(async () => {
      await result.current.send('会话一的问题')
    })
    act(() => agent.emit({ sessionId: 1, turnId: 't1', kind: 'turn-start' }))
    expect(result.current.running).toBe(true)

    // 切到会话 2：不卡 running（显示目标会话自身运行态 = false）
    act(() => result.current.selectSession(2))
    expect(result.current.running).toBe(false)
    expect(result.current.messages).toEqual([])

    // 会话 1 的流事件仍写会话 1 的桶（trace 出现在会话 1，不污染会话 2）
    act(() => agent.emit({ sessionId: 1, turnId: 't1', kind: 'part-delta', partId: 'text', delta: '甲' }))
    act(() => agent.emit({ sessionId: 1, turnId: 't1', kind: 'turn-end', costCny: 0.05 }))
    expect(result.current.running).toBe(false)

    // 切回会话 1：运行态已收尾、流式内容仍在缓存里
    act(() => result.current.selectSession(1))
    expect(result.current.running).toBe(false)
    await waitFor(() => expect(result.current.messages.some((m) => m.role === 'user')).toBe(true))

    // 会话 2 开跑后停止 → stop 调的是会话 2
    act(() => result.current.selectSession(2))
    await act(async () => {
      await result.current.send('会话二的问题')
    })
    act(() => agent.emit({ sessionId: 2, turnId: 't2', kind: 'turn-start' }))
    expect(result.current.running).toBe(true)
    await act(async () => {
      await result.current.stop()
    })
    expect(agent.stops).toEqual([2])
  })

  it('运行中删除当前会话：先 stop 再删，不残留 running', async () => {
    const agent = fakeAgent()
    const { result } = renderHook(() => useAgentSession({ graphId: 1, entry: { type: 'graph' }, api: agent }))
    await waitFor(() => expect(result.current.current?.id).toBe(1))
    await act(async () => {
      await result.current.send('问题')
    })
    act(() => agent.emit({ sessionId: 1, turnId: 't1', kind: 'turn-start' }))
    expect(result.current.running).toBe(true)

    await act(async () => {
      await result.current.deleteSession(1)
    })
    expect(agent.stops).toEqual([1])
    expect(result.current.sessions.map((s) => s.id)).toEqual([2])
    expect(result.current.current?.id).toBe(2)
    expect(result.current.running).toBe(false)
  })

  it('send 失败：回滚乐观 user 消息并抛出（建议修 #3）', async () => {
    const agent = fakeAgent({ failSend: true })
    const { result } = renderHook(() => useAgentSession({ graphId: 1, entry: { type: 'graph' }, api: agent }))
    await waitFor(() => expect(result.current.current?.id).toBe(1))
    await expect(act(async () => {
      await result.current.send('会失败的消息')
    })).rejects.toThrow('未实现')
    expect(result.current.messages).toEqual([])
  })

  it('contextRefs 随 send 发出（D30 上下文 chip 的数据面）', async () => {
    const agent = fakeAgent()
    const { result } = renderHook(() => useAgentSession({ graphId: 1, entry: { type: 'graph' }, api: agent }))
    await waitFor(() => expect(result.current.current?.id).toBe(1))
    await act(async () => {
      await result.current.send('带着上下文', [{ kind: 'paper', paperId: 5 }])
    })
    expect(agent.lastSend?.contextRefs).toEqual([{ kind: 'paper', paperId: 5 }])
  })

  it('03f 重试：error 消息经 retryMessage 清错并回源新内容', async () => {
    const agent = fakeAgent()
    const { result } = renderHook(() => useAgentSession({ graphId: 1, entry: { type: 'graph' }, api: agent }))
    await waitFor(() => expect(result.current.current?.id).toBe(1))
    // 构造一个失败回合（口径 D：error 挂消息上，已生成内容保留）
    agent.msgs.push(
      { sid: 1, id: 500, role: 'user', parts: [{ type: 'text', text: '前一个问题' }], createdAt: '' } as ChatMessageView & { sid: number },
      {
        sid: 1,
        id: 501,
        role: 'assistant',
        parts: [{ type: 'text', text: '失败前已生成的部分回答。' }],
        createdAt: '',
        error: '冒烟构造的回合失败（点击重试）'
      } as ChatMessageView & { sid: number }
    )
    // 模拟真实失败回合（口径 D：回合在跑 → 落库 → error 事件 → 渲染层回源）
    act(() => agent.emit({ sessionId: 1, turnId: 't-err', kind: 'turn-start' }))
    act(() => agent.emit({ sessionId: 1, turnId: 't-err', kind: 'error', message: '冒烟构造的回合失败（点击重试）' }))
    await waitFor(() => expect(result.current.messages.some((m) => m.id === 501)).toBe(true))
    expect(result.current.messages.find((m) => m.id === 501)?.error).toBeTruthy()

    await act(async () => {
      await result.current.retryMessage(501)
    })
    expect(agent.retryCalls).toEqual([501])
    expect(result.current.running).toBe(false)
    await waitFor(() => {
      const m = result.current.messages.find((x) => x.id === 501)
      expect(m?.error).toBeUndefined()
      expect(m?.parts[0]).toEqual({ type: 'text', text: '重试后的回答' })
    })
  })
})

describe('抽屉显示条件 chatVisibleOnRoute（评审必须修 #2）', () => {
  const chatGraph = { open: true, graphId: 1, entry: { type: 'graph' } as const }
  const chatPaper = { open: true, graphId: 1, entry: { type: 'paper', paperId: 7 } as const }
  const chatRel = { open: true, graphId: 1, entry: { type: 'relation', relationId: 3 } as const }

  it('02：graph/relation 入口在所属图谱页显示；切图谱/回首页/设置页隐藏', () => {
    expect(chatVisibleOnRoute(chatGraph, { page: 'graph', graphId: 1 }, null)).toBe(true)
    expect(chatVisibleOnRoute(chatRel, { page: 'graph', graphId: 1 }, null)).toBe(true)
    expect(chatVisibleOnRoute(chatGraph, { page: 'graph', graphId: 2 }, null)).toBe(false) // 切图谱不残留
    expect(chatVisibleOnRoute(chatGraph, { page: 'home' }, null)).toBe(false)
    expect(chatVisibleOnRoute(chatGraph, { page: 'settings' }, null)).toBe(false)
    expect(chatVisibleOnRoute(chatGraph, { page: 'paper', paperId: 7, graphId: 1 }, null)).toBe(false) // 入口不匹配
  })

  it('03：paper 入口匹配当前论文页（含 lastGraph 兜底）', () => {
    expect(chatVisibleOnRoute(chatPaper, { page: 'paper', paperId: 7, graphId: 1 }, null)).toBe(true)
    expect(chatVisibleOnRoute(chatPaper, { page: 'paper', paperId: 8, graphId: 1 }, null)).toBe(false)
    expect(chatVisibleOnRoute(chatPaper, { page: 'paper', paperId: 7 }, 1)).toBe(true) // 从首页进：lastGraph 兜底
    expect(chatVisibleOnRoute(chatPaper, { page: 'paper', paperId: 7 }, 2)).toBe(false)
  })

  it('收起（open=false）一律不显示', () => {
    expect(chatVisibleOnRoute({ ...chatGraph, open: false }, { page: 'graph', graphId: 1 }, null)).toBe(false)
    expect(chatVisibleOnRoute(null, { page: 'graph', graphId: 1 }, null)).toBe(false)
  })
})

describe('data-trace 渲染与展开', () => {
  it('PartsView 白名单分发：灰色行 + 点击展开 excerpt', () => {
    render(
      h(
        createElement(PartsView, {
          parts: [{ type: 'data-trace', toolName: 'readPaper', summary: '读取 §3 方法', excerpt: '原文片段内容' }]
        })
      )
    )
    const row = screen.getByTestId('part-trace')
    expect(row.textContent).toContain('读原文')
    expect(row.textContent).toContain('读取 §3 方法')
    expect(screen.queryByText('原文片段内容')).toBeNull()
    fireEvent.click(row.querySelector('.gt-trace-head') as Element)
    expect(screen.queryByText('原文片段内容')).not.toBeNull()
  })

  it('无 excerpt 的 trace 行为纯展示、不可点', () => {
    render(h(createElement(PartsView, { parts: [{ type: 'data-trace', toolName: 'getPapers', summary: '读取图谱成员' }] })))
    const head = screen.getByTestId('part-trace').querySelector('.gt-trace-head') as HTMLButtonElement
    expect(head.disabled).toBe(true)
  })
})

describe('MessageList', () => {
  it('用户消息气泡 / 流式占位三点动画', () => {
    render(
      h(
        createElement(MessageList, {
          running: true,
          messages: [
            { id: 1, role: 'user', parts: [{ type: 'text', text: '你好' }], createdAt: '' },
            { id: 2, role: 'assistant', parts: [], createdAt: '' }
          ]
        })
      )
    )
    expect(screen.getByTestId('chat-msg-user').textContent).toContain('你好')
    expect(screen.getByTestId('chat-typing').querySelectorAll('.gt-dots i').length).toBe(3)
  })

  it('03f：出错消息显示错误行与重试按钮，点击回调 onRetry', () => {
    const onRetry = vi.fn()
    render(
      h(
        createElement(MessageList, {
          running: false,
          onRetry,
          messages: [
            { id: 9, role: 'user', parts: [{ type: 'text', text: '问' }], createdAt: '' },
            {
              id: 10,
              role: 'assistant',
              parts: [{ type: 'text', text: '部分内容' }],
              createdAt: '',
              error: '回合失败'
            }
          ]
        })
      )
    )
    expect(screen.getByTestId('chat-msg-error').textContent).toContain('回合失败')
    fireEvent.click(screen.getByTestId('chat-retry'))
    expect(onRetry).toHaveBeenCalledWith(10)
  })
})

describe('SessionPicker', () => {
  it('删除会话需二次确认（D122），确认后才回调', () => {
    const onDelete = vi.fn()
    render(
      h(
        createElement(SessionPicker, {
          sessions: [{ id: 1, graphId: 1, entryType: 'graph', entryId: null, name: '会话一', updatedAt: '2026-10-26T10:00:00.000Z' }],
          currentId: 1,
          onSelect: () => {},
          onCreate: () => {},
          onRename: () => {},
          onDelete
        })
      )
    )
    fireEvent.click(screen.getByTestId('session-picker'))
    fireEvent.click(screen.getByTestId('session-menu-delete'))
    // 二次确认弹层出现，此时还没删
    expect(onDelete).not.toHaveBeenCalled()
    expect(screen.getByTestId('session-picker').ownerDocument.body.textContent).toContain('永久删除')
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(onDelete).toHaveBeenCalledWith(1)
  })

  it('新建会话菜单项带 ⌘N 标注（原型）', () => {
    render(
      h(
        createElement(SessionPicker, {
          sessions: [],
          currentId: null,
          onSelect: () => {},
          onCreate: () => {},
          onRename: () => {},
          onDelete: () => {}
        })
      )
    )
    fireEvent.click(screen.getByTestId('session-picker'))
    expect(screen.getByTestId('session-menu-new').textContent).toContain('⌘N')
  })

  it('uat10：同名默认会话用「日期 + HH:mm」区分；同一分钟撞车追加短 id；完整名进 title', () => {
    const same = (id: number, iso: string): SessionSummary => ({
      id,
      graphId: 1,
      entryType: 'graph',
      entryId: null,
      name: '图谱对话 · Uncertainty-aware Search',
      updatedAt: iso
    })
    render(
      h(
        createElement(SessionPicker, {
          sessions: [
            same(7, '2026-10-28T10:01:00.000Z'),
            same(8, '2026-10-28T10:01:30.000Z'), // 与 7 同一分钟：撞车
            same(9, '2026-10-28T10:02:00.000Z') // 不同分钟：不撞车
          ],
          currentId: 7,
          onSelect: () => {},
          onCreate: () => {},
          onRename: () => {},
          onDelete: () => {}
        })
      )
    )
    fireEvent.click(screen.getByTestId('session-picker'))
    const stamps = Array.from(document.querySelectorAll('.gt-sess-menu .mi .kb')).map((el) => el.textContent)
    // 与运行机器时区无关：预期值走同一本地时间格式化器，原始 ISO 仍固定。
    expect(stamps[0]).toContain(clockTime('2026-10-28T10:01:00.000Z'))
    expect(stamps[1]).toContain(clockTime('2026-10-28T10:01:30.000Z'))
    expect(stamps[2]).toContain(clockTime('2026-10-28T10:02:00.000Z'))
    expect(stamps[0]).not.toBe(stamps[1])
    // 同一分钟撞车：追加短 id
    expect(stamps[0]).toContain('#7')
    expect(stamps[1]).toContain('#8')
    expect(stamps[2]).not.toContain('#') // 不同分钟不加 id
    const names = Array.from(document.querySelectorAll('.gt-sess-menu .gt-sess-item-name'))
    expect(names[0].getAttribute('title')).toBe('图谱对话 · Uncertainty-aware Search')
    // 顶栏当前会话名带完整名 title
    expect(document.querySelector('.gt-sess-name')?.getAttribute('title')).toBe('图谱对话 · Uncertainty-aware Search')
  })
})

describe('ContextChips', () => {
  it('按 key 去重追加 / 按 key 移除', () => {
    const paper: ChatChip = { ref: { kind: 'paper', paperId: 5 }, label: '论文五' }
    const quote: ChatChip = { ref: { kind: 'quote', paperId: 5, page: 1, text: '引文内容' }, label: 'p.2「引文内容」' }
    let chips = addChip([], paper)
    chips = addChip(chips, paper)
    expect(chips.length).toBe(1)
    chips = addChip(chips, quote)
    expect(chips.length).toBe(2)
    chips = removeChip(chips, 'paper:5')
    expect(chips.length).toBe(1)
    expect(chips[0].ref.kind).toBe('quote')
  })
})

describe('批 3：App 级常驻与防御（评审批 2 必须修 1 + 附带）', () => {
  it('换入口不清运行态：隐藏/换入口回来 running 仍真、增量落正确回合', async () => {
    const agent = fakeAgent()
    const { result, rerender } = renderHook(
      ({ entry }: { entry: import('../../lib/useAgentSession').ChatEntry }) =>
        useAgentSession({ graphId: 1, entry, api: agent }),
      { initialProps: { entry: { type: 'graph' } as import('../../lib/useAgentSession').ChatEntry } }
    )
    await waitFor(() => expect(result.current.current?.id).toBe(1))
    await act(async () => {
      await result.current.send('问题')
    })
    act(() => agent.emit({ sessionId: 1, turnId: 't1', kind: 'turn-start' }))
    expect(result.current.running).toBe(true)

    // 换入口（抽屉隐藏/重挂的等价）：三个常驻桶不清，运行态保留
    rerender({ entry: { type: 'paper', paperId: 9 } })
    expect(result.current.anyRunning).toBe(true)
    await waitFor(() => expect(result.current.current?.id).toBe(1))
    expect(result.current.running).toBe(true)

    // 隐藏期间的增量仍写会话 1 的在跑回合（不落到已完成旧消息）
    act(() => agent.emit({ sessionId: 1, turnId: 't1', kind: 'part-delta', partId: 'text', delta: '恢复后的增量' }))
    act(() => agent.emit({ sessionId: 1, turnId: 't1', kind: 'turn-end', costCny: 0.09 }))
    expect(result.current.running).toBe(false)
    expect(result.current.costCny).toBe(0.09)
  })

  it('error 可无 turn-start 前导（busy/invalid）：乐观 user 消息不被冲掉，sendError 透出', async () => {
    const agent = fakeAgent()
    const { result } = renderHook(() => useAgentSession({ graphId: 1, entry: { type: 'graph' }, api: agent }))
    await waitFor(() => expect(result.current.current?.id).toBe(1))
    await act(async () => {
      await result.current.send('撞 busy 的消息')
    })
    expect(result.current.messages.map((m) => m.role)).toEqual(['user'])
    act(() => agent.emit({ sessionId: 1, turnId: 'busy', kind: 'error', message: '会话有回合正在进行（busy）' }))
    // 乐观 user 消息仍在；无 error 挂在任何消息上；sendError 透出给宿主 toast
    expect(result.current.messages.map((m) => m.role)).toEqual(['user'])
    expect(result.current.messages.every((m) => !m.error)).toBe(true)
    expect(result.current.sendError?.message).toContain('busy')
    expect(result.current.running).toBe(false)
    act(() => result.current.clearSendError())
    expect(result.current.sendError).toBeNull()
  })

  it('回合边界清理：新 turn-start 移除上个未收尾回合的悬空空 assistant（含空 text 块）', async () => {
    const agent = fakeAgent()
    const { result } = renderHook(() => useAgentSession({ graphId: 1, entry: { type: 'graph' }, api: agent }))
    await waitFor(() => expect(result.current.current?.id).toBe(1))
    act(() => agent.emit({ sessionId: 1, turnId: 't1', kind: 'turn-start' }))
    act(() => agent.emit({ sessionId: 1, turnId: 't1', kind: 'part-start', part: { type: 'text', text: '' } }))
    expect(result.current.messages.length).toBe(1)
    // 上个回合没有正常收尾（如异常断开），新 turn-start 清掉悬空空块
    act(() => agent.emit({ sessionId: 1, turnId: 't2', kind: 'turn-start' }))
    expect(result.current.messages.length).toBe(1)
    expect(result.current.messages[0].parts).toEqual([])
  })

  it('stop 空转：当前会话没在跑时不调 agent.stop（评审建 6）', async () => {
    const agent = fakeAgent()
    const { result } = renderHook(() => useAgentSession({ graphId: 1, entry: { type: 'graph' }, api: agent }))
    await waitFor(() => expect(result.current.current?.id).toBe(1))
    await act(async () => {
      await result.current.stop()
    })
    expect(agent.stops).toEqual([])
  })

  it('deleteSession 的 listSessions 失败时保留旧列表（评审建 7）', async () => {
    const agent = fakeAgent({ listFailAfter: 1 }) // 初次加载成功，删除后的刷新失败
    const { result } = renderHook(() => useAgentSession({ graphId: 1, entry: { type: 'graph' }, api: agent }))
    await waitFor(() => expect(result.current.current?.id).toBe(1))
    await act(async () => {
      await result.current.deleteSession(2)
    })
    // 列表没被清空（仍显示旧列表），不崩
    expect(result.current.sessions.length).toBe(2)
  })
})

describe('graphChangeUndo（必须修 1：D104 守卫）', () => {
  const part: GraphChangePart = {
    type: 'data-graph-change',
    id: 'gc1',
    status: 'done',
    changeType: 'addRelation',
    relationIds: [7],
    paperIds: [1, 2],
    summary: '新增 1 条关系'
  }

  function stubGraph(relations: Array<{ id: number; createdAt: string }>, deletes: number[]): void {
    ;(window as unknown as { graphictero: unknown }).graphictero = {
      getGraph: async () => ({
        graph: { name: 'g' },
        members: [],
        relations: relations.map((r) => ({
          paperLow: 1,
          paperHigh: 2,
          srcPaper: 1,
          statement: '',
          llmTypes: [],
          autoTypes: [],
          ...r
        }))
      }),
      deleteRelation: async (id: number) => {
        deletes.push(id)
      },
      restoreRelation: async () => 7
    }
  }

  it('本回合前已存在的边（upsert 改写命中）：不调 deleteRelation，失败即停并如实报告', async () => {
    const deletes: number[] = []
    // 边 createdAt 早于回合起点（消息 createdAt）→ addRelation 只是改写既有边
    stubGraph([{ id: 7, createdAt: '2026-10-26T09:00:00.000Z' }], deletes)
    const r = await undoGraphChange(1, part, '2026-10-26T10:00:00.000Z')
    expect(deletes).toEqual([])
    expect(r.undone).toBe(0)
    expect(r.failed).toBe(1)
    expect(r.message).toContain('本回合前已存在')
  })

  it('本回合新建的边（createdAt ≥ 回合起点）：正常删除撤销', async () => {
    const deletes: number[] = []
    stubGraph([{ id: 7, createdAt: '2026-10-26T10:30:00.000Z' }], deletes)
    const r = await undoGraphChange(1, part, '2026-10-26T10:00:00.000Z')
    expect(deletes).toEqual([7])
    expect(r.undone).toBe(1)
    expect(r.failed).toBe(0)
  })

  it('无回合起点（旧消息无宿主匹配）：守卫不触发，维持删除行为', async () => {
    const deletes: number[] = []
    stubGraph([{ id: 7, createdAt: '2026-10-26T09:00:00.000Z' }], deletes)
    const r = await undoGraphChange(1, part, null)
    expect(deletes).toEqual([7])
    expect(r.undone).toBe(1)
  })

  it('addCandidate 等未知类型：诚实报「暂不支持撤销」（评审建 2 删死分支后的形态）', async () => {
    const r = await undoGraphChange(1, { ...part, changeType: 'addCandidate', relationIds: [], paperIds: [3] }, '2026-10-26T10:00:00.000Z')
    expect(r.undone).toBe(0)
    expect(r.failed).toBe(1)
    expect(r.message).toContain('暂不支持撤销')
  })
})

describe('graphChangeUndo（M6 前置 2a：快照还原，D129）', () => {
  function stubSnapshotApi(restores: number[]): void {
    ;(window as unknown as { graphictero: unknown }).graphictero = {
      restoreRelationSnapshot: async (id: number) => {
        restores.push(id)
        return 1
      },
      getGraph: async () => ({ graph: { name: 'g' }, members: [], relations: [] }),
      deleteRelation: async () => {}
    }
  }
  const overwritePart: GraphChangePart = {
    type: 'data-graph-change',
    id: 'gc-ow',
    status: 'done',
    changeType: 'updateRelation',
    relationIds: [8],
    paperIds: [1, 2],
    snapshotIds: [41],
    summary: '修改关系 #8（原：对比 · …）'
  }

  it('updateRelation 带 snapshotIds：经 rel:restoreSnapshot 按快照还原（修改可撤）', async () => {
    const restores: number[] = []
    stubSnapshotApi(restores)
    const r = await undoGraphChange(1, overwritePart, '2026-10-26T10:00:00.000Z')
    expect(restores).toEqual([41])
    expect(r).toMatchObject({ undone: 1, failed: 0 })
    expect(r.message).toContain('已撤销本轮全部 1 条改动')
  })

  it('deleteRelation 带 snapshotIds：同样走快照还原', async () => {
    const restores: number[] = []
    stubSnapshotApi(restores)
    const r = await undoGraphChange(1, { ...overwritePart, changeType: 'deleteRelation', snapshotIds: [42, 43] }, '2026-10-26T10:00:00.000Z')
    expect(restores).toEqual([43, 42]) // 撤销组逆序恢复（D119）
    expect(r.undone).toBe(2)
  })

  it('updateRelation 无 snapshotIds（旧数据）：诚实报「缺少改动前快照」', async () => {
    const restores: number[] = []
    stubSnapshotApi(restores)
    const r = await undoGraphChange(1, { ...overwritePart, snapshotIds: undefined }, '2026-10-26T10:00:00.000Z')
    expect(restores).toEqual([])
    expect(r.failed).toBe(1)
    expect(r.message).toContain('缺少改动前快照')
  })
})

describe('resolveCandidate（建议修 1：part.id 精确匹配）', () => {
  const cands: CandidateView[] = [
    { id: 11, graphId: 1, title: 'Same Title', authors: [], year: null, doi: '10.1/a', arxivId: null, existingPaperId: null, reason: '', x: 0, y: 0, status: 'pending', createdAt: '', updatedAt: '' },
    { id: 22, graphId: 1, title: 'Same Title', authors: [], year: null, doi: '10.1/b', arxivId: null, existingPaperId: null, reason: '', x: 0, y: 0, status: 'pending', createdAt: '', updatedAt: '' }
  ]
  const base: Omit<PaperCardPart, 'id' | 'doi'> = { type: 'data-paper-card', status: 'done', title: 'Same Title', authors: [], reason: 'r', cardStatus: 'candidate' }

  it("part.id = 'c22' 精确命中第二条（同标题两条候选不错位）", () => {
    const part: PaperCardPart = { ...base, id: 'c22' }
    expect(resolveCandidate(cands, part)?.id).toBe(22)
  })

  it("mock 风格 id 'card-*' 解析失败回退 title/DOI 匹配", () => {
    const part: PaperCardPart = { ...base, id: 'card-x', doi: '10.1/b' }
    expect(resolveCandidate(cands, part)?.id).toBe(22)
  })

  it('解析不出且 title/DOI 无命中 → undefined', () => {
    const part: PaperCardPart = { ...base, id: 'c99', doi: '10.1/none' }
    expect(resolveCandidate(cands, part)).toBeUndefined()
  })
})

describe('resolveTurnStart（批 5 必须修 1：跨回合 g-id 撞车不绕过 D104 守卫）', () => {
  const T1 = '2026-10-26T10:00:00.000Z'
  const EDGE1 = '2026-10-26T10:05:00.000Z' // 回合 1 期间新建的边
  const MANUAL = '2026-10-26T10:15:00.000Z' // 回合间手动建的边
  const T2 = '2026-10-26T10:20:00.000Z'
  const EDGE2 = '2026-10-26T10:25:00.000Z' // 回合 2 期间新建的边

  const gc = (relationIds: number[]): GraphChangePart => ({
    type: 'data-graph-change',
    id: 'g1', // runtime 每回合从 g1 重编号——两回合撞 id
    status: 'done',
    changeType: 'addRelation',
    relationIds,
    paperIds: [1, 2],
    summary: '新增关系'
  })
  const aiMsg = (id: number, createdAt: string, parts: DetailPart[]): ChatMessageView => ({ id, role: 'assistant', parts, createdAt })

  function stubGraph(relations: Array<{ id: number; createdAt: string }>, deletes: number[]): void {
    ;(window as unknown as { graphictero: unknown }).graphictero = {
      getGraph: async () => ({
        graph: { name: 'g' },
        members: [],
        relations: relations.map((r) => ({
          paperLow: 1,
          paperHigh: 2,
          srcPaper: 1,
          statement: '',
          llmTypes: [],
          autoTypes: [],
          ...r
        }))
      }),
      deleteRelation: async (id: number) => {
        deletes.push(id)
      },
      restoreRelation: async () => 1
    }
  }

  it('(a) 同对边跨回合改写：回合起点取最新回合 → 守卫拒删上一回合的边', async () => {
    // 两个回合各含 g1 且 relationIds 相同（[7]）——id 撞车 + 内容也相同，只能取「最新命中」
    const msgs = [aiMsg(1, T1, [gc([7])]), aiMsg(2, T2, [gc([7])])]
    expect(resolveTurnStart(msgs, gc([7]))).toBe(T2) // 不取 T1（旧实现 bug）
    const deletes: number[] = []
    stubGraph([{ id: 7, createdAt: EDGE1 }], deletes)
    const r = await undoGraphChange(1, gc([7]), resolveTurnStart(msgs, gc([7])))
    expect(deletes).toEqual([])
    expect(r.failed).toBe(1)
    expect(r.message).toContain('本回合前已存在')
  })

  it('(b) 不同对边：relationIds 消歧，各自命中所在回合并正确删除本回合新建边', async () => {
    const msgs = [aiMsg(1, T1, [gc([7])]), aiMsg(2, T2, [gc([8])])]
    // 撤销回合 2 的 part（[8]）：起点 = T2，edge8 新建于回合 2 → 删除
    expect(resolveTurnStart(msgs, gc([8]))).toBe(T2)
    const deletes: number[] = []
    stubGraph([{ id: 7, createdAt: EDGE1 }, { id: 8, createdAt: EDGE2 }], deletes)
    const r2 = await undoGraphChange(1, gc([8]), resolveTurnStart(msgs, gc([8])))
    expect(deletes).toEqual([8])
    expect(r2.undone).toBe(1)
    // 撤销回合 1 的 part（[7]）：从最新往回扫，回合 2 的 g1 因 relationIds 不同被跳过 → 起点 = T1
    expect(resolveTurnStart(msgs, gc([7]))).toBe(T1)
    const r1 = await undoGraphChange(1, gc([7]), resolveTurnStart(msgs, gc([7])))
    expect(deletes).toEqual([8, 7])
    expect(r1.undone).toBe(1)
  })

  it('(c) 回合间手动建边后被后一回合改写：守卫拒删手动边', async () => {
    // 回合 2 upsert 了回合间手动创建的边 9（createdAt 在 T1 与 T2 之间），仍报 addRelation+[9]
    const msgs = [aiMsg(1, T1, [gc([7])]), aiMsg(2, T2, [gc([9])])]
    expect(resolveTurnStart(msgs, gc([9]))).toBe(T2)
    const deletes: number[] = []
    stubGraph([{ id: 9, createdAt: MANUAL }], deletes)
    const r = await undoGraphChange(1, gc([9]), resolveTurnStart(msgs, gc([9])))
    expect(deletes).toEqual([])
    expect(r.failed).toBe(1)
    expect(r.message).toContain('本回合前已存在')
  })
})

describe('ChatDrawer 抽屉宽度夹紧（D30：300–560px）', () => {
  it('拖柄拖动被夹到 300–560', async () => {
    const agent = fakeAgent()
    render(h(createElement(ChatDrawerWithSession, { graphId: 1, entry: { type: 'graph' }, onClose: () => {}, api: agent })))
    const drawer = await screen.findByTestId('chat-drawer')
    await waitFor(() => expect(drawer.textContent).toContain('测试图谱'))

    const rz = screen.getByTestId('chat-rz')
    fireEvent.pointerDown(rz, { clientX: 800 })
    fireEvent.pointerMove(window, { clientX: 200 })
    fireEvent.pointerUp(window)
    expect(drawer.style.width).toBe(`${CHAT_MAX_W}px`)
    fireEvent.pointerDown(rz, { clientX: 800 })
    fireEvent.pointerMove(window, { clientX: 5000 })
    fireEvent.pointerUp(window)
    expect(drawer.style.width).toBe(`${CHAT_MIN_W}px`)
    expect(localStorage.getItem('graphictero.chatWidth')).toBe(String(CHAT_MIN_W))
  })

  it('入口对象行：paper 入口显示论文真实标题（建议修 #7）', async () => {
    const agent = fakeAgent()
    render(h(createElement(ChatDrawerWithSession, { graphId: 1, entry: { type: 'paper', paperId: 7 }, onClose: () => {}, api: agent })))
    const drawer = await screen.findByTestId('chat-drawer')
    await waitFor(() => expect(drawer.textContent).toContain('测试论文'))
  })

  it('App 注入的 pendingChips（quote）合入 chip 区并回执清空', async () => {
    const agent = fakeAgent()
    const consumed = vi.fn()
    const { rerender } = render(
      h(
        createElement(ChatDrawerWithSession, {
          graphId: 1,
          entry: { type: 'paper', paperId: 7 },
          onClose: () => {},
          api: agent,
          pendingChips: [],
          onPendingChipsConsumed: consumed
        })
      )
    )
    await screen.findByTestId('chat-drawer')
    rerender(
      h(
        createElement(ChatDrawerWithSession, {
          graphId: 1,
          entry: { type: 'paper', paperId: 7 },
          onClose: () => {},
          api: agent,
          pendingChips: [{ kind: 'quote', paperId: 7, page: 0, text: '阅读器选中的文字' }],
          onPendingChipsConsumed: consumed
        })
      )
    )
    await waitFor(() => expect(screen.getByTestId('chat-chips').textContent).toContain('阅读器选中的文字'))
    expect(consumed).toHaveBeenCalled()
  })
})


describe('uat7 D176–D178 对话上下文与费用显示', () => {
  it('D177：+ 弹层长标题有完整 title tooltip 与单行省略类，弹层标记为 Esc 层', async () => {
    const longTitle = `Long paper ${'x'.repeat(150)}`
    ;(window as unknown as { graphictero: { listLibrary: () => Promise<unknown[]> } }).graphictero.listLibrary = async () => [
      { id: 5, title: longTitle, firstAuthor: null, year: null, hasPdf: false, inGraph: true }
    ]
    const agent = fakeAgent()
    render(h(createElement(ChatDrawerWithSession, { graphId: 1, entry: { type: 'graph' }, onClose: () => {}, api: agent })))
    fireEvent.click(await screen.findByTestId('chat-at'))
    const menu = await screen.findByTestId('chat-at-menu')
    expect(menu.hasAttribute('data-esc-popover')).toBe(true)
    const item = await screen.findByTestId('chat-at-item')
    const name = item.querySelector('.gt-sess-item-name')!
    expect(name.getAttribute('title')).toBe(longTitle)
    expect(name.classList.contains('gt-sess-item-name')).toBe(true) // CSS 省略规则由静态守卫覆盖
  })

  it('D176：App 注入多个 paper chip 按 id 去重并在库标题到达后更新', async () => {
    ;(window as unknown as { graphictero: { listLibrary: () => Promise<unknown[]> } }).graphictero.listLibrary = async () => [
      { id: 5, title: '论文五完整标题', firstAuthor: null, year: null, hasPdf: true, inGraph: true },
      { id: 6, title: '论文六完整标题', firstAuthor: null, year: null, hasPdf: true, inGraph: true }
    ]
    const agent = fakeAgent()
    render(
      h(createElement(ChatDrawerWithSession, {
        graphId: 1, entry: { type: 'graph' }, onClose: () => {}, api: agent,
        pendingChips: [{ kind: 'paper', paperId: 5 }, { kind: 'paper', paperId: 6 }, { kind: 'paper', paperId: 5 }]
      }))
    )
    await waitFor(() => expect(screen.getAllByTestId('chat-chip')).toHaveLength(2))
    await waitFor(() => expect(screen.getByTestId('chat-chips').textContent).toContain('论文五完整标题'))
    expect(screen.getByTestId('chat-chips').textContent).toContain('论文六完整标题')
  })

  it('D178：底部保留模型名，非零费用数据也不渲染 ¥', async () => {
    const agent = fakeAgent()
    render(h(createElement(ChatDrawerWithSession, { graphId: 1, entry: { type: 'graph' }, onClose: () => {}, api: agent })))
    const drawer = await screen.findByTestId('chat-drawer')
    await waitFor(() => expect(drawer.textContent).toContain('deepseek-flash'))
    expect(screen.getByTestId('chat-cost').textContent).not.toContain('¥')
    expect(screen.getByTestId('chat-cost').textContent).not.toContain('对话')
    expect(screen.getByTestId('chat-cost').textContent).not.toContain('后台')
  })

  it('D178：assistant 带非零 costCny 仍不渲染每回合金额', () => {
    render(h(createElement(MessageList, {
      running: false,
      messages: [{ id: 1, role: 'assistant', parts: [{ type: 'text', text: '回答' }], createdAt: '', costCny: 3.21 }]
    })))
    expect(screen.getByTestId('chat-messages').textContent).not.toContain('¥')
    expect(screen.queryByTestId('msg-cost')).toBeNull()
  })
})
