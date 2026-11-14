import { useEffect, useRef, useState } from 'react'
import type { JobsOverview } from '../../../shared/ipc'
import { ipcErrorMessage } from '../lib/ipcError'
import { humanizeJobError } from '../lib/jobErrorText'
import { useNotify } from '../lib/notify'
import { useMineruStatus } from '../lib/useMineruStatus'
import { mineruUnavailableReason } from '../lib/mineruStatus'
import { MotionPresence } from './MotionPresence'

const api = window.graphictero

const STEP_LABELS: Record<string, string> = {
  parse: '解析',
  card: '名片',
  detail: '生成详情',
  // uat6c-fix1 M1 / D183：relation_gen 步骤中文（界面不出现英文 step id）
  references: '读取引用',
  generate: '生成关系'
}

/**
 * 顶栏全局状态点（D53/D65(2)）：
 * - 平时灰色；有失败任务（failed_retryable / failed_action）变红带数量；
 *   排队中（等待联网 / 缺少 API Key）为空心中性点；
 * - uat1：MinerU 安装失败（install_failed）与 crashed 让状态点变错误色，弹层「环境」组
 *   出现「解析组件（MinerU）安装失败/运行失败 · 重试」。
 * - uat1b D144：MinerU 不可用期间（未安装/安装中/安装失败/已停止/启动中/重启中/崩溃），
 *   有论文在等待解析时弹层出现「解析组件不可用 · 影响 N 篇 · 去设置」一行（写法同
 *   D70 汇总行）；仅有未安装/安装中时不点红（D95 不点红），用中性空心点。
 *   环境条目不是伪造的解析任务（D95 语义不变：不入队、不算失败）。
 * - 点开是任务状态弹层：401/402 暂停时顶部一行汇总「API Key 无效 · 影响 N 个任务」
 *   （D70），下分「需要你处理」（failed_action，uat6c D183：列出标题 + 失败步骤 +
 *   失败原因，带「重试」——需要你处理但可手动重试，同一 retryJob 通路）和
 *   「可重试」（failed_retryable，带「重试」）两组；两组重试都防同 tick 双击
 *   （ref 守到 IPC finally）。自动补排仍永不重排 failed_action（background.ts）。
 */
