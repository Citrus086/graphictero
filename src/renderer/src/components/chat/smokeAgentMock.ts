import type {
  AgentApi,
  AgentCandidatesEvent,
  AgentStreamEvent,
  ChatMessageView,
  CreateSessionInput,
  SendInput,
  SessionSummary
} from '../../../../shared/ipc/agent'
import type { DetailPart } from '../../../../shared/parts'

/**
 * M5 lane/chat 批 1 冒烟专用 mock（task_lane_chat1：渲染层测试注入，不动冻结文件）。
 *
 * 只在 `?smoke=1`（useAgentSession 的冒烟开关）时接管渲染层 AgentApi——主进程 agent IPC
 * 骨架（lane/agent 车道实装中）此时尚为「未实现」。内存会话 + 定时器驱动的假流式：
 * turn-start → text part 增量（partId='text'）→ data-trace 行 → 续写 → part-done →
 * turn-end（带本回合费用，D96-② 口径）；stop 取消后续增量、保留已生成内容并回 'stopped'。
 * 全程无网络、无真实数据。
 */

interface PendingTimers {
  timers: ReturnType<typeof setTimeout>[]
  add(t: ReturnType<typeof setTimeout>): void
  clear(): void
}

export function createSmokeAgentMock(): AgentApi {
  let nextSessionId = 1
  let nextMsgId = 1
  let turnSeq = 0
  const sessions = new Map<number, SessionSummary>()
  const messages = new Map<number, ChatMessageView[]>()
  const costs = new Map<number, number>()
  const streamListeners = new Set<(e: AgentStreamEvent) => void>()
  const candidateListeners = new Set<(e: AgentCandidatesEvent) => void>()
  /** M5 批 3：graph_candidates 的内存 mock（卡片与画布虚线节点两处同步，D117） */
  let nextCandidateId = 1
  const candidates = new Map<number, import('../../../../shared/ipc/agent').CandidateView>()
  const emitCandidates = (graphId: number, sessionId: number | null): void => {
    const list = [...candidates.values()].filter((c) => c.graphId === graphId)
    candidateListeners.forEach((cb) => cb({ graphId, sessionId, candidates: list }))
  }
  /** 每会话进行中的回合（stop 用）；partsBox 与 send 闭包共享——stop 时保留已生成内容，
   * finish/stop 把累积的完整 parts（text + trace 交错）存成权威消息 */
  const activeTurns = new Map<
    number,
    { seq: number; pending: PendingTimers; partsBox: { parts: DetailPart[]; textPart: { type: 'text'; text: string } | null } }
  >()

  const emitStream = (e: AgentStreamEvent): void => streamListeners.forEach((cb) => cb(e))
  const now = (): string => new Date().toISOString()

  function makePending(): PendingTimers {
    const pending: PendingTimers = { timers: [], add(t) { this.timers.push(t) }, clear() { this.timers.forEach(clearTimeout); this.timers = [] } }
    return pending
  }

  function pushMessage(sessionId: number, msg: ChatMessageView): void {
    const list = messages.get(sessionId) ?? []
    list.push(msg)
    messages.set(sessionId, list)
  }

  return {
    listSessions(graphId, entryType, entryId) {
      const list = [...sessions.values()]
        .filter((s) => s.graphId === graphId && s.entryType === entryType && s.entryId === entryId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      return Promise.resolve(list)
    },
    createSession(input: CreateSessionInput) {
      const s: SessionSummary = {
        id: nextSessionId++,
        graphId: input.graphId,
        entryType: input.entryType,
        entryId: input.entryId,
        name: input.name ?? '新会话',
        updatedAt: now()
      }
      sessions.set(s.id, s)
      messages.set(s.id, [])
      costs.set(s.id, 0)
      return Promise.resolve(s)
    },
    renameSession(sessionId, name) {
      const s = sessions.get(sessionId)
      if (s) s.name = name
      return Promise.resolve()
    },
    deleteSession(sessionId) {
      // D122 语义的 mock 版：会话 + 消息级联删除，费用清零（真实实现由 lane/agent 落库）
      sessions.delete(sessionId)
      messages.delete(sessionId)
      costs.delete(sessionId)
      return Promise.resolve()
    },
    getMessages(sessionId) {
      return Promise.resolve(messages.get(sessionId) ?? [])
    },
    sessionCost(sessionId) {
      return Promise.resolve(costs.get(sessionId) ?? 0)
    },
    sessionCostBreakdown(sessionId) {
      const total = costs.get(sessionId) ?? 0
      return Promise.resolve({ chat: total, background: 0, total })
    },
    send(input: SendInput) {
      const s = sessions.get(input.sessionId)
      if (!s) return Promise.reject(new Error('会话不存在'))
      const sessionId = input.sessionId
      const turnId = `smoke-turn-${++turnSeq}`
      const mySeq = turnSeq
      s.updatedAt = now()
      pushMessage(sessionId, { id: nextMsgId++, role: 'user', parts: [{ type: 'text', text: input.text }], createdAt: now() })

      const partsBox: { parts: DetailPart[]; textPart: { type: 'text'; text: string } | null } = {
        parts: [],
        textPart: null
      }
      const acc = (): string => partsBox.textPart?.text ?? ''
      const pending = makePending()
      activeTurns.set(sessionId, { seq: mySeq, pending, partsBox })
      const schedule = (ms: number, fn: () => void): void => pending.add(setTimeout(fn, ms))
      const finish = (turnCost: number, kind: 'turn-end' | 'stopped'): void => {
        if (activeTurns.get(sessionId)?.seq !== mySeq) return
        activeTurns.delete(sessionId)
        pending.clear()
        const total = (costs.get(sessionId) ?? 0) + turnCost
        costs.set(sessionId, total)
        pushMessage(sessionId, {
          id: nextMsgId++,
          role: 'assistant',
          parts: partsBox.parts,
          createdAt: now(),
          costCny: turnCost
        })
        if (kind === 'turn-end') emitStream({ sessionId, turnId, kind, costCny: total })
        else emitStream({ sessionId, turnId, kind })
      }
      const delta = (d: string): void => {
        if (partsBox.textPart) partsBox.textPart.text += d
        emitStream({ sessionId, turnId, kind: 'part-delta', partId: 'text', delta: d })
      }

      // 假流式脚本：text 增量 → 中途一行读取记录（D8 trace）→ 续写 → 定稿。
      // 上下文 chip 回显：让 smoke 能断言 contextRefs 随 send 发出（D30）。
      const echo = input.contextRefs.length > 0 ? `收到 ${input.contextRefs.length} 个上下文标签。` : ''
      const deltas1 = [`${echo}冒烟回答：`, '这张图谱', '现有 5 篇论文', '。']
      const deltas2 = ['其中 2 篇', '已生成详情', '，其余仍是名片。']
      schedule(60, () => emitStream({ sessionId, turnId, kind: 'turn-start' }))
      schedule(120, () => {
        partsBox.textPart = { type: 'text', text: '' }
        partsBox.parts.push(partsBox.textPart)
        emitStream({ sessionId, turnId, kind: 'part-start', part: { type: 'text', text: '' } })
      })
      // 03f 数据源：消息含「冒烟失败」→ 中途出错（保留已生成内容 + error 挂消息上，口径 D）
      if (input.text.includes('冒烟失败')) {
        schedule(180, () => delta('失败前已生成的部分回答。'))
        schedule(320, () => {
          if (activeTurns.get(sessionId)?.seq !== mySeq) return
          activeTurns.delete(sessionId)
          pending.clear()
          costs.set(sessionId, (costs.get(sessionId) ?? 0) + 0.01)
          pushMessage(sessionId, {
            id: nextMsgId++,
            role: 'assistant',
            parts: partsBox.parts,
            createdAt: now(),
            error: '冒烟构造的回合失败（点击重试）',
            costCny: 0.01
          })
          emitStream({ sessionId, turnId, kind: 'error', message: '冒烟构造的回合失败（点击重试）' })
        })
        return Promise.resolve()
      }
      deltas1.forEach((d, i) => schedule(180 + i * 50, () => delta(d)))
      schedule(180 + deltas1.length * 50, () => {
        const trace = {
          type: 'data-trace' as const,
          toolName: 'getPapers',
          summary: '读取图谱成员列表（5 篇）',
          excerpt: 'Smoke Paper Alpha\nSmoke Paper Beta\nSmoke Paper Gamma\n冒烟缓存详情 Beta\nFigJump 冒烟图谱方法'
        }
        partsBox.parts.push(trace)
        emitStream({ sessionId, turnId, kind: 'trace', trace })
      })
      deltas2.forEach((d, i) => schedule(280 + deltas1.length * 50 + i * 50, () => delta(d)))
      schedule(340 + (deltas1.length + deltas2.length) * 50, () =>
        emitStream({ sessionId, turnId, kind: 'part-done', part: { type: 'text', text: acc() } })
      )

      // 批 3 触发器①「冒烟候选」：回合中段推两张候选卡片 + graph_candidates 行 + 候选事件
      if (input.text.includes('冒烟候选')) {
        schedule(600, () => {
          const t = now()
          const mk = (title: string, existingPaperId: number | null, x: number, y: number): import('../../../../shared/ipc/agent').CandidateView => ({
            id: nextCandidateId++,
            graphId: s.graphId,
            title,
            authors: ['Smoke Author'],
            year: 2024,
            doi: null,
            arxivId: null,
            existingPaperId,
            reason: '冒烟构造的候选（卡片与虚线节点两处同步）',
            x,
            y,
            status: 'pending',
            createdAt: t,
            updatedAt: t
          })
          const existing = mk('Smoke Candidate Existing', 1, 320, -140)
          const external = mk('Smoke Candidate External', null, 0, 0)
          candidates.set(existing.id, existing)
          candidates.set(external.id, external)
          const cardPart = (id: string, title: string, existingPaperId: number | null): DetailPart => ({
            type: 'data-paper-card',
            id,
            status: 'done',
            title,
            authors: ['Smoke Author'],
            year: 2024,
            reason: '冒烟构造的候选（卡片与虚线节点两处同步）',
            cardStatus: 'candidate',
            ...(existingPaperId != null ? { existingPaperId } : {})
          })
          // M6 lane/ui 批 1：part.id 用产出端口径 `c${view.id}`（9a797a6）——库外确认要按它
          // 解析 candidateId 发 cand:importConfirm；resolveCandidate 的 'card-*' 回退保留兼容
          partsBox.parts.push(cardPart(`c${existing.id}`, existing.title, 1), cardPart(`c${external.id}`, external.title, null))
          emitCandidates(s.graphId, sessionId)
        })
      }

      // 批 3 触发器②「冒烟改图」：回合中段推一条改图小结（addRelation，供定位 flash / 撤销组）
      if (input.text.includes('冒烟改图')) {
        schedule(600, () => {
          partsBox.parts.push({
            type: 'data-graph-change',
            id: 'gc-smoke-1',
            status: 'done',
            changeType: 'addRelation',
            relationIds: [1],
            paperIds: [1, 2],
            summary: '新增 1 条关系（冒烟构造）'
          })
        })
      }

      // M6 第 0 批触发器③「冒烟修改」（D143 起触发词改）：updateRelation 小结（含 snapshotIds）——
      // 显示「修改」+ 快照撤销还原（快照行由 smoke 主进程段预置，id=1）
      if (input.text.includes('冒烟修改')) {
        schedule(600, () => {
          partsBox.parts.push({
            type: 'data-graph-change',
            id: 'gc-smoke-overwrite',
            status: 'done',
            changeType: 'updateRelation',
            relationIds: [1],
            paperIds: [1, 2],
            snapshotIds: [1],
            summary: '修改关系 #1（原：对比 · 冒烟原关系陈述 · 自动生成 · 方向 P01→P02）→ P01→P02（对比）：冒烟修改后的陈述'
          })
        })
      }

      schedule(400 + (deltas1.length + deltas2.length) * 50, () => finish(0.06, 'turn-end'))
      return Promise.resolve()
    },
    stop(sessionId) {
      const active = activeTurns.get(sessionId)
      if (!active) return Promise.resolve()
      activeTurns.delete(sessionId)
      active.pending.clear()
      // 保留已生成内容（D53：停止保留已生成内容，回合标记 stopped 非错误）
      const turnId = `smoke-turn-${active.seq}`
      const total = (costs.get(sessionId) ?? 0) + 0.01
      costs.set(sessionId, total)
      pushMessage(sessionId, {
        id: nextMsgId++,
        role: 'assistant',
        parts: active.partsBox.parts,
        createdAt: now(),
        costCny: 0.01
      })
      const t = setTimeout(() => emitStream({ sessionId, turnId, kind: 'stopped' }), 30)
      active.pending.add(t)
      return Promise.resolve()
    },
    appendSystemNote(sessionId, text) {
      const msg: ChatMessageView = { id: nextMsgId++, role: 'system', parts: [{ type: 'text', text }], createdAt: now() }
      pushMessage(sessionId, msg)
      return Promise.resolve(msg)
    },
    retryMessage(sessionId, messageId) {
      // 03f：清错 + 走一小段流式（turn-start → 增量 → 定稿 → turn-end），把重试结果落库
      const list = messages.get(sessionId)
      const msg = list?.find((m) => m.id === messageId)
      if (!list || !msg) return Promise.reject(new Error('消息不存在'))
      const turnId = `smoke-turn-${++turnSeq}`
      const fixed: ChatMessageView = { ...msg, error: undefined }
      list[list.indexOf(msg)] = fixed
      const answer = '重试成功：这是重试后的回答。'
      const emitRetry = (ms: number, fn: () => void): void => {
        setTimeout(fn, ms)
      }
      emitRetry(40, () => {
        emitStream({ sessionId, turnId, kind: 'turn-start' })
        emitStream({ sessionId, turnId, kind: 'part-start', part: { type: 'text', text: '' } })
      })
      emitRetry(90, () => emitStream({ sessionId, turnId, kind: 'part-delta', partId: 'text', delta: answer }))
      emitRetry(150, () => {
        fixed.parts = [{ type: 'text', text: answer }]
        costs.set(sessionId, (costs.get(sessionId) ?? 0) + 0.02)
        emitStream({ sessionId, turnId, kind: 'part-done', part: { type: 'text', text: answer } })
        emitStream({ sessionId, turnId, kind: 'turn-end', costCny: costs.get(sessionId) ?? 0 })
      })
      return Promise.resolve()
    },
    listCandidates(graphId) {
      return Promise.resolve([...candidates.values()].filter((c) => c.graphId === graphId))
    },
    cardLiveStates() {
      return Promise.resolve([])
    },
    moveCandidate(candidateId, x, y) {
      const c = candidates.get(candidateId)
      if (!c) return Promise.reject(new Error('候选不存在'))
      c.x = x
      c.y = y
      c.updatedAt = now()
      emitCandidates(c.graphId, null)
      return Promise.resolve()
    },
    candidateConfirm(candidateId) {
      const c = candidates.get(candidateId)
      if (!c) return Promise.reject(new Error('候选不存在'))
      // D117：库外候选确认禁用（M6 接入）；「已在库中」→ 加入图谱（M5 可用，mock 只改状态）
      if (c.existingPaperId == null) return Promise.reject(new Error('库外候选的确认与入库 M6 接入'))
      c.status = 'confirmed'
      c.updatedAt = now()
      emitCandidates(c.graphId, null)
      return Promise.resolve(c)
    },
    candidateIgnore(candidateId) {
      const c = candidates.get(candidateId)
      if (!c) return Promise.reject(new Error('候选不存在'))
      c.status = 'ignored'
      c.updatedAt = now()
      emitCandidates(c.graphId, null)
      return Promise.resolve(c)
    },
    onSessionCost() {
      return () => {}
    },
    onAgentStream(cb) {
      streamListeners.add(cb)
      return () => streamListeners.delete(cb)
    },
    onAgentCandidates(cb) {
      candidateListeners.add(cb)
      return () => candidateListeners.delete(cb)
    }
  }
}
