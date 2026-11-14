import { useEffect, useState } from 'react'
import type { ParseProgressView } from '../../../shared/ipc/pdf'

const api = window.graphictero

/** 订阅单篇论文的解析进度（event:pdf:parseProgress；03d 面板数据源） */
export function useParseProgress(paperId: number | null): ParseProgressView | null {
  const [p, setP] = useState<ParseProgressView | null>(null)
  useEffect(() => {
    setP(null)
    if (paperId == null) return
    return api.onParseProgress((ev) => {
      if (ev.paperId === paperId) setP(ev)
    })
  }, [paperId])
  return p
}

/** 订阅全部论文的解析进度（解析队列数据源：paperId → 最新进度） */
export function useParseProgressMap(): Map<number, ParseProgressView> {
  const [map, setMap] = useState<Map<number, ParseProgressView>>(new Map())
  useEffect(() => {
    return api.onParseProgress((ev) => {
      setMap((m) => {
        const n = new Map(m)
        n.set(ev.paperId, ev)
        return n
      })
    })
  }, [])
  return map
}

function stageLabel(stage: ParseProgressView['stage']): string {
  return stage === 'upload' ? '上传 PDF' : stage === 'parse' ? '解析' : '取回结果'
}

/** 解析进度一行文案：优先页码（D72 best-effort），退回文件计数 + 已用时长 */
export function progressLine(p: ParseProgressView): string {
  const stage = stageLabel(p.stage)
  if (p.pagesDone != null && p.pagesTotal != null) return `${stage} · 第 ${p.pagesDone}/${p.pagesTotal} 页 · 已用 ${p.elapsedSec}s`
  if (p.totalFiles > 0) return `${stage} · 文件 ${p.completedFiles}/${p.totalFiles} · 已用 ${p.elapsedSec}s`
  return `${stage} · 已用 ${p.elapsedSec}s`
}
