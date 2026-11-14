import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { enqueueJob, setJobStatus } from '../jobs/store'
import { getLastParseInfo, getPapersProcessStatus } from './paperStatus'
import type Database from 'better-sqlite3'

/** 失败标记数据通路：论文处理状态由最新 process_paper 任务派生（不新增表） */

let dir: string
let db: Database.Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-pstatus-'))
  db = openDatabase(join(dir, 'graphictero.db'))
  runMigrations(db, MIGRATIONS)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function addPaper(title: string): number {
  const now = new Date().toISOString()
  const r = db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES (?, 'zotero', 1, ?, ?)").run(title, now, now)
  return Number(r.lastInsertRowid)
}

describe('getPapersProcessStatus（失败标记数据通路，D48/D85）', () => {
  it('从未入队 → unprocessed（D95「未处理」口径）', () => {
    const a = addPaper('A')
    expect(getPapersProcessStatus(db, [a])).toEqual([
      { paperId: a, jobId: null, state: 'unprocessed', currentStep: null, failedStep: null, error: null, updatedAt: null, detailRegen: null }
    ])
  })

  it('排队 / 运行 / 等待（联网·Key）→ 对应状态；等待态带原因、不带失败步骤', () => {
    const a = addPaper('排队')
    const b = addPaper('等网')
    enqueueJob(db, 'process_paper', { paperId: a })
    const jobB = enqueueJob(db, 'process_paper', { paperId: b })
    setJobStatus(db, jobB, 'waiting_network', { error: '等待联网' })
    const rows = getPapersProcessStatus(db, [a, b])
    expect(rows.find((r) => r.paperId === a)?.state).toBe('queued')
    expect(rows.find((r) => r.paperId === b)).toMatchObject({ state: 'waiting', failedStep: null, error: '等待联网' })
  })

  it('终态失败 → failed + 失败步骤 + 原因（03d 失败界面数据源）', () => {
    const a = addPaper('解析失败')
    const job = enqueueJob(db, 'process_paper', { paperId: a })
    setJobStatus(db, job, 'failed_retryable', { failedStep: 'parse', error: 'MinerU 进程意外退出' })
    const row = getPapersProcessStatus(db, [a])[0]
    expect(row).toMatchObject({ state: 'failed', failedStep: 'parse', error: 'MinerU 进程意外退出' })
    expect(row.updatedAt).not.toBeNull()
  })

  it('多任务取最新（重试后旧失败被覆盖）', () => {
    const a = addPaper('重试')
    const old = enqueueJob(db, 'process_paper', { paperId: a })
    setJobStatus(db, old, 'failed_action', { failedStep: 'card', error: '旧失败' })
    // 手动重试 → 新任务？同一论文已有终态任务时 enqueueJob 不拦（只拦活动任务）
    const newer = enqueueJob(db, 'process_paper', { paperId: a })
    expect(newer).not.toBe(old)
    setJobStatus(db, newer, 'succeeded')
    const row = getPapersProcessStatus(db, [a])[0]
    expect(row.state).toBe('succeeded')
    expect(row.error).toBeNull()
  })

  it('成功 → succeeded', () => {
    const a = addPaper('成功')
    const job = enqueueJob(db, 'process_paper', { paperId: a })
    setJobStatus(db, job, 'succeeded')
    expect(getPapersProcessStatus(db, [a])[0].state).toBe('succeeded')
  })
})

