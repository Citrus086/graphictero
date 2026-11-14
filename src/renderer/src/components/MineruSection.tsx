import { useEffect, useState } from 'react'
import type { LastParseView, MineruStatusView, MineruSidecarState, ModelDirSizeView } from '../../../shared/ipc/pdf'
import { ConfirmDialog } from './Modal'
import { Ic } from '../lib/icons'
import { ipcErrorMessage } from '../lib/ipcError'
import { useNotify } from '../lib/notify'
import { useMineruStatus } from '../lib/useMineruStatus'
import { mineruApi } from '../lib/mineruStatus'
import { installFailedText, INSTALL_PHASE_LABEL } from '../lib/mineruStatus'
import { ellipsisMiddle, localClock, tildePath } from '../lib/format'
import { MotionPresence } from './MotionPresence'

const api = window.graphictero

const STATE_LABEL: Record<MineruSidecarState, string> = {
  unavailable: '当前环境未接入 MinerU',
  not_installed: '未安装',
  installing: '正在安装',
  install_failed: '安装失败',
  stopped: '已安装 · 未运行',
  starting: '正在启动',
  ready: '运行中',
  restarting: '崩溃后自动重启中',
  crashed: '运行失败'
}

/**
 * 设置页「PDF 解析」的 MinerU 分组（原型 05d + D137 行名 + D194③ 队列在本组件之后）。
 * 「重新检测」只再查一次状态，不重启服务。启动 / 停止 / 重试安装是原型没画的操作，保留在服务状态行。
 */
