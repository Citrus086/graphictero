import { useState } from 'react'
import { ConfirmDialog } from '../Modal'
import { MotionPresence } from '../MotionPresence'

/**
 * DeepSeek 与 OpenAlex 共用的 Key 行（uat8c）。
 * 已配置时占位是掩码，不是明文。空输入不能保存。清除走单独按钮和确认框。
 */
export function ApiKeyField({
  configured,
  tail,
  onSave,
  onClear,
  testId
}: {
  configured: boolean
  tail: string | null
  onSave: (key: string) => Promise<void>
  onClear: () => Promise<void>
  testId: string
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const placeholder = configured ? (tail ? `已配置 · ••••${tail}` : '已配置') : 'sk-…'

  const save = async (): Promise<void> => {
    const trimmed = value.trim()
    if (!trimmed || saving) return
    setSaving(true)
    try {
      await onSave(trimmed)
      setValue('')
    } catch {
      // 调用方负责提示；输入保留，方便改完再存
    } finally {
      setSaving(false)
    }
  }

  const clear = async (): Promise<void> => {
    if (clearing) return
    setClearing(true)
    try {
      await onClear()
      setValue('')
      setConfirmClear(false)
    } catch {
      // 调用方负责提示
    } finally {
      setClearing(false)
    }
  }

  return (
    <>
      <input
        className="tin"
        type="password"
        data-testid={`${testId}-input`}
        style={{ width: 240 }}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save()
        }}
      />
      <button
        className="btn bordered"
        data-testid={`${testId}-save`}
        disabled={saving || value.trim() === ''}
        onClick={() => void save()}
      >
        {saving ? '保存中…' : '保存'}
      </button>
      {configured && (
        <button className="btn" data-testid={`${testId}-clear`} disabled={clearing} onClick={() => setConfirmClear(true)}>
          清除
        </button>
      )}
      <MotionPresence open={confirmClear} kind="modal">
        {confirmClear ? (
        <ConfirmDialog
          title="清除 API Key？"
          okText={clearing ? '清除中…' : '清除'}
          okDisabled={clearing}
          onOk={() => void clear()}
          onClose={() => setConfirmClear(false)}
        >
          清除后相关请求会停，直到重新填写。Key 只存在本机 .env，清除不会进备份。
        </ConfirmDialog>
        ) : null}
      </MotionPresence>
    </>
  )
}
