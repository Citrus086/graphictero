import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'

/**
 * M5 lane/agent：agent:* IPC 参数穿透（模式对齐 src/main/ipc.test.ts：
 * mock electron 捕获 handler；不改动那个冻结断言文件，本文件补 agent 通道穿透）。
 */

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()

/** 捕获 broadcast（webContents.send）出参，断言 event:agent:candidates 载荷用 */
const { broadcastSpy } = vi.hoisted(() => ({ broadcastSpy: vi.fn() }))

vi.mock('electron', () => ({
  app: {
    getPath: () => join(process.cwd(), 'node_modules/.cache/gt-test-userdata'),
    relaunch: vi.fn(),
    exit: vi.fn()
  },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler)
    }
  },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: broadcastSpy } }] }
}))

import { registerAgentIpc } from '../ipc/agent'
import { recordUsage } from '../llm/usage'

let dir: string
let db: Database.Database
let state: { db: Database.Database; dataDir: string }
let graphId: number

const now = (): string => new Date().toISOString()

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const h = handlers.get(channel)
  if (!h) throw new Error(`channel 未注册：${channel}`)
  return (await h({} as unknown, ...args)) as T
}

beforeEach(() => {
  handlers.clear()
  broadcastSpy.mockClear()
  dir = mkdtempSync(join(tmpdir(), 'gt-agent-ipc-'))
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS)
  state = { db, dataDir: dir }
  graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('IPC图', now(), now()).lastInsertRowid)
  registerAgentIpc(state as never, ((fn: (...a: unknown[]) => unknown) => fn) as never)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('agent:* IPC 参数穿透', () => {
  it('通道全部注册', () => {
    for (const ch of [
      'agent:listSessions', 'agent:createSession', 'agent:renameSession', 'agent:deleteSession',
      'agent:getMessages', 'agent:send', 'agent:stop', 'agent:retryMessage',
      'agent:candidateConfirm', 'agent:candidateIgnore', 'agent:listCandidates', 'agent:cardLiveStates', 'agent:sessionCost',
      'agent:sessionCostBreakdown'
    ]) {
      expect(handlers.has(ch), ch).toBe(true)
    }
  })

  it('会话 CRUD 全链路穿透 + 删除级联', async () => {
    const created = await call<{ id: number; name: string; graphId: number }>('agent:createSession', {
      graphId,
      entryType: 'graph',
      entryId: null
    })
    expect(created.graphId).toBe(graphId)
    expect(created.name).toContain('图谱对话')

    const listed = await call<Array<{ id: number }>>('agent:listSessions', graphId, 'graph', null)
    expect(listed.map((s) => s.id)).toEqual([created.id])

    await call('agent:renameSession', created.id, '新名字')
    expect((await call<Array<{ name: string }>>('agent:listSessions', graphId, 'graph', null))[0].name).toBe('新名字')

    await call('agent:send', { sessionId: created.id, text: '你好', contextRefs: [] }) // 未配置 Key：走错误事件，不 throw
    await call('agent:getMessages', created.id)

    await call('agent:deleteSession', created.id)
    expect(await call<Array<unknown>>('agent:listSessions', graphId, 'graph', null)).toEqual([])
    expect(await call<number>('agent:sessionCost', created.id)).toBe(0)
    expect(await call('agent:sessionCostBreakdown', created.id)).toEqual({ chat: 0, background: 0, total: 0 })
  })

  it('zod 参数校验穿透：坏入参在 handler 层拒绝', async () => {
    await expect(call('agent:createSession', { graphId: 'x', entryType: 'graph', entryId: null })).rejects.toThrow()
    await expect(call('agent:send', { sessionId: 1, text: '' })).rejects.toThrow()
    await expect(call('agent:renameSession', 1, '')).rejects.toThrow()
    await expect(call('agent:listSessions', graphId, 'bogus', null)).rejects.toThrow()
  })

  it('候选链路：list → 库外确认入库（M6 lane/fetch 批 1，D124）→ 忽略 → 「已在库中」确认加入图谱', async () => {
    // 候选带来源会话（040 列）；确认/忽略后 event:agent:candidates 广播应带出该 sessionId（评审建议修 3）
    const sid = Number(db.prepare("INSERT INTO sessions (graph_id, entry_type, entry_id, name, created_at, updated_at) VALUES (?, 'graph', NULL, '广播会话', ?, ?)").run(graphId, now(), now()).lastInsertRowid)
    const candidatesEvents = () =>
      broadcastSpy.mock.calls.filter(([ch]) => ch === 'event:agent:candidates').map(([, payload]) => payload as { graphId: number; sessionId: number | null })
    db.prepare(
      `INSERT INTO graph_candidates (graph_id, title, authors_json, year, doi, reason, x, y, status, session_id, created_at, updated_at)
       VALUES (?, '库外候选', '["A"]', 2024, '10.1/x', '理由', 0, 0, 'pending', ?, ?, ?)`
    ).run(graphId, sid, now(), now())
    const list = await call<Array<{ title: string; authors: string[]; status: string }>>('agent:listCandidates', graphId)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ title: '库外候选', authors: ['A'], status: 'pending' })

    // 库外候选确认（M6 lane/fetch 批 1，D124）：真入库——papers(source='agent') +
    // 加图谱 + confirmed + 排 candidate_pdf；papers 表行立即可查
    const imported = await call<{ id: number; status: string; existingPaperId: number | null; paperId?: number }>('agent:candidateConfirm', 1)
    expect(imported).toMatchObject({ status: 'confirmed', paperId: expect.any(Number) })
    const paperRow = db.prepare("SELECT source, doi FROM papers WHERE id = ?").get(imported.paperId as number) as { source: string; doi: string }
    expect(paperRow).toEqual({ source: 'agent', doi: '10.1/x' })
    const candJob = db.prepare("SELECT kind FROM jobs WHERE kind = 'candidate_pdf' AND paper_id = ?").get(imported.paperId as number) as { kind: string } | undefined
    expect(candJob?.kind).toBe('candidate_pdf') // D130
    expect(candidatesEvents().at(-1)).toMatchObject({ graphId, sessionId: sid })

    // 已在库中：命中论文 → 确认 = 加入图谱（插 graph_members）
    const pid = Number(db.prepare("INSERT INTO papers (title, source, doi, created_at, updated_at) VALUES ('库内论文', 'zotero', '10.1/y', ?, ?)").run(now(), now()).lastInsertRowid)
    db.prepare(
      `INSERT INTO graph_candidates (graph_id, title, authors_json, doi, existing_paper_id, reason, x, y, status, session_id, created_at, updated_at)
       VALUES (?, '库内候选', '["B"]', '10.1/Y', ?, '命中', 100, 50, 'pending', ?, ?, ?)`
    ).run(graphId, pid, sid, now(), now())
    const confirmed = await call<{ id: number; status: string; existingPaperId: number | null }>('agent:candidateConfirm', 2)
    expect(confirmed).toMatchObject({ status: 'confirmed', existingPaperId: pid })
    expect(db.prepare('SELECT 1 FROM graph_members WHERE graph_id = ? AND paper_id = ?').get(graphId, pid)).toBeDefined()
    expect(candidatesEvents().at(-1)).toMatchObject({ graphId, sessionId: sid })

    // 忽略：用第三个候选（1 已确认入库、2 已确认加入图谱，都不是 pending）
    db.prepare(
      `INSERT INTO graph_candidates (graph_id, title, authors_json, doi, reason, x, y, status, session_id, created_at, updated_at)
       VALUES (?, '待忽略', '["C"]', '10.1/z', '忽略我', 0, 0, 'pending', ?, ?, ?)`
    ).run(graphId, sid, now(), now())
    const ignored = await call<{ id: number; status: string }>('agent:candidateIgnore', 3)
    expect(ignored.status).toBe('ignored')
    expect(candidatesEvents().at(-1)).toMatchObject({ graphId, sessionId: sid })
  })

  it('名片/详情/概览/关系生成带会话落账广播 sessionCost；chat、web 与无会话不广播', () => {
    const sid = Number(
      db.prepare("INSERT INTO sessions (graph_id, entry_type, entry_id, name, created_at, updated_at) VALUES (?, 'graph', NULL, '费用会话', ?, ?)").run(graphId, now(), now()).lastInsertRowid
    )
    const usage = { inputTokens: 10, cacheHitTokens: 0, outputTokens: 4 }
    const base = { model: 'deepseek-flash', usage, sessionId: sid }
    recordUsage(db, { ...base, category: 'card' })
    recordUsage(db, { ...base, category: 'detail' })
    recordUsage(db, { ...base, category: 'overview' })
    recordUsage(db, { ...base, category: 'chat' })
    recordUsage(db, { ...base, category: 'relation' })
    recordUsage(db, { ...base, category: 'web' })
    recordUsage(db, { category: 'overview', model: 'deepseek-flash', usage })
    recordUsage(db, { category: 'card', model: 'deepseek-flash', usage, sessionId: 0 })
    const events = broadcastSpy.mock.calls
      .filter(([ch]) => ch === 'event:agent:sessionCost')
      .map(([, payload]) => payload)
    expect(events).toEqual([{ sessionId: sid }, { sessionId: sid }, { sessionId: sid }, { sessionId: sid }])
  })

  it('stop / retryMessage 未跑回合时不炸', async () => {
    await call('agent:stop', 12345) // 无运行回合：静默成功
    await expect(call('agent:retryMessage', 12345, 1)).rejects.toThrow('不存在')
  })
})
