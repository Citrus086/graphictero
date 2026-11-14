import { useCallback, useEffect, useState } from 'react'
import type { ConnectionTestView, LlmSettingsView } from '../../../../shared/ipc'
import { ipcErrorMessage } from '../../lib/ipcError'
import { useNotify } from '../../lib/notify'
import { ApiKeyField } from './ApiKeyField'

const api = window.graphictero
const MODEL_OPTIONS = ['deepseek-flash', 'deepseek-v4-pro']

/** 设置 · 语言模型（D195）。页标题在外面，这里不再重复「语言模型」。 */
export function LlmSection({ onOpenUsage }: { onOpenUsage: () => void }): React.JSX.Element {
  const notify = useNotify()
  const [llm, setLlm] = useState<LlmSettingsView | null>(null)
  const [model, setModel] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ConnectionTestView | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const s = await api.getLlmSettings()
    setLlm(s)
    setModel(s.model)
  }, [])

  useEffect(() => {
    void load().catch(() => notify('读取语言模型设置失败'))
  }, [load, notify])

  const saveModel = async (m: string): Promise<void> => {
    setModel(m)
    try {
      await api.setLlmSettings('deepseek', m)
      notify('已保存模型设置')
    } catch (e) {
      notify(ipcErrorMessage(e, '保存失败'))
    }
  }

  const test = async (): Promise<void> => {
    if (testing) return
    setTesting(true)
    try {
      const r = await api.testLlmConnection()
      setTestResult(r)
    } catch (e) {
      setTestResult({ ok: false, message: ipcErrorMessage(e, '网络不可用') })
    } finally {
      setTesting(false)
    }
  }

  return (
    <>
      <div className="ghead">DeepSeek</div>
      <div className="group">
        <div className="grow-r" style={{ minHeight: 42, padding: '6px 16px' }}>
          <div className="k">服务商</div>
          <div className="v">DeepSeek</div>
        </div>
        <div className="grow-r" style={{ minHeight: 42, padding: '6px 16px' }}>
          <div className="k">模型</div>
          <div className="v">
            <select className="tin" style={{ width: 220 }} value={model} onChange={(e) => void saveModel(e.target.value)}>
              {MODEL_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="grow-r" style={{ minHeight: 42, padding: '6px 16px' }}>
          <div className="k">API Key</div>
          <div className="v">
            <ApiKeyField
              testId="llm-key"
              configured={llm?.hasApiKey === true}
              tail={llm?.keyTail ?? null}
              onSave={async (key) => {
                try {
                  await api.setApiKey(key)
                  await load()
                  notify('API Key 已保存')
                } catch (e) {
                  notify(ipcErrorMessage(e, '保存 API Key 失败'))
                  throw e
                }
              }}
              onClear={async () => {
                try {
                  await api.clearApiKey()
                  await load()
                  setTestResult(null)
                  notify('API Key 已清除')
                } catch (e) {
                  notify(ipcErrorMessage(e, '清除 API Key 失败'))
                  throw e
                }
              }}
            />
          </div>
        </div>
        <div className="grow-r" style={{ minHeight: 42, padding: '6px 16px' }}>
          <div className="k">测试连接</div>
          <div className="v">
            <button className="btn bordered" data-testid="llm-test" disabled={testing} onClick={() => void test()}>
              {testing ? '测试中…' : '测试连接'}
            </button>
            {testResult && (
              <span className="t3" data-testid="llm-test-result">
                {testResult.message}
              </span>
            )}
          </div>
        </div>
        <div className="grow-r" style={{ minHeight: 36, padding: '6px 16px' }}>
          <div className="k">用量</div>
          <div className="v">
            <button className="btn bordered" data-testid="open-usage" onClick={onOpenUsage}>
              用量与费用 ›
            </button>
          </div>
        </div>
      </div>
      <div className="note">API Key 只保存在数据目录的 .env 文件里，不进数据库、不进备份、不打日志。清除需要单独确认。</div>
    </>
  )
}
