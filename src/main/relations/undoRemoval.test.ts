import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { removePaperFromGraph, setNodePosition, softDeletePaper } from '../appService'
import { upsertRelation } from '../db/relations'
import type { UndoGraphRemovalInput } from '../../shared/ipc/relations'
import { undoGraphRemoval } from './undoRemoval'

/**
 * uat8b B5：撤销「从图谱移除」时跳过已从库软删的论文。
 * 全跳过不写库（含 graphs.updated_at）；部分跳过只恢复仍在库中的论文与不触及被跳过论文的关系。
 */

let dir: string
let db: Database.Database
let graphId: number
let paperA: number
let paperB: number
let paperC: number

const ADDED_A = '2026-09-01T08:00:00.000Z'
const ADDED_B = '2026-09-02T08:00:00.000Z'
const DONE_A = '2026-09-10T09:00:00.000Z'
const GRAPH_AT = '2026-09-20T10:00:00.000Z'
const REL_AT = '2026-10-15T08:00:00.000Z'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-undo-rm-'))
  const dataDir = join(dir, 'Graphictero')
  mkdirSync(dataDir, { recursive: true })
  db = new Database(join(dataDir, 'graphictero.db'))
  runMigrations(db, MIGRATIONS)
  const now = new Date().toISOString()
  graphId = Number(
    db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('撤销图', now, GRAPH_AT).lastInsertRowid
  )
  const ins = db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES (?, 'zotero', 1, ?, ?)")
  paperA = Number(ins.run('Alpha', now, now).lastInsertRowid)
  paperB = Number(ins.run('Beta', now, now).lastInsertRowid)
  paperC = Number(ins.run('Gamma', now, now).lastInsertRowid)
  db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 10, 20, ?)').run(graphId, paperA, ADDED_A)
  db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 30, 40, ?)').run(graphId, paperB, ADDED_B)
  db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 50, 60, ?)').run(graphId, paperC, now)
  db.prepare('INSERT INTO relation_gen_progress (graph_id, paper_id, done_at) VALUES (?, ?, ?)').run(graphId, paperA, DONE_A)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function memberOf(paperId: number): { x: number; y: number; added_at: string } | undefined {
  return db.prepare('SELECT x, y, added_at FROM graph_members WHERE graph_id = ? AND paper_id = ?').get(graphId, paperId) as
    | { x: number; y: number; added_at: string }
    | undefined
}

function graphUpdatedAt(): string {
  return (db.prepare('SELECT updated_at FROM graphs WHERE id = ?').get(graphId) as { updated_at: string }).updated_at
}

function progressDoneAt(paperId: number): string | null {
  const row = db.prepare('SELECT done_at FROM relation_gen_progress WHERE graph_id = ? AND paper_id = ?').get(graphId, paperId) as
    | { done_at: string }
    | undefined
  return row?.done_at ?? null
}

function relDeleted(id: number): string | null {
  return (db.prepare('SELECT deleted_at FROM relations WHERE id = ?').get(id) as { deleted_at: string | null }).deleted_at
}

function changes(): number {
  return db.prepare('SELECT total_changes() AS n').pluck().get() as number
}

