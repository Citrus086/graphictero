import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from '../connection'
import { MIGRATIONS, runMigrations } from './index'
import { migration090 } from './090_jobs_superseded_at'

/**
 * 090（uat6c S2 / D183）：jobs.superseded_at 列 + 一次性清理——同 (kind, graph,
 * 论文组签名) 存在更晚 succeeded 时，较早的 failed_retryable / failed_action 行
 * 标已被取代（不物理删除）；不同论文组 / 不同 kind 不动；幂等。
 */

let dir: string
let db: Database.Database
let graphId: number

const now = (): string => new Date().toISOString()

function insertJob(kind: string, status: string, over: Partial<{ paperId: number | null; paperIds: number[] | null; at: string }> = {}): number {
  const payload = over.paperIds != null ? JSON.stringify({ paperIds: over.paperIds }) : '{}'
  const at = over.at ?? now()
  return Number(
    db
      .prepare('INSERT INTO jobs (kind, graph_id, paper_id, status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(kind, graphId, over.paperId ?? null, status, payload, at, at).lastInsertRowid
  )
}

const supersededOf = (id: number): string | null =>
  (db.prepare('SELECT superseded_at FROM jobs WHERE id = ?').get(id) as { superseded_at: string | null }).superseded_at

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-mig090-'))
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS.filter((m) => m.version <= 89)) // 090 之前（列还不存在）
  graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('图', now(), now()).lastInsertRowid)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('090（uat6c S2）：jobs.superseded_at 列 + 同组旧失败一次性清理', () => {
  it('加列：jobs.superseded_at 可空，旧行 NULL', () => {
    const id = insertJob('relation_gen', 'failed_action')
    migration090.up(db)
    const cols = db.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>
    expect(cols.some((c) => c.name === 'superseded_at')).toBe(true)
    expect(supersededOf(id)).toBeNull()
  })

  it('同组存在更晚 succeeded → 较早的 failed_action / failed_retryable 被标已被取代', () => {
    const old1 = insertJob('relation_gen', 'failed_action', { paperIds: [10], at: '2026-10-20T00:00:00Z' })
    const old2 = insertJob('relation_gen', 'failed_retryable', { paperIds: [10], at: '2026-10-21T00:00:00Z' })
    const ok = insertJob('relation_gen', 'succeeded', { paperIds: [10], at: '2026-10-22T00:00:00Z' })
    migration090.up(db)
    expect(supersededOf(old1)).not.toBeNull()
    expect(supersededOf(old2)).not.toBeNull()
    expect(supersededOf(ok)).toBeNull()
    // 不物理删除、状态保留
    expect((db.prepare('SELECT status FROM jobs WHERE id = ?').get(old1) as { status: string }).status).toBe('failed_action')
  })

  it('不同论文组 / 不同 kind / 无更晚成功的失败任务不动', () => {
    const otherPapers = insertJob('relation_gen', 'failed_action', { paperIds: [99], at: '2026-10-20T00:00:00Z' })
    const paper = Number(
      db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES ('P', 'zotero', 1, ?, ?)").run(now(), now()).lastInsertRowid
    )
    const otherKind = insertJob('process_paper', 'failed_action', { paperId: paper, at: '2026-10-20T00:00:00Z' })
    const noLaterSuccess = insertJob('relation_gen', 'failed_action', { paperIds: [10], at: '2026-10-23T00:00:00Z' })
    insertJob('relation_gen', 'succeeded', { paperIds: [10], at: '2026-10-22T00:00:00Z' }) // 更早成功：不取代更晚失败
    migration090.up(db)
    expect(supersededOf(otherPapers)).toBeNull()
    expect(supersededOf(otherKind)).toBeNull()
    expect(supersededOf(noLaterSuccess)).toBeNull()
  })

  it('幂等：第二遍零写入（表级快照一致）', () => {
    insertJob('relation_gen', 'failed_action', { paperIds: [10], at: '2026-10-20T00:00:00Z' })
    insertJob('relation_gen', 'succeeded', { paperIds: [10], at: '2026-10-22T00:00:00Z' })
    migration090.up(db)
    const snap = JSON.stringify(db.prepare('SELECT * FROM jobs ORDER BY id').all())
    migration090.up(db)
    expect(JSON.stringify(db.prepare('SELECT * FROM jobs ORDER BY id').all())).toBe(snap)
  })

  it('全量迁移 89→90 在启动路径上应用', () => {
    insertJob('relation_gen', 'failed_action', { paperIds: [10] })
    const applied = runMigrations(db, MIGRATIONS)
    expect(applied).toEqual([90])
    expect(db.pragma('user_version', { simple: true })).toBe(90)
  })
})
