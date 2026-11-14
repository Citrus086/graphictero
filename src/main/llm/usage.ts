import type Database from 'better-sqlite3'
import {
  USAGE_CATEGORIES,
  type UsageAgg,
  type UsageByCategory,
  type UsageCategory,
  type UsageSeriesInput,
  type UsageSeriesView,
  type UsageSessionRow
} from '../../shared/ipc'
import { BACKGROUND_POST_CATEGORIES } from '../../shared/usageMeta'
import { costCny, isPeakHour, type TokenUsage } from './pricing'

export type { UsageCategory } from '../../shared/ipc'
// uat7b S6(a)：常量本体挪到 src/shared/usageMeta.ts（主进程 / 渲染层共用），
// 这里再导出保持既有 import 站点不变；渲染层不再 import src/main。
export { BACKGROUND_POST_CATEGORIES } from '../../shared/usageMeta'

/**
 * 用量记账（D58/D96 实时计费）：每次 LLM 调用流式结束拿到 usage（含缓存命中
 * token）时，立刻按调用发生时刻的高峰/空闲人民币价算出费用写入 usage_records——
 * 不做事后批量结算；设置页「用量与费用」轮询读取本表即为实时刷新。不设上限、
 * 不做大调用提醒。
 * category：chat | detail | relation | card（D58 本月分类汇总口径）+ web（M6 前置 2d，
 * 062 放宽 CHECK：DeepSeek Search/Fetch 按次计价，D125；实现归 lane/fetch）
 * + overview（064，D142：导出概览单独记账，不再并进 chat；仍不加 'export'）。
 */

/** 名片 / 详情 / 概览 / 关系生成落账且带会话时通知抽屉再拉分项（D160）。
 *  常量本体在 src/shared/usageMeta.ts（uat7b S6(a)），此处仅导入使用。 */
const BACKGROUND_POST_SET: ReadonlySet<UsageCategory> = BACKGROUND_POST_CATEGORIES

export interface UsagePosted {
  category: UsageCategory
  sessionId: number
}

let onPosted: ((event: UsagePosted) => void) | null = null

/** 主进程注册一次。换 handler 会替换上一个；传 null 卸掉。 */
export function setUsagePostedHandler(handler: ((event: UsagePosted) => void) | null): void {
  onPosted = handler
}

function notifyUsagePosted(input: UsageRecordInput): void {
  const sessionId = input.sessionId
  if (sessionId == null || sessionId <= 0) return
  if (!BACKGROUND_POST_SET.has(input.category)) return
  try {
    onPosted?.({ category: input.category, sessionId })
  } catch {
    // 通知失败不影响已经写下的账
  }
}

export interface UsageRecordInput {
  category: UsageCategory
  model: string
  usage: TokenUsage
  paperId?: number | null
  sessionId?: number | null
  /** 请求发生时间（高峰/空闲判定按它，D79）；默认当前时间 */
  at?: Date
  /** D92：所有 LLM 调用统一开 thinking，默认记 1 */
  thinking?: boolean
}

