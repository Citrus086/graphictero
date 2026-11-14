import { useEffect, useState } from 'react'
import type { MineruStatusView } from '../../../shared/ipc/pdf'
import { mineruApi } from './mineruStatus'

/**
 * MinerU sidecar 状态（设置页 PDF 解析组 / 03d 失败原因数据通路 / uat1 首启界面与状态点）：
 * 首查 pdf:sidecarStatus，之后随 event:pdf:sidecar 推送实时刷新。
 * uat1：统一走 mineruApi() 渲染层接缝（smoke 模式为内存 mock，真实环境 window.graphictero）。
 */
export function useMineruStatus(): MineruStatusView | null {
  const [status, setStatus] = useState<MineruStatusView | null>(null)
  useEffect(() => {
    let alive = true
    const api = mineruApi()
    api
      .getMineruStatus()
      .then((s) => {
        if (alive) setStatus(s)
      })
      .catch(() => {
        // sidecar 状态拿不到不打扰主界面
      })
    const off = api.onMineruStatus((s) => setStatus(s))
    return () => {
      alive = false
      off()
    }
  }, [])
  return status
}
