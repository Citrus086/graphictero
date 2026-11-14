import type Database from 'better-sqlite3'
import type { RelationRestoreInput, UndoGraphRemovalInput, UndoGraphRemovalResult } from '../../shared/ipc/relations'
import { setNodePosition } from '../appService'
import { restoreGraphUpdatedAt, restoreRemovedPaper } from './progress'
import { restoreRelation } from './restore'

/**
 * uat8b B5：D148 ⌘Z 撤销「从图谱移除」时，论文若之后已被从库软删除（D75 deleted_at），
 * 跳过这些论文（不恢复成员、不恢复其关系）。其余照 D164② 原样恢复。
 * 一篇都恢复不了时不写任何行，包括 graphs.updated_at。
 */

const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

function assertIso(value: string, field: string): void {
  if (!ISO_TS.test(value)) throw new Error(`${field} 必须是 ISO 时间戳（快照写回通道）`)
}

function assertInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${field} 必须是整数`)
  return value
}

interface Keeper {
  paperId: number
  x: number
  y: number
  addedAt: string
  doneAt: string | null
}

export function undoGraphRemoval(db: Database.Database, input: UndoGraphRemovalInput): UndoGraphRemovalResult {
  const graphId = assertInt(input?.graphId, 'graphId')
  if (!Array.isArray(input.papers) || !Array.isArray(input.relations)) throw new Error('撤销快照不完整')

  const seen = new Set<number>()
  const papers: Keeper[] = []
  for (const raw of input.papers) {
    const paperId = assertInt(raw?.paperId, 'paperId')
    if (seen.has(paperId)) continue
    seen.add(paperId)
    if (typeof raw.x !== 'number' || !Number.isFinite(raw.x) || typeof raw.y !== 'number' || !Number.isFinite(raw.y)) {
      throw new Error('坐标必须是数字')
    }
    const doneAt = raw.doneAt ?? null
    if (doneAt != null && typeof doneAt !== 'string') throw new Error('doneAt 必须是 ISO 时间戳或 null')
    if (typeof raw.addedAt !== 'string') throw new Error('addedAt 必须是 ISO 时间戳（快照写回通道）')
    papers.push({ paperId, x: raw.x, y: raw.y, addedAt: raw.addedAt, doneAt })
  }
  if (papers.length === 0) return { restored: 0, skipped: 0, applied: false, restoredIds: [] }

  const relations: RelationRestoreInput[] = input.relations
  const lookupIds = new Set<number>(papers.map((p) => p.paperId))
  for (const rel of relations) {
    lookupIds.add(assertInt(rel?.srcPaperId, 'srcPaperId'))
    lookupIds.add(assertInt(rel?.dstPaperId, 'dstPaperId'))
  }
  const alive = alivePaperIds(db, [...lookupIds])
  const keep = papers.filter((p) => alive.has(p.paperId))
  const skipped = papers.length - keep.length
  if (keep.length === 0) return { restored: 0, skipped, applied: false, restoredIds: [] }

  assertIso(input.graphUpdatedAt, 'graphUpdatedAt')
  for (const paper of keep) {
    assertIso(paper.addedAt, 'addedAt')
    if (paper.doneAt != null) assertIso(paper.doneAt, 'doneAt')
  }
  const skippedIds = new Set(papers.filter((p) => !alive.has(p.paperId)).map((p) => p.paperId))
  const restorable = relations.filter(
    (rel) => !skippedIds.has(rel.srcPaperId) && !skippedIds.has(rel.dstPaperId) && alive.has(rel.srcPaperId) && alive.has(rel.dstPaperId)
  )
  for (const rel of restorable) {
    if (rel.updatedAt != null) assertIso(rel.updatedAt, 'updatedAt')
  }

  const tx = db.transaction(() => {
    for (const paper of keep) {
      restoreRemovedPaper(db, graphId, paper.paperId, { addedAt: paper.addedAt, doneAt: paper.doneAt })
      setNodePosition(db, graphId, paper.paperId, paper.x, paper.y)
    }
    for (const rel of restorable) restoreRelation(db, { ...rel, graphId })
    restoreGraphUpdatedAt(db, graphId, input.graphUpdatedAt)
  })
  tx()
  return { restored: keep.length, skipped, applied: true, restoredIds: keep.map((p) => p.paperId) }
}

function alivePaperIds(db: Database.Database, ids: number[]): Set<number> {
  const alive = new Set<number>()
  const chunk = 200
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk)
    const rows = db
      .prepare(`SELECT id FROM papers WHERE deleted_at IS NULL AND id IN (${slice.map(() => '?').join(',')})`)
      .all(...slice) as Array<{ id: number }>
    for (const row of rows) alive.add(row.id)
  }
  return alive
}
