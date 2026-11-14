import { useEffect, useRef } from 'react'
import type { ChatMessageView } from '../../../../shared/ipc/agent'
import { PartsView } from '../richtext/PartsView'

/** 距底部多近才自动跟随（评审建议修 #5：用户上翻历史时不被流式 delta 拽回底部） */
const FOLLOW_THRESHOLD_PX = 80

/**
 * M5 lane/chat：消息流（D30）。assistant 消息复用 PartsView（D19 共用渲染器，含
 * data-trace 灰色读取记录行）；用户消息右侧气泡；回合出错保留已生成内容 + 错误行 +
 * 「重试」（03f，retryMessage 由 ChatDrawer 接线）；流式「正在思考…」三点动画。
 */
export function MessageList({
  messages,
  running,
  onRetry,
  anchor,
  pinBottom,
  entryKind = 'graph',
  replaceText
}: {
  messages: ChatMessageView[]
  running: boolean
  onRetry?: (messageId: number) => void
  /** 会话锚点（sessionId）：变化/首次挂载强制落底（评审建 3），流式期间才用阈值跟随 */
  anchor?: number | null
  /** 发送时递增：不论是否离开底部，都滚到最新一条 */
  pinBottom?: number
  entryKind?: 'graph' | 'paper' | 'relation'
  /** uat5 建议修 5：回复文本的 P0x 显示层替换（只展示不写库） */
  replaceText?: (text: string) => string
}): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  const lastAnchor = useRef<number | null | undefined>(undefined)
  const lastPin = useRef<number | undefined>(undefined)
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const anchorChanged = lastAnchor.current === undefined || lastAnchor.current !== anchor
    const pinChanged = pinBottom !== undefined && lastPin.current !== pinBottom
    if (anchorChanged || pinChanged) {
      lastAnchor.current = anchor
      lastPin.current = pinBottom
      el.scrollTop = el.scrollHeight
      return
    }
    // 增量 append：仅当本就在底部附近（上翻阅读时不打扰）
    if (el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD_PX) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages, running, anchor, pinBottom])

  const last = messages[messages.length - 1]
  const showTyping = running && (!last || last.role !== 'assistant' || last.parts.length === 0)

  /** 展示前克隆 text part 做 P0x→《短标题》替换（不改动消息数据本身） */
  const displayParts = (m: ChatMessageView): typeof m.parts =>
    replaceText ? m.parts.map((p) => (p.type === 'text' ? { ...p, text: replaceText(p.text) } : p)) : m.parts

  return (
    <div className="gt-chat-msgs" data-testid="chat-messages" ref={boxRef}>
      {messages.length === 0 && !running && (
        <div className="gt-chat-empty" data-testid="chat-empty">
          {entryKind === 'paper'
            ? '还没有对话。输入问题，Agent 会基于这篇论文回答。'
            : entryKind === 'relation'
              ? '还没有对话。输入问题，Agent 会基于这条关系回答。'
              : '还没有对话。输入问题，Agent 会基于这张图谱回答。'}
        </div>
      )}
      {messages.map((m) =>
        m.role === 'system' ? (
          // uat5 D172：系统记录（撤销通知等）——居中灰行，不作用户/助手消息
          <div key={m.id} className="gt-msg gt-msg-system" data-testid="chat-msg-system">
            {m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('')}
          </div>
        ) : m.role === 'user' ? (
          <div key={m.id} className="gt-msg gt-msg-user" data-testid="chat-msg-user">
            <div className="gt-bubble">{m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('')}</div>
          </div>
        ) : (
          <div key={m.id} className="gt-msg gt-msg-ai" data-testid="chat-msg-ai">
            {m.parts.length > 0 && <PartsView parts={displayParts(m)} />}
            {m.error && (
              <div className="gt-msg-error" data-testid="chat-msg-error">
                <span>{m.error}</span>
                {onRetry && (
                  <button type="button" className="btn bordered sm" data-testid="chat-retry" onClick={() => onRetry(m.id)}>
                    重试
                  </button>
                )}
              </div>
            )}
          </div>
        )
      )}
      {showTyping && (
        <div className="gt-typing" data-testid="chat-typing">
          正在思考
          <span className="gt-dots">
            <i />
            <i />
            <i />
          </span>
        </div>
      )}
    </div>
  )
}
