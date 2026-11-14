import { useEffect, useState } from 'react'
import type { DataInfo, LastSnapshotView } from '../../../shared/ipc'
import { ConfirmDialog } from '../components/Modal'
import { splitDirPath, tildePath, localClock } from '../lib/format'
import { Ic } from '../lib/icons'
import { ipcErrorMessage } from '../lib/ipcError'
import { useNotify } from '../lib/notify'
import { MineruSection } from '../components/MineruSection'
import { ParseQueueSection } from '../components/ParseQueueSection'
import { AppearanceSection } from '../components/settings/AppearanceSection'
import { ImportSources } from '../components/settings/ImportSources'
import { LlmSection } from '../components/settings/LlmSection'
import { PdfSources } from '../components/settings/PdfSources'
import { UsageSection } from '../components/settings/UsageSection'
import { MotionPresence } from '../components/MotionPresence'

export { formatCny } from '../components/settings/usageChart'

const api = window.graphictero

/** D195：取消「通用」。用量紧跟语言模型。 */
export const SETTINGS_NAV: Array<[string, string, string]> = [
  ['llm', '语言模型', 'sliders'],
  ['usage', '用量与费用', 'sum'],
  ['import', '导入来源', 'import'],
  ['pdf', 'PDF 来源', 'doc'],
  ['parse', 'PDF 解析', 'thumbs'],
  ['data', '数据与备份', 'lib'],
  ['appearance', '外观', 'contrast']
]

/** 旧深链 / localStorage 残留的 gen 映射到 llm。未知值也落到语言模型。 */
export function normalizeSettingsSection(raw: string | undefined): string {
  if (raw == null || raw === '' || raw === 'gen') return 'llm'
  return SETTINGS_NAV.some(([key]) => key === raw) ? raw : 'llm'
}

