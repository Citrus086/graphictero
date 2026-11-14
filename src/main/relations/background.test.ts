import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { backfillNewPapers, startRelationsBackground } from './background'
import type { RelationGenEngine } from './engine'
import { markPaperProcessed, isPaperProcessed, clearPaperProcessed, restorePaperProgress } from './progress'

/**
 * startRelationsBackground（Q4 口径：周期 drain + 启动恢复 + 新增论文补排）测试。
 * 引擎用假实现（只记录调用），不跑真实任务。
 */

let dir: string
let db: Database.Database
let graphId: number
let paperA: number
let paperB: number
let engine: Pick<RelationGenEngine, 'enqueue' | 'resumeWaiting' | 'drain'>

function addPaper(title: string, withDetail: boolean): number {
  const now = new Date().toISOString()
  const id = Number(
    db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES (?, 'zotero', 1, ?, ?)").run(title, now, now).lastInsertRowid
  )
  db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)').run(graphId, id, now)
  if (withDetail) {
    db.prepare(
      `INSERT INTO paper_details (paper_id, parts, model, prompt_version, generated_at, created_at, updated_at)
       VALUES (?, ?, 'deepseek-flash', 'detail-v1', ?, ?, ?)`
    ).run(id, JSON.stringify([{ type: 'text', text: `${title} 详情。` }]), now, now, now)
  }
  return id
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-rel-bg-'))
  const dataDir = join(dir, 'Graphictero')
  mkdirSync(dataDir, { recursive: true })
  db = new Database(join(dataDir, 'graphictero.db'))
  runMigrations(db, MIGRATIONS)
  const now = new Date().toISOString()
  graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('后台图', now, now).lastInsertRowid)
  paperA = addPaper('Alpha', true)
  paperB = addPaper('Beta', true)
  engine = {
    enqueue: vi.fn(() => 1),
    resumeWaiting: vi.fn(),
    drain: vi.fn(async () => {})
  }
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('startRelationsBackground（Q4）', () => {
  it('启动立即 resumeWaiting + drain，并按周期重复', async () => {
    const h = startRelationsBackground({ db: () => db, engine: engine as RelationGenEngine, drainIntervalMs: 30 })
    await new Promise((r) => setTimeout(r, 100))
    h.stop()
    expect(engine.resumeWaiting).toHaveBeenCalled()
    expect(engine.drain).toHaveBeenCalled()
    // 30ms 周期 × 100ms ≈ 3 次以上
    expect(vi.mocked(engine.drain).mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('补排扫描：已生成过的图里，详情就绪但未处理的论文入队（D88）', () => {
    markPaperProcessed(db, graphId, paperA, new Date().toISOString()) // 此前生成过：A 已处理
    const out = backfillNewPapers(db, engine as RelationGenEngine)
    expect(out).toEqual([{ graphId, paperIds: [paperB] }])
    expect(engine.enqueue).toHaveBeenCalledWith(graphId, [paperB])
  })

  it('uat2 D62①：首次建图（从无 progress 行）所有论文详情就绪 → 整图补排一次', () => {
    // UAT 根因回归：旧口径扫 relation_gen_progress，空跑 succeeded 的图永远漏补
    const out = backfillNewPapers(db, engine as RelationGenEngine)
    expect(out).toEqual([{ graphId, paperIds: [paperA, paperB] }])
    expect(engine.enqueue).toHaveBeenCalledWith(graphId, [paperA, paperB])
  })

  it('uat2 D62②：已建图后某篇解析成功（新成员详情就绪）→ 只补这篇', () => {
    markPaperProcessed(db, graphId, paperA, new Date().toISOString())
    markPaperProcessed(db, graphId, paperB, new Date().toISOString())
    const gamma = addPaper('Gamma', true) // 后补 PDF / 重试成功的新增论文
    const out = backfillNewPapers(db, engine as RelationGenEngine)
    expect(out).toEqual([{ graphId, paperIds: [gamma] }])
  })

  it('uat2 D62③：无 PDF 的论文不参与补排', () => {
    markPaperProcessed(db, graphId, paperA, new Date().toISOString())
    markPaperProcessed(db, graphId, paperB, new Date().toISOString())
    const now = new Date().toISOString()
    const noPdf = Number(
      db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES ('NoPdf', 'zotero', 0, ?, ?)").run(now, now).lastInsertRowid
    )
    db.prepare('INSERT INTO paper_details (paper_id, parts, model, prompt_version, generated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      noPdf, JSON.stringify([{ type: 'text', text: '详情' }]), 'deepseek-flash', 'detail-v1', now, now, now
    )
    db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)').run(graphId, noPdf, now)
    expect(backfillNewPapers(db, engine as RelationGenEngine)).toEqual([])
    expect(engine.enqueue).not.toHaveBeenCalled()
  })

  it('uat2 D62④：已全部处理过的图不重复入队', () => {
    markPaperProcessed(db, graphId, paperA, new Date().toISOString())
    markPaperProcessed(db, graphId, paperB, new Date().toISOString())
    expect(backfillNewPapers(db, engine as RelationGenEngine)).toEqual([])
    expect(engine.enqueue).not.toHaveBeenCalled()
  })

  it('uat2-fix1 必须修 3：移除→撤销（恢复原进度行）→ 补排不把该论文当新论文重排', () => {
    markPaperProcessed(db, graphId, paperA, new Date().toISOString()) // A 此前生成过关系
    // 模拟 removePaperFromGraph：清进度行（hadProgress=true 由它返回）
    expect(isPaperProcessed(db, graphId, paperA)).toBe(true)
    clearPaperProcessed(db, graphId, paperA)
    expect(isPaperProcessed(db, graphId, paperA)).toBe(false)
    // 撤销：仅当原来有才恢复
    restorePaperProgress(db, graphId, paperA)
    expect(isPaperProcessed(db, graphId, paperA)).toBe(true)
    const out = backfillNewPapers(db, engine as RelationGenEngine)
    expect(out).toEqual([{ graphId, paperIds: [paperB] }]) // A 已处理不再补；只补详情就绪的 B
  })

  it('uat2-fix1 必须修 3：原来没有进度行的论文，撤销移除后仍会被正常补排（不误标已处理）', () => {
    // A/B 都未处理、详情就绪 → 都在补排范围（模拟「从未处理完就移除」的论文被加回）
    expect(isPaperProcessed(db, graphId, paperA)).toBe(false)
    const out = backfillNewPapers(db, engine as RelationGenEngine)
    expect(out).toEqual([{ graphId, paperIds: [paperA, paperB] }])
  })

  it('uat2-fix1：restorePaperProgress 幂等，已存在的行不被覆盖', () => {
    const t1 = '2026-01-01T00:00:00.000Z'
    markPaperProcessed(db, graphId, paperA, t1)
    restorePaperProgress(db, graphId, paperA, '2026-10-27T00:00:00.000Z')
    const row = db.prepare('SELECT done_at FROM relation_gen_progress WHERE graph_id = ? AND paper_id = ?').get(graphId, paperA) as { done_at: string }
    expect(row.done_at).toBe(t1) // DO NOTHING：原 done_at 保留
  })

  it('补排扫描：无详情的未处理论文不入队（D62/D67）', () => {
    markPaperProcessed(db, graphId, paperA, new Date().toISOString())
    addPaper('Gamma', false) // 无详情
    const out = backfillNewPapers(db, engine as RelationGenEngine)
    expect(out).toEqual([{ graphId, paperIds: [paperB] }])
  })

  // ── uat6b M2：补排退避（永久失败不重排 / 可恢复退避 + 上限 / 只留手动重试）──

  function insFailedRelationJob(status: 'failed_action' | 'failed_retryable', paperIds: number[], updatedAt: string): void {
    db.prepare(
      `INSERT INTO jobs (kind, graph_id, status, payload, created_at, updated_at)
       VALUES ('relation_gen', ?, ?, ?, ?, ?)`
    ).run(graphId, status, JSON.stringify({ paperIds }), updatedAt, updatedAt)
  }

  it('uat6b M2：failed_action（永久失败）的 (graph, paper) 不再自动补排——连续多轮零入队', () => {
    markPaperProcessed(db, graphId, paperA, new Date().toISOString()) // A 已处理，只看 B 的门控
    insFailedRelationJob('failed_action', [paperB], '2026-10-28T03:00:00.000Z')
    const t0 = Date.parse('2026-10-28T03:30:00.000Z')
    for (let i = 0; i < 5; i++) {
      expect(backfillNewPapers(db, engine as RelationGenEngine, new Date(t0 + i * 30_000))).toEqual([])
    }
    expect(engine.enqueue).not.toHaveBeenCalled() // 每 30 s 一个新失败任务的风暴停止
  })

  it('uat6b M2：failed_retryable 按指数退避——1 min 内不重排，过后补排一次', () => {
    markPaperProcessed(db, graphId, paperA, new Date().toISOString()) // A 已处理，只看 B 的门控
    const failAt = Date.parse('2026-10-28T03:00:00.000Z')
    insFailedRelationJob('failed_retryable', [paperB], new Date(failAt).toISOString())
    // 退避未到（< 1 min）：不补排
    expect(backfillNewPapers(db, engine as RelationGenEngine, new Date(failAt + 30_000))).toEqual([])
    expect(engine.enqueue).not.toHaveBeenCalled()
    // 退避到期（≥ 1 min）：补排
    expect(backfillNewPapers(db, engine as RelationGenEngine, new Date(failAt + 61_000))).toEqual([{ graphId, paperIds: [paperB] }])
    expect(engine.enqueue).toHaveBeenCalledWith(graphId, [paperB])
  })

  it('uat6b M2：可恢复失败满 3 次后停止自动补排（手动重试仍是唯一通道）', () => {
    markPaperProcessed(db, graphId, paperA, new Date().toISOString()) // A 已处理，只看 B 的门控
    const t0 = Date.parse('2026-10-28T03:00:00.000Z')
    for (let i = 0; i < 3; i++) {
      insFailedRelationJob('failed_retryable', [paperB], new Date(t0 + i * 600_000).toISOString())
    }
    // 第 3 次失败后无论过多久都不再自动补排
    expect(backfillNewPapers(db, engine as RelationGenEngine, new Date(t0 + 7 * 24 * 3600_000))).toEqual([])
    expect(engine.enqueue).not.toHaveBeenCalled()
  })

  it('uat6b-fix1 S2：可恢复失败第 2 次后等 4 分钟——3 分 59 秒不入队、4 分 01 秒入队', () => {
    markPaperProcessed(db, graphId, paperA, new Date().toISOString())
    const t0 = Date.parse('2026-10-28T03:00:00.000Z')
    insFailedRelationJob('failed_retryable', [paperB], new Date(t0).toISOString()) // 第 1 次
    insFailedRelationJob('failed_retryable', [paperB], new Date(t0 + 600_000).toISOString()) // 第 2 次（10 min 后）
    const lastFail = t0 + 600_000
    // 未到 4 分钟窗口：不入队（count=2 → 60s × 4^1 = 4 min）
    expect(backfillNewPapers(db, engine as RelationGenEngine, new Date(lastFail + 3 * 60_000 + 59_000))).toEqual([])
    expect(engine.enqueue).not.toHaveBeenCalled()
    // 过了 4 分钟窗口：补排一次
    expect(backfillNewPapers(db, engine as RelationGenEngine, new Date(lastFail + 4 * 60_000 + 1_000))).toEqual([{ graphId, paperIds: [paperB] }])
    expect(engine.enqueue).toHaveBeenCalledWith(graphId, [paperB])
  })

  it('uat6b M2：手动重试成功（进度行落库）后论文恢复正常的「已处理」口径，不再补排', () => {
    markPaperProcessed(db, graphId, paperA, new Date().toISOString()) // A 已处理，只看 B 的门控
    insFailedRelationJob('failed_action', [paperB], '2026-10-28T03:00:00.000Z')
    expect(backfillNewPapers(db, engine as RelationGenEngine, new Date('2026-10-28T04:00:00.000Z'))).toEqual([])
    markPaperProcessed(db, graphId, paperB, new Date().toISOString()) // 手动重试跑完：标记已处理
    expect(backfillNewPapers(db, engine as RelationGenEngine, new Date('2026-10-28T04:01:00.000Z'))).toEqual([])
    expect(engine.enqueue).not.toHaveBeenCalled()
  })

  it('uat6b M2：失败任务只影响其 payload 里的论文，其它未处理论文照常补排', () => {
    insFailedRelationJob('failed_action', [paperA], '2026-10-28T03:00:00.000Z')
    const out = backfillNewPapers(db, engine as RelationGenEngine, new Date('2026-10-28T04:00:00.000Z'))
    expect(out).toEqual([{ graphId, paperIds: [paperB] }]) // A 永久失败跳过，B 正常
  })

  it('uat6b M2：全图失败任务（payload 无 paperIds，手动重新生成）不按论文门控', () => {
    db.prepare(
      `INSERT INTO jobs (kind, graph_id, status, payload, created_at, updated_at)
       VALUES ('relation_gen', ?, 'failed_action', '{}', ?, ?)`
    ).run(graphId, '2026-10-28T03:00:00.000Z', '2026-10-28T03:00:00.000Z')
    const out = backfillNewPapers(db, engine as RelationGenEngine, new Date('2026-10-28T04:00:00.000Z'))
    expect(out).toEqual([{ graphId, paperIds: [paperA, paperB] }])
  })
})