export function StatusDot({
  onOpenSettings,
  onOpenParseSettings
}: {
  onOpenSettings?: () => void
  /** uat1b D144：直达 设置 → PDF 解析（缺省退回 onOpenSettings） */
  onOpenParseSettings?: () => void
}): React.JSX.Element {
  const notify = useNotify()
  const [ov, setOv] = useState<JobsOverview | null>(null)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // uat1/uat1b：MinerU 环境状态（与 jobs 概览相互独立）
  const mineru = useMineruStatus()
  const mineruState = mineru?.state
  const mineruReason = mineruUnavailableReason(mineruState)
  /** uat1（错误态）：安装失败 / 崩溃后不再自动重启 / 已停止 */
  const mineruHardDown = mineruState === 'install_failed' || mineruState === 'crashed' || mineruState === 'stopped'
  /** uat1b D144：等待解析组件的论文数（null = 尚未取到；-1 闪空态修掉，见 uat1-fix1 建议修 9） */
  const [waitingCount, setWaitingCount] = useState<number | null>(null)
  /** uat1-fix1：弹层「重试」进行中禁连点 */
  const [mineruRetrying, setMineruRetrying] = useState(false)
  /** uat1b D144：D144 汇总行显示条件（不可用 + 已取到计数 + N>0） */
  const showWaitingRow = mineruReason != null && waitingCount != null && waitingCount > 0
  useEffect(() => {
    let alive = true
    const load = (): void => {
      api
        .getWaitingCount()
        .then((n) => {
          if (alive) setWaitingCount(n)
        })
        .catch(() => {
          // 取不到不打扰（旧主进程 / 测试 mock 缺该方法）；下一轮 5s 轮询再试
        })
    }
    load()
    const t = setInterval(load, 5000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  useEffect(() => {
    let alive = true
    const poll = async (): Promise<void> => {
      try {
        const o = await api.getJobsOverview()
        if (alive) setOv(o)
      } catch {
        // 主进程还没就绪等瞬时失败：下一轮再说
      }
    }
    void poll()
    const t = setInterval(() => void poll(), 5000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    // uat6 S6 + D176：Esc 只关状态弹层；capture 处理后停止同一次事件继续清画布选择。
    // 焦点在输入控件时仍让控件先处理（uat5 笔记 / 搜索语义不变）。
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      setOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const actionable = (ov?.failed ?? []).filter((f) => f.status === 'failed_action')
  const retryable = (ov?.failed ?? []).filter((f) => f.status === 'failed_retryable')
  // D197：角标数实际显示条目；一条合并项 = 1，合并任务数只在行内 ×N 展示。
  const failedCount = actionable.length + retryable.length
  const waiting = (ov?.waitingNetwork ?? 0) + (ov?.waitingKey ?? 0)
  // uat2：真正在跑 / 排队等并发额度的任务（有其一就不能说「没有失败或排队的任务」）
  const activeJobs = (ov?.running ?? 0) + (ov?.queued ?? 0)
  // uat1/uat1b：安装失败/崩溃/已停止点红（角标仍只数失败任务）；其余不可用态（未安装/
  // 安装中/启动中/重启中）只在无其它信号时用中性空心点提示（D95 不点红）
  const dotClass =
    failedCount > 0 || ov?.pauseSummary || mineruHardDown
      ? 'dot red'
      : waiting > 0 || mineruReason != null
        ? 'dot hollow'
        : 'dot'

  const retryMineru = async (): Promise<void> => {
    if (mineruRetrying) return
    setMineruRetrying(true)
    try {
      // uat1-fix1：install_failed/crashed/stopped 统一走 start()——未安装先装再拉服务，
      // 成功终态 ready（服务起好才 resolve），经 ready 事件触发 D95 补排
      await api.startMineru()
    } catch (e) {
      notify(ipcErrorMessage(e, '重试 MinerU 失败'))
    } finally {
      setMineruRetrying(false)
    }
  }

  // uat6c M2 / D183：重试防重复点击——ref 守卫守到 IPC finally（同 tick 双击只发一次）
  const retryGuard = useRef(new Set<number>())
  const [retryingIds, setRetryingIds] = useState<ReadonlySet<number>>(new Set())
  const retry = async (jobId: number): Promise<void> => {
    if (retryGuard.current.has(jobId)) return
    retryGuard.current.add(jobId)
    setRetryingIds(new Set(retryGuard.current))
    try {
      await api.retryJob(jobId)
      setOv(await api.getJobsOverview()) // 成功后该行从分组消失、状态点计数刷新
    } catch (e) {
      notify(ipcErrorMessage(e, '重试失败'))
    } finally {
      retryGuard.current.delete(jobId)
      setRetryingIds(new Set(retryGuard.current))
    }
  }

  return (
    <div className="stdot" ref={ref}>
      <button
        className="btn icon"
        title="任务状态"
        onClick={() => setOpen((v) => !v)}
        style={{ position: 'relative' }}
      >
        <span className={dotClass}>{failedCount > 0 && <span className="n">{failedCount}</span>}</span>
      </button>
      <MotionPresence open={open && ov != null} kind="pop">
        {open && ov ? (
        <div className="stpop" data-esc-popover>
          {ov.pauseSummary && (
            <>
              <div className="cap">需要你处理</div>
              <div className="strow" style={{ borderTop: 'none' }}>
                <span className="t">{ov.pauseSummary}</span>
                {onOpenSettings && (
                  <button
                    className="btn bordered sm"
                    onClick={() => {
                      setOpen(false)
                      onOpenSettings()
                    }}
                  >
                    去设置
                  </button>
                )}
              </div>
            </>
          )}
          {waiting > 0 && (
            <div className="t3" style={{ fontSize: 11.5, padding: '4px 0' }}>
              排队中 {waiting} 个任务（{[
                ov.waitingNetwork > 0 ? `等待联网 ${ov.waitingNetwork}` : '',
                ov.waitingKey > 0 ? `等待 API Key ${ov.waitingKey}` : ''
              ].filter(Boolean).join('，')}）· 条件满足后自动继续
            </div>
          )}
          {/* uat2：串行队列可见——正在跑 / 排队等并发额度的任务（queued 口径 = 排队中）；
              uat4 D167：除计数外列出正在处理 / 排队的论文简称 */}
          {activeJobs > 0 && (
            <div className="t3" style={{ fontSize: 11.5, padding: '4px 0' }} data-testid="stpop-active">
              {ov.running > 0 ? `处理中 ${ov.running} 个任务` : ''}
              {ov.running > 0 && ov.queued > 0 ? ' · ' : ''}
              {ov.queued > 0 ? `排队中 ${ov.queued} 个任务` : ''}
              {(ov.active?.length ?? 0) > 0 && (
                <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: '2px 8px' }} data-testid="stpop-active-names">
                  {ov.active!.map((a) => (
                    <span key={a.jobId} title={a.step ? STEP_LABELS[a.step] ?? a.step : ''}>
                      {a.paperTitle}
                      {a.status === 'queued' ? '（排队中）' : a.status === 'waiting_network' ? '（等待联网）' : a.status === 'waiting_key' ? '（等待 API Key）' : ''}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          {/* uat6c M2 / D183：failed_action =「需要你处理，但可手动重试」——列出
              标题 + 失败步骤 + 失败原因，并带「重试」按钮（同一 retryJob 通路，与
              可重试分组同一实现）；自动补排仍永不重排 failed_action（background.ts 不变） */}
          {actionable.length > 0 && (
            <>
              {!ov.pauseSummary && <div className="cap">需要你处理</div>}
              {actionable.map((f) => {
                const reason = humanizeJobError(f.error)
                return (
                <div key={f.jobId} className="strow" data-testid="stpop-actionable">
                  <span className="t">{f.paperTitle || `任务 ${f.jobId}`}</span>
                  {(f.count ?? 1) > 1 && <span className="strow-mult" data-testid="stpop-count">{` ×${f.count}`}</span>}
                  <span className="e" title={reason.detail}>
                    {STEP_LABELS[f.failedStep ?? ''] ?? f.failedStep ?? ''} · {reason.summary}
                  </span>
                  <button
                    className="btn bordered sm"
                    data-testid="stpop-retry-actionable"
                    disabled={retryingIds.has(f.jobId)}
                    onClick={() => void retry(f.jobId)}
                  >
                    {retryingIds.has(f.jobId) ? '重试中…' : '重试'}
                  </button>
                </div>
                )
              })}
            </>
          )}
          {retryable.length > 0 && (
            <>
              <div className="cap">可重试（已自动重试 3 次）</div>
              {retryable.map((f) => {
                const reason = humanizeJobError(f.error)
                return (
                <div key={f.jobId} className="strow">
                  <span className="t">{f.paperTitle || `任务 ${f.jobId}`}</span>
                  {(f.count ?? 1) > 1 && <span className="strow-mult" data-testid="stpop-count">{` ×${f.count}`}</span>}
                  <span className="e" title={reason.detail}>
                    {STEP_LABELS[f.failedStep ?? ''] ?? ''} 失败 · {reason.summary}
                  </span>
                  <button className="btn bordered sm" disabled={retryingIds.has(f.jobId)} onClick={() => void retry(f.jobId)}>
                    {retryingIds.has(f.jobId) ? '重试中…' : '重试'}
                  </button>
                </div>
                )
              })}
            </>
          )}
          {/* uat1/uat1b：MinerU 环境条目（D95：不伪造解析任务行）——「环境」组合并：
              错误行（安装失败/运行失败/已停止，带重试）+ D144 汇总行（不可用 · 影响 N 篇，带去设置） */}
          {(mineruHardDown || showWaitingRow) && (
            <>
              <div className="cap">环境</div>
              {mineruHardDown && (
                <div className="strow" data-testid="stpop-mineru-env">
                  <span className="t">解析组件（MinerU）{mineruState === 'install_failed' ? '安装失败' : mineruState === 'crashed' ? '运行失败' : '已停止'}</span>
                  <button className="btn bordered sm" disabled={mineruRetrying} onClick={() => void retryMineru()}>
                    {mineruRetrying ? '重试中…' : '重试'}
                  </button>
                </div>
              )}
              {showWaitingRow && (
                <div className="strow" data-testid="stpop-mineru-waiting">
                  <span className="t">解析组件不可用 · 影响 {waitingCount} 篇</span>
                  {(onOpenParseSettings ?? onOpenSettings) && (
                    <button
                      className="btn bordered sm"
                      onClick={() => {
                        setOpen(false)
                        ;(onOpenParseSettings ?? onOpenSettings)!()
                      }}
                    >
                      去设置
                    </button>
                  )}
                </div>
              )}
            </>
          )}
          {/* uat1-fix1 建议修 9：waitingCount 未取到（null）时不闪「没有失败或排队的任务」；
              uat2：有 running/queued 任务时同样不写这句 */}
          {failedCount === 0 && waiting === 0 && activeJobs === 0 && !ov.pauseSummary && !mineruHardDown && !showWaitingRow && waitingCount !== null && (
            <div className="t3" style={{ fontSize: 12 }}>
              没有失败或排队的任务
            </div>
          )}
        </div>
        ) : null}
      </MotionPresence>
    </div>
  )
}
