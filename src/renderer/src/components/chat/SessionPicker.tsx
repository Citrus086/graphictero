import { useEffect, useRef, useState } from 'react'
import type { SessionSummary } from '../../../../shared/ipc/agent'
import { ConfirmDialog } from '../Modal'
import { Ic } from '../../lib/icons'
import { MotionPresence } from '../MotionPresence'

/**
 * M5 lane/chat 批 1：会话下拉（D30，按时间倒序）。新建 / 重命名（行内编辑）/
 * 删除（D122：二次确认，文案说明物理删除级联与用量记录保留）。
 */
export function SessionPicker({
  sessions,
  currentId,
  onSelect,
  onCreate,
  onRename,
  onDelete
}: {
  sessions: SessionSummary[]
  currentId: number | null
  onSelect: (id: number) => void
  onCreate: () => void
  onRename: (id: number, name: string) => void
  onDelete: (id: number) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  /** 重命名中的会话 id（行内输入框） */
  const [editing, setEditing] = useState<number | null>(null)
  const [editValue, setEditValue] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // 点别处关闭（与 GraphPage 菜单同口径）
  useEffect(() => {
    if (!open) return
    const close = (): void => {
      setOpen(false)
      setEditing(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      close()
    }
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const commitRename = (): void => {
    if (editing != null && editValue.trim()) onRename(editing, editValue.trim())
    setEditing(null)
  }

  const current = sessions.find((s) => s.id === currentId) ?? null

  /** uat10：按「相对日期 + HH:mm」分组，同一分钟多条时这些 key 视为撞车 */
  const dupKeys = new Set<string>()
  {
    const counts = new Map<string, number>()
    for (const s of sessions) {
      const k = sessionMinuteKey(s.updatedAt)
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    for (const [k, n] of counts) if (n > 1) dupKeys.add(k)
  }

  return (
    <div className="gt-sess" ref={rootRef} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="gt-sess-btn"
        data-testid="session-picker"
        title="会话 · 按时间"
        onClick={() => setOpen((v) => !v)}
      >
        <Ic name="chat" size={13} />
        <span className="gt-sess-name" title={current?.name ?? ''}>{current?.name ?? '会话'}</span>
        <Ic name="chevD" size={12} />
      </button>

      <MotionPresence open={open} kind="pop">
        {open ? (
        <div className="menu gt-sess-menu" data-testid="session-menu" data-esc-popover style={{ left: 0, top: '100%' }}>
          <div className="cap" style={{ padding: '6px 10px 4px' }}>
            会话 · 按时间
          </div>
          {sessions.length === 0 && <div className="t3 sm" style={{ padding: '4px 10px 6px' }}>还没有会话</div>}
          {sessions.map((s) => {
            // uat10：默认会话名同名（如多个「图谱对话 · 图谱名」）时用时间区分；同一分钟
            // 撞车再追加短 id。完整名经 title tooltip 展示。
            const stamp = sessionStamp(s, dupKeys)
            return editing === s.id ? (
              <div key={s.id} className="gt-sess-edit" style={{ padding: '2px 8px' }}>
                <input
                  data-testid="session-rename-input"
                  value={editValue}
                  autoFocus
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') {
                      e.stopPropagation()
                      setEditing(null)
                    }
                  }}
                />
              </div>
            ) : (
              <div
                key={s.id}
                className={`mi ${s.id === currentId ? 'gt-sess-on' : ''}`}
                onClick={() => {
                  onSelect(s.id)
                  setOpen(false)
                }}
              >
                <span className="gt-sess-item-name" title={s.name}>{s.name}</span>
                <span className="kb">{stamp}</span>
              </div>
            )
          })}
          <div className="ms" />
          <div
            className="mi"
            data-testid="session-menu-new"
            onClick={() => {
              setOpen(false)
              onCreate()
            }}
          >
            <Ic name="plus" size={14} />
            新建会话
            <span className="kb">⌘N</span>
          </div>
          {current && (
            <div
              className="mi"
              onClick={() => {
                setEditing(current.id)
                setEditValue(current.name)
              }}
            >
              <Ic name="note" size={14} />
              重命名…
            </div>
          )}
          {current && (
            <div
              className="mi danger"
              data-testid="session-menu-delete"
              onClick={() => {
                setOpen(false)
                setConfirmingDelete(true)
              }}
            >
              <Ic name="trash" size={14} />
              删除会话…
            </div>
          )}
        </div>
        ) : null}
      </MotionPresence>

      <MotionPresence open={confirmingDelete && current != null} kind="modal">
        {confirmingDelete && current ? (
        <ConfirmDialog
          title={`删除会话「${shortName(current.name)}」？`}
          okText="删除"
          danger
          onOk={() => {
            setConfirmingDelete(false)
            onDelete(current.id)
          }}
          onClose={() => setConfirmingDelete(false)}
        >
          会话和它的全部消息、读取记录会被永久删除，不能恢复。会话产生的用量记录保留（费用统计不受影响）。
        </ConfirmDialog>
        ) : null}
      </MotionPresence>
    </div>
  )
}

function shortName(n: string): string {
  return n.length > 16 ? `${n.slice(0, 16)}…` : n
}

/** 今天 / 昨天 / M月d日 */
export function relTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const today = new Date()
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const t = d.getTime()
  if (t >= startOfToday) return '今天'
  if (t >= startOfToday - 86400000) return '昨天'
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** uat10：HH:mm（本地时区；解析失败返回空串） */
export function clockTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** uat10：撞车判定 key = 相对日期 + 分钟 */
function sessionMinuteKey(iso: string): string {
  return `${relTime(iso)} ${clockTime(iso)}`
}

/** uat10：下拉项短区分 = 相对日期 + HH:mm；同一分钟撞车再追加短 id */
export function sessionStamp(s: SessionSummary, dupKeys: Set<string>): string {
  const base = `${relTime(s.updatedAt)} ${clockTime(s.updatedAt)}`.trim()
  if (!base) return ''
  return dupKeys.has(sessionMinuteKey(s.updatedAt)) ? `${base} · #${s.id}` : base
}
