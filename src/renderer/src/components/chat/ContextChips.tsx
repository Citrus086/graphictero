import { useState } from 'react'
import type { ContextRef } from '../../../../shared/ipc/agent'
import { Ic } from '../../lib/icons'

/**
 * M5 lane/chat 批 2：上下文标签（D30 输入框上方 chip 区）。三类来源：
 * - quote（D105-①）：阅读器选区「发给 agent」，kind='quote'（paperId + page + text）
 * - paper：@ 选论文 / 画布拖入论文行，kind='paper'
 * chip 是会话内待发送附件：随 send 的 contextRefs 发出后清空（SendInput.contextRefs）。
 */
export interface ChatChip {
  ref: ContextRef
  /** 展示标签（论文标题 / p.x「引文前 24 字」） */
  label: string
}

function chipKey(c: ChatChip): string {
  return c.ref.kind === 'quote' ? `quote:${c.ref.paperId}:${c.ref.page ?? ''}:${c.ref.text.slice(0, 24)}` : `paper:${c.ref.paperId}`
}

export function ContextChips({
  chips,
  onRemove,
  onDropPaper
}: {
  chips: ChatChip[]
  onRemove: (key: string) => void
  /** 画布/侧栏论文行拖入（mime 与画布 DnD 同源） */
  onDropPaper: (paperId: number) => void
}): React.JSX.Element {
  /** uat3b 必须修 3：引文 chip 展开态（点击字数徽标展开/收起全文） */
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggleExpand = (key: string): void => {
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  // 评审建 2：空态也常驻拖放目标（「画布拖入」是最常见来源，空态不渲染会鸡生蛋）
  if (chips.length === 0) {
    return (
      <div
        className="gt-chips gt-chips-empty"
        data-testid="chat-chips"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('application/x-graphictero-paper')) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
          }
        }}
        onDrop={(e) => {
          const pid = e.dataTransfer.getData('application/x-graphictero-paper')
          if (pid) {
            e.preventDefault()
            onDropPaper(Number(pid))
          }
        }}
      >
        <span className="gt-chips-hint">拖入论文，或点 + 添加上下文</span>
      </div>
    )
  }
  return (
    <div
      className="gt-chips"
      data-testid="chat-chips"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-graphictero-paper')) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDrop={(e) => {
        const pid = e.dataTransfer.getData('application/x-graphictero-paper')
        if (pid) {
          e.preventDefault()
          onDropPaper(Number(pid))
        }
      }}
    >
      {chips.map((c) => {
        const key = chipKey(c)
        const isQuote = c.ref.kind === 'quote'
        const isExpanded = expanded.has(key)
        // uat3b 必须修 3：引文 chip 悬停（title）看全文 + 字数徽标 + 点击展开
        return (
          <span
            key={key}
            className={`gt-chip${isQuote && isExpanded ? ' gt-chip-expanded' : ''}`}
            data-testid="chat-chip"
            data-kind={c.ref.kind}
            title={isQuote && c.ref.kind === 'quote' ? c.ref.text : c.label}
          >
            <Ic name={isQuote ? 'marker' : 'doc'} size={11} />
            <span className="gt-chip-label">{isQuote && isExpanded && c.ref.kind === 'quote' ? c.ref.text : c.label}</span>
            {isQuote && c.ref.kind === 'quote' && (
              <button
                type="button"
                className="gt-chip-n"
                data-testid="chip-expand"
                title={isExpanded ? '收起' : `展开全文（${c.ref.text.length} 字）`}                onClick={() => toggleExpand(key)}
              >
                {isExpanded ? '收起' : `${c.ref.text.length}字`}
              </button>
            )}
            <button type="button" className="gt-chip-x" title="移除" onClick={() => onRemove(key)}>
              <Ic name="close" size={10} />
            </button>
          </span>
        )
      })}
    </div>
  )
}

/** 追加 chip（按 key 去重） */
export function addChip(chips: ChatChip[], chip: ChatChip): ChatChip[] {
  const key = chipKey(chip)
  return chips.some((c) => chipKey(c) === key) ? chips : [...chips, chip]
}

export function removeChip(chips: ChatChip[], key: string): ChatChip[] {
  return chips.filter((c) => chipKey(c) !== key)
}
