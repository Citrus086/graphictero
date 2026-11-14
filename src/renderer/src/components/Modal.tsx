import { useEffect, type ReactNode } from 'react'
import { Ic } from '../lib/icons'

/** 通用遮罩 + 对话框容器（点遮罩不关闭，统一用按钮/× 关闭，避免误触） */
export function Overlay({ children, width }: { children: ReactNode; width?: number }): React.JSX.Element {
  return (
    <div className="ov">
      <div className="modal" style={width ? { width } : undefined}>
        {children}
      </div>
    </div>
  )
}

export function ConfirmDialog({
  title,
  children,
  okText,
  danger,
  /** uat2 建议修 3：克制的灰阶主按钮（非破坏性确认用） */
  okMuted,
  okDisabled,
  onOk,
  onClose
}: {
  title: string
  children?: ReactNode
  okText: string
  danger?: boolean
  okMuted?: boolean
  okDisabled?: boolean
  onOk: () => void
  onClose: () => void
}): React.JSX.Element {
  // D176：模态层先于菜单 / 子图 / 选择；输入控件仍保留自己的 Esc 第一层。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div className="ov" style={{ paddingTop: 120 }}>
      <div className="modal cfm">
        <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
        {children && (
          <div className="t2" style={{ fontSize: 12.5, lineHeight: '19px', marginTop: 6 }}>
            {children}
          </div>
        )}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button className="btn bordered" onClick={onClose}>
            取消
          </button>
          <button className={`btn ${danger ? 'dfill' : okMuted ? 'muted' : 'primary'}`} disabled={okDisabled} onClick={onOk}>
            {okText}
          </button>
        </div>
      </div>
    </div>
  )
}

export function DialogHeader({ title, sub, onClose }: { title: string; sub?: ReactNode; onClose: () => void }): React.JSX.Element {
  return (
    <div className="dlg-h">
      <div className="row">
        <div className="grow" style={{ fontSize: 15, fontWeight: 600 }}>
          {title}
        </div>
        <button className="btn icon" onClick={onClose} title="关闭">
          <Ic name="close" size={14} />
        </button>
      </div>
      {sub && (
        <div className="t3" style={{ fontSize: 12.5, marginTop: 2 }}>
          {sub}
        </div>
      )}
    </div>
  )
}
