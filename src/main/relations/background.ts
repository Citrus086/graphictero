import type Database from 'better-sqlite3'
import type { RelationGenEngine } from './engine'
import { paperDetailText } from './context'
import { processedPaperIds } from './progress'

/**
 * 关系生成的后台调度（Q4 口径：本车道只导出 startRelationsBackground(deps)，
 * 合并回 main 时 src/main/index.ts 只加一行调用；本车道不改 index.ts）。
 *
 * - 启动恢复：立即 resumeWaiting（waiting_network / waiting_key 回 queued）+ drain，
 *   重启前遗留的 queued 任务因此被捞起来跑；
 * - 周期 drain：默认 2s 轮询（对齐 process_paper 的 JobRunner drainTimer），
 *   保证 next_retry_at 到期的重试任务被重新调度；
 * - 新增论文自动补排：默认 30s 扫一遍「有详情就绪却还没处理过的参与论文」的
 *   图，按图入队——新加论文的详情由解析 / 详情任务异步产出，就绪后在这里自动
 *   补上关系生成（D62/D88：解析成功后自动补关系）。
 *   uat2 修正：扫描范围从「有 relation_gen_progress 行的图」改为「有成员的图」——
 *   首次建图时详情普遍未就绪，首跑 relation_gen 空跑 succeeded 不留 progress 行，
 *   旧口径会让该图永远漏补（UAT relations=0 的根因）；新口径下详情就绪后扫描自然接上。
 *   不重复入队：同图活动任务时 engine.enqueue 幂等合并（engine.ts，回归测试在 engine.test.ts）。
 */

export interface RelationsBackgroundDeps {
  /** 惰性取库（与引擎同口径） */
  db: () => Database.Database
  engine: RelationGenEngine
  /** drain 轮询间隔，默认 2000ms（对齐 process_paper） */
  drainIntervalMs?: number
  /** 新增论文补排扫描间隔，默认 30000ms */
  backfillIntervalMs?: number
  log?: (msg: string) => void
}

export interface RelationsBackgroundHandle {
  stop(): void
}

export function startRelationsBackground(deps: RelationsBackgroundDeps): RelationsBackgroundHandle {
  const log = deps.log ?? ((msg: string) => console.error('[graphictero]', msg))
  const drainOnce = (): void => {
    try {
      deps.engine.resumeWaiting()
      void deps.engine.drain().catch((e) => log(`关系引擎 drain 异常：${e instanceof Error ? e.message : String(e)}`))
    } catch (e) {
      log(`关系引擎 drain 异常：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const backfillOnce = (): void => {
    try {
      backfillNewPapers(deps.db(), deps.engine)
    } catch (e) {
      log(`关系补排扫描异常：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  drainOnce() // 启动恢复
  const drainTimer = setInterval(drainOnce, deps.drainIntervalMs ?? 2000)
  const backfillTimer = setInterval(backfillOnce, deps.backfillIntervalMs ?? 30000)
  return {
    stop(): void {
      clearInterval(drainTimer)
      clearInterval(backfillTimer)
    }
  }
}

/** 只读扫描 + 入队；可独立单测。返回本次补排的 { graphId, paperIds } 列表。 */

/**
 * uat6b M2 维护者口径：关系补排
 * 停止重试风暴——按 (graph, paper) 看 jobs 表终态失败推算，不新增表：
 * - 永久失败（failed_action，如 OpenAlex 400 / LLM 400）：**不再自动补排**，只留
 *   手动重试（状态弹层 / jobsRetry）；手动重试成功后论文进入 relation_gen_progress，
 *   自然恢复补排口径。
 * - 可恢复失败（failed_retryable：网络 / 5xx / 429 重试耗尽）：指数退避后再自动补排——
 *   第 1 次失败后 1 min、第 2 次后 4 min（×4）；满 3 次后停止自动补排，只留手动重试。
 * 只统计显式 paperIds 的失败任务（补排产物）；全图任务（手动「重新生成关系」）不参与
 * 按论文门控。jobs.updated_at 为最近失败时刻。
 */
export const AUTO_RETRY_BASE_MS = 60_000
export const AUTO_RETRY_FACTOR = 4
export const AUTO_RETRY_MAX_FAILURES = 3

interface PaperFailures {
  count: number
  lastAt: number
  permanent: boolean
}

/** 本图 relation_gen 终态失败任务 → 按论文字段 paperIds 聚合的失败记录（JS 侧解析 payload） */
function relationFailuresByPaper(db: Database.Database, graphId: number): Map<number, PaperFailures> {
  const jobs = db
    .prepare(
      `SELECT payload, status, updated_at FROM jobs
       WHERE kind = 'relation_gen' AND graph_id = ? AND status IN ('failed_action', 'failed_retryable')
         AND superseded_at IS NULL`
    )
    .all(graphId) as Array<{ payload: string; status: string; updated_at: string }>
  const map = new Map<number, PaperFailures>()
  for (const j of jobs) {
    let ids: number[] | null = null
    try {
      const p = JSON.parse(j.payload || '{}') as { paperIds?: unknown }
      if (Array.isArray(p.paperIds)) ids = p.paperIds.filter((x): x is number => typeof x === 'number')
    } catch {
      continue
    }
    if (ids == null) continue // 全图任务（手动重新生成）：不按论文门控
    const at = Date.parse(j.updated_at) || 0
    for (const pid of ids) {
      const cur = map.get(pid)
      if (!cur) {
        map.set(pid, { count: 1, lastAt: at, permanent: j.status === 'failed_action' })
      } else {
        cur.count += 1
        cur.lastAt = Math.max(cur.lastAt, at)
        cur.permanent = cur.permanent || j.status === 'failed_action'
      }
    }
  }
  return map
}

/** 该论文此刻是否允许自动补排（false = 跳过：永久失败 / 退避未到 / 达上限） */
function autoRetryAllowed(f: PaperFailures | undefined, nowMs: number): boolean {
  if (!f) return true
  if (f.permanent) return false // failed_action：永久失败不自动重排
  if (f.count >= AUTO_RETRY_MAX_FAILURES) return false // 可恢复失败达上限：停止自动补排
  return nowMs - f.lastAt >= AUTO_RETRY_BASE_MS * AUTO_RETRY_FACTOR ** (f.count - 1)
}

export function backfillNewPapers(db: Database.Database, engine: RelationGenEngine, now: Date = new Date()): Array<{ graphId: number; paperIds: number[] }> {
  const nowMs = now.getTime()
  // uat2（D62）：有成员的图都参与扫描——空跑 succeeded 的图不再漏补关系
  const graphs = db
    .prepare('SELECT DISTINCT graph_id AS gid FROM graph_members')
    .all() as Array<{ gid: number }>
  const out: Array<{ graphId: number; paperIds: number[] }> = []
  for (const { gid } of graphs) {
    const processed = processedPaperIds(db, gid)
    const failures = relationFailuresByPaper(db, gid)
    const members = db
      .prepare(
        `SELECT p.id FROM graph_members m JOIN papers p ON p.id = m.paper_id
         WHERE m.graph_id = ? AND p.deleted_at IS NULL AND p.has_pdf = 1 ORDER BY p.id`
      )
      .all(gid) as Array<{ id: number }>
    const todo = members
      .map((r) => r.id)
      .filter((id) => !processed.has(id) && paperDetailText(db, id) != null && autoRetryAllowed(failures.get(id), nowMs))
    if (todo.length > 0) {
      engine.enqueue(gid, todo)
      out.push({ graphId: gid, paperIds: todo })
    }
  }
  return out
}