export function recordUsage(db: Database.Database, input: UsageRecordInput): number {
  const at = input.at ?? new Date()
  const cost = costCny(input.usage, at)
  const cacheHit = Math.max(0, input.usage.cacheHitTokens)
  const cacheMiss = Math.max(0, input.usage.inputTokens - cacheHit)
  const r = db
    .prepare(
      `INSERT INTO usage_records
         (occurred_at, category, session_id, paper_id, model,
          input_tokens, cache_hit_tokens, cache_miss_tokens, output_tokens, cost_cny, thinking, reasoning_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      at.toISOString(),
      input.category,
      input.sessionId ?? null,
      input.paperId ?? null,
      input.model,
      input.usage.inputTokens,
      cacheHit,
      cacheMiss,
      input.usage.outputTokens,
      cost,
      input.thinking === false ? 0 : 1,
      input.usage.reasoningTokens ?? null
    )
  notifyUsagePosted(input)
  return Number(r.lastInsertRowid)
}

/** D125：DeepSeek Search/Fetch 每 1000 次成功请求 ¥5。失败和空结果不记账。 */
export const WEB_CALL_CNY = 0.005

export function recordWebCall(db: Database.Database, opts: { sessionId?: number | null; at?: Date } = {}): number {
  const at = opts.at ?? new Date()
  const r = db
    .prepare(
      `INSERT INTO usage_records
         (occurred_at, category, session_id, paper_id, model,
          input_tokens, cache_hit_tokens, cache_miss_tokens, output_tokens, cost_cny, thinking, reasoning_tokens)
       VALUES (?, 'web', ?, NULL, 'deepseek-web', 0, 0, 0, 0, ?, 0, NULL)`
    )
    .run(at.toISOString(), opts.sessionId ?? null, WEB_CALL_CNY)
  return Number(r.lastInsertRowid)
}

/** uat4：本地时区「YYYY-MM」月份标签 */
export function currentUsageMonth(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** uat4：月份标签 → [start, end)（按本地时界，与 recordUsage 落库的 ISO 时间可单调比较） */
export function usageMonthRange(month: string): { start: Date; end: Date } {
  const [y, m] = month.split('-').map(Number)
  return { start: new Date(y, m - 1, 1), end: new Date(y, m, 1) }
}

/** uat4：库中最早有记录的月份（本地时区「YYYY-MM」）；无记录返回 null（‹ 切换下界） */
export function earliestUsageMonth(db: Database.Database): string | null {
  const row = db.prepare('SELECT MIN(occurred_at) AS first FROM usage_records').get() as { first: string | null }
  return row.first ? currentUsageMonth(new Date(row.first)) : null
}

/**
 * 指定月份费用按类别汇总（设置页「用量与费用」，D58；金额人民币）。
 * month 为「YYYY-MM」；缺省 = 本月（向后兼容旧的无参调用）。
 * uat4：加月份上界，响应带 month / earliestMonth 供页面切换器使用。
 */
export function monthUsageSummary(
  db: Database.Database,
  month?: string
): {
  month: string
  earliestMonth: string | null
  totalCny: number
  byCategory: Array<{ category: UsageCategory; costCny: number; calls: number }>
} {
  const label = month && /^\d{4}-\d{2}$/.test(month) ? month : currentUsageMonth()
  const { start, end } = usageMonthRange(label)
  const rows = db
    .prepare(
      `SELECT category, SUM(cost_cny) AS cost, COUNT(*) AS calls
       FROM usage_records WHERE occurred_at >= ? AND occurred_at < ? GROUP BY category`
    )
    .all(start.toISOString(), end.toISOString()) as Array<{ category: UsageCategory; cost: number; calls: number }>
  return {
    month: label,
    earliestMonth: earliestUsageMonth(db),
    totalCny: rows.reduce((s, r) => s + r.cost, 0),
    byCategory: rows.map((r) => ({ category: r.category, costCny: r.cost, calls: r.calls }))
  }
}

interface UsageSeriesRow {
  date: string
  category: UsageCategory
  costCny: number
  calls: number
  inputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  outputTokens: number
  reasoningTokens: number | null
}

function localDateLabel(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function shiftLocalDate(label: string, days: number): string {
  const [y, m, d] = label.split('-').map(Number)
  return localDateLabel(new Date(y, m - 1, d + days))
}

function localDayLabels(start: string, end: string): string[] {
  const days: string[] = []
  for (let date = start; date <= end; date = shiftLocalDate(date, 1)) days.push(date)
  return days
}

function zeroUsageAgg(): UsageAgg {
  return {
    costCny: 0,
    calls: 0,
    inputTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0
  }
}

function zeroUsageByCategory(): UsageByCategory {
  return Object.fromEntries(USAGE_CATEGORIES.map((category) => [category, zeroUsageAgg()])) as UsageByCategory
}

/** 纯函数：把 SQL 的本地日 × 类别聚合行补成连续日期与全类别，并计算合计。 */
function buildUsageSeries(rows: UsageSeriesRow[], dates: string[]): UsageSeriesView {
  const days = dates.map((date) => ({ date, byCategory: zeroUsageByCategory() }))
  const byDate = new Map(days.map((day) => [day.date, day]))
  const totals = zeroUsageByCategory()

  for (const row of rows) {
    const day = byDate.get(row.date)
    if (!day) continue
    const agg: UsageAgg = {
      costCny: row.costCny,
      calls: row.calls,
      inputTokens: row.inputTokens,
      cacheHitTokens: row.cacheHitTokens,
      cacheMissTokens: row.cacheMissTokens,
      outputTokens: row.outputTokens,
      reasoningTokens: row.reasoningTokens
    }
    day.byCategory[row.category] = agg

    const total = totals[row.category]
    const hadCalls = total.calls > 0
    total.costCny += agg.costCny
    total.calls += agg.calls
    total.inputTokens += agg.inputTokens
    total.cacheHitTokens += agg.cacheHitTokens
    total.cacheMissTokens += agg.cacheMissTokens
    total.outputTokens += agg.outputTokens
    // 与 SQL SUM 一致：已知值求和、忽略未知行；整类均未知才保持 null。
    if (agg.reasoningTokens == null) {
      if (!hadCalls) total.reasoningTokens = null
    } else {
      total.reasoningTokens = (total.reasoningTokens ?? 0) + agg.reasoningTokens
    }
  }

  const reasoningKnown = rows.some((row) => byDate.has(row.date) && row.reasoningTokens != null)
  if (!reasoningKnown) {
    // 全未知时，包括补零日 / 空类别在内一律 null，避免把「没上报」画成真实的 0。
    for (const category of USAGE_CATEGORIES) totals[category].reasoningTokens = null
    for (const day of days) {
      for (const category of USAGE_CATEGORIES) day.byCategory[category].reasoningTokens = null
    }
  }
  return { days, totals, reasoningKnown }
}

/** 用量序列与按会话汇总共用的时间 / 来源过滤（本地时界，与 usageSeries 一致）。 */
export function usageQueryWindow(input: UsageSeriesInput, now: Date = new Date()): {
  where: string[]
  params: string[]
  start: Date | null
  end: Date
  today: Date
} {
  if (!input || !['7d', '30d', 'month', 'all'].includes(input.range)) throw new Error('用量区间无效')
  if (input.category != null && !USAGE_CATEGORIES.includes(input.category)) throw new Error('用量类别无效')
  if (input.range === 'month' && input.month != null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)) {
    throw new Error('用量月份格式应为 YYYY-MM')
  }

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
  let start: Date | null = null
  let end = tomorrow
  if (input.range === '7d' || input.range === '30d') {
    const count = input.range === '7d' ? 7 : 30
    start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - count + 1)
  } else if (input.range === 'month') {
    const month = input.month ?? currentUsageMonth(now)
    const range = usageMonthRange(month)
    start = range.start
    end = range.end
  }

  const where = ["date(occurred_at, 'localtime') IS NOT NULL", 'occurred_at < ?']
  const params: string[] = [end.toISOString()]
  if (start) {
    where.push('occurred_at >= ?')
    params.push(start.toISOString())
  }
  if (input.category) {
    where.push('category = ?')
    params.push(input.category)
  }
  return { where, params, start, end, today }
}

function usageSessionTitle(kind: UsageSessionRow['kind'], sessionId: number | null, name: string | null): string {
  if (kind === 'background') return '后台任务（无会话）'
  if (kind === 'deleted') return `已删除的会话 #${sessionId}`
  const trimmed = (name ?? '').trim()
  return trimmed.length > 0 ? trimmed : `会话 #${sessionId}`
}

/**
 * uat8b D185/D193：按 session_id 只读汇总。时间与来源过滤与 usageSeries 同一套。
 * session_id IS NULL（后台任务，以及 D122 删会话后被置空的记录）合成一行；
 * session_id 仍在、sessions 行已不在的，记为「已删除的会话」。不加索引、不改记账。
 */
export function usageBySession(db: Database.Database, input: UsageSeriesInput, now: Date = new Date()): UsageSessionRow[] {
  const bounds = usageQueryWindow(input, now)
  const where = bounds.where.map((clause) => {
    if (clause.startsWith('date(occurred_at')) return clause.replaceAll('occurred_at', 'usage_records.occurred_at')
    if (clause.startsWith('occurred_at') || clause.startsWith('category')) return `usage_records.${clause}`
    return clause
  })
  const rows = db
    .prepare(
      `SELECT usage_records.session_id AS sessionId,
              CASE
                WHEN usage_records.session_id IS NULL THEN 'background'
                WHEN sessions.id IS NULL THEN 'deleted'
                ELSE 'session'
              END AS kind,
              sessions.name AS sessionName,
              graphs.name AS graphName,
              COALESCE(SUM(usage_records.cost_cny), 0) AS costCny,
              COUNT(*) AS calls,
              COALESCE(SUM(usage_records.input_tokens), 0) AS inputTokens,
              COALESCE(SUM(usage_records.output_tokens), 0) AS outputTokens,
              SUM(usage_records.reasoning_tokens) AS reasoningTokens,
              MAX(usage_records.occurred_at) AS lastUsedAt
       FROM usage_records
       LEFT JOIN sessions ON sessions.id = usage_records.session_id
       LEFT JOIN graphs ON graphs.id = sessions.graph_id
       WHERE ${where.join(' AND ')}
       GROUP BY usage_records.session_id
       ORDER BY costCny DESC, lastUsedAt DESC`
    )
    .all(...bounds.params) as Array<{
      sessionId: number | null
      kind: UsageSessionRow['kind']
      sessionName: string | null
      graphName: string | null
      costCny: number
      calls: number
      inputTokens: number
      outputTokens: number
      reasoningTokens: number | null
      lastUsedAt: string
    }>
  return rows.map((row) => ({
    kind: row.kind,
    sessionId: row.sessionId,
    title: usageSessionTitle(row.kind, row.sessionId, row.sessionName),
    graphName: row.kind === 'session' ? row.graphName : null,
    costCny: row.costCny,
    calls: row.calls,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    reasoningTokens: row.reasoningTokens,
    lastUsedAt: row.lastUsedAt
  }))
}

/**
 * uat7 D180：只读用量序列。7d/30d 含今天；month 为完整本地月；all 从首条
 * 有记录的本地日期到今天（空库 days=[]）。整个查询只有下面一条聚合 SQL。
 *
 * category 过滤直接下推到 SQL：days/totals 只有所选类别可能非零，其余类别仍
 * 返回全零 Agg，前端无需变更 Record 形状；跨类别的图表过滤由前端自行组合。
 */
export function usageSeries(db: Database.Database, input: UsageSeriesInput, now: Date = new Date()): UsageSeriesView {
  const bounds = usageQueryWindow(input, now)
  const { where, params, start, end, today } = bounds

  const rows = db
    .prepare(
      `SELECT date(occurred_at, 'localtime') AS date,
              category,
              COALESCE(SUM(cost_cny), 0) AS costCny,
              COUNT(*) AS calls,
              COALESCE(SUM(input_tokens), 0) AS inputTokens,
              COALESCE(SUM(cache_hit_tokens), 0) AS cacheHitTokens,
              COALESCE(SUM(cache_miss_tokens), 0) AS cacheMissTokens,
              COALESCE(SUM(output_tokens), 0) AS outputTokens,
              SUM(reasoning_tokens) AS reasoningTokens
       FROM usage_records
       WHERE ${where.join(' AND ')}
       GROUP BY date(occurred_at, 'localtime'), category
       ORDER BY date ASC, category ASC`
    )
    .all(...params) as UsageSeriesRow[]

  let dates: string[]
  if (input.range === 'all') {
    dates = rows.length > 0 ? localDayLabels(rows[0].date, localDateLabel(today)) : []
  } else {
    dates = localDayLabels(localDateLabel(start!), shiftLocalDate(localDateLabel(end), -1))
  }
  return buildUsageSeries(rows, dates)
}

export interface UsagePeriodView {
  peakCny: number
  offPeakCny: number
  /** 查询时刻是否高峰（与 isPeakHour 同一函数，含周末空闲） */
  nowPeak: boolean
}

/**
 * uat8c：按时段汇总。时间范围与来源过滤与 usageSeries 同一套 usageQueryWindow。
 * 高峰判定复用 isPeakHour（北京时间工作日 9–12、14–18；周末全空闲），不另写区间。
 */
export function usageByPeriod(db: Database.Database, input: UsageSeriesInput, now: Date = new Date()): UsagePeriodView {
  const bounds = usageQueryWindow(input, now)
  const rows = db
    .prepare(
      `SELECT occurred_at AS at, cost_cny AS cost
       FROM usage_records
       WHERE ${bounds.where.join(' AND ')}`
    )
    .all(...bounds.params) as Array<{ at: string; cost: number }>
  let peakCny = 0
  let offPeakCny = 0
  for (const row of rows) {
    const at = new Date(row.at)
    if (Number.isNaN(at.getTime())) continue
    if (isPeakHour(at)) peakCny += row.cost
    else offPeakCny += row.cost
  }
  return { peakCny, offPeakCny, nowPeak: isPeakHour(now) }
}

export interface RecentUsageCall {
  occurredAt: string
  category: string
  peak: boolean
  costCny: number
}

/**
 * uat8c：最近调用。只按来源过滤，不按页面时间范围裁。只读，不改记账。
 * 默认 20 条，按 occurred_at 降序。
 */
export function recentUsageCalls(
  db: Database.Database,
  input: { category?: UsageCategory | null; limit?: number } = {}
): RecentUsageCall[] {
  if (input.category != null && !USAGE_CATEGORIES.includes(input.category)) throw new Error('用量类别无效')
  const limit = input.limit == null ? 20 : input.limit
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('最近调用条数无效')
  const where: string[] = []
  const params: Array<string | number> = []
  if (input.category) {
    where.push('category = ?')
    params.push(input.category)
  }
  params.push(limit)
  const rows = db
    .prepare(
      `SELECT occurred_at AS occurredAt, category, cost_cny AS costCny
       FROM usage_records
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY occurred_at DESC, id DESC
       LIMIT ?`
    )
    .all(...params) as Array<{ occurredAt: string; category: string; costCny: number }>
  return rows.map((row) => ({
    occurredAt: row.occurredAt,
    category: row.category,
    peak: isPeakHour(new Date(row.occurredAt)),
    costCny: row.costCny
  }))
}
