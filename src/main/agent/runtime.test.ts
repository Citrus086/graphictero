import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { startStubLlm, type StubLlm } from '../llm/stubServer'
import { DEEPSEEK_FLASH_MAX_OUTPUT } from '../llm/client'
import { AgentRuntime, classifyAgentError } from './runtime'
import { appendSystemMessage, createSession, getMessages, listTraces, sessionCost } from './sessionStore'
import type { AgentStreamEvent } from '../../shared/ipc/agent'

/**
 * M5 lane/agent：运行时集成测试（全部走 stubServer，绝不调真实 DeepSeek）。
 *
 * 覆盖完成标准：≥3 步工具循环、trace 落库、abort 保留部分内容、401/断网错误分类、
 * 计费落账（D96-②）、事件信封序列。
 */

let dir: string
let db: Database.Database
let dataDir: string
let stub: StubLlm
let graphId: number
let paperA: number
let paperB: number
let sessionId: number
let events: AgentStreamEvent[]
let runtime: AgentRuntime

const now = (): string => new Date().toISOString()

function insertPaper(title: string): number {
  return Number(
    db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES (?, 'zotero', 1, ?, ?)").run(title, now(), now()).lastInsertRowid
  )
}

/** 等 turn 结束事件（turn-end / error / stopped）。 */
async function waitTurnEnd(timeoutMs = 8000): Promise<AgentStreamEvent> {
  const t0 = Date.now()
  for (;;) {
    const end = events.find((e) => e.kind === 'turn-end' || e.kind === 'error' || e.kind === 'stopped')
    if (end) return end
    if (Date.now() - t0 > timeoutMs) throw new Error('等待回合结束超时')
    await new Promise((r) => setTimeout(r, 25))
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gt-agent-'))
  dataDir = join(dir, 'data')
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS)
  graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('运行图', now(), now()).lastInsertRowid)
  paperA = insertPaper('论文甲')
  paperB = insertPaper('论文乙')
  const ins = db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)')
  ins.run(graphId, paperA, now())
  ins.run(graphId, paperB, now())
  db.prepare(
    `INSERT INTO paper_details (paper_id, parts, model, prompt_version, generated_at, created_at, updated_at)
     VALUES (?, '[{"type":"text","text":"甲的详情正文"}]', 'deepseek-flash', 'detail-v2', ?, ?, ?)`
  ).run(paperA, now(), now(), now())
  sessionId = createSession(db, { graphId, entryType: 'graph', entryId: null }).id
  events = []
  stub = await startStubLlm()
  runtime = new AgentRuntime({
    db,
    dataDir,
    llm: () => ({ baseUrl: stub.baseUrl, apiKey: 'test-key', model: 'deepseek-flash' }),
    broadcast: (e) => events.push(e)
  })
})