describe('detailRegen 独立字段（M5 前置 2a：detail_regen 期间显示「生成中」）', () => {
  it('running 的 detail_regen → 字段可见（排队/等待联网/等待 Key 同理），state 不受影响', () => {
    const a = addPaper('重生成中')
    const job = enqueueJob(db, 'process_paper', { paperId: a })
    setJobStatus(db, job, 'succeeded')
    const regen = enqueueJob(db, 'detail_regen', { paperId: a })
    setJobStatus(db, regen, 'running', { currentStep: 'detail' })
    const b = addPaper('等Key')
    setJobStatus(db, enqueueJob(db, 'detail_regen', { paperId: b }), 'waiting_key', { error: '缺少 API Key' })
    const rows = getPapersProcessStatus(db, [a])
    expect(rows[0]).toMatchObject({ state: 'succeeded', detailRegen: 'running', jobId: job })
    expect(getPapersProcessStatus(db, [b])[0].detailRegen).toBe('waiting_key')
  })

  it('detail_regen 已终结（succeeded / 失败）→ detailRegen 为 null', () => {
    const a = addPaper('重生成完')
    const regen = enqueueJob(db, 'detail_regen', { paperId: a })
    setJobStatus(db, regen, 'succeeded')
    expect(getPapersProcessStatus(db, [a])[0].detailRegen).toBeNull()
    setJobStatus(db, regen, 'failed_retryable', { failedStep: 'detail', error: '模型返回空' })
    expect(getPapersProcessStatus(db, [a])[0].detailRegen).toBeNull()
  })

  it('与 process 状态并存互不覆盖：process succeeded + detail_regen running 同时可见', () => {
    const a = addPaper('并存')
    const proc = enqueueJob(db, 'process_paper', { paperId: a })
    setJobStatus(db, proc, 'succeeded')
    const regen = enqueueJob(db, 'detail_regen', { paperId: a })
    setJobStatus(db, regen, 'running', { currentStep: 'detail' })
    const row = getPapersProcessStatus(db, [a])[0]
    expect(row.state).toBe('succeeded')
    expect(row.detailRegen).toBe('running')
    // 反向也不覆盖：detail_regen 终结后 process 状态原样保留
    setJobStatus(db, regen, 'succeeded')
    const after = getPapersProcessStatus(db, [a])[0]
    expect(after.state).toBe('succeeded')
    expect(after.detailRegen).toBeNull()
  })
})

describe('getLastParseInfo（设置页 05d「最近一次解析」，只读）', () => {
  it('从未解析成功 → null；解析步骤成功后 → 完成时间 + 耗时', () => {
    expect(getLastParseInfo(db)).toBeNull()
    const a = addPaper('P')
    const job = enqueueJob(db, 'process_paper', { paperId: a })
    // 模拟解析步骤成功：10:00:00 开始，10:00:24 完成
    db.prepare(
      "UPDATE job_steps SET status = 'succeeded', started_at = '2026-10-26T10:00:00.000Z', finished_at = '2026-10-26T10:00:24.000Z' WHERE job_id = ? AND step = 'parse'"
    ).run(job)
    expect(getLastParseInfo(db)).toEqual({ at: '2026-10-26T10:00:24.000Z', durationSec: 24, ok: true })
  })

  it('取最近一次：多篇解析后返回最新 finished_at；缺 started_at 时耗时为 null', () => {
    const a = addPaper('P1')
    const b = addPaper('P2')
    const j1 = enqueueJob(db, 'process_paper', { paperId: a })
    db.prepare(
      "UPDATE job_steps SET status = 'succeeded', started_at = '2026-10-26T09:00:00.000Z', finished_at = '2026-10-26T09:00:30.000Z' WHERE job_id = ? AND step = 'parse'"
    ).run(j1)
    const j2 = enqueueJob(db, 'process_paper', { paperId: b })
    db.prepare(
      "UPDATE job_steps SET status = 'succeeded', started_at = NULL, finished_at = '2026-10-26T11:00:00.000Z' WHERE job_id = ? AND step = 'parse'"
    ).run(j2)
    expect(getLastParseInfo(db)).toEqual({ at: '2026-10-26T11:00:00.000Z', durationSec: null, ok: true })
  })

  it('最近一条失败的解析也返回，ok 为 false', () => {
    const a = addPaper('P')
    const job = enqueueJob(db, 'process_paper', { paperId: a })
    db.prepare(
      "UPDATE job_steps SET status = 'failed', started_at = '2026-10-26T12:00:00.000Z', finished_at = '2026-10-26T12:00:08.000Z' WHERE job_id = ? AND step = 'parse'"
    ).run(job)
    expect(getLastParseInfo(db)).toEqual({ at: '2026-10-26T12:00:08.000Z', durationSec: 8, ok: false })
  })
})
