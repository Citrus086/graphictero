import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { recentUsageCalls, usageByPeriod } from './usage'

let dir: string
let db: ReturnType<typeof openDatabase>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-usage-period-'))
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function add(at: string, cost: number, category = 'chat'): void {
  db.prepare(
    `INSERT INTO usage_records
       (occurred_at, category, model, input_tokens, cache_hit_tokens, cache_miss_tokens,
        output_tokens, cost_cny, thinking, reasoning_tokens)
     VALUES (?, ?, 'deepseek-flash', 1, 0, 1, 1, ?, 0, NULL)`
  ).run(at, category, cost)
}

describe('usageByPeriod（北京时间边界，周末一律空闲）', () => {
  it('8:59 / 9:00 / 12:00 / 14:00 / 18:00 与周六高峰钟点', () => {
    // 2026-10-26 是周一。时刻是 UTC，对应北京时间 +8。
    add('2026-10-26T00:59:00.000Z', 1) // 08:59 空闲
    add('2026-10-26T01:00:00.000Z', 2) // 09:00 高峰
    add('2026-10-26T04:00:00.000Z', 4) // 12:00 结束，空闲
    add('2026-10-26T06:00:00.000Z', 8) // 14:00 高峰
    add('2026-10-26T10:00:00.000Z', 16) // 18:00 结束，空闲
    add('2026-10-24T02:00:00.000Z', 32) // 周六，钟点落在高峰窗仍算空闲

    const now = new Date('2026-10-29T12:00:00.000Z')
    const view = usageByPeriod(db, { range: 'all' }, now)
    expect(view.peakCny).toBe(10)
    expect(view.offPeakCny).toBe(53)
    expect(view.nowPeak).toBe(false)
    expect(usageByPeriod(db, { range: 'all' }, new Date('2026-10-26T01:30:00.000Z')).nowPeak).toBe(true)
  })

  it('来源过滤只加所选类别', () => {
    add('2026-10-26T01:00:00.000Z', 2, 'chat')
    add('2026-10-26T01:10:00.000Z', 8, 'web')
    const view = usageByPeriod(db, { range: 'all', category: 'chat' }, new Date('2026-10-29T12:00:00.000Z'))
    expect(view.peakCny).toBe(2)
    expect(view.offPeakCny).toBe(0)
  })
})

describe('recentUsageCalls', () => {
  it('最多 20 条，按时间与 id 降序，来源过滤不看时间范围', () => {
    for (let i = 0; i < 25; i++) {
      const at = new Date(Date.parse('2026-10-01T00:00:00.000Z') + i * 3600_000).toISOString()
      add(at, i + 1, 'chat')
    }
    for (let i = 0; i < 3; i++) {
      const at = new Date(Date.parse('2026-10-20T00:00:00.000Z') + i * 1000).toISOString()
      add(at, 100 + i, 'web')
    }
    const all = recentUsageCalls(db)
    expect(all).toHaveLength(20)
    expect(all[0].category).toBe('web')
    expect(all[0].costCny).toBe(102)
    expect(all.filter((row) => row.category === 'web')).toHaveLength(3)
    const chat = recentUsageCalls(db, { category: 'chat' })
    expect(chat).toHaveLength(20)
    expect(chat.every((row) => row.category === 'chat')).toBe(true)
    expect(chat[0].costCny).toBe(25)

    const tieAt = '2026-10-21T08:00:00.000Z'
    add(tieAt, 1, 'detail')
    add(tieAt, 2, 'detail')
    const tied = recentUsageCalls(db, { category: 'detail' })
    expect(tied[0].costCny).toBe(2)
    expect(tied[1].costCny).toBe(1)
    expect(tied[0].occurredAt).toBe(tieAt)
  })

  it('条数超出 1–20 拒绝', () => {
    expect(() => recentUsageCalls(db, { limit: 21 })).toThrow('最近调用条数无效')
    expect(() => recentUsageCalls(db, { limit: 0 })).toThrow('最近调用条数无效')
  })
})
