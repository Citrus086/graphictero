import { useEffect, useState } from 'react'
import type { PaperSummary } from '../../../shared/ipc'
import type { PaperProcessStatusView } from '../../../shared/ipc/pdf'
import { failTitle, usePapersStatus } from '../lib/usePapersStatus'
import { useParseProgressMap, progressLine } from '../lib/useParseProgress'
import { useNotify } from '../lib/notify'

const api = window.graphictero

const STATE_TEXT: Record<string, string> = {
  queued: '排队中',
  running: '处理中',
  waiting: '等待中',
  failed: '失败'
}

/**
 * 设置页「PDF 解析」组的解析队列：排队/运行/等待/失败的论文与实时进度
 * （event:pdf:parseProgress），底部一行未处理计数（D95：MinerU 可用后自动开始）。
 */
export function ParseQueueSection(): React.JSX.Element {
  const notify = useNotify()
  const [library, setLibrary] = useState<PaperSummary[]>([])
  useEffect(() => {
    let alive = true
    api
      .listLibrary()
      .then((lib) => {
        if (alive) setLibrary(lib)
      })
      .catch(() => {
        // 队列区加载失败不打扰设置页
      })
    return () => {
      alive = false
    }
  }, [])

  const statuses = usePapersStatus(library.map((p) => p.id))
  const progress = useParseProgressMap()

  const active = library.filter((p) => {
    const s = statuses.get(p.id)?.state
    return s === 'queued' || s === 'running' || s === 'waiting' || s === 'failed'
  })
  const unprocessed = library.filter((p) => p.hasPdf && statuses.get(p.id)?.state === 'unprocessed').length

  const rowText = (p: PaperSummary, s: PaperProcessStatusView | undefined): string => {
    if (!s) return ''
    if (s.state === 'running') {
      const line = s.currentStep === 'parse' && progress.get(p.id) ? ` · ${progressLine(progress.get(p.id)!)}` : ''
      return `处理中${line}`
    }
    if (s.state === 'waiting') return `等待中${s.error ? `：${s.error}` : ''}`
    return STATE_TEXT[s.state] ?? s.state
  }

  return (
    <>
      <div className="ghead" style={{ marginTop: 22 }}>
        解析队列
      </div>
      {active.length === 0 ? (
        <div className="note" style={{ marginTop: 0 }}>
          当前没有排队或运行中的解析任务。
        </div>
      ) : (
        <div className="group">
          {active.map((p) => {
            const s = statuses.get(p.id)
            return (
              <div key={p.id} className="grow-r" style={{ minHeight: 38, padding: '6px 16px' }}>
                <div className="k" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.title}>
                  {p.title}
                </div>
                <div className={`v q-${s?.state ?? ''}`} style={{ fontSize: 12, flex: 'none' }} title={s?.state === 'failed' ? failTitle(s) : ''}>
                  {rowText(p, s)}
                </div>
              </div>
            )
          })}
        </div>
      )}
      {unprocessed > 0 && (
        <div className="note">{unprocessed} 篇有 PDF 的论文未处理：MinerU 可用后会自动开始解析。</div>
      )}
    </>
  )
}
