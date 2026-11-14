import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { snapshotRelation, restoreSnapshot } from './snapshots'

/**
 * M6 前置 2a（D129 = Q-M6-6 ①）：关系改动前快照。
 * 测试闸门（m6_plan §2a）：修改 job 边（updateRelation 路径）→ 撤销后字节一致；删除 → 撤销后恢复含
 * autoTypes；同回合同边改两次 → 撤销回到回合前；跨回合冲突 → 仍拒绝并给中文原因。
 */

let dir: string
let db: Database.Database
let graphId: number
let sessionId: number
let paperA: number
let paperB: number

const now = (): string => new Date().toISOString()

function insertPaper(title: string): number {
  return Number(
    db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES (?, 'zotero', 1, ?, ?)").run(title, now(), now()).lastInsertRowid
  )
}

/** 预置一条 job 边（含 autoTypes / source_job_id / model / promptVersion），返回关系 id。 */
function seedJobEdge(): number {
  const jobId = Number(
    db.prepare("INSERT INTO jobs (kind, paper_id, status, payload, created_at, updated_at) VALUES ('relation_gen', ?, 'succeeded', '{}', ?, ?)").run(paperA, now(), now()).lastInsertRowid
  )
  return Number(
    db
      .prepare(
        `INSERT INTO relations (graph_id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types,
           source_type, source_job_id, model, prompt_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'job 版陈述', '["compares"]', '["same_author"]', 'job', ?, 'deepseek-flash', 'rel-v1', ?, ?)`
      )
      .run(graphId, Math.min(paperA, paperB), Math.max(paperA, paperB), paperA, jobId, now(), now()).lastInsertRowid
  )
}

