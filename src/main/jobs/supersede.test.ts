import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { enqueueJob, getJob, retryJob, supersedeSiblingFailures } from './store'
import { jobsOverview } from '../appService'

/**
 * uat6c S2 / D183：同 (kind, graph, 论文组) 的旧失败任务收敛为已被取代
 * （superseded_at）——不物理删除；状态点 / 弹层计数（jobsOverview）与补排退避
 * 不再计它们；已被取代的行不可手动重试；手动重试某条旧失败时同组其它旧失败先收敛。
 */

let dir: string
let db: Database.Database
let graphId: number

const now = (): string => new Date().toISOString()

function insertPaper(): number {
  const t = now()
  return Number(
    db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES (?, 'zotero', 1, ?, ?)").run(`论文${Math.random()}`, t, t).lastInsertRowid
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-supersede-'))
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS)
  graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('图', now(), now()).lastInsertRowid)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const supOf = (id: number): string | null =>
  (db.prepare('SELECT superseded_at FROM jobs WHERE id = ?').get(id) as { superseded_at: string | null }).superseded_at

describe('uat6c S2：同组旧失败任务收敛（superseded_at）', () => {
  it('手动重试某条失败任务 → 同（kind, graph, 论文组）其它失败被标已被取代；不同组不动', () => {
    const pid = insertPaper()
    const a = enqueueJob(db, 'relation_gen', { graphId, payload: { paperIds: [pid] } })
    const b = enqueueJob(db, 'relation_gen', { graphId, payload: { paperIds: [pid] } })
    const other = enqueueJob(db, 'relation_gen', { graphId, payload: { paperIds: [pid + 1000] } })
    const otherKind = enqueueJob(db, 'process_paper', { graphId, paperId: pid })
    for (const id of [a, b, other, otherKind]) db.prepare("UPDATE jobs SET status = 'failed_action' WHERE id = ?").run(id)
    retryJob(db, a) // 重试 a：同组其它失败收敛
    expect(getJob(db, a)!.status).toBe('queued')
    expect(supOf(b)).not.toBeNull()
    expect(supOf(other)).toBeNull()
    expect(supOf(otherKind)).toBeNull()
  })

  it('已被取代的行不可手动重试（报「已被更新的任务取代」）；未取代的失败仍可重试', () => {
    const pid = insertPaper()
    const a = enqueueJob(db, 'relation_gen', { graphId, payload: { paperIds: [pid] } })
    const b = enqueueJob(db, 'relation_gen', { graphId, payload: { paperIds: [pid] } })
    for (const id of [a, b]) db.prepare("UPDATE jobs SET status = 'failed_action' WHERE id = ?").run(id)
    retryJob(db, a)
    expect(() => retryJob(db, b)).toThrow('已被更新的任务取代')
    const c = enqueueJob(db, 'relation_gen', { graphId, payload: { paperIds: [pid] } })
    db.prepare("UPDATE jobs SET status = 'failed_retryable' WHERE id = ?").run(c)
    retryJob(db, c) // 未被取代的失败照常可重试
    expect(getJob(db, c)!.status).toBe('queued')
  })

  it('成功后（supersedeSiblingFailures 由引擎调用）：旧失败不再计入状态点计数与弹层列表', () => {
    const pid = insertPaper()
    const old1 = enqueueJob(db, 'relation_gen', { graphId, payload: { paperIds: [pid] } })
    const old2 = enqueueJob(db, 'relation_gen', { graphId, payload: { paperIds: [pid] } })
    for (const id of [old1, old2]) db.prepare("UPDATE jobs SET status = 'failed_action' WHERE id = ?").run(id)
    let ov = jobsOverview(db)
    expect(ov.failedAction).toBe(2)
    // B2：弹层按论文组合成一行，原始计数仍是 2
    expect(ov.failed).toHaveLength(1)
    expect(ov.failed[0].count).toBe(2)

    const ok = enqueueJob(db, 'relation_gen', { graphId, payload: { paperIds: [pid] } })
    db.prepare("UPDATE jobs SET status = 'succeeded' WHERE id = ?").run(ok)
    supersedeSiblingFailures(db, getJob(db, ok)!)
    ov = jobsOverview(db)
    expect(ov.failedAction).toBe(0)
    expect(ov.failed).toHaveLength(0)
    // 行还在（不物理删除）
    expect(db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).toEqual({ n: 3 })
  })

  it('收敛幂等：第二遍零写入；paper_id 与 payload.paperIds 不互认（签名不同组）', () => {
    const pid = insertPaper()
    const byPayload = enqueueJob(db, 'relation_gen', { graphId, payload: { paperIds: [pid] } })
    const byPaperId = enqueueJob(db, 'relation_gen', { graphId, paperId: pid })
    for (const id of [byPayload, byPaperId]) db.prepare("UPDATE jobs SET status = 'failed_action' WHERE id = ?").run(id)
    const ok = enqueueJob(db, 'relation_gen', { graphId, payload: { paperIds: [pid] } })
    db.prepare("UPDATE jobs SET status = 'succeeded' WHERE id = ?").run(ok)
    supersedeSiblingFailures(db, getJob(db, ok)!)
    expect(supOf(byPayload)).not.toBeNull()
    expect(supOf(byPaperId)).toBeNull() // 签名 ids:10 ≠ p10，不互认
    const snap = JSON.stringify(db.prepare('SELECT id, superseded_at FROM jobs ORDER BY id').all())
    supersedeSiblingFailures(db, getJob(db, ok)!)
    expect(JSON.stringify(db.prepare('SELECT id, superseded_at FROM jobs ORDER BY id').all())).toBe(snap)
  })
})

