import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { currentUsageMonth, earliestUsageMonth, monthUsageSummary, recordUsage } from './usage'

/** uat4：月份切换（getUsageSummary 带「YYYY-MM」参数，无参 = 本月）+ 最早月份下界。 */

let dir: string
let db: Database.Database

const usage = { inputTokens: 1000, cacheHitTokens: 0, outputTokens: 500 }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-usage-'))
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('monthUsageSummary 月份口径（uat4）', () => {
  it('造两个月记录：查指定月只返回该月；合计与分类正确', () => {
    recordUsage(db, { category: 'chat', model: 'deepseek-flash', usage, at: new Date(2026, 8, 15, 10) }) // 2026-09
    recordUsage(db, { category: 'web', model: 'deepseek-web', usage, at: new Date(2026, 9, 3, 10) }) // 2026-10
    recordUsage(db, { category: 'web', model: 'deepseek-web', usage, at: new Date(2026, 9, 20, 10) }) // 2026-10

    const sep = monthUsageSummary(db, '2026-09')
    expect(sep.month).toBe('2026-09')
    expect(sep.byCategory).toHaveLength(1)
    expect(sep.byCategory[0].category).toBe('chat')
    expect(sep.byCategory[0].calls).toBe(1)
    expect(sep.totalCny).toBeCloseTo(sep.byCategory[0].costCny, 10)

    const oct = monthUsageSummary(db, '2026-10')
    expect(oct.month).toBe('2026-10')
    expect(oct.byCategory).toHaveLength(1)
    expect(oct.byCategory[0]).toMatchObject({ category: 'web', calls: 2 })
    expect(oct.totalCny).toBeCloseTo(oct.byCategory[0].costCny, 10) // 该月仅此一类

    // 无记录月份：空汇总
    const empty = monthUsageSummary(db, '2025-01')
    expect(empty.totalCny).toBe(0)
    expect(empty.byCategory).toHaveLength(0)
  })

  it('earliestMonth = 库中最早记录所在月（本地时区）；空库为 null', () => {
    expect(earliestUsageMonth(db)).toBeNull()
    expect(monthUsageSummary(db, '2026-10').earliestMonth).toBeNull()

    recordUsage(db, { category: 'card', model: 'deepseek-flash', usage, at: new Date(2026, 7, 2, 8) }) // 2026-08
    recordUsage(db, { category: 'chat', model: 'deepseek-flash', usage, at: new Date(2026, 9, 1, 0, 30) }) // 2026-10
    expect(earliestUsageMonth(db)).toBe('2026-08')
    expect(monthUsageSummary(db, '2026-10').earliestMonth).toBe('2026-08')
  })

  it('无参 = 本月（向后兼容）：本月记录计入，earliestMonth 照常返回', () => {
    recordUsage(db, { category: 'detail', model: 'deepseek-flash', usage, at: new Date() })
    recordUsage(db, { category: 'detail', model: 'deepseek-flash', usage, at: new Date(2026, 8, 15) }) // 上月，不并入
    const s = monthUsageSummary(db)
    expect(s.month).toBe(currentUsageMonth())
    expect(s.byCategory[0].calls).toBe(1)
    expect(s.earliestMonth).toBe('2026-09')
  })
})
