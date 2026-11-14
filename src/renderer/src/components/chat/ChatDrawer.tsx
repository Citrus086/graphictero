import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CardLiveQuery, CardLiveState, ChatMessageView, ContextRef } from '../../../../shared/ipc/agent'
import type { CandidateView } from '../../../../shared/ipc/agent'
import type { PaperSummary } from '../../../../shared/ipc'
import type { GraphChangePart, PaperCardPart } from '../../../../shared/parts'
import { agentApi, useAgentSession, type AgentSession, type ChatEntry } from '../../lib/useAgentSession'
import { useNotify } from '../../lib/notify'
import { Ic } from '../../lib/icons'
import { PartsHostContext, type PartsHost } from '../richtext/PartsHostContext'
import { shortIdReplaceForDisplay } from '../../lib/shortIds'
import { MessageList } from './MessageList'
import { SessionPicker } from './SessionPicker'
import { ContextChips, addChip, removeChip, type ChatChip } from './ContextChips'
import { undoGraphChange } from './graphChangeUndo'
import { candidateIdOfPartId } from '../../lib/candProgress'
import { MotionPresence } from '../MotionPresence'

/**
 * M5 lane/chat：对话抽屉（D30，原型 02/03/06/07 右侧抽屉）。批 3：hook 上提 App 级
 * （本组件只消费 sess，隐藏/换入口不再丢运行态）；候选卡片与改图小结的宿主回调
 * （PartsHostContext 注入：确认/忽略/加入图谱、定位、⌘Z 撤销组）。
 *
 * - 顶栏：会话下拉（新建/重命名/删除二次确认 D122，按时间）+ 新建会话（⌘N）+ 收起；
 *   入口对象行（整张图谱 / 论文 · 标题 / 关系 · A → B，真实标签）。
 * - 左侧拖柄调宽 300–560px（持久化 localStorage）；z-index 61——07 阅读器 modal（mask z-60）
 *   之上，选区弹层（z-70）之下。
 * - 消息流复用 PartsView（D19）；data-paper-card / data-graph-change 的交互经宿主回调；
 *   候选状态经 event:agent:candidates + listCandidates 与画布虚线节点两处同步（D117）。
 * - 上下文 chip（ContextChips）：quote（阅读器「发给 agent」）/ @ 选论文 / 画布拖入；
 *   随 send 的 contextRefs 发出后清空；切入口清空，会话内切换保留。
 */
function cardQueriesOf(messages: ChatMessageView[]): CardLiveQuery[] {
  const out: CardLiveQuery[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== 'data-paper-card' || part.id == null || part.id.length === 0) continue
      out.push({
        key: part.id,
        candidateId: candidateIdOfPartId(part.id),
        paperId: part.existingPaperId ?? null,
        doi: part.doi ?? null,
        arxivId: part.arxivId ?? null
      })
    }
  }
  return out
}

const WIDTH_KEY = 'graphictero.chatWidth'
export const CHAT_MIN_W = 300
export const CHAT_MAX_W = 560
const CHAT_DEFAULT_W = 360

export function clampChatWidth(w: number): number {
  return Math.min(CHAT_MAX_W, Math.max(CHAT_MIN_W, Math.round(w)))
}

