import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from '../connection'
import { costCny } from '../../llm/pricing'
import { recordUsage, recordWebCall } from '../../llm/usage'
import { MIGRATIONS, runMigrations } from './index'

/** 088（uat7 D180）：推理 token 可空列；旧数据未知，计价不受影响。 */

let dir: string
let db: Database.Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-mig088-'))
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS.filter((m) => m.version <= 87))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('迁移 088 usage_records.reasoning_tokens', () => {
  it('87→88：旧行 reasoning_tokens=NULL，原字段与 cost_cny 不变', () => {
    db.prepare(
      `INSERT INTO usage_records
         (occurred_at, category, session_id, paper_id, model,
          input_tokens, cache_hit_tokens, cache_miss_tokens, output_tokens, cost_cny, thinking)
       VALUES ('2026-10-20T10:00:00.000Z', 'chat', 1, NULL, 'deepseek-flash',
               1000, 800, 200, 50, 0.0123, 1)`
    ).run()
    const before = db.prepare('SELECT * FROM usage_records WHERE id = 1').get() as Record<string, unknown>

    expect(runMigrations(db, MIGRATIONS)).toEqual([88, 89, 90])
    expect(db.pragma('user_version', { simple: true })).toBe(90)
    const after = db.prepare('SELECT * FROM usage_records WHERE id = 1').get() as Record<string, unknown>
    expect(after).toEqual({ ...before, reasoning_tokens: null })
    expect(after.cost_cny).toBe(0.0123)
  })

  it('新行写入上报值；缺字段与 web 记录为 NULL，推理 token 不改变费用', () => {
    runMigrations(db, MIGRATIONS)
    const at = new Date('2026-10-26T02:00:00.000Z')
    const base = { inputTokens: 1000, cacheHitTokens: 400, outputTokens: 500 }
    const withReasoningId = recordUsage(db, {
      category: 'chat',
      model: 'deepseek-flash',
      usage: { ...base, reasoningTokens: 320 },
      at
    })
    const withoutReasoningId = recordUsage(db, { category: 'detail', model: 'deepseek-flash', usage: base, at })
    const webId = recordWebCall(db, { at })

    const rows = db
      .prepare('SELECT id, reasoning_tokens, cost_cny FROM usage_records ORDER BY id')
      .all() as Array<{ id: number; reasoning_tokens: number | null; cost_cny: number }>
    expect(rows.find((r) => r.id === withReasoningId)).toMatchObject({ reasoning_tokens: 320 })
    expect(rows.find((r) => r.id === withoutReasoningId)).toMatchObject({ reasoning_tokens: null })
    expect(rows.find((r) => r.id === webId)).toMatchObject({ reasoning_tokens: null })
    expect(rows.find((r) => r.id === withReasoningId)!.cost_cny).toBeCloseTo(costCny(base, at), 10)
    expect(rows.find((r) => r.id === withReasoningId)!.cost_cny).toBeCloseTo(
      costCny({ ...base, reasoningTokens: 320 }, at),
      10
    )
  })
})
