import type Database from 'better-sqlite3'
import type { Migration } from './index'

/**
 * 090（uat6c S2 / D183）：jobs 加可空 superseded_at 列——同 (kind, graph, 论文组)
 * 的失败任务被更新的成功取代后标已被取代，状态点 / 弹层计数 / 补排退避不再计它们
 * （不物理删除，状态保留，便于追溯）。取代判定：同 kind、同 graph_id、同论文组签名
 * （paper_id 优先；否则 payload.paperIds 排序签名；全图任务 = 'full'），存在更晚
 * （updated_at, id 字典序）的 succeeded 任务时，较早的 failed_retryable /
 * failed_action 行置 superseded_at。
 *
 * 一次性清理与加列同迁移，纯 JS 按签名精确判定（幂等：只处理 superseded_at IS NULL
 * 的失败行；第二遍零写入；不动运行时已标记的行）。
 */

interface JobRow {
  id: number
  kind: string
  graph_id: number | null
  paper_id: number | null
  payload: string
  status: string
  updated_at: string
  superseded_at: string | null
}

/** 论文组签名：paper_id 优先；payload.paperIds（排序拼接）；全图任务 'full'。 */
function groupSignature(row: JobRow): string {
  if (row.paper_id != null) return `p${row.paper_id}`
  try {
    const p = JSON.parse(row.payload || '{}') as { paperIds?: unknown }
    if (Array.isArray(p.paperIds)) {
      const ids = p.paperIds.filter((x): x is number => typeof x === 'number').sort((a, b) => a - b)
      if (ids.length > 0) return `ids:${ids.join(',')}`
    }
  } catch {
    // 坏 payload 按全图组处理
  }
  return 'full'
}

const later = (a: JobRow, b: JobRow): boolean => a.updated_at > b.updated_at || (a.updated_at === b.updated_at && a.id > b.id)

export const migration090: Migration = {
  version: 90,
  name: 'jobs_superseded_at',
  up(db: Database.Database): void {
    const cols = db.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'superseded_at')) {
      db.exec('ALTER TABLE jobs ADD COLUMN superseded_at TEXT')
    }
    const jobs = db
      .prepare('SELECT id, kind, graph_id, paper_id, payload, status, updated_at, superseded_at FROM jobs')
      .all() as JobRow[]
    const succeeded = jobs.filter((j) => j.status === 'succeeded')
    const stamp = new Date().toISOString()
    const upd = db.prepare('UPDATE jobs SET superseded_at = ? WHERE id = ?')
    for (const f of jobs) {
      if (f.superseded_at != null) continue
      if (f.status !== 'failed_retryable' && f.status !== 'failed_action') continue
      if (f.graph_id == null) continue
      const sig = groupSignature(f)
      const replaced = succeeded.some(
        (s) => s.graph_id === f.graph_id && s.kind === f.kind && groupSignature(s) === sig && later(s, f)
      )
      if (replaced) upd.run(stamp, f.id)
    }
  }
}
