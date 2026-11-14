import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { startStubLlm, type StubLlm } from '../llm/stubServer'
import { AgentRuntime } from './runtime'
import { createSession, getMessages, listObservations } from './sessionStore'
import {
  archivedWatermark,
  buildObservationsPrefix,
  createTurnCompressor,
  OBSERVATION_LIMIT_TOKENS
} from './compress'
import { appendMessage } from './sessionStore'
import type { AgentStreamEvent } from '../../shared/ipc/agent'
import type { ModelMessage } from 'ai'

/**
 * M5 lane/agent 批 3：D28 压缩（回合起始增量归档 + 观察日志前缀注入 + 回合内 prune）。
 * 覆盖评审 2 必须修 1（模型看到「观察日志 + 最近原文」）与建议修 2（高水位、
 * 跨回合不重复归档/计费）。
 */

let dir: string
let db: Database.Database
let dataDir: string
let stub: StubLlm
let graphId: number
let sessionId: number
let events: AgentStreamEvent[]

const now = (): string => new Date().toISOString()

async function waitTurnEnd(timeoutMs = 8000): Promise<AgentStreamEvent> {
  const t0 = Date.now()
  for (;;) {
    const end = events.find((e) => e.kind === 'turn-end' || e.kind === 'error' || e.kind === 'stopped')
    if (end) return end
    if (Date.now() - t0 > timeoutMs) throw new Error('等待回合结束超时')
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** 造 n 轮长历史（直接写库，每条约 200 字）。 */
function seedLongHistory(n: number): number {
  let seq = 0
  for (let i = 0; i < n; i++) {
    appendMessage(db, sessionId, 'user', [{ type: 'text', text: `第 ${i} 轮提问：` + '围绕方法论展开分析。'.repeat(10) }])
    appendMessage(db, sessionId, 'assistant', [{ type: 'text', text: `第 ${i} 轮回答：` + '结论若干。'.repeat(10) }])
    seq += 2
  }
  return seq
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gt-agent-'))
  dataDir = join(dir, 'data')
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS)
  graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('压缩图', now(), now()).lastInsertRowid)
  sessionId = createSession(db, { graphId, entryType: 'graph', entryId: null }).id
  events = []
  stub = await startStubLlm()
})

