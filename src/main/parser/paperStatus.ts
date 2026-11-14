import type Database from 'better-sqlite3'
import type { LastParseView, PaperProcessState, PaperProcessStatusView } from '../../shared/ipc/pdf'

/**
 * 论文处理状态的读取侧（失败标记数据通路，D48/D85；03d 界面数据源）。
 * 不新增表：由最新一条 process_paper 任务派生（jobs 已记 status / failed_step /
 * error / updated_at）。「未处理」= 从未入过队（D95 口径，含终态失败之外的无任务）。
 * M5 前置 2a：另派生 detailRegen（最新一条 detail_regen 的进行态，独立字段）。
 */
export function getPapersProcessStatus(db: Database.Database, paperIds: number[]): PaperProcessStatusView[] {
  const stmt = db.prepare(
    `SELECT id, paper_id, status, current_step, failed_step, error, updated_at
       FROM jobs
      WHERE kind = 'process_paper' AND paper_id = ?
      ORDER BY updated_at DESC, id DESC LIMIT 1`
  )
  // M5 前置 2a：另查最新一条 detail_regen，进行态独立成字段（不并进 state，与
  // process 状态并存互不覆盖——regen 期间名片/详情早已就绪，state 保持 succeeded）
  const regenStmt = db.prepare(
    `SELECT status FROM jobs
      WHERE kind = 'detail_regen' AND paper_id = ?
      ORDER BY updated_at DESC, id DESC LIMIT 1`
  )
  return paperIds.map((paperId) => {
    const row = stmt.get(paperId) as
      | {
          id: number
          paper_id: number
          status: string
          current_step: string | null
          failed_step: string | null
          error: string | null
          updated_at: string
        }
      | undefined
    const detailRegen = mapDetailRegen(
      (regenStmt.get(paperId) as { status: string } | undefined)?.status
    )
    if (!row) {
      return {
        paperId,
        jobId: null,
        state: 'unprocessed' as PaperProcessState,
        currentStep: null,
        failedStep: null,
        error: null,
        updatedAt: null,
        detailRegen
      }
    }
    return {
      paperId,
      jobId: row.id,
      state: mapState(row.status),
      currentStep: row.status === 'running' || row.status === 'waiting_network' || row.status === 'waiting_key' ? row.current_step : null,
      failedStep: row.status === 'failed_retryable' || row.status === 'failed_action' ? row.failed_step : null,
      // 等待态也带原因（如「缺少 API Key」「等待联网」），失败态带失败原因
      error:
        row.status === 'failed_retryable' || row.status === 'failed_action' || row.status === 'waiting_network' || row.status === 'waiting_key'
          ? row.error
          : null,
      updatedAt: row.updated_at,
      detailRegen
    }
  })
}

/** detail_regen 只暴露进行态（queued/running/waiting_*）；succeeded/failed 等终态对
 *  界面无意义（完成刷新走 event:detail:updated，失败走任务弹层），一律 null */
function mapDetailRegen(status: string | undefined): PaperProcessStatusView['detailRegen'] {
  if (status === 'queued' || status === 'running' || status === 'waiting_network' || status === 'waiting_key') return status
  return null
}

function mapState(status: string): PaperProcessState {
  switch (status) {
    case 'succeeded':
      return 'succeeded'
    case 'failed_retryable':
    case 'failed_action':
      return 'failed'
    case 'running':
      return 'running'
    case 'waiting_network':
    case 'waiting_key':
      return 'waiting'
    case 'queued':
    default:
      return 'queued'
  }
}

/** 设置页「最近一次解析」（只读）：最近一条已结束的解析步骤（成功或失败）。从未结束为 null。 */
export function getLastParseInfo(db: Database.Database): LastParseView | null {
  const row = db
    .prepare(
      `SELECT s.finished_at AS at, s.started_at AS started, s.status AS status
       FROM job_steps s JOIN jobs j ON j.id = s.job_id
       WHERE j.kind = 'process_paper' AND s.step = 'parse'
         AND s.status IN ('succeeded', 'failed') AND s.finished_at IS NOT NULL
       ORDER BY s.finished_at DESC LIMIT 1`
    )
    .get() as { at: string; started: string | null; status: string } | undefined
  if (!row) return null
  let durationSec: number | null = null
  if (row.started) {
    const ms = new Date(row.at).getTime() - new Date(row.started).getTime()
    if (Number.isFinite(ms) && ms >= 0) durationSec = Math.round(ms / 1000)
  }
  return { at: row.at, durationSec, ok: row.status === 'succeeded' }
}
