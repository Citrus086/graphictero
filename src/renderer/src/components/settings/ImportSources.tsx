import { useCallback, useEffect, useState } from 'react'
import type { ConnectionTestView, ZoteroDisplayView } from '../../../../shared/ipc'
import { tildePath } from '../../lib/format'
import { ipcErrorMessage } from '../../lib/ipcError'
import { useNotify } from '../../lib/notify'
import { ApiKeyField } from './ApiKeyField'

const api = window.graphictero

/**
 * 设置 · 导入来源（D194④ / D195）。只展示和检测，不新增导入、不在进页时打 OpenAlex。
 * Zotero 数据目录没有可配置项，所以没有「更改…」。
 */
export function ImportSources({ homeDir }: { homeDir: string }): React.JSX.Element {
  const notify = useNotify()
  const [zotero, setZotero] = useState<ZoteroDisplayView | null>(null)
  const [checking, setChecking] = useState(false)
  const [oaConfigured, setOaConfigured] = useState(false)
  const [oaTail, setOaTail] = useState<string | null>(null)
  const [oaTesting, setOaTesting] = useState(false)
  const [oaResult, setOaResult] = useState<ConnectionTestView | null>(null)

  const loadZotero = useCallback(async (): Promise<void> => {
    setZotero(await api.getZoteroDisplay())
  }, [])

  const loadOpenAlex = useCallback(async (): Promise<void> => {
    const s = await api.getOpenAlexKey()
    setOaConfigured(s.configured)
    setOaTail(s.tail)
  }, [])

  useEffect(() => {
    void loadZotero().catch(() => notify('检测 Zotero 失败'))
    void loadOpenAlex().catch(() => notify('读取 OpenAlex 设置失败'))
  }, [loadZotero, loadOpenAlex, notify])

  const recheck = async (): Promise<void> => {
    if (checking) return
    setChecking(true)
    try {
      await loadZotero()
    } catch (e) {
      notify(ipcErrorMessage(e, '检测 Zotero 失败'))
    } finally {
      setChecking(false)
    }
  }

  const testOpenAlex = async (): Promise<void> => {
    if (oaTesting) return
    setOaTesting(true)
    try {
      setOaResult(await api.testOpenAlex())
    } catch (e) {
      setOaResult({ ok: false, message: ipcErrorMessage(e, '网络不可用') })
    } finally {
      setOaTesting(false)
    }
  }

  const dataDir = zotero?.dataDir ? tildePath(zotero.dataDir, homeDir) : null

  return (
    <>
      <div className="ghead">Zotero</div>
      <div className="group" data-testid="import-zotero">
        <div className="grow-r" style={{ minHeight: 42, padding: '6px 16px' }}>
          <div className="k">来源</div>
          <div className="v">Zotero · 单向导入</div>
        </div>
        <div className="grow-r" style={{ minHeight: 42, padding: '6px 16px' }}>
          <div className="k">Zotero Local API</div>
          <div className="v">
            <span data-testid="zotero-api">
              {zotero == null ? '…' : zotero.apiUp ? '可用' : '不可用'}
              {' · '}
              <span className="mono">localhost:23119</span>
            </span>
            <button className="btn bordered" data-testid="zotero-recheck" disabled={checking} onClick={() => void recheck()}>
              {checking ? '检测中…' : '重新检测'}
            </button>
          </div>
        </div>
        <div className="grow-r" style={{ minHeight: 42, padding: '6px 16px' }}>
          <div className="k">Zotero 数据目录</div>
          <div className="v">
            {dataDir ? (
              <span className="mono" title={zotero?.dataDir ?? ''} data-testid="zotero-dir">
                {dataDir}
              </span>
            ) : (
              <span className="t3" data-testid="zotero-dir">
                {zotero == null ? '…' : '未找到'}
              </span>
            )}
          </div>
        </div>
        {zotero?.sqliteFallback && (
          <div className="grow-r" style={{ minHeight: 42, padding: '6px 16px' }}>
            <div className="k">Zotero 未运行时</div>
            <div className="v">读取 zotero.sqlite 的只读副本</div>
          </div>
        )}
      </div>
      <div className="note">
        需在 Zotero 设置中开启「允许本机其他应用与 Zotero 通信」。导入时复制 PDF 并记录 item key；导入后不依赖 Zotero，也不会写回。按 DOI 和 arXiv ID 判断是否已在库中，已在库中的不重复导入。
      </div>

      <div className="ghead" style={{ marginTop: 22 }}>
        文献数据 · OpenAlex
      </div>
      <div className="group" data-testid="import-openalex">
        <div className="grow-r" style={{ minHeight: 42, padding: '6px 16px' }}>
          <div className="k">OpenAlex API Key</div>
          <div className="v">
            <ApiKeyField
              testId="openalex-key"
              configured={oaConfigured}
              tail={oaTail}
              onSave={async (key) => {
                try {
                  await api.setOpenAlexKey(key)
                  await loadOpenAlex()
                  setOaResult(null)
                  notify('OpenAlex API Key 已保存')
                } catch (e) {
                  notify(ipcErrorMessage(e, '保存 API Key 失败'))
                  throw e
                }
              }}
              onClear={async () => {
                try {
                  await api.clearOpenAlexKey()
                  await loadOpenAlex()
                  setOaResult(null)
                  notify('OpenAlex API Key 已清除')
                } catch (e) {
                  notify(ipcErrorMessage(e, '清除 API Key 失败'))
                  throw e
                }
              }}
            />
            <button className="btn bordered" data-testid="openalex-test" disabled={oaTesting} onClick={() => void testOpenAlex()}>
              {oaTesting ? '测试中…' : '测试连接'}
            </button>
            {oaResult && (
              <span className="t3" data-testid="openalex-test-result">
                {oaResult.message}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="note">用于获取引用（referenced_works）和补全 DOI。保存在本机 .env，和 DeepSeek Key 一样不会进入备份。</div>
    </>
  )
}