export function ChatDrawer({
  graphId,
  entry,
  sess,
  onClose,
  pendingChips,
  onPendingChipsConsumed,
  onLocateGraphChange,
  onLocateCandidate,
  agentRunning,
  dropActive
}: {
  graphId: number
  entry: ChatEntry
  /** App 级 useAgentSession（批 3 上提：隐藏/换入口不丢运行态） */
  sess: AgentSession
  onClose: () => void
  /** App 级注入的待发送上下文（07「发给 agent」quote chip）；消费后回调清空 */
  pendingChips?: ContextRef[]
  onPendingChipsConsumed?: () => void
  /** 改图小结「定位」→ 画布 flash（App 转发 GraphPage） */
  onLocateGraphChange?: (part: GraphChangePart) => void
  /** D182（uat6b）：「已在待确认候选中」卡片「定位」→ 画布高亮候选节点 */
  onLocateCandidate?: (part: PaperCardPart, paperId?: number | null) => void
  /** Agent 运行中（D77/D88）：撤销组入口禁用 */
  agentRunning?: boolean
  /** D176：已选节点 pointer 拖拽悬停在抽屉上 */
  dropActive?: boolean
}): React.JSX.Element {
  const notify = useNotify()
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(WIDTH_KEY))
    return clampChatWidth(Number.isFinite(saved) && saved > 0 ? saved : CHAT_DEFAULT_W)
  })
  const [entryLabel, setEntryLabel] = useState('')
  const [text, setText] = useState('')
  /** 待发送上下文 chip（入口内附件：发送后 / 切入口后清空） */
  const [chips, setChips] = useState<ChatChip[]>([])
  const [library, setLibrary] = useState<PaperSummary[]>([])
  const [candidates, setCandidates] = useState<CandidateView[]>([])
  const [cardLive, setCardLive] = useState<CardLiveState[]>([])
  const [cardLiveNonce, setCardLiveNonce] = useState(0)
  /** uat5 建议修 5：图内成员（P0x→《短标题》显示层替换用） */
  const [members, setMembers] = useState<Array<{ paper: PaperSummary }>>([])
  const [showPicker, setShowPicker] = useState(false)
  const [pinBottom, setPinBottom] = useState(0)

  // 入口对象行真实标签：图谱名 / 论文标题 / 关系两端标题
  useEffect(() => {
    let disposed = false
    const load = async (): Promise<void> => {
      try {
        if (entry.type === 'graph') {
          const d = await window.graphictero.getGraph(graphId)
          if (disposed) return
          setEntryLabel(d.graph.name)
          setMembers(d.members)
        } else if (entry.type === 'paper') {
          const m = await window.graphictero.getPaperMeta(entry.paperId)
          if (!disposed) setEntryLabel((m && m.title) || `论文 #${entry.paperId}`)
        } else {
          const d = await window.graphictero.getGraph(graphId)
          if (disposed) return
          setMembers(d.members)
          const rel = d.relations.find((r) => r.id === entry.relationId)
          if (disposed) return
          if (!rel) {
            setEntryLabel(`关系 #${entry.relationId}`)
            return
          }
          const titleOf = (pid: number): string => d.members.find((mm) => mm.paper.id === pid)?.paper.title ?? `#${pid}`
          const dst = rel.srcPaper === rel.paperLow ? rel.paperHigh : rel.paperLow
          const short = (t: string): string => (t.length > 12 ? `${t.slice(0, 12)}…` : t)
          setEntryLabel(`关系 · ${short(titleOf(rel.srcPaper))} → ${short(titleOf(dst))}`)
        }
      } catch {
        if (!disposed) setEntryLabel('')
      }
    }
    void load()
    return () => {
      disposed = true
    }
  }, [graphId, entry])

  // 论文库（@ 选论文 / 拖入论文行的标题解析）+ 候选（卡片状态与画布虚线节点两处同步）
  useEffect(() => {
    let disposed = false
    window.graphictero
      .listLibrary(graphId)
      .then((lib) => !disposed && setLibrary(lib))
      .catch(() => {})
    agentApi()
      .listCandidates(graphId)
      .then((cs) => !disposed && setCandidates(cs))
      .catch(() => {})
    const unsub = agentApi().onAgentCandidates((e) => {
      if (e.graphId !== graphId) return
      setCandidates(e.candidates)
    })
    return () => {
      disposed = true
      unsub()
    }
  }, [graphId])

  // D191：旧卡片按当前库刷新。加入 / 移除 / 删除 / 忽略 / 确认 / ⌘Z 都会让 nonce 加一。
  const cardQueryKey = JSON.stringify(cardQueriesOf(sess.messages))
  useEffect(() => {
    const bump = (): void => setCardLiveNonce((n) => n + 1)
    window.addEventListener('gt:graph-changed', bump)
    const unsub = agentApi().onAgentCandidates((e) => {
      if (e.graphId === graphId) bump()
    })
    return () => {
      window.removeEventListener('gt:graph-changed', bump)
      unsub()
    }
  }, [graphId])
  useEffect(() => {
    let disposed = false
    const queries = JSON.parse(cardQueryKey) as CardLiveQuery[]
    if (queries.length === 0) {
      setCardLive([])
      return
    }
    agentApi()
      .cardLiveStates(graphId, queries)
      .then((rows) => {
        if (!disposed) setCardLive(rows)
      })
      .catch(() => {})
    return () => {
      disposed = true
    }
  }, [graphId, cardQueryKey, cardLiveNonce])

  // 发送期校验失败（busy/invalid，无 turn-start 前导）：提示；乐观 user 消息已由 hook 保留
  useEffect(() => {
    if (!sess.sendError) return
    notify(`发送失败：${sess.sendError.message}`)
    sess.clearSendError()
  }, [sess, notify])

  // 待发送 chip 属于入口（entry）：切换入口清空（须在 pendingChips 注入之前声明，
  // 否则「发给 agent」换入口注入的 quote chip 会被先清掉）；会话内新建/切换会话保留
  const entryKey = `${graphId}:${entry.type}:${entry.type === 'paper' ? entry.paperId : entry.type === 'relation' ? entry.relationId : ''}`
  useEffect(() => {
    setChips([])
  }, [entryKey])

  // App 级注入的 quote chip（07「发给 agent」）：合入待发送区并回执清空
  useEffect(() => {
    if (!pendingChips || pendingChips.length === 0) return
    setChips((cs) => pendingChips.reduce((acc, ref) => addChip(acc, chipOf(ref)), cs))
    onPendingChipsConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingChips])

  // ⌘N / Ctrl+N 新建会话（原型菜单标注）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'n') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      e.preventDefault()
      void sess.createSession().catch(() => notify('新建会话失败'))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sess, notify])

  const chipOf = useCallback(
    (ref: ContextRef): ChatChip => {
      if (ref.kind === 'quote') {
        const head = ref.text.length > 24 ? `${ref.text.slice(0, 24)}…` : ref.text
        return { ref, label: `p.${(ref.page ?? 0) + 1}「${head}」` }
      }
      const title = library.find((p) => p.id === ref.paperId)?.title ?? `论文 #${ref.paperId}`
      return { ref, label: title.length > 18 ? `${title.slice(0, 18)}…` : title }
    },
    [library]
  )

  // App 注入可能先于 listLibrary 返回：标题到达后把「论文 #id」升级为真实 18 字 chip。
  useEffect(() => {
    setChips((cs) => cs.map((c) => (c.ref.kind === 'paper' ? chipOf(c.ref) : c)))
  }, [chipOf])

  const addPaperChip = useCallback(
    (paperId: number): void => {
      setChips((cs) => addChip(cs, chipOf({ kind: 'paper', paperId })))
    },
    [chipOf]
  )

  // ── 候选卡片动作（D117）与改图小结动作（D119）──

  const candidateFor = useCallback((part: PaperCardPart): CandidateView | undefined => resolveCandidate(candidates, part), [candidates])

  const doCandidateAction = useCallback(
    (part: PaperCardPart, action: 'confirm' | 'ignore'): Promise<void> => {
      const cand = candidateFor(part)
      if (!cand) {
        notify('找不到对应候选（画布与卡片状态由 event:agent:candidates 同步）')
        return Promise.resolve()
      }
      const call = action === 'confirm' ? agentApi().candidateConfirm(cand.id) : agentApi().candidateIgnore(cand.id)
      // uat6b S4(a)：把 IPC promise 返回给卡片——卡片据此把 busy 守到 finally（同 tick 双击 / 慢 IPC 都挡住）
      return call
        .then(() => {
          if (action === 'confirm') {
            window.dispatchEvent(new CustomEvent('gt:graph-changed'))
            notify('已确认加入')
          } else {
            notify('已忽略')
          }
        })
        .catch((e: unknown) => {
          notify(e instanceof Error ? e.message : '操作失败，请重试')
        })
    },
    [candidateFor, notify]
  )

  const doUndoGraphChange = useCallback(
    async (part: GraphChangePart): Promise<boolean> => {
      // 回合起点（必须修 1，D104）：用于区分「本回合新建的边」与「upsert 改写的既有边」。
      // 批 5：runtime 的改图 part id 每回合从 g1 重编号——必须按「最新往回 + id/changeType/
      // relationIds 三重匹配」解析（resolveTurnStart），否则第二个改图回合起会解析到上一回合，
      // 守卫失效、误删上一回合或回合间手动建的边。
      try {
        const r = await undoGraphChange(graphId, part, resolveTurnStart(sess.messages, part))
        notify(r.message)
        if (r.undone > 0) {
          window.dispatchEvent(new CustomEvent('gt:graph-changed'))
          // uat5 D172：撤销成功后追加系统记录——不作用户消息，下一轮上下文可见
          const sid = sess.current?.id
          if (sid != null) {
            agentApi()
              .appendSystemNote(sid, `用户已撤销上一轮对图谱的 ${r.undone} 条改动`)
              .catch(() => {})
          }
        }
        return r.undone > 0
      } catch {
        notify('撤销失败，请重试')
        return false
      }
    },
    [graphId, notify, sess.messages, sess.current]
  )

  const partsHost = useMemo<PartsHost>(
    () => ({
      onCandidateAction: doCandidateAction,
      candidateStatusOf: (part) => {
        const st = candidateFor(part)?.status
        // D169：dismissed（已在本图谱自动收起）在卡片上按 candidate 展示——
        // 「已在本图谱中」徽标与无确认按钮的口径不变
        return st == null || st === 'pending' || st === 'dismissed' ? null : st
      },
      cardLiveOf: (part) => {
        if (part.id == null) return null
        const row = cardLive.find((item) => item.key === part.id)
        return row != null && row.kind !== 'unknown' ? row : null
      },
      onLocateGraphChange: (part) => onLocateGraphChange?.(part),
      onLocateCandidate: (part, paperId) => onLocateCandidate?.(part, paperId),
      onUndoGraphChange: doUndoGraphChange,
      undoDisabled: agentRunning === true,
      // uat5 建议修 5：回复 / 改图小结里的 P0x 显示时换成《短标题》（只展示不写库）
      replaceShortIdsForDisplay: shortIdReplaceForDisplay(members)
    }),
    [doCandidateAction, candidateFor, cardLive, onLocateGraphChange, onLocateCandidate, doUndoGraphChange, agentRunning, members]
  )

  const onResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = width
      const onMove = (ev: PointerEvent): void => setWidth(clampChatWidth(startW + (startX - ev.clientX)))
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        setWidth((w) => {
          localStorage.setItem(WIDTH_KEY, String(w))
          return w
        })
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [width]
  )

  const doSend = useCallback(async (): Promise<void> => {
    const t = text.trim()
    if (!t || sess.running) return
    setPinBottom((n) => n + 1)
    setText('')
    const refs = chips.map((c) => c.ref)
    try {
      await sess.send(t, refs)
      setChips([])
    } catch {
      // 发送失败：恢复输入原文与 chip（hook 已回滚乐观 user 消息）
      setText(t)
      notify('发送失败，请稍后重试')
    }
  }, [text, sess, chips, notify])

  const doRetry = useCallback(
    (messageId: number): void => {
      void sess.retryMessage(messageId).catch(() => notify('重试失败，请稍后重试'))
    },
    [sess, notify]
  )

  // @ 选论文弹层：点别处关闭；Esc 在 capture 只关本层，不让同一次 Esc 清画布选择。
  useEffect(() => {
    if (!showPicker) return
    const close = (): void => setShowPicker(false)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      setShowPicker(false)
    }
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [showPicker])

  const entryTitle =
    entry.type === 'graph' ? `整张图谱${entryLabel ? ` · ${entryLabel}` : ''}` : entry.type === 'paper' ? `论文 · ${entryLabel}` : entryLabel
  const placeholder =
    entry.type === 'paper' ? '问问这篇论文…' : entry.type === 'relation' ? '问问这条关系…' : '输入问题，Enter 发送（Shift+Enter 换行）'

  return (
    <aside
      className={`gt-chat-drawer${dropActive ? ' gt-chat-drop-active' : ''}`}
      data-testid="chat-drawer"
      data-drop-active={dropActive ? 'true' : undefined}
      style={{ width }}
    >
      <div
        className="gt-chat-rz"
        data-testid="chat-rz"
        title="拖动调整宽度"
        onPointerDown={onResizeStart}
      />
      <div className="gt-chat-head">
        <SessionPicker
          sessions={sess.sessions}
          currentId={sess.current?.id ?? null}
          onSelect={sess.selectSession}
          onCreate={() => void sess.createSession().catch(() => notify('新建会话失败'))}
          onRename={(id, name) => void sess.renameSession(id, name).catch(() => notify('重命名失败'))}
          onDelete={(id) => void sess.deleteSession(id).catch(() => notify('删除会话失败'))}
        />
        <div className="grow" />
        <button
          type="button"
          className="btn icon"
          data-testid="chat-new-session"
          title="新建会话 ⌘N"
          onClick={() => void sess.createSession().catch(() => notify('新建会话失败'))}
        >
          <Ic name="plus" size={15} />
        </button>
        <button type="button" className="btn icon" data-testid="chat-collapse" title="收起" onClick={onClose}>
          <Ic name="back" size={15} />
        </button>
      </div>

      <div className="gt-chat-entry" data-testid="chat-entry">
        <Ic name={entry.type === 'graph' ? 'tree' : entry.type === 'paper' ? 'doc' : 'arrowD'} size={13} />
        <b>{entryTitle}</b>
        <span>· {sess.sessions.length} 个会话</span>
      </div>

      <PartsHostContext.Provider value={partsHost}>
        <MessageList
          messages={sess.messages}
          running={sess.running}
          onRetry={doRetry}
          anchor={sess.currentId}
          pinBottom={pinBottom}
          entryKind={entry.type}
          replaceText={partsHost.replaceShortIdsForDisplay}
        />
      </PartsHostContext.Provider>

      <div className="gt-chat-composer" onClick={(e) => e.stopPropagation()}>
        <ContextChips chips={chips} onRemove={(key) => setChips((cs) => removeChip(cs, key))} onDropPaper={addPaperChip} />
        <div className="gt-chat-inputrow">
          <div className="gt-chat-at">
            <button
              type="button"
              className="btn icon"
              data-testid="chat-at"
              title="添加上下文：@ 论文 / 从画布拖入"
              disabled={sess.running}
              onClick={(e) => {
                e.stopPropagation()
                setShowPicker((v) => !v)
              }}
            >
              <Ic name="plus" size={14} w={1.8} />
            </button>
            <MotionPresence open={showPicker} kind="pop">
              {showPicker ? (
              <div className="menu gt-at-menu" data-testid="chat-at-menu" data-esc-popover style={{ bottom: '100%' }}>
                <div className="cap" style={{ padding: '6px 10px 4px' }}>
                  添加上下文 · 本图谱论文库
                </div>
                {library.length === 0 && <div className="t3 sm" style={{ padding: '4px 10px 6px' }}>论文库为空</div>}
                {library.slice(0, 30).map((p) => (
                  <div
                    key={p.id}
                    className="mi"
                    data-testid="chat-at-item"
                    onClick={() => {
                      setShowPicker(false)
                      addPaperChip(p.id)
                    }}
                  >
                    <span className="gt-sess-item-name" title={p.title}>{p.title}</span>
                  </div>
                ))}
              </div>
              ) : null}
            </MotionPresence>
          </div>
          <textarea
            className="ta gt-chat-input"
            data-testid="chat-input"
            rows={2}
            placeholder={placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void doSend()
              }
            }}
          />
          {sess.running ? (
            <button type="button" className="btn bordered gt-chat-stop" data-testid="chat-stop" onClick={() => void sess.stop()}>
              停止
            </button>
          ) : (
            <button
              type="button"
              className="btn primary gt-chat-send"
              data-testid="chat-send"
              disabled={!text.trim()}
              onClick={() => void doSend()}
            >
              发送
            </button>
          )}
        </div>
        <div className="gt-chat-cost" data-testid="chat-cost">
          <span className="gt-chat-model" data-testid="chat-model" title="Agent 对话模型（D24）">
            deepseek-flash
          </span>
        </div>
      </div>
    </aside>
  )
}

