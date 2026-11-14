import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { MIGRATIONS, runMigrations } from './db/migrations'
import { upsertRelation } from './db/relations'
import { paperRelationStats, softDeletePaper } from './appService'

/**
 * uat7b S2：从库删除确认框的跨图谱关系计数（主进程口径）。
 * 只计有效关系（deleted_at IS NULL，与 D75 软删除实际会移除的范围一致）。
 */

let dir: string
let db: Database.Database
let graph1: number
let graph2: number
let paperX: number
let paperY: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-relstats-'))
  const dataDir = join(dir, 'Graphictero')
  mkdirSync(dataDir, { recursive: true })
  db = new Database(join(dataDir, 'graphictero.db'))
  runMigrations(db, MIGRATIONS)
  const now = new Date().toISOString()
  graph1 = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('图1', now, now).lastInsertRowid)
  graph2 = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('图2', now, now).lastInsertRowid)
  const ins = db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES (?, 'zotero', 1, ?, ?)")
  paperX = Number(ins.run('X', now, now).lastInsertRowid)
  paperY = Number(ins.run('Y', now, now).lastInsertRowid)
  for (const [g, p] of [[graph1, paperX], [graph1, paperY], [graph2, paperX]] as const) {
    db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)').run(g, p, now)
  }
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('uat7b S2 paperRelationStats（跨图谱计数）', () => {
  it('统计所有图谱里与论文相连的有效关系数与涉及图谱数', () => {
    upsertRelation(db, { graphId: graph1, srcPaperId: paperX, dstPaperId: paperY, statement: 'a', llmTypes: ['based_on'], sourceType: 'job' })
    upsertRelation(db, { graphId: graph2, srcPaperId: paperX, dstPaperId: paperY, statement: 'b', llmTypes: ['compares'], sourceType: 'job' })
    expect(paperRelationStats(db, paperX)).toEqual({ count: 2, graphCount: 2 })
    expect(paperRelationStats(db, paperY)).toEqual({ count: 2, graphCount: 2 }) // Y 同样在两图的边上
    const lone = Number(db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES ('Z', 'zotero', 1, ?, ?)").run(new Date().toISOString(), new Date().toISOString()).lastInsertRowid)
    expect(paperRelationStats(db, lone)).toEqual({ count: 0, graphCount: 0 })
  })

  it('已软删（deleted_at 非空）的关系不计入', () => {
    const id = upsertRelation(db, { graphId: graph1, srcPaperId: paperX, dstPaperId: paperY, statement: 'a', llmTypes: ['based_on'], sourceType: 'job' })
    upsertRelation(db, { graphId: graph2, srcPaperId: paperX, dstPaperId: paperY, statement: 'b', llmTypes: ['compares'], sourceType: 'job' })
    db.prepare('UPDATE relations SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), id)
    expect(paperRelationStats(db, paperX)).toEqual({ count: 1, graphCount: 1 })
  })

  it('论文在其它图谱的成员身份不影响计数；从库软删后全部关系被软删 → 计数归零', () => {
    upsertRelation(db, { graphId: graph1, srcPaperId: paperX, dstPaperId: paperY, statement: 'a', llmTypes: ['based_on'], sourceType: 'job' })
    softDeletePaper(db, paperX)
    expect(paperRelationStats(db, paperX)).toEqual({ count: 0, graphCount: 0 })
  })
})