describe('uat6c-fix1 M1 / D183：relation_gen 失败行的论文标题（paper_id=NULL 真实形状）', () => {
  /** 造一条 relation_gen failed_action：paper_id 为 NULL、只在 payload.paperIds 记论文。 */
  const mkRelationFailure = (payload: Record<string, unknown>): number =>
    Number(
      db
        .prepare("INSERT INTO jobs (kind, graph_id, status, failed_step, error, payload, created_at, updated_at) VALUES ('relation_gen', ?, 'failed_action', 'generate', 'OpenAlex 400', ?, ?, ?)")
        .run(graphId, JSON.stringify(payload), now(), now()).lastInsertRowid
    )

  it('单篇：payload.paperIds=[pid] → 该论文标题（paper_id 为 NULL）', () => {
    const pid = insertPaper()
    const jobId = mkRelationFailure({ paperIds: [pid] })
    const ov = jobsOverview(db)
    const row = ov.failed.find((f) => f.jobId === jobId)!
    expect(row.paperId).toBeNull()
    expect(row.paperTitle).toBe((db.prepare('SELECT title FROM papers WHERE id = ?').get(pid) as { title: string }).title)
  })

  it('多篇：payload.paperIds=[a,b] →「2 篇论文」', () => {
    const a = insertPaper()
    const b = insertPaper()
    const jobId = mkRelationFailure({ paperIds: [a, b] })
    const row = jobsOverview(db).failed.find((f) => f.jobId === jobId)!
    expect(row.paperTitle).toBe('2 篇论文')
  })

  it('全图任务：payload 无 paperIds →「整个图谱」', () => {
    const jobId = mkRelationFailure({ regenerate: true })
    const row = jobsOverview(db).failed.find((f) => f.jobId === jobId)!
    expect(row.paperTitle).toBe('整个图谱')
  })

  it('已软删的论文不报错：多篇里含软删论文按原数量计 N，单篇软删退回「1 篇论文」', () => {
    const a = insertPaper()
    const b = insertPaper()
    db.prepare("UPDATE papers SET deleted_at = 'x' WHERE id = ?").run(b)
    const multi = mkRelationFailure({ paperIds: [a, b] })
    expect(jobsOverview(db).failed.find((f) => f.jobId === multi)!.paperTitle).toBe('2 篇论文')
    const single = mkRelationFailure({ paperIds: [b] })
    expect(jobsOverview(db).failed.find((f) => f.jobId === single)!.paperTitle).toBe('1 篇论文')
  })

  it('paper_id 非空的 process_paper 行照旧用 JOIN 标题（不走 payload）', () => {
    const pid = insertPaper()
    const jobId = enqueueJob(db, 'process_paper', { graphId, paperId: pid })
    db.prepare("UPDATE jobs SET status = 'failed_action' WHERE id = ?").run(jobId)
    const row = jobsOverview(db).failed.find((f) => f.jobId === jobId)!
    expect(row.paperTitle).toBe((db.prepare('SELECT title FROM papers WHERE id = ?').get(pid) as { title: string }).title)
  })
})

describe('uat8b B2 任务名与失败合并', () => {
  it('运行中的 relation_gen 走论文组标题，而不是「任务 N」', () => {
    const pid = insertPaper()
    const title = (db.prepare('SELECT title FROM papers WHERE id = ?').get(pid) as { title: string }).title
    db.prepare(
      "INSERT INTO jobs (kind, graph_id, status, payload, created_at, updated_at) VALUES ('relation_gen', ?, 'running', ?, ?, ?)"
    ).run(graphId, JSON.stringify({ paperIds: [pid] }), now(), now())
    const active = jobsOverview(db).active ?? []
    expect(active).toHaveLength(1)
    expect(active[0].paperTitle).toBe(title)
    expect(active[0].paperTitle.startsWith('任务 ')).toBe(false)
  })

  it('同一论文同一动作的失败合成一行，重试代表行后整组不再显示', () => {
    const pid = insertPaper()
    const older = enqueueJob(db, 'relation_gen', { graphId, payload: { paperIds: [pid] } })
    const newer = enqueueJob(db, 'relation_gen', { graphId, payload: { paperIds: [pid] } })
    db.prepare("UPDATE jobs SET status = 'failed_action', error = 'OpenAlex 400', updated_at = ? WHERE id = ?").run('2026-10-01T00:00:00.000Z', older)
    db.prepare("UPDATE jobs SET status = 'failed_action', error = 'OpenAlex 400', updated_at = ? WHERE id = ?").run('2026-10-02T00:00:00.000Z', newer)
    const ov = jobsOverview(db)
    expect(ov.failedAction).toBe(2)
    expect(ov.failed).toHaveLength(1)
    expect(ov.failed[0]).toMatchObject({ jobId: newer, count: 2 })
    retryJob(db, ov.failed[0].jobId)
    const after = jobsOverview(db)
    expect(after.failed).toHaveLength(0)
    expect(after.failedAction).toBe(0)
    expect(getJob(db, newer)!.status).toBe('queued')
    expect(supOf(older)).not.toBeNull()
  })
})