afterEach(async () => {
  await stub.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function makeRuntime(s: StubLlm): AgentRuntime {
  return new AgentRuntime({
    db,
    dataDir,
    llm: () => ({ baseUrl: s.baseUrl, apiKey: 'test-key', model: 'deepseek-flash' }),
    broadcast: (e) => events.push(e)
  })
}

/** 四步脚本：getPapers → readPaper → addRelation → 总结。正好 ≥3 步工具循环。 */
function fourStepBehaviors() {
  return [
    {
      kind: 'script' as const,
      rounds: [
        {
          text: '我先看看图谱里有哪些论文。',
          calls: [{ id: 'call_1', name: 'getPapers' }]
        },
        {
          text: '让我读一下第一篇。',
          calls: [{ id: 'call_2', name: 'readPaper', arguments: JSON.stringify({ paperId: paperA }), argChunks: ['{"paperId":', `${paperA}}`] }]
        },
        {
          text: '我认为这两篇可以连一条关系。',
          calls: [
            {
              id: 'call_3',
              name: 'addRelation',
              arguments: JSON.stringify({ srcPaperId: paperA, dstPaperId: paperB, statement: '乙针对甲的框架做了对比实验', types: ['compares'] })
            }
          ]
        }
      ],
      finalText: '综上所述：图里有两篇论文，乙针对甲的框架做了对比实验，我已经连好关系。',
      usage: { prompt_tokens: 1000, completion_tokens: 120, prompt_cache_hit_tokens: 400 }
    }
  ]
}

describe('AgentRuntime 工具循环（stub 多步脚本）', () => {
  it('≥3 步工具循环：4 次 LLM 调用、trace 落库、关系直写、事件信封与计费落账', async () => {
    stub = await startStubLlm(fourStepBehaviors())
    runtime = makeRuntime(stub)

    runtime.startTurn({ sessionId, text: '看看这个图谱，然后给甲乙两篇连一条关系', contextRefs: [] })
    const end = await waitTurnEnd()
    expect(end.kind).toBe('turn-end')

    // 4 次 LLM 调用（3 次工具步 + 1 次总结）
    expect(stub.requests).toHaveLength(4)

    // D100：max_tokens 393216；工具定义已下发
    const first = stub.requests[0].body as Record<string, unknown>
    expect(first.max_tokens).toBe(DEEPSEEK_FLASH_MAX_OUTPUT)
    const toolNames = (first.tools as Array<{ function: { name: string } }>).map((t) => t.function.name).sort()
    expect(toolNames).toEqual(['addRelation', 'updateRelation', 'listRelations', 'deleteRelation', 'getFigure', 'getPapers', 'readPaper', 'recallHistory', 'searchImages', 'searchLibrary', 'searchPapers', 'webFetch', 'webSearch', 'proposeCandidate'].sort())

    // B8（D92）：DeepSeek providerOptions 显式开启 thinking——请求体可见（stub 记录断言）
    expect(first.thinking).toEqual({ type: 'enabled' })

    // 后续请求带上了工具结果（OpenAI tool 角色消息）
    const last = stub.requests[3].body as { messages: Array<{ role: string }> }
    expect(last.messages.some((m) => m.role === 'tool')).toBe(true)

    // 事件序列：turn-start → part 流 → trace ×3 → part-done → turn-end
    const kinds = events.map((e) => e.kind)
    expect(kinds[0]).toBe('turn-start')
    expect(kinds.filter((k) => k === 'trace')).toHaveLength(2) // 读类工具落 trace；addRelation 是写不落
    expect(kinds.filter((k) => k === 'part-delta').length).toBeGreaterThan(0)

    // 消息落库：user + assistant（text + data-graph-change）
    const msgs = getMessages(db, sessionId)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    const a = msgs[1]
    expect(a.error).toBeUndefined()
    const textParts = a.parts.filter((p) => p.type === 'text')
    expect(textParts.length).toBe(4) // 三个工具步各一块 + 总结一块（独立定稿，无合并无空块）
    expect(textParts.every((p) => p.type === 'text' && p.text.length > 0)).toBe(true)
    expect(textParts.at(-1)!.type === 'text' && textParts.at(-1)!.text).toContain('综上所述')
    // 口径 C：data-trace part 在 parts JSON 里（回源后读取记录行仍在），与 text 按时间序交错
    const traceParts = a.parts.filter((p) => p.type === 'data-trace')
    expect(traceParts).toHaveLength(2)
    expect(traceParts.map((t) => t.type === 'data-trace' && t.toolName)).toEqual(['getPapers', 'readPaper'])
    expect(a.parts.map((p) => p.type)).toEqual(['text', 'data-trace', 'text', 'data-trace', 'text', 'text', 'data-graph-change']) // 改图小结在回合末追加
    const change = a.parts.find((p) => p.type === 'data-graph-change')
    expect(change).toMatchObject({ changeType: 'addRelation' })
    if (change?.type === 'data-graph-change') {
      expect(change.relationIds).toHaveLength(1)
      expect(change.summary).toContain('对比实验')
    }

    // trace 落库（D8）
    const traces = listTraces(db, sessionId)
    expect(traces.map((t) => t.toolName)).toEqual(['getPapers', 'readPaper'])

    // 关系直写 source=session（D16）
    const rel = db.prepare('SELECT * FROM relations WHERE graph_id = ?').get(graphId) as Record<string, unknown>
    expect(rel.source_type).toBe('session')
    expect(rel.source_session_id).toBe(sessionId)

    // D96-②：4 条 usage_records（category chat，带 session_id）+ turn-end 费用对得上
    const usage = db.prepare("SELECT COUNT(*) AS n, SUM(cost_cny) AS cost FROM usage_records WHERE session_id = ? AND category = 'chat'").get(sessionId) as { n: number; cost: number }
    expect(usage.n).toBe(4)
    expect(usage.cost).toBeGreaterThan(0)
    expect(sessionCost(db, sessionId)).toBeCloseTo(usage.cost, 6)
    if (end.kind === 'turn-end') expect(end.costCny).toBeCloseTo(usage.cost, 6)

    // B6：本回合费用写进 assistant 消息（重开会话 getMessages 仍返回 costCny）
    const aMsg = msgs[1]
    expect(aMsg.costCny).not.toBeUndefined()
    expect(aMsg.costCny!).toBeCloseTo(usage.cost, 6)
    expect(db.prepare('SELECT cost_cny FROM session_messages WHERE id = ?').get(aMsg.id)).toMatchObject({ cost_cny: aMsg.costCny })
  })

  it('B6：出错 / 停止的回合也记已发生的费用；多回合各自独立', async () => {
    // 第一回合正常（两步脚本，两次调用计费）
    stub = await startStubLlm([
      {
        kind: 'script',
        rounds: [{ text: '先看看。', calls: [{ id: 'c1', name: 'getPapers' }] }],
        finalText: '第一回合回答。',
        usage: { prompt_tokens: 5000, completion_tokens: 100, prompt_cache_hit_tokens: 0 }
      }
    ])
    runtime = makeRuntime(stub)
    runtime.startTurn({ sessionId, text: '第一问', contextRefs: [] })
    await waitTurnEnd()
    await stub.close()

    // 第二回合 401 失败：已发生的费用（0 次成功调用）仍记 0，消息带错误且 costCny=0
    stub = await startStubLlm([{ kind: 'status', status: 401 }])
    runtime = makeRuntime(stub)
    events.length = 0
    runtime.startTurn({ sessionId, text: '第二问', contextRefs: [] })
    const end2 = await waitTurnEnd()
    expect(end2.kind).toBe('error')

    const msgs = getMessages(db, sessionId)
    const ai = msgs.filter((m) => m.role === 'assistant')
    expect(ai).toHaveLength(2)
    expect(ai[0].costCny).not.toBeUndefined()
    expect(ai[0].costCny!).toBeGreaterThan(0)
    expect(ai[1].costCny).not.toBeUndefined() // 出错回合：已发生（此处为 0）也写
    expect(ai[1].error).toContain('401')
    // 两回合之和 = 会话累计
    expect((ai[0].costCny ?? 0) + (ai[1].costCny ?? 0)).toBeCloseTo(sessionCost(db, sessionId), 6)
  })

  it('上下文标签随消息入库（quote / paper 两类 ContextRef）', async () => {
    stub = await startStubLlm([{ kind: 'ok', text: '好的' }])
    runtime = makeRuntime(stub)
    runtime.startTurn({
      sessionId,
      text: '这段话什么意思',
      contextRefs: [
        { kind: 'paper', paperId: paperA },
        { kind: 'quote', paperId: paperA, page: 2, text: '原文摘句' }
      ]
    })
    await waitTurnEnd()
    const user = getMessages(db, sessionId)[0]
    const text = user.parts[0].type === 'text' ? user.parts[0].text : ''
    expect(text).toContain('[上下文论文')
    expect(text).toContain('原文摘句')
    expect(text).toContain('第 3 页')
    // 引用进了发给模型的消息
    const sent = stub.requests[0].body as { messages: Array<{ role: string; content: string }> }
    expect(sent.messages.at(-1)!.content).toContain('原文摘句')
  })

  it('uat5 D172：system 记录进下轮上下文——降级为带【系统记录】标头的 user 行（AI SDK 不收 system 消息）', async () => {
    stub = await startStubLlm([{ kind: 'ok', text: '第二回合回答' }])
    runtime = makeRuntime(stub)
    // 撤销成功后追加的系统记录（D172 同口径），下一轮模型必须可见
    appendSystemMessage(db, sessionId, '用户已撤销上一轮对图谱的 2 条改动')
    runtime.startTurn({ sessionId, text: '现在图里有什么', contextRefs: [] })
    await waitTurnEnd()
    const sent = stub.requests[0].body as { messages: Array<{ role: string; content: string }> }
    // 请求里允许有 SDK 注入的 system 消息（instructions 载体），但系统记录**不得**以
    // system 角色出现（AI SDK/DeepSeek 口径：system 不进 messages 的对话序列）
    expect(sent.messages.some((m) => m.role === 'system' && m.content.includes('用户已撤销'))).toBe(false)
    const sysRow = sent.messages.find((m) => m.content.includes('用户已撤销上一轮对图谱的 2 条改动'))
    expect(sysRow).toBeDefined()
    expect(sysRow!.role).toBe('user')
    expect(sysRow!.content).toContain('【系统记录】')
  })

  it('停止（abort）：回合标记 stopped 非错误，已生成内容保留', async () => {
    stub = await startStubLlm([{ kind: 'ok', text: '回答前半段。', delayMs: 150 }])
    runtime = makeRuntime(stub)
    runtime.startTurn({ sessionId, text: '随便聊聊', contextRefs: [] })
    await new Promise((r) => setTimeout(r, 20))
    runtime.stop(sessionId)
    const end = await waitTurnEnd()
    expect(end.kind).toBe('stopped')
    const a = getMessages(db, sessionId).find((m) => m.role === 'assistant')!
    expect(a.error).toBeUndefined() // stopped 不挂错误
  })

  it('401 错误分类：inline 提示 + 错误挂消息保留内容（D53 ⑧-4）', async () => {
    stub = await startStubLlm([{ kind: 'status', status: 401 }])
    runtime = makeRuntime(stub)
    runtime.startTurn({ sessionId, text: '问个问题', contextRefs: [] })
    const end = await waitTurnEnd()
    expect(end.kind).toBe('error')
    if (end.kind === 'error') expect(end.message).toContain('401')
    const a = getMessages(db, sessionId).find((m) => m.role === 'assistant')!
    expect(a.error).toContain('401')
  })

  it('断网（流中途断连）：分类为网络错误', async () => {
    stub = await startStubLlm([{ kind: 'abort' }])
    runtime = makeRuntime(stub)
    runtime.startTurn({ sessionId, text: '问个问题', contextRefs: [] })
    const end = await waitTurnEnd()
    expect(end.kind).toBe('error')
    if (end.kind === 'error') expect(end.message).toContain('网络')
  })

  it('同一会话回合进行中再发：报错事件且不污染', async () => {
    stub = await startStubLlm([{ kind: 'ok', text: '慢回答', delayMs: 300 }])
    runtime = makeRuntime(stub)
    runtime.startTurn({ sessionId, text: '第一问', contextRefs: [] })
    await new Promise((r) => setTimeout(r, 10))
    events.length = 0
    runtime.startTurn({ sessionId, text: '第二问', contextRefs: [] })
    const busy = await waitTurnEnd()
    expect(busy.kind).toBe('error')
    if (busy.kind === 'error') expect(busy.message).toContain('进行中')
    runtime.stop(sessionId)
    await new Promise((r) => setTimeout(r, 100))
  })

  it('改图 part id 会话内唯一：跨回合不复用 g1（合并批 ③，review_lane_chat4 §六-5）', async () => {
    // 第三篇论文入图，两回合各建一对新边（互不 upsert），id 断言到具体值
    const paperC = insertPaper('论文丙')
    db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)').run(graphId, paperC, now())
    // 历史跨回合纯文本（getMessageEntries 只出文本），stub 的 roundIdx 每回合从 0 重新计；
    // 每回合配一个全新 stub（单 script 行为覆盖该回合的工具步 + 总结请求）
    const addRel = (dst: number) => [
      {
        kind: 'script' as const,
        rounds: [
          {
            text: '连一条关系。',
            calls: [
              {
                id: 'call_1',
                name: 'addRelation',
                arguments: JSON.stringify({ srcPaperId: paperA, dstPaperId: dst, statement: `甲与 ${dst} 的关系`, types: ['compares'] })
              }
            ]
          }
        ],
        finalText: '已连好。',
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 0 }
      }
    ]
    stub = await startStubLlm(addRel(paperB))
    runtime = makeRuntime(stub)

    runtime.startTurn({ sessionId, text: '连甲乙', contextRefs: [] })
    let end = await waitTurnEnd()
    expect(end.kind).toBe('turn-end')
    await stub.close()
    stub = await startStubLlm(addRel(paperC))
    runtime = makeRuntime(stub)
    events.length = 0 // waitTurnEnd 扫全量 events，先清掉第一回合的结束事件
    runtime.startTurn({ sessionId, text: '再连甲丙', contextRefs: [] })
    end = await waitTurnEnd()
    expect(end.kind).toBe('turn-end')

    const aiMsgs = getMessages(db, sessionId).filter((m) => m.role === 'assistant')
    expect(aiMsgs).toHaveLength(2)
    const ids = aiMsgs.map((m) => m.parts.find((p) => p.type === 'data-graph-change'))
    // id = `g<assistant 消息 id>-<回合内序号>`：跨回合前缀不同 → 会话内唯一，不再都是 g1
    expect(ids[0]).toMatchObject({ id: `g${aiMsgs[0].id}-1` })
    expect(ids[1]).toMatchObject({ id: `g${aiMsgs[1].id}-1` })
    expect(ids[0]?.type === 'data-graph-change' && ids[1]?.type === 'data-graph-change' && ids[0].id !== ids[1].id).toBe(true)
    // 两条边都真实落库（不同对，各一条）
    expect(db.prepare('SELECT COUNT(*) AS n FROM relations WHERE graph_id = ?').get(graphId)).toMatchObject({ n: 2 })
  })

  it('proposeCandidate 落库即广播候选事件（合并批 e2e 发现的缺口）', async () => {
    const candSpy = vi.fn()
    stub = await startStubLlm([
      {
        kind: 'script',
        rounds: [
          {
            text: '我提议一篇候选。',
            calls: [
              {
                id: 'call_cand',
                name: 'proposeCandidate',
                arguments: JSON.stringify({ title: '运行时候选', authors: ['A'], year: 2024, doi: '10.9/rt-cand', reason: '理由' })
              }
            ]
          }
        ],
        finalText: '已提议。',
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 0 }
      }
    ])
    runtime = new AgentRuntime({
      db,
      dataDir,
      llm: () => ({ baseUrl: stub.baseUrl, apiKey: 'k', model: 'deepseek-flash' }),
      broadcast: (e) => events.push(e),
      onCandidates: candSpy
    })
    runtime.startTurn({ sessionId, text: '推荐一篇', contextRefs: [] })
    const end = await waitTurnEnd()
    expect(end.kind).toBe('turn-end')
    expect(candSpy).toHaveBeenCalledWith(graphId, sessionId) // graphId + 来源会话，载荷组装归 IPC 层
    expect(db.prepare('SELECT COUNT(*) AS n FROM graph_candidates WHERE graph_id = ?').get(graphId)).toMatchObject({ n: 1 })
  })

  it('retryMessage：失败的回合删旧重跑，成功则清错（03f）', async () => {
    stub = await startStubLlm([
      { kind: 'status', status: 401 },
      { kind: 'ok', text: '重试成功回答', usage: { prompt_tokens: 10, completion_tokens: 5 } }
    ])
    runtime = new AgentRuntime({
      db,
      dataDir,
      llm: () => ({ baseUrl: stub.baseUrl, apiKey: 'test-key', model: 'deepseek-flash' }),
      broadcast: (e) => events.push(e)
    })
    runtime.startTurn({ sessionId, text: '同一个问题', contextRefs: [] })
    await waitTurnEnd()
    let msgs = getMessages(db, sessionId)
    expect(msgs.find((m) => m.role === 'assistant')!.error).toContain('401')

    const failedId = msgs.find((m) => m.role === 'assistant')!.id
    events.length = 0
    runtime.retryMessage(sessionId, failedId)
    const end = await waitTurnEnd()
    expect(end.kind).toBe('turn-end')
    msgs = getMessages(db, sessionId)
    expect(msgs.filter((m) => m.role === 'user')).toHaveLength(1) // 不重复追加 user
    const a = msgs.find((m) => m.role === 'assistant')!
    expect(a.error).toBeUndefined()
    expect(a.parts[0]).toMatchObject({ type: 'text', text: '重试成功回答' })
  })
})

describe('classifyAgentError', () => {
  it('状态码与网络错误的分类口径', async () => {
    const { APICallError } = await import('ai')
    const e401 = new APICallError({ message: 'unauthorized', url: 'http://x', requestBodyValues: {}, statusCode: 401 })
    expect(classifyAgentError(e401, false).message).toContain('API Key')
    const e402 = new APICallError({ message: 'payment', url: 'http://x', requestBodyValues: {}, statusCode: 402 })
    expect(classifyAgentError(e402, false).message).toContain('余额')
    const e429 = new APICallError({ message: 'rate', url: 'http://x', requestBodyValues: {}, statusCode: 429, isRetryable: true })
    expect(classifyAgentError(e429, false).message).toContain('429')
    const e500 = new APICallError({ message: 'boom', url: 'http://x', requestBodyValues: {}, statusCode: 500, isRetryable: true })
    expect(classifyAgentError(e500, false).message).toContain('500')
    const net = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
    expect(classifyAgentError(net, false).message).toContain('网络')
    const abort = new DOMException('aborted', 'AbortError')
    expect(classifyAgentError(abort, false).stopped).toBe(true)
    expect(classifyAgentError(new Error('x'), true).stopped).toBe(true)
  })
})