export function MineruSection({ homeDir = '' }: { homeDir?: string }): React.JSX.Element {
  const notify = useNotify()
  const live = useMineruStatus()
  const [fresh, setFresh] = useState<MineruStatusView | null>(null)
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState<false | 'start' | 'stop' | 'reinstall'>(false)
  const [confirmReinstall, setConfirmReinstall] = useState(false)
  const [showFailDetail, setShowFailDetail] = useState(false)
  const [showInstallDetail, setShowInstallDetail] = useState(false)
  const [lastParse, setLastParse] = useState<LastParseView | null | undefined>(undefined)
  const [modelSize, setModelSize] = useState<ModelDirSizeView | null>(null)

  useEffect(() => {
    setFresh(null)
  }, [live])

  const status = fresh ?? live

  useEffect(() => {
    let liveFlag = true
    api.getLastParse().then((v) => {
      if (liveFlag) setLastParse(v)
    })
    api
      .getModelDirSize()
      .then((v) => {
        if (liveFlag) setModelSize(v)
      })
      .catch(() => {
        if (liveFlag) setModelSize({ bytes: null, label: '未下载' })
      })
    return () => {
      liveFlag = false
    }
  }, [])

  const recheck = async (): Promise<void> => {
    if (checking) return
    setChecking(true)
    try {
      setFresh(await mineruApi().getMineruStatus())
    } catch (e) {
      notify(ipcErrorMessage(e, '重新检测失败'))
    } finally {
      setChecking(false)
    }
  }

  const run = async (what: 'start' | 'stop' | 'reinstall'): Promise<void> => {
    if (busy) return
    setBusy(what)
    try {
      if (what === 'start') await api.startMineru()
      else if (what === 'stop') await api.stopMineru()
      else await api.reinstallMineru()
      notify(what === 'start' ? 'MinerU 已启动' : what === 'stop' ? 'MinerU 已停止' : 'MinerU 已重装完成')
    } catch (e) {
      notify(ipcErrorMessage(e, what === 'start' ? '启动 MinerU 失败' : what === 'stop' ? '停止 MinerU 失败' : '重装 MinerU 失败'))
    } finally {
      setBusy(false)
      setConfirmReinstall(false)
    }
  }

  const state = status?.state ?? 'unavailable'
  const installing = state === 'installing'
  const installFailed = state === 'install_failed'
  const busyAny = busy !== false || installing || state === 'starting' || state === 'restarting' || checking
  const running = state === 'ready'
  const stopped = state === 'stopped' || state === 'crashed'
  const failText = installFailed && status?.error ? installFailedText(status.error) : null
  const envPath = status?.modelsPath ? tildePath(status.modelsPath, homeDir) : ''
  const lastText =
    lastParse === undefined ? '…' : lastParse == null ? '—' : `${localClock(lastParse.at)} · ${lastParse.ok ? '成功' : '失败'}`

  return (
    <>
      <div className="ghead">MinerU</div>
      <div className="group">
        <div className="grow-r" style={{ minHeight: 42, padding: '6px 16px' }}>
          <div className="k">服务状态</div>
          <div className="v">
            <span className={`mstate ${state}`}>{STATE_LABEL[state]}{running ? ' · 本机' : ''}</span>
            <button type="button" className="btn bordered sm" data-testid="mineru-recheck" disabled={checking} onClick={() => void recheck()}>
              {checking ? '检测中…' : '重新检测'}
            </button>
            {(stopped || state === 'not_installed') && (
              <button className="btn bordered sm" disabled={busyAny} onClick={() => void run('start')}>
                {busy === 'start' ? '启动中…' : state === 'crashed' ? '重新启动' : '启动'}
              </button>
            )}
            {installFailed && (
              <button className="btn bordered sm" disabled={busyAny} onClick={() => void run('start')} data-testid="mineru-retry-install">
                {busy === 'start' ? '重试中…' : '重试安装'}
              </button>
            )}
            {running && (
              <button className="btn bordered sm" disabled={busyAny} onClick={() => void run('stop')}>
                {busy === 'stop' ? '停止中…' : '停止'}
              </button>
            )}
          </div>
        </div>
        {(status?.port ?? null) != null && (
          <div className="grow-r" style={{ minHeight: 36, padding: '6px 16px' }}>
            <div className="k">端口 / 进程</div>
            <div className="v t3 mono">
              {status?.port} · pid {status?.pid ?? '—'}
            </div>
          </div>
        )}
        <div className="grow-r" style={{ minHeight: 42, padding: '6px 16px' }}>
          <div className="k">版本</div>
          <div className="v">
            <span className="mono">{status?.version || '—'}</span>
            <span className="t3" style={{ fontSize: 12 }}>锁定于 uv.lock，不自动升级</span>
          </div>
        </div>
        <div className="grow-r" style={{ minHeight: 42, padding: '6px 16px' }}>
          <div className="k">解析环境</div>
          <div className="v" style={{ gap: 8 }}>
            {envPath ? (
              <>
                <span className="t3 mono" style={{ fontSize: 12 }} title={`${status?.modelsPath}（模型存放在 App 数据目录，首次从 ~/.mineru/models 克隆复用或下载）`}>
                  {ellipsisMiddle(envPath)}
                </span>
                <span className={`mstate ${status?.modelsReady ? 'ready' : 'crashed'}`} style={{ fontSize: 12 }}>
                  {status?.modelsReady ? '已就绪' : '未就绪'}
                </span>
              </>
            ) : (
              <span className="t3" style={{ fontSize: 12 }}>—</span>
            )}
          </div>
        </div>
        <div className="grow-r" style={{ minHeight: 36, padding: '6px 16px' }} data-testid="mineru-model-size">
          <div className="k">模型文件</div>
          <div className="v t3">{modelSize?.label ?? '…'}</div>
        </div>
        <div className="grow-r" style={{ minHeight: 36, padding: '6px 16px' }} data-testid="mineru-last-parse">
          <div className="k">最近一次解析</div>
          <div className="v t3">{lastText}</div>
        </div>
        <div className="grow-r" style={{ minHeight: 42, padding: '6px 16px' }}>
          <div className="k">重新安装</div>
          <div className="v">
            <button className="btn bordered" disabled={busyAny || state === 'unavailable'} onClick={() => setConfirmReinstall(true)}>
              重新安装…
            </button>
          </div>
        </div>
        {installing && status?.installProgress && (
          <div className="grow-r" style={{ minHeight: 46, padding: '6px 16px', alignItems: 'flex-start', flexDirection: 'column', gap: 6 }}>
            <div className="row" style={{ gap: 8, width: '100%' }}>
              <span className="k" style={{ width: 'auto', fontSize: 12.5 }}>
                {INSTALL_PHASE_LABEL[status.installProgress.phase]}
              </span>
              <button className="btn lnk" style={{ fontSize: 11.5, marginLeft: 'auto' }} onClick={() => setShowInstallDetail((v) => !v)}>
                {showInstallDetail ? '收起详细信息' : '详细信息'}
              </button>
            </div>
            <div className="pbar ind">
              <div className="pbar-fill" />
            </div>
            {showInstallDetail && (
              <div className="t3" style={{ fontSize: 11.5, width: '100%', wordBreak: 'break-all' }}>
                {status.installProgress.detail}
              </div>
            )}
          </div>
        )}
      </div>

      {installFailed && failText && (
        <div className="hintbar warn" style={{ marginTop: 12, alignItems: 'flex-start' }} data-testid="mineru-install-failed">
          <Ic name="warn" size={14} />
          <span style={{ lineHeight: 1.6 }}>
            {failText.title}
            <br />
            {failText.hint}
            {status?.error && (
              <span style={{ display: 'block', marginTop: 4 }}>
                <button className="btn lnk" style={{ fontSize: 11.5 }} onClick={() => setShowFailDetail((v) => !v)}>
                  {showFailDetail ? '收起详细信息' : '详细信息'}
                </button>
                {showFailDetail && (
                  <span className="t3" style={{ fontSize: 11.5, display: 'block', wordBreak: 'break-all' }}>
                    {status.error}
                  </span>
                )}
              </span>
            )}
          </span>
        </div>
      )}

      {state === 'crashed' && status?.error && (
        <div className="hintbar warn" style={{ marginTop: 12 }}>
          <Ic name="warn" size={14} />
          <span>
            {status.error}。自动重启未成功，请手动重新启动；反复失败可尝试「重新安装…」。
          </span>
        </div>
      )}

      <div className="note">
        版本锁定于 uv.lock，不自动升级。MinerU 在本机作为解析组件运行，只监听 127.0.0.1 的随机端口。
        模型存放在 App 数据目录内（sidecar/mineru-home，随数据目录走，备份不含）。旧版留在全局 ~/.mineru/models 的模型已不再使用，可手动删除释放空间。复用时优先 APFS 克隆（几乎不占额外空间）；无法克隆时会普通复制，安装详情和日志会写明约占多少额外磁盘。
      </div>

      <MotionPresence open={confirmReinstall} kind="modal">
        {confirmReinstall ? (
        <ConfirmDialog
          title="重新安装 MinerU？"
          okText={busy === 'reinstall' ? '重装中…' : '重新安装'}
          okDisabled={busy !== false}
          onOk={() => void run('reinstall')}
          onClose={() => setConfirmReinstall(false)}
        >
          会删除本地 Python 环境并重新安装依赖。已有模型会保留，不会重新下载。这一步仍需要几分钟。已有的解析缓存和论文详情不受影响。
        </ConfirmDialog>
        ) : null}
      </MotionPresence>
    </>
  )
}
