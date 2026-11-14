import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { cardLiveStates, classifyCardLive } from './cardLive'

let dir: string
let db: Database.Database
let graphId: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-card-live-'))
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS)
  const now = '2026-10-01T00:00:00.000Z'
  graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('G', now, now).lastInsertRowid)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function paper(title: string, extra: { doi?: string; arxiv?: string; deleted?: boolean } = {}): number {
  const now = '2026-10-01T00:00:00.000Z'
  return Number(
    db.prepare(
      `INSERT INTO papers (title, doi, arxiv_id, source, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, 'zotero', ?, ?, ?)`
    ).run(title, extra.doi ?? null, extra.arxiv ?? null, extra.deleted ? now : null, now, now).lastInsertRowid
  )
}

function member(paperId: number): void {
  db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 10, 20, ?)').run(
    graphId,
    paperId,
    '2026-10-02T00:00:00.000Z'
  )
}

function candidate(status: string, extra: { paperId?: number; doi?: string; arxiv?: string } = {}): number {
  const now = '2026-10-01T00:00:00.000Z'
  return Number(
    db.prepare(
      `INSERT INTO graph_candidates
         (graph_id, title, authors_json, doi, arxiv_id, existing_paper_id, status, created_at, updated_at)
       VALUES (?, 'Self-RAG', '[]', ?, ?, ?, ?, ?, ?)`
    ).run(graphId, extra.doi ?? null, extra.arxiv ?? null, extra.paperId ?? null, status, now, now).lastInsertRowid
  )
}

describe('classifyCardLive', () => {
  it('软删优先于在图谱与忽略', () => {
    expect(classifyCardLive({ candidateStatus: 'pending', paperDeleted: true, paperKnown: true, inGraph: true })).toBe('deleted')
    expect(classifyCardLive({ candidateStatus: 'ignored', paperDeleted: false, paperKnown: true, inGraph: true })).toBe('in_graph')
    expect(classifyCardLive({ candidateStatus: 'ignored', paperDeleted: false, paperKnown: true, inGraph: false })).toBe('ignored')
    expect(classifyCardLive({ candidateStatus: 'pending', paperDeleted: false, paperKnown: false, inGraph: false })).toBe('pending')
    expect(classifyCardLive({ candidateStatus: 'confirmed', paperDeleted: false, paperKnown: true, inGraph: false })).toBe('in_library')
    expect(classifyCardLive({ candidateStatus: null, paperDeleted: false, paperKnown: false, inGraph: false })).toBe('unknown')
  })
})

describe('cardLiveStates（D191）', () => {
  it('同一候选从待确认变成已在本图谱、移出、软删、忽略', () => {
    const pid = paper('Self-RAG', { doi: '10.1/self' })
    const cid = candidate('pending', { paperId: pid, doi: '10.1/self' })
    const query = { key: 'c' + cid, candidateId: cid, paperId: pid, doi: '10.1/SELF' }

    expect(cardLiveStates(db, graphId, [query])[0].kind).toBe('pending')
    member(pid)
    expect(cardLiveStates(db, graphId, [query])[0]).toMatchObject({ kind: 'in_graph', paperId: pid })
    db.prepare('DELETE FROM graph_members WHERE paper_id = ?').run(pid)
    db.prepare("UPDATE graph_candidates SET status = 'confirmed' WHERE id = ?").run(cid)
    expect(cardLiveStates(db, graphId, [query])[0].kind).toBe('in_library')
    db.prepare('UPDATE papers SET deleted_at = ? WHERE id = ?').run('2026-10-03T00:00:00.000Z', pid)
    expect(cardLiveStates(db, graphId, [query])[0].kind).toBe('deleted')
    db.prepare('UPDATE papers SET deleted_at = NULL WHERE id = ?').run(pid)
    db.prepare("UPDATE graph_candidates SET status = 'ignored' WHERE id = ?").run(cid)
    expect(cardLiveStates(db, graphId, [query])[0].kind).toBe('ignored')
  })

  it('查不到时为 unknown，不把别的图谱的候选算进来', () => {
    const other = Number(
      db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('O', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z').lastInsertRowid
    )
    const now = '2026-10-01T00:00:00.000Z'
    const foreign = Number(
      db.prepare(
        `INSERT INTO graph_candidates (graph_id, title, authors_json, status, created_at, updated_at)
         VALUES (?, 'x', '[]', 'pending', ?, ?)`
      ).run(other, now, now).lastInsertRowid
    )
    const rows = cardLiveStates(db, graphId, [
      { key: 'missing', candidateId: foreign },
      { key: 'blank' }
    ])
    expect(rows.map((r) => r.kind)).toEqual(['unknown', 'unknown'])
  })
})
