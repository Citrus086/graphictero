import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from '../connection'
import { MIGRATIONS, runMigrations } from './index'
import { migration085 } from './085_candidate_verified'

/** 085（uat5 D168/D169）：verified 列 + status CHECK 放宽含 dismissed（整表重建保数据）。 */

let dir: string
let db: Database.Database
let graphId: number

const now = (): string => new Date().toISOString()

function insertCandidate(status: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO graph_candidates (graph_id, title, authors_json, year, status, created_at, updated_at)
         VALUES (?, ?, '[]', 2020, ?, ?, ?)`
      )
      .run(graphId, `候选-${status}`, status, now(), now()).lastInsertRowid
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-mig085-'))
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS.filter((m) => m.version < 85))
  graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('g', now(), now()).lastInsertRowid)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('迁移 085（uat5 D168/D169）', () => {
  it('老库（84）：加 verified 列、CHECK 放宽含 dismissed、存量数据原样保留', () => {
    const pendingId = insertCandidate('pending')
    const ignoredId = insertCandidate('ignored')
    expect(db.pragma('user_version', { simple: true })).toBe(84)

    migration085.up(db)

    const cols = (db.pragma('table_info(graph_candidates)') as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toContain('verified')
    // 存量行数据不动，verified 默认 1
    expect(db.prepare('SELECT title, status, verified FROM graph_candidates WHERE id = ?').get(pendingId)).toEqual({
      title: '候选-pending',
      status: 'pending',
      verified: 1
    })
    expect((db.prepare('SELECT status FROM graph_candidates WHERE id = ?').get(ignoredId) as { status: string }).status).toBe('ignored')
    // 新状态可写（旧 CHECK 会拒）
    db.prepare("UPDATE graph_candidates SET status = 'dismissed' WHERE id = ?").run(ignoredId)
    expect((db.prepare('SELECT status FROM graph_candidates WHERE id = ?').get(ignoredId) as { status: string }).status).toBe('dismissed')
    // 索引重建在
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_candidates_graph'").get() as { n: number }).n
    ).toBe(1)
    // 幂等：再跑不炸
    migration085.up(db)
    expect(db.prepare('SELECT COUNT(*) AS n FROM graph_candidates').get()).toEqual({ n: 2 })
  })

  it('全量迁移：新库直接到 88，dismissed 可写', () => {
    db.close()
    db = openDatabase(join(dir, 't2.db'))
    runMigrations(db, MIGRATIONS)
    expect(db.pragma('user_version', { simple: true })).toBe(90)
    const gid = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('g2', now(), now()).lastInsertRowid)
    insertCandidateIn(db, gid, 'dismissed')
    expect(db.prepare("SELECT COUNT(*) AS n FROM graph_candidates WHERE status = 'dismissed'").get()).toEqual({ n: 1 })
  })
})

function insertCandidateIn(d: Database.Database, gid: number, status: string): number {
  return Number(
    d
      .prepare(
        `INSERT INTO graph_candidates (graph_id, title, authors_json, status, created_at, updated_at)
         VALUES (?, ?, '[]', ?, ?, ?)`
      )
      .run(gid, `c-${status}`, status, now(), now()).lastInsertRowid
  )
}
