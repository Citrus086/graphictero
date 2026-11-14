import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import type { AppState } from './types'

/**
 * lane/relations 车道 IPC 接线测试：通道注册 + 参数透传 + 视图形状。
 * 引擎与 OpenAlex 客户端均 mock（本文件不断网、不触真实 API）。
 */

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
const engineMocks = vi.hoisted(() => ({
  enqueue: vi.fn((_graphId: number, _paperIds?: number[]) => 42),
  enqueueRegenerate: vi.fn((_graphId: number) => 43)
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler)
    }
  },
  BrowserWindow: { getAllWindows: () => [] },
  net: { isOnline: () => true }
}))

  vi.mock('../relations/engine', () => ({
  RelationGenEngine: class {
    enqueue = engineMocks.enqueue
    enqueueRegenerate = engineMocks.enqueueRegenerate
    drain = vi.fn(async () => {})
  }
}))

import { registerRelationsIpc } from './relations'

let dir: string
let state: AppState
let graphId: number
let paperA: number
let paperB: number
let registeredEngine: unknown

const call = (channel: string, ...args: unknown[]): Promise<unknown> => {
  const h = handlers.get(channel)
  if (!h) throw new Error(`channel ${channel} 未注册`)
  return h({ sender: { isDestroyed: () => true, send: vi.fn() } }, ...args)
}

function addPaper(title: string): number {
  const now = new Date().toISOString()
  const r = dbOf()
    .prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES (?, 'zotero', 1, ?, ?)")
    .run(title, now, now)
  const id = Number(r.lastInsertRowid)
  dbOf().prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)').run(graphId, id, now)
  return id
}

function dbOf(): Database.Database {
  return state.db
}

beforeEach(() => {
  handlers.clear()
  engineMocks.enqueue.mockClear()
  engineMocks.enqueueRegenerate.mockClear()
  dir = mkdtempSync(join(tmpdir(), 'gt-rel-ipc-'))
  const dataDir = join(dir, 'Graphictero')
  mkdirSync(join(dataDir, 'backups'), { recursive: true })
  const db = new Database(join(dataDir, 'graphictero.db'))
  runMigrations(db, MIGRATIONS)
  state = { db, dataDir, backupDir: join(dataDir, 'backups'), root: dir }
  const now = new Date().toISOString()
  graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('IPC 测试图', now, now).lastInsertRowid)
  paperA = addPaper('Alpha')
  paperB = addPaper('Beta')
  registeredEngine = registerRelationsIpc(state, <T, A extends unknown[]>(fn: (...a: A) => T | Promise<T>) => async (...a: A): Promise<T> => fn(...a))
})

afterEach(() => {
  state.db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('lane/relations IPC（rel:* 通道）', () => {
  it('全部 rel 通道已注册', () => {
    for (const ch of [
      'rel:generate',
      'rel:regenerate',
      'rel:status',
      'rel:findRelated',
      'rel:fetchReferences',
      'rel:restore',
      'rel:detail'
    ]) {
      expect(handlers.has(ch), ch).toBe(true)
    }
  })

  it('评审接线清单第 2 条：registerRelationsIpc 返回引擎句柄（index.ts 一行接线用）', () => {
    expect(registeredEngine).toBeTruthy()
    expect(registeredEngine).toHaveProperty('enqueue')
    expect(registeredEngine).toHaveProperty('enqueueRegenerate')
    expect(registeredEngine).toHaveProperty('drain')
  })

  it('rel:generate：graphId 与 paperIds 透传到引擎，返回 job id', async () => {
    const jobId = await call('rel:generate', graphId, [paperA])
    expect(jobId).toBe(42)
    expect(engineMocks.enqueue).toHaveBeenCalledWith(graphId, [paperA])
    const jobId2 = await call('rel:generate', graphId) // paperIds 省略 = 全图
    expect(engineMocks.enqueue).toHaveBeenLastCalledWith(graphId, undefined)
    expect(jobId2).toBe(42)
  })

  it('rel:regenerate：透传到引擎 enqueueRegenerate，返回 job id', async () => {
    const jobId = await call('rel:regenerate', graphId)
    expect(jobId).toBe(43)
    expect(engineMocks.enqueueRegenerate).toHaveBeenCalledWith(graphId)
  })

  it('rel:restore：按快照恢复关系（含自动类型），返回关系 id', async () => {
    const id = (await call('rel:restore', {
      graphId,
      srcPaperId: paperA,
      dstPaperId: paperB,
      statement: 'B 基于 A。',
      llmTypes: ['based_on'],
      autoTypes: ['cites']
    })) as number
    const row = dbOf()
      .prepare('SELECT statement_text, llm_types, auto_types, source_type FROM relations WHERE id = ?')
      .get(id) as { statement_text: string; llm_types: string; auto_types: string; source_type: string }
    expect(row.statement_text).toBe('B 基于 A。')
    expect(JSON.parse(row.llm_types)).toEqual(['based_on'])
    expect(JSON.parse(row.auto_types)).toEqual(['cites'])
    expect(row.source_type).toBe('session')
  })

  it('rel:detail：返回来源 / 模型 provenance（D75）', async () => {
    const id = (await call('rel:restore', {
      graphId,
      srcPaperId: paperA,
      dstPaperId: paperB,
      statement: 's',
      llmTypes: ['compares']
    })) as number
    const d = (await call('rel:detail', id)) as { sourceType: string; model: null; graphId: number; autoTypes: string[] }
    expect(d.sourceType).toBe('session')
    expect(d.model).toBeNull()
    expect(d.graphId).toBe(graphId)
    expect(d.autoTypes).toEqual([])
  })

  it('rel:status：无活动任务时的视图', async () => {
    const s = (await call('rel:status', graphId)) as { running: boolean; activeJob: unknown; processedCount: number; totalCount: number }
    expect(s.running).toBe(false)
    expect(s.activeJob).toBeNull()
    expect(s.totalCount).toBe(2)
    expect(s.processedCount).toBe(0)
  })

  it('rel:status：有活动任务 + 已处理计数', async () => {
    const now = new Date().toISOString()
    dbOf()
      .prepare("INSERT INTO jobs (kind, graph_id, status, created_at, updated_at) VALUES ('relation_gen', ?, 'queued', ?, ?)")
      .run(graphId, now, now)
    dbOf()
      .prepare('INSERT INTO relation_gen_progress (graph_id, paper_id, done_at) VALUES (?, ?, ?)')
      .run(graphId, paperA, now)
    const s = (await call('rel:status', graphId)) as { running: boolean; activeJob: { id: number; status: string } | null; processedCount: number; totalCount: number }
    expect(s.running).toBe(true)
    expect(s.activeJob?.status).toBe('queued')
    expect(s.processedCount).toBe(1)
  })

  it('rel:findRelated：参数透传，返回信号候选视图（D40/D102）', async () => {
    const now = new Date().toISOString()
    dbOf()
      .prepare(
        "INSERT INTO paper_references (paper_id, openalex_wid, doi, title, year, matched_paper_id, source, created_at) VALUES (?, 'W1', NULL, 't', 2024, ?, 'openalex', ?)"
      )
      .run(paperB, paperA, now)
    const cs = (await call('rel:findRelated', graphId, paperA)) as Array<{ paperId: number; title: string; signals: string[] }>
    const b = cs.find((c) => c.paperId === paperB)
    expect(b?.title).toBe('Beta')
    expect(b?.signals).toContain('cites')
    expect(b?.signals).toContain('cards')
  })
})