function liveRow(relationId: number): Record<string, unknown> {
  return db.prepare('SELECT * FROM relations WHERE id = ?').get(relationId) as Record<string, unknown>
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-snap-'))
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS)
  graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('快照图', now(), now()).lastInsertRowid)
  sessionId = Number(db.prepare("INSERT INTO sessions (graph_id, entry_type, entry_id, name, created_at, updated_at) VALUES (?, 'graph', NULL, 's', ?, ?)").run(graphId, now(), now()).lastInsertRowid)
  paperA = insertPaper('甲')
  paperB = insertPaper('乙')
  const ins = db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)')
  ins.run(graphId, paperA, now())
  ins.run(graphId, paperB, now())
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('relation_snapshots（M6 前置 2a，D129）', () => {
  it('修改 job 边（updateRelation 路径）→ 按快照撤销后 statement / llm_types / source_type / source_job_id / src_paper 字节一致', () => {
    const rid = seedJobEdge()
    const snapId = snapshotRelation(db, { sessionId, turnId: 't1', relationId: rid, op: 'update' })
    // 修改改写（模拟 tools.ts 的 updateRelation upsert：翻 session、换陈述/类型、方向保持）
    db.prepare(
      `UPDATE relations SET statement_text = '会话版陈述', llm_types = '["based_on"]', source_type = 'session',
         source_job_id = NULL, source_session_id = ?, updated_at = ? WHERE id = ?`
    ).run(sessionId, now(), rid)

    restoreSnapshot(db, snapId)
    const row = liveRow(rid)
    expect(row.statement_text).toBe('job 版陈述')
    expect(row.llm_types).toBe('["compares"]')
    expect(row.auto_types).toBe('["same_author"]')
    expect(row.source_type).toBe('job')
    expect(row.source_job_id).not.toBeNull()
    expect(row.source_session_id).toBeNull()
    expect(row.src_paper).toBe(paperA) // 方向还原
    expect(row.deleted_at).toBeNull()
  })

  it('删除 → 按快照撤销后原地复活，含 autoTypes 与原 provenance', () => {
    const rid = seedJobEdge()
    const snapId = snapshotRelation(db, { sessionId, turnId: 't1', relationId: rid, op: 'delete' })
    db.prepare('UPDATE relations SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), rid)
    expect(liveRow(rid).deleted_at).not.toBeNull()

    const restoredId = restoreSnapshot(db, snapId)
    expect(restoredId).toBe(rid) // 原地复活：id / created_at 不变
    const row = liveRow(rid)
    expect(row.deleted_at).toBeNull()
    expect(row.auto_types).toBe('["same_author"]')
    expect(row.source_type).toBe('job')
    expect(row.created_at).toBe(row.created_at)
  })

  it('同回合同边改两次 → 逆序还原两次快照回到回合前', () => {
    const rid = seedJobEdge()
    const s1 = snapshotRelation(db, { sessionId, turnId: 't1', relationId: rid, op: 'update' })
    db.prepare("UPDATE relations SET statement_text = '第一次改写' WHERE id = ?").run(rid)
    const s2 = snapshotRelation(db, { sessionId, turnId: 't1', relationId: rid, op: 'update' })
    db.prepare("UPDATE relations SET statement_text = '第二次改写' WHERE id = ?").run(rid)
    expect(liveRow(rid).statement_text).toBe('第二次改写')

    // 撤销组逆序：先还 s2（→ 第一次改写前 = 第一次改写？不——s2 的快照是「第一次改写」态）
    restoreSnapshot(db, s2)
    expect(liveRow(rid).statement_text).toBe('第一次改写')
    restoreSnapshot(db, s1)
    expect(liveRow(rid).statement_text).toBe('job 版陈述') // 回到回合前
  })

  it('跨回合冲突：较新回合又改过同一条边 → 拒绝并给中文原因（D104 守卫保留）', () => {
    const rid = seedJobEdge()
    const s1 = snapshotRelation(db, { sessionId, turnId: 't1', relationId: rid, op: 'update' })
    db.prepare("UPDATE relations SET statement_text = '第一次改写' WHERE id = ?").run(rid)
    const s2 = snapshotRelation(db, { sessionId, turnId: 't2', relationId: rid, op: 'update' }) // 较新回合快照
    db.prepare("UPDATE relations SET statement_text = '回合二改写' WHERE id = ?").run(rid)

    // 撤回合一：较新回合（t2）又改过 → 拒绝；当前内容不被破坏
    expect(() => restoreSnapshot(db, s1)).toThrow('更新的回合被再次改动')
    expect(liveRow(rid).statement_text).toBe('回合二改写')
    // 撤回合二：回到回合二改写前的状态
    restoreSnapshot(db, s2)
    expect(liveRow(rid).statement_text).toBe('第一次改写')
  })

  it('uat4 建议修11（D148/D164 原样恢复）：删除 → 按快照撤销后 updated_at 写回原值，不盖成撤销时刻', () => {
    const rid = seedJobEdge()
    const original = '2026-10-20T08:00:00.000Z'
    db.prepare('UPDATE relations SET updated_at = ? WHERE id = ?').run(original, rid)
    const snapId = snapshotRelation(db, { sessionId, turnId: 't1', relationId: rid, op: 'delete' })
    db.prepare('UPDATE relations SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), rid)

    restoreSnapshot(db, snapId)
    expect(liveRow(rid).updated_at).toBe(original) // 原样恢复：不是撤销时刻

    // 再做一轮 删除→撤销（重做后重复撤销）：仍等于原值，不回退
    db.prepare('UPDATE relations SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), rid)
    restoreSnapshot(db, snapId)
    expect(liveRow(rid).updated_at).toBe(original)
  })

  it('uat4 建议修11：撤销「编辑」快照同样写回原 updated_at', () => {
    const rid = seedJobEdge()
    const original = '2026-10-20T08:00:00.000Z'
    db.prepare('UPDATE relations SET updated_at = ? WHERE id = ?').run(original, rid)
    const snapId = snapshotRelation(db, { sessionId, turnId: 't1', relationId: rid, op: 'update' })
    db.prepare("UPDATE relations SET statement_text = '改写', updated_at = ? WHERE id = ?").run(now(), rid)

    restoreSnapshot(db, snapId)
    expect(liveRow(rid).updated_at).toBe(original)
    expect(liveRow(rid).statement_text).toBe('job 版陈述')
  })

  it('快照不存在：中文报错', () => {
    expect(() => restoreSnapshot(db, 999)).toThrow('不存在')
  })
})