afterEach(async () => {
  await stub.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('D28 压缩集成（评审 2 必须修 1 + 建议修 2）', () => {
  it('超阈值：payload 变短、观察日志要点进模型上下文（system 前缀）、历史完整、archives/计费各一次', async () => {
    const historyCount = seedLongHistory(20) // 40 条
    // 行为 1 给压缩摘要（回合起始压缩在 LLM 调用前），行为 2 给回合回答
    stub = await startStubLlm([
      { kind: 'ok', text: '要点：甲乙两篇做过对比实验。', usage: { prompt_tokens: 500, completion_tokens: 100 } },
      { kind: 'ok', text: '基于要点回答。', usage: { prompt_tokens: 800, completion_tokens: 60 } }
    ])
    const runtime = new AgentRuntime({
      db,
      dataDir,
      llm: () => ({ baseUrl: stub.baseUrl, apiKey: 'test-key', model: 'deepseek-flash' }),
      broadcast: (e) => events.push(e),
      compressorOverrides: { thresholdTokens: 300, keepRecent: 6 }
    })
    runtime.startTurn({ sessionId, text: '新问题来了', contextRefs: [] })
    const end = await waitTurnEnd()
    expect(end.kind).toBe('turn-end')

    // 必须修 1：发给模型的 system（instructions）含观察日志要点前缀
    const turnReq = stub.requests.at(-1)!.body as { messages: Array<{ role: string; content: string }> }
    const system = turnReq.messages[0]
    expect(system.role).toBe('system')
    expect(system.content).toContain('本会话早期要点')
    expect(system.content).toContain('对比实验')

    // payload 变短：只带最近原文，不含被归档的早期内容
    expect(turnReq.messages.length).toBeLessThanOrEqual(6 + 2) // keepRecent 6 + 新 user + system
    expect(JSON.stringify(turnReq.messages)).not.toContain('第 0 轮提问')

    // 界面历史完整（D28）
    expect(getMessages(db, sessionId).length).toBe(historyCount + 2)

    // 归档一行（真实 DB seq 区间）+ 观察日志要点 + 摘要计费一次
    const archives = db.prepare('SELECT * FROM session_archives WHERE session_id = ?').all(sessionId) as Array<{ seq_from: number; seq_to: number; parts: string }>
    expect(archives).toHaveLength(1)
    expect(archives[0].seq_from).toBe(1) // 真实 DB seq（第一条消息）
    expect(archives[0].seq_to).toBe(historyCount - 6) // 留最近 6 条（本回合 user 单独追加，不参与归档）
    expect(JSON.stringify(archives[0].parts)).toContain('第 0 轮提问')
    expect(listObservations(db, sessionId)[0].content).toContain('要点')
    expect(archivedWatermark(db, sessionId)).toBe(historyCount - 6)
    expect(buildObservationsPrefix(db, sessionId)).toContain('对比实验')
    const usage = db.prepare("SELECT COUNT(*) AS n FROM usage_records WHERE session_id = ? AND category = 'chat'").get(sessionId) as { n: number }
    expect(usage.n).toBe(2) // 摘要 1 + 回合 1
  })

  it('建议修 2：连续两回合——第二回合不重复归档、不重复摘要计费，前缀稳定仍在', async () => {
    const historyCount = seedLongHistory(20)
    stub = await startStubLlm([
      { kind: 'ok', text: '要点一。', usage: { prompt_tokens: 500, completion_tokens: 100 } },
      { kind: 'ok', text: '第一回合回答', usage: { prompt_tokens: 800, completion_tokens: 60 } },
      { kind: 'ok', text: '第二回合回答', usage: { prompt_tokens: 900, completion_tokens: 70 } }
    ])
    const runtime = new AgentRuntime({
      db,
      dataDir,
      llm: () => ({ baseUrl: stub.baseUrl, apiKey: 'test-key', model: 'deepseek-flash' }),
      broadcast: (e) => events.push(e),
      compressorOverrides: { thresholdTokens: 2000, keepRecent: 6 } // 归档后剩余 ≈1830 < 2000：第二回合不再触发
    })

    runtime.startTurn({ sessionId, text: '问题一', contextRefs: [] })
    await waitTurnEnd()
    const archivesAfter1 = (db.prepare('SELECT COUNT(*) AS n FROM session_archives WHERE session_id = ?').get(sessionId) as { n: number }).n
    const usageAfter1 = (db.prepare("SELECT COUNT(*) AS n FROM usage_records WHERE session_id = ? AND category = 'chat'").get(sessionId) as { n: number }).n
    expect(archivesAfter1).toBe(1)
    expect(usageAfter1).toBe(2)

    events.length = 0
    runtime.startTurn({ sessionId, text: '问题二', contextRefs: [] })
    await waitTurnEnd()

    // 第二回合：高水位已到，不重复归档同段、不重复摘要计费
    // 不重复归档：第二回合后仍只有第一回合那一行，且无重叠区间
    const rows2 = db.prepare('SELECT seq_from, seq_to FROM session_archives WHERE session_id = ?').all(sessionId) as Array<{ seq_from: number; seq_to: number }>
    expect(rows2).toHaveLength(1)
    expect(rows2[0].seq_from).toBe(1)
    expect((db.prepare("SELECT COUNT(*) AS n FROM usage_records WHERE session_id = ? AND category = 'chat'").get(sessionId) as { n: number }).n).toBe(3) // + 本回合 1
    // 前缀仍在（利缓存命中）；被归档内容仍不在 payload
    const turnReq = stub.requests.at(-1)!.body as { messages: Array<{ role: string; content: string }> }
    expect(turnReq.messages[0].content).toContain('本会话早期要点')
    expect(turnReq.messages[0].content).toContain('要点一')
    expect(JSON.stringify(turnReq.messages)).not.toContain('第 0 轮提问')
    // 界面历史完整
    expect(getMessages(db, sessionId).length).toBe(historyCount + 4)
  })

  it('未超阈值：不触发归档/摘要计费；无观察日志时无前缀', async () => {
    seedLongHistory(2)
    stub = await startStubLlm([{ kind: 'ok', text: '回答' }])
    const runtime = new AgentRuntime({
      db,
      dataDir,
      llm: () => ({ baseUrl: stub.baseUrl, apiKey: 'test-key', model: 'deepseek-flash' }),
      broadcast: (e) => events.push(e),
      compressorOverrides: { thresholdTokens: 10_000_000 }
    })
    runtime.startTurn({ sessionId, text: 'hi', contextRefs: [] })
    await waitTurnEnd()
    expect((db.prepare('SELECT COUNT(*) AS n FROM session_archives WHERE session_id = ?').get(sessionId) as { n: number }).n).toBe(0)
    const sent = (stub.requests[0].body as { messages: Array<{ role: string; content: string }> }).messages
    expect(sent[0].content).not.toContain('【本会话早期要点') // AGENT_PROMPT 正文提到该词，前缀以【头区分
    expect(sent).toHaveLength(6) // system + 4 历史 + user
  })
})

describe('D28 压缩单元（归档/降级/反思/回合内 prune）', () => {
  const entries = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      seq: i + 1,
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `消息 ${i}，` + '内容。'.repeat(100)
    }))

  it('增量归档：第二次调用只归档增量（高水位推进）', async () => {
    const c = createTurnCompressor({
      db,
      sessionId,
      llm: () => ({ baseUrl: 'x', apiKey: 'k', model: 'm' }),
      thresholdTokens: 10,
      keepRecent: 4,
      summarize: async () => '要点'
    })
    const r1 = await c.compressHistory(entries(12))
    expect(r1.archived).toBe(8)
    expect(r1.entries.map((e) => e.seq)).toEqual([9, 10, 11, 12])
    const w1 = archivedWatermark(db, sessionId)
    expect(w1).toBe(8)

    // 追加 4 条（seq 13-16），再来一回合：只归档 13-16 之前的增量？13,14 归档（留最近 4）
    const r2 = await c.compressHistory([...entries(12), ...entries(4).map((e) => ({ ...e, seq: e.seq + 12 }))])
    expect(r2.archived).toBe(4) // 高水位 8：可见 seq9-16，归档最老 4 条（9-12），留最近 4
    expect(r2.entries.map((e) => e.seq)).toEqual([13, 14, 15, 16])
    expect(archivedWatermark(db, sessionId)).toBe(12)
    const obs = listObservations(db, sessionId)
    expect(obs.length).toBeGreaterThanOrEqual(2) // 两次归档两条要点
  })

  it('摘要失败降级机械摘录、不计费不中断；观察日志过长反思压缩成一条', async () => {
    const c = createTurnCompressor({
      db,
      sessionId,
      llm: () => ({ baseUrl: 'x', apiKey: 'k', model: 'm' }),
      thresholdTokens: 10,
      keepRecent: 2,
      summarize: async (text) => {
        if (text.includes('观察日志')) return '浓缩要点'
        throw new Error('断网')
      }
    })
    const r = await c.compressHistory(entries(12))
    expect(r.archived).toBe(10)
    const obs = listObservations(db, sessionId)
    expect(obs[0].content).toContain('问：') // 机械摘录
    expect((db.prepare("SELECT COUNT(*) AS n FROM usage_records WHERE session_id = ? AND category = 'chat'").get(sessionId) as { n: number }).n).toBe(0)

    // 反思：塞爆观察日志后下一次归档触发
    const { addObservation } = await import('./sessionStore')
    for (let i = 0; i < 12; i++) addObservation(db, sessionId, `第 ${i} 条观察：` + '观察内容很长。'.repeat(200), 1)
    expect(OBSERVATION_LIMIT_TOKENS).toBe(8000)
    const c2 = createTurnCompressor({
      db,
      sessionId,
      llm: () => ({ baseUrl: 'x', apiKey: 'k', model: 'm' }),
      thresholdTokens: 10,
      keepRecent: 2,
      summarize: async () => '浓缩要点'
    })
    await c2.compressHistory([...entries(12), ...entries(4).map((e) => ({ ...e, seq: e.seq + 12 }))])
    const reflected = listObservations(db, sessionId).filter((o) => o.content.includes('反思压缩'))
    expect(reflected).toHaveLength(1)
  })

  it('回合内 prepareStep：有工具结果且超阈值时 prune，不归档不计费', async () => {
    const c = createTurnCompressor({
      db,
      sessionId,
      llm: () => ({ baseUrl: 'x', apiKey: 'k', model: 'm' }),
      thresholdTokens: 10
    })
    const messages = [
      { role: 'user', content: 'u'.repeat(50) },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'getPapers', args: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'getPapers', result: { big: 'x'.repeat(500) } }] },
      { role: 'user', content: '后续提问（工具结果在此之前，可被 prune）' }
    ] as ModelMessage[]
    const r = c.prepareStep({ messages, stepNumber: 2 })
    expect(r).toBeDefined()
    expect(JSON.stringify(r!.messages)).not.toContain('xxx') // 旧工具结果被清（before-last-message）
    expect((db.prepare('SELECT COUNT(*) AS n FROM session_archives WHERE session_id = ?').get(sessionId) as { n: number }).n).toBe(0)
    // 无工具结果 / 未超阈值：不动
    expect(c.prepareStep({ messages: [{ role: 'user', content: '短' }], stepNumber: 1 })).toBeUndefined()
  })
})
