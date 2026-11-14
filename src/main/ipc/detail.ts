import { ipcMain } from 'electron'
import { IPC_DETAIL } from '../../shared/ipc/detail'
import { getDetailView, getPaperMetaView } from '../llm/detail'
import { enqueueJob } from '../jobs/store'
import type { AppState, IpcWrap } from './types'

/** 对齐 src/main/ipc/pdf.ts requirePaperId 先例：IPC 边界拒字符串/负数/小数 */
function requirePaperId(paperId: unknown): number {
  if (!Number.isInteger(paperId) || (paperId as number) <= 0) throw new Error(`论文 ID 不合法（${String(paperId)}）`)
  return paperId as number
}

/**
 * lane/detail 车道的 IPC 注册模块（M4 批 1 实装）：
 * - detail:get → 缓存 parts + 元信息 + staleReason（D29，服务层见 llm/detail.ts）；
 * - detail:getMeta → 详情页头部元数据（03 / 03e 简版）；
 * - detail:regenerate → 入队 detail_regen（D42/D108：覆盖、不保留旧版、不进撤销历史 D50），
 *   顺手触发一次调度（生产有 2s 定时器兜底，事件触发让 UI 即时反映排队）。
 */
export function registerDetailIpc(state: AppState, h: IpcWrap): void {
  ipcMain.handle(
    IPC_DETAIL.get,
    h((_e: unknown, paperId: number) => getDetailView(state.db, requirePaperId(paperId)))
  )
  ipcMain.handle(
    IPC_DETAIL.getMeta,
    h((_e: unknown, paperId: number) => getPaperMetaView(state.db, requirePaperId(paperId)))
  )
  ipcMain.handle(
    IPC_DETAIL.regenerate,
    h((_e: unknown, paperId: number): number => {
      const id = requirePaperId(paperId)
      const exists = state.db.prepare('SELECT 1 FROM papers WHERE id = ? AND deleted_at IS NULL AND has_pdf = 1').get(id)
      if (!exists) throw new Error(`论文 ${id} 不存在、已删除或没有 PDF，无法重新生成详情`)
      const jobId = enqueueJob(state.db, 'detail_regen', { paperId: id })
      void state.runner?.drain().catch(() => {
        /* 调度异常由定时器兜底，不阻断入队响应 */
      })
      return jobId
    })
  )
}
