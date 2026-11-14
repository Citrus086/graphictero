import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from '../connection'
import { MIGRATIONS, runMigrations } from './index'
import { migration087 } from './087_pending_in_graph_dismissed'

/**
 * 087（uat6b S2）：遗留 pending + in_graph 候选改 dismissed（D169 判定口径：
 * existing_paper_id 是该图谱成员、未软删）。不改 085；幂等。
 */

let dir: string
let db: Database.Database
let graphId: number
let memberPaper: number
let outsiderPaper: number

const now = (): string => new Date().toISOString()

function insertPaper(title: string, deleted = false): number {
  const t = now()
  const id = Number(
    db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES (?, 'zotero', 1, ?, ?)").run(title, t, t).lastInsertRowid
  )
  if (deleted) db.prepare('UPDATE papers SET deleted_at = ? WHERE id = ?').run(t, id)
  return id
}

function insertCandidate(status: string, existingPaperId: number | null, over: Partial<{ reason: string; inGraph: number }> = {}): number {
  return Number(
    db
      .prepare(
        `INSERT INTO graph_candidates
           (graph_id, title, authors_json, year, doi, arxiv_id, existing_paper_id, reason, x, y, status,
            session_id, abstract, venue, oa_url, openalex_wid, title_dup, in_graph, verified, created_at, updated_at)
         VALUES (?, ?, '[]', 2024, NULL, NULL, ?, ?, 0, 0, ?, NULL, NULL, NULL, NULL, NULL, 0, ?, 1, ?, ?)`
      )
      .run(graphId, '候选', existingPaperId, over.reason ?? '提议', status, over.inGraph ?? 0, now(), now()).lastInsertRowid
  )
}

const rowOf = (id: number): Record<string, unknown> =>
  db.prepare('SELECT status, reason, title, doi, x, y, in_graph FROM graph_candidates WHERE id = ?').get(id) as Record<string, unknown>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-mig087-'))
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS.filter((m) => m.version <= 86)) // 087 之前
  graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('图', now(), now()).lastInsertRowid)
  memberPaper = insertPaper('成员论文')
  outsiderPaper = insertPaper('库外论文')
  db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)').run(graphId, memberPaper, now())
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('087（uat6b S2）：遗留 pending + in_graph 候选改 dismissed', () => {
  it('遗留 pending 且 existing_paper 是本图成员（未软删）→ dismissed（reason=in_graph，其它字段不动）', () => {
    const cid = insertCandidate('pending', memberPaper, { inGraph: 1 })
    migration087.up(db)
    const r = rowOf(cid)
    expect(r.status).toBe('dismissed')
    expect(r.reason).toBe('in_graph')
    expect(r.title).toBe('候选') // 其它字段不动
    expect(r.in_graph).toBe(1)
  })

  it('pending 但论文不是本图成员（库外 existing_paper_id）→ 不动', () => {
    const cid = insertCandidate('pending', outsiderPaper)
    migration087.up(db)
    expect(rowOf(cid).status).toBe('pending')
  })

  it('pending 但成员论文已软删 → 不动（D169 判定要求未软删）', () => {
    const deletedMember = insertPaper('已删成员', true)
    db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)').run(graphId, deletedMember, now())
    const cid = insertCandidate('pending', deletedMember)
    migration087.up(db)
    expect(rowOf(cid).status).toBe('pending')
  })

  it('已 confirmed / dismissed / ignored 的行一律不动', () => {
    const confirmed = insertCandidate('confirmed', memberPaper)
    const dismissed = insertCandidate('dismissed', memberPaper)
    const ignored = insertCandidate('ignored', memberPaper)
    migration087.up(db)
    expect(rowOf(confirmed).status).toBe('confirmed')
    expect(rowOf(dismissed).status).toBe('dismissed')
    expect(rowOf(ignored).status).toBe('ignored')
  })

  it('幂等：第二遍零写入（表级快照一致）', () => {
    insertCandidate('pending', memberPaper, { inGraph: 1 })
    insertCandidate('pending', outsiderPaper)
    migration087.up(db)
    const snap = JSON.stringify(db.prepare('SELECT * FROM graph_candidates ORDER BY id').all())
    migration087.up(db)
    expect(JSON.stringify(db.prepare('SELECT * FROM graph_candidates ORDER BY id').all())).toBe(snap)
  })

  it('全量迁移 86→88 在启动路径上应用（086 已在起点跑过则补 087、088）', () => {
    insertCandidate('pending', memberPaper, { inGraph: 1 })
    const applied = runMigrations(db, MIGRATIONS)
    expect(applied).toEqual([87, 88, 89, 90])
    expect(db.pragma('user_version', { simple: true })).toBe(90)
  })
})
