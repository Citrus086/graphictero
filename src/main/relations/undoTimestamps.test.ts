import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { removePaperFromGraph, setNodePosition } from '../appService'
import { upsertRelation } from '../db/relations'
import { restoreRelation } from './restore'
import { isPaperProcessed, restoreGraphUpdatedAt, restoreRemovedPaper } from './progress'

/**
 * uat7b S1：⌘Z 撤销「从图谱移除」恢复原时间戳（D173④ 收尾）。
 * 移除时快照原 added_at / done_at / graphs.updated_at；撤销原样写回，
 * 不把这三个时间盖成撤销时刻。单个（D148）与批量（D179）同一路径。
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-undo-ts-'))
  const dataDir = join(dir, 'Graphictero')
  mkdirSync(dataDir, { recursive: true })
  db = new Database(join(dataDir, 'graphictero.db'))
  runMigrations(db, MIGRATIONS)
  const now = new Date().toISOString()
  graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('时间戳图', now, GRAPH_AT).lastInsertRowid)
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

function memberAddedAt(paperId: number): string | null {
  const row = db.prepare('SELECT added_at FROM graph_members WHERE graph_id = ? AND paper_id = ?').get(graphId, paperId) as
    | { added_at: string }
    | undefined
  return row?.added_at ?? null
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

describe('uat7b S1 撤销恢复原时间戳', () => {
  it('单个移除 → 撤销：added_at / done_at / graphs.updated_at 与移除前逐字相等', () => {
    const removed = removePaperFromGraph(db, graphId, paperA)
    expect(removed).toMatchObject({ hadProgress: true, addedAt: ADDED_A, doneAt: DONE_A, graphUpdatedAt: GRAPH_AT })
    // 移除后的中间态：成员与进度行都不在，graphs.updated_at 被 bump
    expect(memberAddedAt(paperA)).toBeNull()
    expect(progressDoneAt(paperA)).toBeNull()
    expect(graphUpdatedAt()).not.toBe(GRAPH_AT)

    restoreRemovedPaper(db, graphId, paperA, { addedAt: removed.addedAt, doneAt: removed.doneAt })
    restoreGraphUpdatedAt(db, graphId, removed.graphUpdatedAt)

    expect(memberAddedAt(paperA)).toBe(ADDED_A)
    expect(progressDoneAt(paperA)).toBe(DONE_A)
    expect(graphUpdatedAt()).toBe(GRAPH_AT)
    expect(isPaperProcessed(db, graphId, paperA)).toBe(true)
  })

  it('批量移除 → 一次撤销：每篇 added_at / done_at 原样，graphs.updated_at 回到移除前', () => {
    const removedA = removePaperFromGraph(db, graphId, paperA)
    const removedB = removePaperFromGraph(db, graphId, paperB)
    restoreRemovedPaper(db, graphId, paperA, { addedAt: removedA.addedAt, doneAt: removedA.doneAt })
    restoreRemovedPaper(db, graphId, paperB, { addedAt: removedB.addedAt, doneAt: removedB.doneAt })
    // 一批只调一次，写回批量移除前的原值（第一次移除前取的快照，D179 与 D148 同口径）
    restoreGraphUpdatedAt(db, graphId, removedA.graphUpdatedAt)
    expect(memberAddedAt(paperA)).toBe(ADDED_A)
    expect(memberAddedAt(paperB)).toBe(ADDED_B)
    expect(progressDoneAt(paperA)).toBe(DONE_A)
    expect(graphUpdatedAt()).toBe(GRAPH_AT)
  })

  it('原来没有进度行的论文：撤销不插进度行（uat2-fix1 口径不变）', () => {
    const removed = removePaperFromGraph(db, graphId, paperB) // B 无进度行
    expect(removed.hadProgress).toBe(false)
    expect(removed.doneAt).toBeNull()
    restoreRemovedPaper(db, graphId, paperB, { addedAt: removed.addedAt, doneAt: removed.doneAt })
    expect(memberAddedAt(paperB)).toBe(ADDED_B)
    expect(progressDoneAt(paperB)).toBeNull()
    expect(isPaperProcessed(db, graphId, paperB)).toBe(false)
  })

  it('重做（再移除）语义不变：重新移除会再次 bump graphs.updated_at', () => {
    const removed = removePaperFromGraph(db, graphId, paperA)
    restoreRemovedPaper(db, graphId, paperA, { addedAt: removed.addedAt, doneAt: removed.doneAt })
    restoreGraphUpdatedAt(db, graphId, removed.graphUpdatedAt)
    // ⌘⇧Z 重做 = 再次移除：时间戳照旧 bump 成重做时刻（不恢复原值）
    removePaperFromGraph(db, graphId, paperA)
    expect(memberAddedAt(paperA)).toBeNull()
    expect(graphUpdatedAt()).not.toBe(GRAPH_AT)
  })
})

describe('uat7b-fix1 M1 整条 undo 调用序列（真实 sqlite，按原语顺序）', () => {
  // uat8b B5 起 GraphPage 改走 undoGraphRemoval（同一顺序，并跳过已软删论文）。
  // 这里仍直接调用原语，锁住时间戳口径：
  //   逐篇 restoreRemovedPaper → 逐篇 setNodePosition（原坐标）→ 逐条 restoreRelation
  //   → restoreGraphUpdatedAt（批量取第一次移除前的快照）
  function undoLikeGraphPage(papers: Array<{ id: number; x: number; y: number }>, snaps: Array<{ addedAt: string; doneAt: string | null }>, graphUpdatedAt: string): void {
    papers.forEach((p, i) => restoreRemovedPaper(db, graphId, p.id, { addedAt: snaps[i].addedAt, doneAt: snaps[i].doneAt }))
    for (const p of papers) setNodePosition(db, graphId, p.id, p.x, p.y)
    restoreGraphUpdatedAt(db, graphId, graphUpdatedAt)
  }

  it('单个移除 → 整条撤销：added_at / done_at / graphs.updated_at 逐字恢复，坐标与边照常', () => {
    const t = '2026-10-15T08:00:00.000Z'
    const relId = upsertRelation(db, { graphId, srcPaperId: paperA, dstPaperId: paperB, statement: 'B 基于 A', llmTypes: ['based_on'], sourceType: 'job' })
    setNodePosition(db, graphId, paperA, 111, 222)

    const removed = removePaperFromGraph(db, graphId, paperA)
    expect(memberAddedAt(paperA)).toBeNull()
    expect(progressDoneAt(paperA)).toBeNull()

    // GraphPage 顺序：成员+进度 → 坐标 → 边 → graphs.updated_at
    restoreRemovedPaper(db, graphId, paperA, { addedAt: removed.addedAt, doneAt: removed.doneAt })
    setNodePosition(db, graphId, paperA, 111, 222)
    restoreRelation(db, { graphId, srcPaperId: paperA, dstPaperId: paperB, statement: 'B 基于 A', llmTypes: ['based_on'], autoTypes: [], id: relId, updatedAt: t })
    restoreGraphUpdatedAt(db, graphId, removed.graphUpdatedAt)

    // 评审必须修：added_at 逐字等于移除前（不是撤销时刻）
    expect(memberAddedAt(paperA)).toBe(ADDED_A)
    const member = db.prepare('SELECT x, y FROM graph_members WHERE graph_id = ? AND paper_id = ?').get(graphId, paperA) as { x: number; y: number }
    expect(member).toEqual({ x: 111, y: 222 })
    expect(progressDoneAt(paperA)).toBe(DONE_A)
    expect(graphUpdatedAt()).toBe(GRAPH_AT)
    const rel = db.prepare('SELECT deleted_at FROM relations WHERE id = ?').get(relId) as { deleted_at: string | null }
    expect(rel.deleted_at).toBeNull()
  })

  it('批量移除 → 一次整条撤销：每篇 added_at 原样、graphs.updated_at 取第一次移除前的值', () => {
    upsertRelation(db, { graphId, srcPaperId: paperA, dstPaperId: paperB, statement: 'B 基于 A', llmTypes: ['based_on'], sourceType: 'job' })
    const removedA = removePaperFromGraph(db, graphId, paperA)
    const removedB = removePaperFromGraph(db, graphId, paperB)
    // GraphPage：graphUpdatedAt ??= 第一次移除前的快照
    undoLikeGraphPage(
      [{ id: paperA, x: 10, y: 20 }, { id: paperB, x: 30, y: 40 }],
      [{ addedAt: removedA.addedAt, doneAt: removedA.doneAt }, { addedAt: removedB.addedAt, doneAt: removedB.doneAt }],
      removedA.graphUpdatedAt
    )
    expect(memberAddedAt(paperA)).toBe(ADDED_A)
    expect(memberAddedAt(paperB)).toBe(ADDED_B)
    expect(progressDoneAt(paperA)).toBe(DONE_A)
    expect(progressDoneAt(paperB)).toBeNull() // B 原来没有进度行，不插
    expect(graphUpdatedAt()).toBe(GRAPH_AT)
  })

  it('uat7b-fix1 S-f：恢复通道只接受 ISO 时间戳（快照写回，不成任意写入口）', () => {
    const removed = removePaperFromGraph(db, graphId, paperA)
    expect(() => restoreRemovedPaper(db, graphId, paperA, { addedAt: 'not-a-timestamp', doneAt: null })).toThrow(/ISO/)
    expect(() => restoreRemovedPaper(db, graphId, paperA, { addedAt: removed.addedAt, doneAt: '2026-10-01' })).toThrow(/ISO/)
    expect(() => restoreGraphUpdatedAt(db, graphId, '随便写')).toThrow(/ISO/)
    // 成员行仍未插入（校验在写入前）
    expect(memberAddedAt(paperA)).toBeNull()
    // 合法快照不受影响
    restoreRemovedPaper(db, graphId, paperA, { addedAt: removed.addedAt, doneAt: removed.doneAt })
    expect(memberAddedAt(paperA)).toBe(ADDED_A)
  })
})
