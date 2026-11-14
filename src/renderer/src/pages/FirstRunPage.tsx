import { useRef, useState } from 'react'
import { useMineruStatus } from '../lib/useMineruStatus'
import { INSTALL_PHASE_LABEL, installFailedText, mineruApi } from '../lib/mineruStatus'

/**
 * 首次启动安装界面（原型 #/00，D57 首启安装 / D82 简单进度条；uat1 实装）：
 * sidecar 处于 not_installed / installing / install_failed 时取代首页。
 * - 安装中：标题 + 不确定进度条（D82：不做分步安装界面）+ 一行中文阶段说明
 *   （「正在安装依赖…」/「正在下载模型文件…」，不糊 uv/pip 原始输出）+ 原型固定两行说明；
 * - 失败（install_failed，uat1）：进度条换成通俗中文失败说明 + 「重试」+
 *   「先跳过，稍后再装」出口；开发者原文（退出码 / stderr 末行）收进「详细信息」。
 * - 安装成功（状态离开安装族）后 App 自动切回首页（App.tsx 判定）。
 */
export function FirstRunPage({ onSkip }: { onSkip: () => void }): React.JSX.Element {
  const status = useMineruStatus()
  const [retrying, setRetrying] = useState(false)
  const [showDetail, setShowDetail] = useState(false)
  // uat1-fix1 建议修 10：连点防护要同步生效（ref 在事件里立刻置位，不等重渲染）——
  // install() 在 installing 时会静默 return，靠一次 finally 会提前解锁按钮
  const retryingRef = useRef(false)

  const state = status?.state ?? 'not_installed'
  const failed = state === 'install_failed'
  // uat1-fix1：禁用盖住整个 installing|starting（start() 到 ready 才 resolve，期间一直禁用）
  const busy = state === 'installing' || state === 'starting' || retrying
  const phaseLabel = status?.installProgress ? INSTALL_PHASE_LABEL[status.installProgress.phase] : '正在准备…'
  const fail = failed && status?.error ? installFailedText(status.error) : null

  const retry = (): void => {
    if (retryingRef.current) return
    retryingRef.current = true
    setRetrying(true)
    // uat1-fix1：经 pdf:sidecarInstall → start()，成功终态 ready（服务起好才 resolve）——
    // 结果经 event:pdf:sidecar 推回；promise 自身的 reject 只是「又失败了」，交给状态推送呈现
    mineruApi()
      .installMineru()
      .catch(() => {})
      .finally(() => {
        retryingRef.current = false
        setRetrying(false)
      })
  }

  return (
    <div className="appwin" style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 520, maxWidth: '80vw' }} data-testid="first-run-page">
        <div style={{ fontSize: 15.5, fontWeight: 600 }}>正在安装解析组件（MinerU）</div>

        {!failed && (
          <>
            {/* D82 简单进度条：安装输出只有文本行没有百分比，用不确定进度条 */}
            <div className="pbar ind" style={{ marginTop: 18 }}>
              <div className="pbar-fill" />
            </div>
            <div className="t3" style={{ fontSize: 12, marginTop: 8 }}>{phaseLabel}</div>
          </>
        )}

        {fail && (
          <div data-testid="first-run-failed">
            <div className="hintbar warn" style={{ marginTop: 18, alignItems: 'flex-start' }}>
              <span data-testid="first-run-fail-text" style={{ lineHeight: 1.6 }}>
                {fail.title}
                <br />
                {fail.hint}
              </span>
            </div>
            <div className="row" style={{ gap: 8, marginTop: 14 }}>
              <button className="btn primary" disabled={busy} onClick={retry} data-testid="first-run-retry">
                {retrying ? '正在重试…' : '重试'}
              </button>
              <button className="btn bordered" onClick={onSkip} data-testid="first-run-skip">
                先跳过，稍后再装
              </button>
            </div>
            {status?.error && (
              <div style={{ marginTop: 12 }}>
                <button className="btn lnk" onClick={() => setShowDetail((v) => !v)}>
                  {showDetail ? '收起详细信息' : '详细信息'}
                </button>
                {showDetail && (
                  <div className="t3" style={{ fontSize: 11.5, marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                    {status.error}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* 原型 00 固定两行说明（照原型断行，不出孤字） */}
        <div className="t2" style={{ fontSize: 12.5, marginTop: 18, lineHeight: '19px' }}>
          <span style={{ display: 'block' }}>Graphictero 首次启动会在本机安装 Python 和 MinerU，</span>
          <span style={{ display: 'block' }}>并下载模型文件（几 GB），只需一次。</span>
        </div>
      </div>
    </div>
  )
}