/** 测试辅助：把 hook 与抽屉组合（App 级上提的等价形态） */
export function ChatDrawerWithSession(props: {
  graphId: number
  entry: ChatEntry
  onClose: () => void
  api?: Parameters<typeof useAgentSession>[0]['api']
  pendingChips?: ContextRef[]
  onPendingChipsConsumed?: () => void
  onLocateGraphChange?: (part: GraphChangePart) => void
  onLocateCandidate?: (part: PaperCardPart, paperId?: number | null) => void
  agentRunning?: boolean
}): React.JSX.Element {
  const sess = useAgentSession({ graphId: props.graphId, entry: props.entry, api: props.api })
  return (
    <ChatDrawer
      graphId={props.graphId}
      entry={props.entry}
      sess={sess}
      onClose={props.onClose}
      pendingChips={props.pendingChips}
      onPendingChipsConsumed={props.onPendingChipsConsumed}
      onLocateGraphChange={props.onLocateGraphChange}
      onLocateCandidate={props.onLocateCandidate}
      agentRunning={props.agentRunning}
    />
  )
}

/**
 * 卡片 part → 候选行匹配（建议修 1，review_lane_chat3）：main 的产出端已定 part.id = `c${view.id}`
 * （9a797a6），按 id 精确命中——同标题重复候选（lane/agent 明确不去重）下也不会操作错行；
 * id 解析失败（如 mock 的 'card-*'）回退 title/DOI 匹配。
 */