describe('uat8b B5 撤销跳过已软删论文', () => {
  it('单篇仍在库：坐标、added_at、进度、关系、graphs.updated_at 原样恢复', () => {
    setNodePosition(db, graphId, paperA, 111, 222)
    const relId = upsertRelation(db, {
      graphId,
      srcPaperId: paperA,
      dstPaperId: paperC,
      statement: 'C 基于 A',
      llmTypes: ['based_on'],
      sourceType: 'job',
      now: REL_AT
    })
    const removed = removePaperFromGraph(db, graphId, paperA)
    const result = undoGraphRemoval(db, {
      graphId,
      graphUpdatedAt: removed.graphUpdatedAt,
      papers: [{ paperId: paperA, x: 111, y: 222, addedAt: removed.addedAt, doneAt: removed.doneAt }],
      relations: [{
        graphId,
        id: relId,
        srcPaperId: paperA,
        dstPaperId: paperC,
        statement: 'C 基于 A',
        llmTypes: ['based_on'],
        autoTypes: [],
        updatedAt: REL_AT
      }]
    })
    expect(result).toEqual({ restored: 1, skipped: 0, applied: true, restoredIds: [paperA] })
    expect(memberOf(paperA)).toEqual({ x: 111, y: 222, added_at: ADDED_A })
    expect(progressDoneAt(paperA)).toBe(DONE_A)
    expect(graphUpdatedAt()).toBe(GRAPH_AT)
    expect(relDeleted(relId)).toBeNull()
    const rel = db.prepare('SELECT statement_text, updated_at FROM relations WHERE id = ?').get(relId) as {
      statement_text: string
      updated_at: string
    }
    expect(rel.statement_text).toBe('C 基于 A')
    expect(rel.updated_at).toBe(REL_AT)
  })

  it('批量都还在库：每篇原样恢复，updated_at 取第一次移除前的值', () => {
    const relId = upsertRelation(db, {
      graphId,
      srcPaperId: paperA,
      dstPaperId: paperB,
      statement: 'B 基于 A',
      llmTypes: ['based_on'],
      sourceType: 'job'
    })
    const removedA = removePaperFromGraph(db, graphId, paperA)
    const removedB = removePaperFromGraph(db, graphId, paperB)
    const result = undoGraphRemoval(
      db,
      inputOf(removedA.graphUpdatedAt, [
        { paperId: paperA, x: 10, y: 20, addedAt: removedA.addedAt, doneAt: removedA.doneAt },
        { paperId: paperB, x: 30, y: 40, addedAt: removedB.addedAt, doneAt: removedB.doneAt }
      ], [{ id: relId, srcPaperId: paperA, dstPaperId: paperB, statement: 'B 基于 A' }])
    )
    expect(result).toEqual({ restored: 2, skipped: 0, applied: true, restoredIds: [paperA, paperB] })
    expect(memberOf(paperA)?.added_at).toBe(ADDED_A)
    expect(memberOf(paperB)?.added_at).toBe(ADDED_B)
    expect(progressDoneAt(paperA)).toBe(DONE_A)
    expect(progressDoneAt(paperB)).toBeNull()
    expect(graphUpdatedAt()).toBe(GRAPH_AT)
    expect(relDeleted(relId)).toBeNull()
  })

  it('部分软删：跳过已删论文及其关系，其余原样恢复', () => {
    const relAB = upsertRelation(db, {
      graphId,
      srcPaperId: paperA,
      dstPaperId: paperB,
      statement: 'B 基于 A',
      llmTypes: ['based_on'],
      sourceType: 'job',
      now: REL_AT
    })
    const relAC = upsertRelation(db, {
      graphId,
      srcPaperId: paperA,
      dstPaperId: paperC,
      statement: 'C 基于 A',
      llmTypes: ['compares'],
      sourceType: 'job',
      now: REL_AT
    })
    const removedA = removePaperFromGraph(db, graphId, paperA)
    const removedB = removePaperFromGraph(db, graphId, paperB)
    softDeletePaper(db, paperB)
    const result = undoGraphRemoval(
      db,
      inputOf(removedA.graphUpdatedAt, [
        { paperId: paperA, x: 10, y: 20, addedAt: removedA.addedAt, doneAt: removedA.doneAt },
        { paperId: paperB, x: 30, y: 40, addedAt: removedB.addedAt, doneAt: removedB.doneAt }
      ], [
        { id: relAB, srcPaperId: paperA, dstPaperId: paperB, statement: 'B 基于 A' },
        { id: relAC, srcPaperId: paperA, dstPaperId: paperC, statement: 'C 基于 A', llmTypes: ['compares'] }
      ])
    )
    expect(result).toEqual({ restored: 1, skipped: 1, applied: true, restoredIds: [paperA] })
    expect(memberOf(paperA)).toEqual({ x: 10, y: 20, added_at: ADDED_A })
    expect(memberOf(paperB)).toBeUndefined()
    expect(progressDoneAt(paperA)).toBe(DONE_A)
    expect(progressDoneAt(paperB)).toBeNull()
    expect(relDeleted(relAB)).not.toBeNull()
    expect(relDeleted(relAC)).toBeNull()
    expect(graphUpdatedAt()).toBe(GRAPH_AT)
    expect((db.prepare('SELECT deleted_at FROM papers WHERE id = ?').get(paperB) as { deleted_at: string }).deleted_at).not.toBeNull()
  })

  it('单篇已软删：不恢复成员与关系，graphs.updated_at 一字不改', () => {
    const relId = upsertRelation(db, {
      graphId,
      srcPaperId: paperA,
      dstPaperId: paperC,
      statement: 'C 基于 A',
      llmTypes: ['based_on'],
      sourceType: 'job'
    })
    const removed = removePaperFromGraph(db, graphId, paperA)
    softDeletePaper(db, paperA)
    const before = graphUpdatedAt()
    expect(before).not.toBe(GRAPH_AT)
    const writes = changes()
    const result = undoGraphRemoval(
      db,
      inputOf(removed.graphUpdatedAt, [{ paperId: paperA, x: 10, y: 20, addedAt: removed.addedAt, doneAt: removed.doneAt }], [
        { id: relId, srcPaperId: paperA, dstPaperId: paperC, statement: 'C 基于 A' }
      ])
    )
    expect(result).toEqual({ restored: 0, skipped: 1, applied: false, restoredIds: [] })
    expect(changes()).toBe(writes)
    expect(graphUpdatedAt()).toBe(before)
    expect(memberOf(paperA)).toBeUndefined()
    expect(progressDoneAt(paperA)).toBeNull()
    expect(relDeleted(relId)).not.toBeNull()
  })

  it('批量全部软删：同样不写库', () => {
    const removedA = removePaperFromGraph(db, graphId, paperA)
    const removedB = removePaperFromGraph(db, graphId, paperB)
    softDeletePaper(db, paperA)
    softDeletePaper(db, paperB)
    const before = graphUpdatedAt()
    const writes = changes()
    const result = undoGraphRemoval(
      db,
      inputOf(removedA.graphUpdatedAt, [
        { paperId: paperA, x: 10, y: 20, addedAt: removedA.addedAt, doneAt: removedA.doneAt },
        { paperId: paperB, x: 30, y: 40, addedAt: removedB.addedAt, doneAt: removedB.doneAt }
      ], [])
    )
    expect(result).toEqual({ restored: 0, skipped: 2, applied: false, restoredIds: [] })
    expect(changes()).toBe(writes)
    expect(graphUpdatedAt()).toBe(before)
    expect(memberOf(paperA)).toBeUndefined()
    expect(memberOf(paperB)).toBeUndefined()
  })

  it('关系另一端已软删、不在本次移除名单：不抛错，只恢复仍在库的论文', () => {
    const relAB = upsertRelation(db, {
      graphId,
      srcPaperId: paperA,
      dstPaperId: paperB,
      statement: 'B 基于 A',
      llmTypes: ['based_on'],
      sourceType: 'job'
    })
    const relAC = upsertRelation(db, {
      graphId,
      srcPaperId: paperA,
      dstPaperId: paperC,
      statement: 'C 基于 A',
      llmTypes: ['compares'],
      sourceType: 'job'
    })
    const removed = removePaperFromGraph(db, graphId, paperA)
    softDeletePaper(db, paperB)
    const result = undoGraphRemoval(
      db,
      inputOf(removed.graphUpdatedAt, [{ paperId: paperA, x: 11, y: 22, addedAt: removed.addedAt, doneAt: removed.doneAt }], [
        { id: relAB, srcPaperId: paperA, dstPaperId: paperB, statement: 'B 基于 A' },
        { id: relAC, srcPaperId: paperA, dstPaperId: paperC, statement: 'C 基于 A', llmTypes: ['compares'] }
      ])
    )
    expect(result).toEqual({ restored: 1, skipped: 0, applied: true, restoredIds: [paperA] })
    expect(memberOf(paperA)).toEqual({ x: 11, y: 22, added_at: ADDED_A })
    expect(relDeleted(relAB)).not.toBeNull()
    expect(relDeleted(relAC)).toBeNull()
    expect(graphUpdatedAt()).toBe(GRAPH_AT)
  })

  it('库里没有这篇论文：当作跳过，不写库', () => {
    const before = graphUpdatedAt()
    const writes = changes()
    const result = undoGraphRemoval(
      db,
      inputOf(GRAPH_AT, [{ paperId: 999999, x: 10, y: 20, addedAt: ADDED_A, doneAt: null }], [])
    )
    expect(result).toEqual({ restored: 0, skipped: 1, applied: false, restoredIds: [] })
    expect(changes()).toBe(writes)
    expect(graphUpdatedAt()).toBe(before)
    expect(memberOf(paperA)?.added_at).toBe(ADDED_A)
  })

  it('非法时间戳在写入前拒绝，成员行保持不在', () => {
    const removed = removePaperFromGraph(db, graphId, paperA)
    const writes = changes()
    expect(() =>
      undoGraphRemoval(
        db,
        inputOf('not-a-timestamp', [{ paperId: paperA, x: 10, y: 20, addedAt: removed.addedAt, doneAt: removed.doneAt }], [])
      )
    ).toThrow(/ISO/)
    expect(() =>
      undoGraphRemoval(
        db,
        inputOf(removed.graphUpdatedAt, [{ paperId: paperA, x: 10, y: 20, addedAt: '2026-10-01', doneAt: null }], [])
      )
    ).toThrow(/ISO/)
    expect(changes()).toBe(writes)
    expect(memberOf(paperA)).toBeUndefined()
    expect(graphUpdatedAt()).not.toBe(GRAPH_AT)
  })
})

function inputOf(
  graphUpdatedAt: string,
  papers: UndoGraphRemovalInput['papers'],
  relations: Array<{ id: number; srcPaperId: number; dstPaperId: number; statement: string; llmTypes?: Array<'based_on' | 'compares'> }>
): UndoGraphRemovalInput {
  return {
    graphId,
    graphUpdatedAt,
    papers,
    relations: relations.map((rel) => ({
      graphId,
      id: rel.id,
      srcPaperId: rel.srcPaperId,
      dstPaperId: rel.dstPaperId,
      statement: rel.statement,
      llmTypes: rel.llmTypes ?? ['based_on'],
      autoTypes: [],
      updatedAt: REL_AT
    }))
  }
}
