import { useEffect, useRef, useState } from 'react'
import type { PaperProcessStatusView } from '../../../shared/ipc/pdf'

const api = window.graphictero

/**
 * 论文处理状态（失败标记数据通路，D48/D85）：
 * 按可见论文 id 批量拉取 pdf:papersStatus，失败条目带失败步骤与原因。
 * 03d 完整界面（PaperProcessPanel）与库列表/图谱侧栏红点共用本 hook。
 *
 * 评审建 7：只在 mount/id 变化时拉一次会让页面停留期间发生的失败迟迟不显示——
 * 现在订阅 event:pdf:parseProgress 与 event:pdf:sidecar 做事件驱动刷新（防抖 800ms，
 * 解析进度可能按页推送），有进行中状态时另有 5 秒兜底轮询，丢事件也能收敛。
 */
export function usePapersStatus(paperIds: number[]): Map<number, PaperProcessStatusView> {
  const [map, setMap] = useState<Map<number, PaperProcessStatusView>>(new Map())
  const key = paperIds.join(',')
  const idsRef = useRef(paperIds)
  idsRef.current = paperIds
  const mapRef = useRef(map)
  mapRef.current = map

  useEffect(() => {
    if (paperIds.length === 0) {
      setMap(new Map())
      return
    }
    let alive = true
    const load = (): void => {
      api
        .getPapersStatus(idsRef.current)
        .then((rows) => {
          if (alive) setMap(new Map(rows.map((r) => [r.paperId, r])))
        })
        .catch(() => {
          // 状态拉取失败不打扰主界面
        })
    }
    load()

    // 事件驱动刷新（建 7）：解析进度 / sidecar 状态变化 → 防抖重拉
    let timer: ReturnType<typeof setTimeout> | null = null
    const bump = (): void => {
      if (timer != null) return
      timer = setTimeout(() => {
        timer = null
        load()
      }, 800)
    }
    const offProgress = api.onParseProgress(bump)
    const offSidecar = api.onMineruStatus(bump)

    // 兜底轮询：只要还有排队/运行/等待中的论文，或 detail_regen 进行中
    // （regen 完成靠 event:detail:updated 刷详情内容，指示器消失靠这里 5s 兜底），
    // 就持续 5 秒一刷
    const poll = setInterval(() => {
      for (const s of mapRef.current.values()) {
        if (s.state === 'queued' || s.state === 'running' || s.state === 'waiting' || s.detailRegen != null) {
          load()
          return
        }
      }
    }, 5000)

    return () => {
      alive = false
      if (timer != null) clearTimeout(timer)
      offProgress()
      offSidecar()
      clearInterval(poll)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return map
}

const STEP_LABEL: Record<string, string> = {
  parse: 'MinerU 解析',
  card: '生成名片',
  detail: '生成详情'
}

export function failTitle(s: PaperProcessStatusView): string {
  const step = s.failedStep ? (STEP_LABEL[s.failedStep] ?? s.failedStep) : '处理'
  return `处理失败（${step}）${s.error ? `：${s.error}` : ''}`
}

/** 各处理步骤的中文标签（03d 三步骤用，含 unprocessed 等状态文案见组件） */
export function stepLabel(step: string): string {
  return STEP_LABEL[step] ?? step
}