export function resolveCandidate(candidates: CandidateView[], part: PaperCardPart): CandidateView | undefined {
  if (part.id.startsWith('c')) {
    const id = Number(part.id.slice(1))
    // 产出端（9a797a6）已定 part.id = c${view.id}：数字形态解析成功即按 id 定论——
    // 无命中也直接返回 undefined，不回退（防同标题误操作）
    if (Number.isInteger(id) && id > 0) return candidates.find((c) => c.id === id)
  }
  // 回退（mock 的 'card-*' 等非数字形态）：DOI 精确优先，再 title
  if (part.doi != null) {
    const byDoi = candidates.find((c) => c.doi === part.doi)
    if (byDoi) return byDoi
  }
  return candidates.find((c) => c.title === part.title)
}

/**
 * 改图 part → 宿主消息（回合起点）解析（批 5 必须修 1，review_lane_chat4 §三）：
 * runtime 的改图 part id **每回合从 g1 重编号**——同一会话第二个改图回合起 part.id 与上一回合
 * 撞车。从最新消息往回扫，匹配收紧为 id + changeType + relationIds（内容相同，与顺序无关）；
 * 取最新命中消息的 createdAt 作为回合起点，防止守卫被旧回合的同名 part 绕过。
 */
export function resolveTurnStart(messages: ChatMessageView[], part: GraphChangePart): string | null {
  const sameRelations = (a: number[], b: number[]): boolean =>
    a.length === b.length && a.every((id) => b.includes(id))
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    const hit = m.parts.some(
      (p) => p.type === 'data-graph-change' && p.id === part.id && p.changeType === part.changeType && sameRelations(p.relationIds, part.relationIds)
    )
    if (hit) return m.createdAt
  }
  return null
}