export function SettingsPage({ onBack, initialSection }: { onBack: () => void; initialSection?: string }): React.JSX.Element {
  const notify = useNotify()
  const [group, setGroup] = useState(normalizeSettingsSection(initialSection))
  const [info, setInfo] = useState<DataInfo | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmRestore, setConfirmRestore] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [version, setVersion] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<LastSnapshotView | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        setInfo(await api.getDataInfo())
      } catch {
        notify('读取存储信息失败')
      }
    })()
    void api.getAppVersion?.().then(setVersion).catch(() => setVersion(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅首刷
  }, [notify])

  useEffect(() => {
    if (group !== 'data') return
    let live = true
    api
      .getLastSnapshot()
      .then((v) => {
        if (live) setSnapshot(v)
      })
      .catch(() => {
        if (live) setSnapshot({ at: null })
      })
    return () => {
      live = false
    }
  }, [group])

  const changeRoot = async (): Promise<void> => {
    try {
      const r = await api.chooseDataRoot()
      if (!r.ok) {
        if (r.error) notify(r.error)
        return
      }
      setBusy('正在迁移并重启…')
    } catch (e) {
      notify(ipcErrorMessage(e, '更改存储位置失败'))
    }
  }

  const exportBackup = async (): Promise<void> => {
    try {
      const path = await api.exportBackup()
      if (path) notify(`已导出完整备份到 ${path}`)
    } catch (e) {
      notify(ipcErrorMessage(e, '导出备份失败'))
    }
  }

  const restoreBackup = async (): Promise<void> => {
    if (restoring) return
    setRestoring(true)
    try {
      const r = await api.restoreBackup()
      if (!r.ok) {
        if (r.error) notify(r.error)
        setRestoring(false)
        return
      }
      setConfirmRestore(false)
      setBusy('正在恢复并重启…')
    } catch (e) {
      notify(ipcErrorMessage(e, '从备份恢复失败'))
      setRestoring(false)
    }
  }

  const displayDir = info ? tildePath(info.dataDir, info.homeDir ?? '') : '…'
  const [dirA, dirB] = splitDirPath(displayDir)
  const pageTitle = SETTINGS_NAV.find(([key]) => key === group)?.[1] ?? '设置'

  return (
    <>
      <div className="sidebar">
        <div className="tlspace" />
        <div className="sbody" style={{ paddingTop: 4 }}>
          <div className="sitem" style={{ color: 'var(--text2)' }} onClick={onBack}>
            <Ic name="back" size={15} />
            返回
          </div>
          <div className="shead">
            <span className="cap">设置</span>
          </div>
          {SETTINGS_NAV.map(([key, label, icon]) => (
            <div
              key={key}
              className={`sitem ${group === key ? 'on' : ''}`}
              data-testid={`settings-nav-${key}`}
              onClick={() => setGroup(key)}
            >
              <Ic name={icon} />
              {label}
            </div>
          ))}
          <div className="grow" />
        </div>
        <div className="zfoot" data-testid="settings-version">
          <Ic name="info" size={14} />
          Graphictero · 版本 {version ?? '…'}
        </div>
      </div>

      <div className="setmain">
        <div className="setcol">
          <div style={{ height: 40 }} />
          <div className="h1" style={{ margin: '8px 4px 18px' }}>
            {pageTitle}
          </div>

          {/* D203：设置内分页切换为瞬切，不加淡入淡出（避免交叉淡化闪烁）；页面级切换与弹窗动画不变。 */}
          <>
            {group === 'llm' ? <LlmSection onOpenUsage={() => setGroup('usage')} /> : null}
          </>
          <>
            {group === 'usage' ? <UsageSection /> : null}
          </>
          <>
            {group === 'import' ? <ImportSources homeDir={info?.homeDir ?? ''} /> : null}
          </>
          <>
            {group === 'pdf' ? <PdfSources /> : null}
          </>
          <>
            {group === 'parse' ? (
            <>
              <MineruSection homeDir={info?.homeDir ?? ''} />
              {/* D194③：解析队列是功能性区块，原型 05d 没画，有意留在 MinerU 说明之后 */}
              <ParseQueueSection />
            </>
            ) : null}
          </>
          <>
            {group === 'appearance' ? <AppearanceSection /> : null}
          </>

          <>
            {group === 'data' ? (
            <>
              <div className="ghead">存储</div>
              <div className="group">
                <div className="grow-r" style={{ minHeight: 42, padding: '6px 16px' }}>
                  <div className="k">存储位置</div>
                  <div className="v">
                    <span className="mono pathm" title={info?.dataDir ?? ''}>
                      <span className="pth-a">{dirA}</span>
                      <span className="pth-b">{dirB}</span>
                    </span>
                    <button className="btn" style={{ flex: 'none' }} disabled={busy != null} onClick={() => void changeRoot()}>
                      更改…
                    </button>
                  </div>
                </div>
              </div>
              <div className="note">不能放在 iCloud / Dropbox 同步目录里。改位置前会先做快照，再迁移数据。</div>

              <div className="ghead" style={{ marginTop: 22 }}>
                数据库备份
              </div>
              <div className="group">
                <div className="grow-r" style={{ minHeight: 42, padding: '6px 16px' }}>
                  <div className="k">自动备份</div>
                  <div className="v" data-testid="auto-backup">
                    每天一次 · 保留最近 7 份 · 已开启
                  </div>
                </div>
                <div className="grow-r" style={{ minHeight: 42, padding: '6px 16px' }}>
                  <div className="k">最近自动备份</div>
                  <div className="v" data-testid="last-snapshot">
                    {snapshot == null ? '…' : snapshot.at ? localClock(snapshot.at) : '尚未备份'}
                  </div>
                </div>
                <div className="grow-r" style={{ minHeight: 42, padding: '6px 16px' }}>
                  <div className="k">完整备份</div>
                  <div className="v">
                    <button className="btn bordered" disabled={busy != null} onClick={() => void exportBackup()}>
                      <Ic name="export" size={14} />
                      导出完整备份…
                    </button>
                    <button className="btn bordered" disabled={busy != null} onClick={() => setConfirmRestore(true)}>
                      从备份恢复…
                    </button>
                  </div>
                </div>
              </div>
              <div className="note">
                完整备份包含：数据库快照、设置、论文解析结果（Markdown 与图片），以及手动拖入的无 DOI 论文 PDF。有 DOI 的 PDF
                可重新下载，Zotero 导入的论文可从 Zotero 重新导入，均不进备份。备份不含 API Key（.env）。从备份恢复会替换当前数据，恢复前会再确认一次。
              </div>
              {/* uat6 D175(c)：一行灰色小字说明有 DOI 的 PDF 不进备份、恢复后需重新获取（D59/D76；备份范围不变） */}
              <div className="note" data-testid="backup-pdf-note">
                有 DOI 的论文 PDF 不包含在备份中，恢复后需重新获取。
              </div>

              {busy && (
                <div className="hintbar" style={{ marginTop: 18 }}>
                  <Ic name="info" size={14} />
                  <span>{busy}</span>
                </div>
              )}
            </>
            ) : null}
          </>
        </div>
      </div>

      <MotionPresence open={confirmRestore} kind="modal">
        {confirmRestore ? (
        <ConfirmDialog
          title="从备份恢复？"
          okText={restoring ? '恢复中…' : '继续'}
          okDisabled={restoring}
          onOk={() => void restoreBackup()}
          onClose={() => setConfirmRestore(false)}
        >
          从备份恢复会替换当前全部数据，且恢复前会再确认一次。备份不包含 API Key（.env），恢复后需要重新填写。
        </ConfirmDialog>
        ) : null}
      </MotionPresence>
    </>
  )
}
