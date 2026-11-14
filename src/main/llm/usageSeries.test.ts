import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { USAGE_CATEGORIES, type UsageCategory } from '../../shared/ipc'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { usageSeries } from './usage'

let dir: string
let db: Database.Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-usage-series-'))
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function addUsage(
  at: Date,
  category: UsageCategory,
  values: Partial<{
    cost: number
    input: number
    hit: number
    miss: number
    output: number
    reasoning: number | null
  }> = {}
): void {
  const input = values.input ?? 100
  const hit = values.hit ?? 20
  db.prepare(
    `INSERT INTO usage_records
       (occurred_at, category, model, input_tokens, cache_hit_tokens, cache_miss_tokens,
        output_tokens, cost_cny, thinking, reasoning_tokens)
     VALUES (?, ?, 'deepseek-flash', ?, ?, ?, ?, ?, 1, ?)`
  ).run(
    at.toISOString(),
    category,
    input,
    hit,
    values.miss ?? input - hit,
    values.output ?? 50,
    values.cost ?? 0.01,
    values.reasoning === undefined ? null : values.reasoning
  )
}

describe('usageSeries（uat7 D180）', () => {
  it('一条本地日×类别聚合 + 连续补零：跨日、token/cost/calls 与全类别合计正确', () => {
    addUsage(new Date(2026, 9, 2, 23, 30), 'chat', {
      cost: 0.1,
      input: 100,
      hit: 40,
      output: 20,
      reasoning: 8
    })
    addUsage(new Date(2026, 9, 3, 0, 30), 'chat', {
      cost: 0.2,
      input: 200,
      hit: 50,
      output: 30,
      reasoning: 12
    })
    addUsage(new Date(2026, 9, 3, 1, 0), 'detail', { cost: 0.3, input: 300, output: 60 })

    const result = usageSeries(db, { range: '7d' }, new Date(2026, 9, 8, 12))
    expect(result.days.map((d) => d.date)).toEqual([
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08'
    ])
    expect(result.days[0].byCategory.chat).toMatchObject({
      costCny: 0.1,
      calls: 1,
      inputTokens: 100,
      cacheHitTokens: 40,
      cacheMissTokens: 60,
      outputTokens: 20,
      reasoningTokens: 8
    })
    expect(result.days[1].byCategory.chat).toMatchObject({ costCny: 0.2, calls: 1, reasoningTokens: 12 })
    expect(result.days[1].byCategory.detail).toMatchObject({ costCny: 0.3, calls: 1, reasoningTokens: null })
    expect(result.days[2].byCategory.chat).toMatchObject({ calls: 0, costCny: 0, reasoningTokens: 0 })
    expect(result.days[2].byCategory.web.calls).toBe(0)
    expect(Object.keys(result.days[0].byCategory).sort()).toEqual([...USAGE_CATEGORIES].sort())

    expect(result.totals.chat).toMatchObject({
      calls: 2,
      inputTokens: 300,
      cacheHitTokens: 90,
      cacheMissTokens: 210,
      outputTokens: 50,
      reasoningTokens: 20
    })
    expect(result.totals.chat.costCny).toBeCloseTo(0.3, 10)
    expect(result.totals.detail.costCny).toBeCloseTo(0.3, 10)
    expect(result.totals.detail.reasoningTokens).toBeNull()
    expect(result.reasoningKnown).toBe(true)
  })

  it('30d/month 连续日期；month 只取指定本地月', () => {
    addUsage(new Date(2026, 8, 1, 12), 'card', { reasoning: 1 })
    addUsage(new Date(2026, 8, 30, 23, 59), 'card', { reasoning: 2 })
    addUsage(new Date(2026, 9, 1, 0, 0), 'card', { reasoning: 4 })
    const month = usageSeries(db, { range: 'month', month: '2026-09' }, new Date(2026, 9, 15))
    expect(month.days).toHaveLength(30)
    expect(month.days[0].date).toBe('2026-09-01')
    expect(month.days.at(-1)!.date).toBe('2026-09-30')
    expect(month.totals.card).toMatchObject({ calls: 2, reasoningTokens: 3 })

    const thirty = usageSeries(db, { range: '30d' }, new Date(2026, 9, 15))
    expect(thirty.days).toHaveLength(30)
    expect(thirty.days[0].date).toBe('2026-09-16')
    expect(thirty.days.at(-1)!.date).toBe('2026-10-15')
  })

  it('all 从首条本地日期到今天、排除未来；空库 days=[]', () => {
    const now = new Date(2026, 9, 5, 12)
    expect(usageSeries(db, { range: 'all' }, now)).toMatchObject({ days: [], reasoningKnown: false })
    addUsage(new Date(2026, 8, 29, 12), 'web', { reasoning: null })
    addUsage(new Date(2026, 9, 1, 12), 'web', { reasoning: null })
    addUsage(new Date(2026, 9, 6, 12), 'web', { reasoning: 10 })
    const all = usageSeries(db, { range: 'all' }, now)
    expect(all.days.map((d) => d.date)).toEqual([
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-05'
    ])
    expect(all.totals.web.calls).toBe(2)
  })

  it('category 下推过滤：仅所选类别非零，其它类别保持全零', () => {
    addUsage(new Date(2026, 9, 3, 9), 'chat', { cost: 0.1 })
    addUsage(new Date(2026, 9, 3, 10), 'detail', { cost: 0.2, reasoning: 9 })
    const filtered = usageSeries(db, { range: '7d', category: 'chat' }, new Date(2026, 9, 3, 12))
    expect(filtered.totals.chat).toMatchObject({ calls: 1, costCny: 0.1 })
    for (const category of USAGE_CATEGORIES.filter((c) => c !== 'chat')) {
      expect(filtered.totals[category]).toMatchObject({ calls: 0, costCny: 0, inputTokens: 0, outputTokens: 0 })
    }
    expect(filtered.days[0].byCategory.detail.calls).toBe(0)
    expect(filtered.reasoningKnown).toBe(false) // 别类的已知值不泄漏进本次过滤结果
  })

  it('reasoning 全 NULL 时 reasoningKnown=false 且所有聚合（含补零）均为 null', () => {
    addUsage(new Date(2026, 9, 3, 9), 'chat')
    addUsage(new Date(2026, 9, 4, 9), 'web')
    const result = usageSeries(db, { range: '7d' }, new Date(2026, 9, 4, 12))
    expect(result.reasoningKnown).toBe(false)
    for (const category of USAGE_CATEGORIES) expect(result.totals[category].reasoningTokens).toBeNull()
    for (const day of result.days) {
      for (const category of USAGE_CATEGORIES) expect(day.byCategory[category].reasoningTokens).toBeNull()
    }
  })
})
