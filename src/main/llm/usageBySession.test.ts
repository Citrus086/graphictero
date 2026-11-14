import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { usageBySession } from './usage'

let dir: string
let db: Database.Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-usage-session-'))
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function graph(name: string): number {
  const now = '2026-10-01T00:00:00.000Z'
  return Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run(name, now, now).lastInsertRowid)
}

function session(graphId: number | null, name: string): number {
  const now = '2026-10-01T00:00:00.000Z'
  return Number(
    db.prepare(
      'INSERT INTO sessions (graph_id, entry_type, entry_id, name, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)'
    ).run(graphId, 'graph', name, now, now).lastInsertRowid
  )
}

function add(
  at: string,
  values: { cost: number; category?: string; sessionId?: number | null; input?: number; output?: number; reasoning?: number | null }
): void {
  db.prepare(
    `INSERT INTO usage_records
       (occurred_at, category, session_id, model, input_tokens, cache_hit_tokens, cache_miss_tokens,
        output_tokens, cost_cny, thinking, reasoning_tokens)
     VALUES (?, ?, ?, 'deepseek-flash', ?, 0, ?, ?, ?, 1, ?)`
  ).run(
    at,
    values.category ?? 'chat',
    values.sessionId ?? null,
    values.input ?? 10,
    values.input ?? 10,
    values.output ?? 5,
    values.cost,
    values.reasoning === undefined ? null : values.reasoning
  )
}

const NOW = new Date(2026, 9, 8, 12)

describe('usageBySession（uat8b D185/D193）', () => {
  it('按 session_id 汇总 ¥ / 次数 / token，空标题与图谱名，按 ¥ 降序、同额按最近使用降序', () => {
    const g = graph('综述图谱')
    const named = session(g, 'Self-RAG 讨论')
    const blank = session(g, '   ')
    const other = graph('其它')
    const tiedOld = session(other, '早')
    const tiedNew = session(other, '晚')
    add('2026-10-03T01:00:00.000Z', { sessionId: named, cost: 1.2, input: 100, output: 40, reasoning: 8 })
    add('2026-10-04T01:00:00.000Z', { sessionId: named, cost: 0.3, input: 50, output: 10, reasoning: 2 })
    add('2026-10-05T01:00:00.000Z', { sessionId: blank, cost: 0.5, input: 20, output: 5 })
    add('2026-10-02T01:00:00.000Z', { sessionId: tiedOld, cost: 0.5, input: 1, output: 1 })
    add('2026-10-06T01:00:00.000Z', { sessionId: tiedNew, cost: 0.5, input: 2, output: 2 })
    add('2026-10-07T01:00:00.000Z', { cost: 0.8, input: 7, output: 3, reasoning: 1 })
    add('2026-10-07T02:00:00.000Z', { cost: 0.1, category: 'detail' })

    const rows = usageBySession(db, { range: '7d' }, NOW)
    expect(rows.map((r) => r.title)).toEqual([
      'Self-RAG 讨论',
      '后台任务（无会话）',
      '晚',
      '会话 #' + blank,
      '早'
    ])
    expect(rows[0]).toMatchObject({
      kind: 'session',
      sessionId: named,
      graphName: '综述图谱',
      calls: 2,
      inputTokens: 150,
      outputTokens: 50,
      reasoningTokens: 10
    })
    expect(rows[0].costCny).toBeCloseTo(1.5, 10)
    expect(rows[1]).toMatchObject({
      kind: 'background',
      sessionId: null,
      graphName: null,
      calls: 2,
      title: '后台任务（无会话）'
    })
    expect(rows[1].costCny).toBeCloseTo(0.9, 10)
    expect(rows[2].lastUsedAt > rows[4].lastUsedAt).toBe(true)
    expect(rows[3]).toMatchObject({ kind: 'session', title: `会话 #${blank}`, graphName: '综述图谱' })
  })

  it('来源过滤下推：只汇总所选类别', () => {
    const sid = session(graph('G'), '只聊')
    add('2026-10-03T01:00:00.000Z', { sessionId: sid, cost: 1, category: 'chat' })
    add('2026-10-03T02:00:00.000Z', { sessionId: sid, cost: 4, category: 'detail' })
    add('2026-10-03T03:00:00.000Z', { cost: 2, category: 'detail' })
    const chat = usageBySession(db, { range: 'all', category: 'chat' }, NOW)
    expect(chat).toHaveLength(1)
    expect(chat[0].costCny).toBeCloseTo(1, 10)
    expect(chat[0].calls).toBe(1)
    const detail = usageBySession(db, { range: 'all', category: 'detail' }, NOW)
    expect(detail.map((r) => r.kind).sort()).toEqual(['background', 'session'])
    expect(detail.find((r) => r.kind === 'session')!.costCny).toBeCloseTo(4, 10)
  })

  it('会话行已不在时仍按 session_id 列出「已删除的会话」', () => {
    add('2026-10-04T01:00:00.000Z', { sessionId: 42, cost: 0.2, input: 3, output: 4 })
    const rows = usageBySession(db, { range: 'month', month: '2026-10' }, NOW)
    expect(rows).toEqual([
      expect.objectContaining({
        kind: 'deleted',
        sessionId: 42,
        title: '已删除的会话 #42',
        graphName: null,
        calls: 1,
        inputTokens: 3,
        outputTokens: 4
      })
    ])
  })

  it('区间外与空库：空数组；7 天不含更早的会话', () => {
    expect(usageBySession(db, { range: '7d' }, NOW)).toEqual([])
    const sid = session(graph('G'), '旧')
    add('2026-09-01T01:00:00.000Z', { sessionId: sid, cost: 9 })
    expect(usageBySession(db, { range: '7d' }, NOW)).toEqual([])
    expect(usageBySession(db, { range: 'all' }, NOW)).toHaveLength(1)
  })
})
