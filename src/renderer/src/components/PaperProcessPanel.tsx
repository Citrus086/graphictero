import { useState } from 'react'
import type { PaperSummary } from '../../../shared/ipc'
import type { MineruStatusView, PaperProcessStatusView } from '../../../shared/ipc/pdf'
import { paperMeta, relTime } from '../lib/format'
import { Ic } from '../lib/icons'
import { ipcErrorMessage } from '../lib/ipcError'
import { useNotify } from '../lib/notify'
import { stepLabel } from '../lib/usePapersStatus'
import { useParseProgress, progressLine } from '../lib/useParseProgress'

const api = window.graphictero

const STEPS = ['parse', 'card', 'detail'] as const

/**
 * 论文处理状态面板（原型 03d/03b，320px 与关系面板同宽）：
 * 一篇论文一个合并任务的三步骤（MinerU 解析 → 生成名片 → 生成详情），
 * 标明失败在哪一步、原因与时间；按步骤重试（D85，调 jobs:retry 从失败步骤接着跑）。
 */
export function PaperProcessPanel({
  paper,
  status,
  sidecar,
  onClose
}: {
  paper: PaperSummary
  status: PaperProcessStatusView | undefined
  sidecar: MineruStatusView | null
  onClose: () => void
}): React.JSX.Element {
  const notify = useNotify()
  const [retrying, setRetrying] = useState(false)
  const progress = useParseProgress(status?.state === 'running' ? paper.id : null)

  const retry = async (): Promise<void> => {
    if (!status?.jobId || retrying) return
    setRetrying(true)
    try {
      await api.retryJob(status.jobId)
      notify('已重新排队，从失败的那一步接着处理')
    } catch (e) {
      notify(ipcErrorMessage(e, '重试失败'))
    } finally {
      setRetrying(false)
    }
  }

  const state = status?.state ?? 'unprocessed'
  const failedStep = status?.failedStep ?? null
  const activeStep = status?.currentStep ?? null

  // 各步骤呈现：failed 红 / 当前步骤转圈 / 之前步骤绿勾 / 之后灰点
  const stepState = (step: (typeof STEPS)[number]): 'done' | 'active' | 'failed' | 'pending' => {
    if (failedStep === step) return 'failed'
    if (state === 'succeeded') return 'done'
    const idx = STEPS.indexOf(step)
    if (activeStep === step) return 'active'
    if (activeStep) {
      const activeIdx = STEPS.indexOf(activeStep as (typeof STEPS)[number])
      if (idx < 0 || activeIdx < 0) return 'pending'
      return idx < activeIdx ? 'done' : 'pending'
    }
    if (failedStep) {
      const failedIdx = STEPS.indexOf(failedStep as (typeof STEPS)[number])
      return idx < failedIdx ? 'done' : 'pending'
    }
    return 'pending'
  }

  return (
    <div className="panel" data-testid="paper-process-panel">
      <div className="ph">
        <b>处理状态</b>
        <button className="btn icon" onClick={onClose} title="关闭">
          <Ic name="close" size={14} />
        </button>
      </div>
      <div className="pb">
        <div className="pcard">
          <div className="t">{paper.title}</div>
          <div className="m">{paperMeta(paper)}</div>
        </div>

        {state === 'unprocessed' && (
          <div className="hintbar" style={{ marginTop: 12 }}>
            <Ic name="info" size={14} />
            <span>
              未处理
              {sidecar && sidecar.state !== 'ready'
                ? '：MinerU 解析组件就绪后会自动开始（可在设置的「PDF 解析」里查看）'
                : '：MinerU 可用后会自动开始处理'}
            </span>
          </div>
        )}
        {state === 'queued' && (
          <div className="hintbar" style={{ marginTop: 12 }}>
            <Ic name="info" size={14} />
            <span>排队中，等待处理</span>
          </div>
        )}
        {state === 'waiting' && (
          <div className="hintbar warn" style={{ marginTop: 12 }}>
            <Ic name="info" size={14} />
            <span>等待中{status?.error ? `：${status.error}` : ''}</span>
          </div>
        )}
        {state === 'running' && (
          <div className="hintbar" style={{ marginTop: 12 }}>
            <Ic name="info" size={14} />
            <span>
              正在{activeStep ? stepLabel(activeStep) : '处理'}
              {activeStep === 'parse' && progress ? ` · ${progressLine(progress)}` : ''}
            </span>
          </div>
        )}
        {state === 'succeeded' && (
          <div className="hintbar" style={{ marginTop: 12 }}>
            <Ic name="check" size={14} />
            <span>处理完成</span>
          </div>
        )}
        {state === 'failed' && (
          <div className="pfail">
            <div className="row" style={{ gap: 6 }}>
              <Ic name="warn" size={14} />
              <b>{failedStep ? `${stepLabel(failedStep)}失败` : '处理失败'}</b>
              {status?.updatedAt && <span className="t3" style={{ fontSize: 11, marginLeft: 'auto' }}>{relTime(status.updatedAt)}</span>}
            </div>
            {status?.error && (
              <div className="t3" style={{ fontSize: 12, lineHeight: '17px', marginTop: 4 }}>
                {status.error}
              </div>
            )}
            {failedStep !== 'parse' && (
              <div className="t3" style={{ fontSize: 11.5, lineHeight: '17px', marginTop: 4 }}>
                该步骤已自动重试 3 次仍未成功，重试会从这一步接着做，前面的步骤不重做。
              </div>
            )}
            <div className="row" style={{ gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
              <button className="btn primary sm" disabled={retrying || !status?.jobId} onClick={() => void retry()}>
                {retrying ? '重试中…' : '重试'}
              </button>
            </div>
          </div>
        )}

        <div className="sect" style={{ marginTop: 14 }}>
          <div className="secth">
            <b>处理步骤</b>
            <span className="tagtxt">一篇论文一个任务</span>
          </div>
          <div className="group">
            {STEPS.map((step) => {
              const st = stepState(step)
              return (
                <div key={step} className={`grow-r pstep ${st}`} style={{ minHeight: 38, padding: '6px 16px' }}>
                  <span className={`pic ${st}`}>
                    {st === 'done' ? <Ic name="check" size={13} /> : st === 'failed' ? <Ic name="close" size={12} /> : null}
                  </span>
                  <div className="k">{stepLabel(step)}</div>
                  <div className="v" style={{ fontSize: 12 }}>
                    {st === 'active' ? '进行中' : st === 'done' ? '完成' : st === 'failed' ? '失败' : '等待'}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
