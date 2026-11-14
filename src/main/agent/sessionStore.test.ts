import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { recordUsage } from '../llm/usage'
import {
  addTrace,
  appendMessage,
  appendSystemMessage,
  createSession,
  deleteSession,
  getMessageEntries,
  getMessages,
  getSession,
  listSessions,
  listTraces,
  renameSession,
  sessionCost,
  sessionCostBreakdown,
  turnCost,
  updateMessage
} from './sessionStore'

/** M5 lane/agent：会话存储（CRUD / seq 保序 / D122 删除语义 / trace / 费用汇总）。 */

let dir: string
let db: Database.Database
let graphId: number

const now = (): string => new Date().toISOString()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-agent-'))
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS)
  graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('会话图', now(), now()).lastInsertRowid)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('sessionStore CRUD', () => {
  it('create/list/rename：默认名按入口生成，列表按 updatedAt 倒序', async () => {
    const s1 = createSession(db, { graphId, entryType: 'graph', entryId: null })
    await new Promise((r) => setTimeout(r, 5))
    const s2 = createSession(db, { graphId, entryType: 'graph', entryId: null, name: '我的会话' })
    expect(s1.name).toContain('图谱对话')
    expect(s2.name).toBe('我的会话')

    await new Promise((r) => setTimeout(r, 5))
    renameSession(db, s1.id, '  改名  ')
    const list = listSessions(db, graphId, 'graph', null)
    expect(list.map((s) => s.id)).toEqual([s1.id, s2.id]) // s1 刚改名排最前
    expect(list.find((s) => s.id === s1.id)!.name).toBe('改名')

    expect(() => renameSession(db, s1.id, '   ')).toThrow('不能为空')
    expect(() => renameSession(db, 99999, 'x')).toThrow('不存在')
  })

  it('paper/relation 入口校验 entryId；graphId 不存在报错', () => {
    expect(() => createSession(db, { graphId, entryType: 'paper', entryId: null })).toThrow('entryId')
    expect(() => createSession(db, { graphId: 99999, entryType: 'graph', entryId: null })).toThrow('图谱')
    // 按入口隔离：同图谱不同入口互不相干
    const pid = Number(db.prepare("INSERT INTO papers (title, source, created_at, updated_at) VALUES ('P', 'zotero', ?, ?)").run(now(), now()).lastInsertRowid)
    const sp = createSession(db, { graphId, entryType: 'paper', entryId: pid })
    expect(listSessions(db, graphId, 'paper', pid).map((s) => s.id)).toEqual([sp.id])
    expect(listSessions(db, graphId, 'graph', null)).toHaveLength(0)
  })

  it('uat10：论文入口默认名超 30 字截断加省略号，短标题原样', () => {
    const short = Number(db.prepare("INSERT INTO papers (title, source, created_at, updated_at) VALUES ('CAS: Conformalized Agentic Sea', 'zotero', ?, ?)").run(now(), now()).lastInsertRowid)
    expect(createSession(db, { graphId, entryType: 'paper', entryId: short }).name).toBe('论文对话 · CAS: Conformalized Agentic Sea')
    const longTitle = 'A'.repeat(31)
    const long = Number(db.prepare('INSERT INTO papers (title, source, created_at, updated_at) VALUES (?, ?, ?, ?)').run(longTitle, 'zotero', now(), now()).lastInsertRowid)
    const name = createSession(db, { graphId, entryType: 'paper', entryId: long }).name
    expect(name).toBe(`论文对话 · ${'A'.repeat(30)}…`) // 有省略号，不再无提示硬截
    expect(name).not.toBe(`论文对话 · ${'A'.repeat(30)}`)
  })

  it('D122 删除：物理删除 + 级联消息/trace/观察日志/archives；usage_records 保留仅 session_id 置空', () => {
    const s = createSession(db, { graphId, entryType: 'graph', entryId: null })
    appendMessage(db, s.id, 'user', [{ type: 'text', text: '你好' }])
    appendMessage(db, s.id, 'assistant', [{ type: 'text', text: '回答' }], '曾经出错')
    addTrace(db, s.id, { toolName: 'readPaper', paperId: null, summary: '读取测试' })
    db.prepare('INSERT INTO session_observations (session_id, content, importance, logged_at) VALUES (?, ?, 0, ?)').run(s.id, '要点', now())
    db.prepare('INSERT INTO session_archives (session_id, seq_from, seq_to, parts, created_at) VALUES (?, 1, 1, ?, ?)').run(s.id, '[]', now())
    recordUsage(db, { category: 'chat', model: 'deepseek-flash', sessionId: s.id, usage: { inputTokens: 100, cacheHitTokens: 0, outputTokens: 50 } })

    deleteSession(db, s.id)

    expect(getSession(db, s.id)).toBeNull()
    expect(getMessages(db, s.id)).toEqual([])
    expect(listTraces(db, s.id)).toEqual([])
    expect((db.prepare('SELECT COUNT(*) AS n FROM session_observations WHERE session_id = ?').get(s.id) as { n: number }).n).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM session_archives WHERE session_id = ?').get(s.id) as { n: number }).n).toBe(0)
    const usage = db.prepare('SELECT session_id, cost_cny FROM usage_records').all() as Array<{ session_id: number | null; cost_cny: number }>
    expect(usage).toHaveLength(1)
    expect(usage[0].session_id).toBeNull()
    expect(usage[0].cost_cny).toBeGreaterThan(0)
    expect(sessionCost(db, s.id)).toBe(0)

    expect(() => deleteSession(db, s.id)).toThrow('不存在') // 幂等性：再删报错
  })

  it('消息 seq 保序写读；updateMessage 保留已生成内容并挂错误（D53 ⑧-4）', () => {
    const s = createSession(db, { graphId, entryType: 'graph', entryId: null })
    const m1 = appendMessage(db, s.id, 'user', [{ type: 'text', text: 'q1' }])
    const m2 = appendMessage(db, s.id, 'assistant', [{ type: 'text', text: '半个' }])
    const m3 = appendMessage(db, s.id, 'user', [{ type: 'text', text: 'q2' }])
    expect([m1.seq, m2.seq, m3.seq]).toEqual([1, 2, 3])

    updateMessage(db, m2.id, [{ type: 'text', text: '半个回答' }], '网络错误')
    const msgs = getMessages(db, s.id)
    // seq 保序由插入顺序（id 递增）体现；ChatMessageView 不带 seq 字段
    expect(msgs.map((m) => m.id)).toEqual([m1.id, m2.id, m3.id])
    expect(msgs[1]).toMatchObject({ error: '网络错误' })
    expect(msgs[1].parts[0]).toMatchObject({ type: 'text', text: '半个回答' })

    // 同一 seq 唯一约束兜底
    expect(() =>
      db.prepare('INSERT INTO session_messages (session_id, seq, role, parts, created_at) VALUES (?, 1, ?, ?, ?)').run(s.id, 'user', '[]', now())
    ).toThrow()
  })

  it('uat5 D172：系统记录（appendSystemMessage）——role=system、getMessages 映射、进下轮上下文', () => {
    const s = createSession(db, { graphId, entryType: 'graph', entryId: null })
    appendMessage(db, s.id, 'user', [{ type: 'text', text: '帮我加条关系' }])
    appendMessage(db, s.id, 'assistant', [{ type: 'text', text: '已添加' }])
    const sys = appendSystemMessage(db, s.id, '用户已撤销上一轮对图谱的 2 条改动')
    expect(sys.role).toBe('system')
    expect(sys.parts[0]).toMatchObject({ type: 'text', text: '用户已撤销上一轮对图谱的 2 条改动' })
    const msgs = getMessages(db, s.id)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'system'])
    // 下轮上下文可见（entries 含 system，真实 seq 保序）
    const entries = getMessageEntries(db, s.id)
    expect(entries.map((e) => e.role)).toEqual(['user', 'assistant', 'system'])
    expect(entries[2]).toMatchObject({ seq: 3, text: '用户已撤销上一轮对图谱的 2 条改动' })
  })

  it('trace 落库按序；费用汇总 sessionCost / turnCost（usage_records where session_id）', () => {
    const s = createSession(db, { graphId, entryType: 'graph', entryId: null })
    const t1 = addTrace(db, s.id, { toolName: 'getPapers', summary: '列表 2 篇' })
    const pid = Number(db.prepare("INSERT INTO papers (title, source, created_at, updated_at) VALUES ('T', 'zotero', ?, ?)").run(now(), now()).lastInsertRowid)
    const t2 = addTrace(db, s.id, { toolName: 'readPaper', paperId: pid, summary: '读取', excerpt: '摘录' })
    expect(listTraces(db, s.id)).toEqual([t1, t2])

    recordUsage(db, { category: 'chat', model: 'deepseek-flash', sessionId: s.id, at: new Date(Date.now() - 1000), usage: { inputTokens: 1000, cacheHitTokens: 0, outputTokens: 500 } })
    const mark = now()
    recordUsage(db, { category: 'chat', model: 'deepseek-flash', sessionId: s.id, at: new Date(Date.now() + 1000), usage: { inputTokens: 2000, cacheHitTokens: 0, outputTokens: 1000 } })
    recordUsage(db, { category: 'detail', model: 'deepseek-flash', usage: { inputTokens: 99999, cacheHitTokens: 0, outputTokens: 99999 } }) // 别人的不并入

    const total = sessionCost(db, s.id)
    expect(total).toBeGreaterThan(0)
    const turn = turnCost(db, s.id, mark)
    expect(turn).toBeGreaterThan(0)
    expect(turn).toBeLessThan(total)
  })

  it('sessionCostBreakdown：对话含 web，后台含概览与关系生成（D142/D160）', () => {
    const s = createSession(db, { graphId, entryType: 'graph', entryId: null })
    const ins = db.prepare('INSERT INTO usage_records (occurred_at, category, session_id, cost_cny) VALUES (?, ?, ?, ?)')
    const at = now()
    ins.run(at, 'chat', s.id, 0.1)
    ins.run(at, 'web', s.id, 0.005)
    ins.run(at, 'card', s.id, 0.02)
    ins.run(at, 'detail', s.id, 0.03)
    ins.run(at, 'overview', s.id, 0.04)
    ins.run(at, 'relation', s.id, 0.01)
    ins.run(at, 'overview', null, 9)
    const b = sessionCostBreakdown(db, s.id)
    expect(b.chat).toBeCloseTo(0.105, 6)
    expect(b.background).toBeCloseTo(0.1, 6)
    expect(b.total).toBeCloseTo(0.205, 6)
    expect(sessionCost(db, s.id)).toBeCloseTo(b.total, 6)
  })
})
