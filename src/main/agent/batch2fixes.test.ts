import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { startStubLlm, type StubLlm, type StubUsage } from '../llm/stubServer'
import { DEEPSEEK_FLASH_MAX_OUTPUT } from '../llm/client'
import { costCny } from '../llm/pricing'
import { AgentRuntime } from './runtime'
import { createSession, deleteSession, getMessages, listObservations, listTraces, sessionCost } from './sessionStore'
import { createAgentTools } from './tools'
import { parseFullMarkdown } from './paperFulltext'
import type { AgentStreamEvent } from '../../shared/ipc/agent'

/**
 * M5 lane/agent 批 2：评审必须修 1–6 + 建议修 7/8 的回归测试
 * （契约口径 A/B/C、计费缓存命中、运行中删除、retry busy/去重、finish=length、
 * readPaper 分节）。全部走 stubServer / 内存 SQLite / 临时目录。
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

function makeRuntime(s: StubLlm, overrides?: { thresholdTokens?: number; keepRecent?: number }): AgentRuntime {
  return new AgentRuntime({
    db,
    dataDir,
    llm: () => ({ baseUrl: s.baseUrl, apiKey: 'test-key', model: 'deepseek-flash' }),
    broadcast: (e) => events.push(e),
    compressorOverrides: overrides
  })
}

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
  sessionId = createSession(db, { graphId, entryType: 'graph', entryId: null }).id
  events = []
  stub = await startStubLlm()
  runtime = makeRuntime(stub)
})

afterEach(async () => {
  await stub.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('评审必须修 1（口径 A：text part 按块生命周期）', () => {
  it('块1 → tool → 块2：两个 text part 各自 start/done，无空块、无重复文本', async () => {
    stub = await startStubLlm([
      {
        kind: 'script',
        rounds: [
          { text: '第一块：先看列表。', calls: [{ id: 'call_1', name: 'getPapers' }] },
          { text: '第二块：读完了。' }
        ],
        finalText: '第二块：读完了。'
      }
    ])
    runtime = makeRuntime(stub)
    runtime.startTurn({ sessionId, text: 'hi', contextRefs: [] })
    await waitTurnEnd()

    // 事件级：part-start 与 part-done 一一对应（text 块），partId 恒为保留字 'text'
    const starts = events.filter((e) => e.kind === 'part-start')
    const dones = events.filter((e) => e.kind === 'part-done')
    const deltas = events.filter((e) => e.kind === 'part-delta')
    expect(deltas.every((e) => e.kind === 'part-delta' && e.partId === 'text')).toBe(true)
    expect(dones.filter((e) => e.kind === 'part-done' && e.part.type === 'text')).toHaveLength(starts.length)

    // 落库级：两个非空 text part，文本不重复
    const a = getMessages(db, sessionId).find((m) => m.role === 'assistant')!
    const texts = a.parts.filter((p) => p.type === 'text')
    expect(texts).toHaveLength(2)
    expect(texts.every((p) => p.type === 'text' && p.text.length > 0)).toBe(true)
    const joined = texts.map((p) => (p.type === 'text' ? p.text : '')).join('|')
    expect(joined).toContain('第一块')
    expect(joined).toContain('读完了')
    expect(joined.indexOf('读完了')).toBe(joined.lastIndexOf('读完了')) // 无重复
  })
})

describe('评审 2 建议修 3（空 text 块零事件）', () => {
  it('模型只调工具不出正文：无 part-start/delta/done 悬空事件，parts 无空 text', async () => {
    stub = await startStubLlm([
      {
        kind: 'script',
        rounds: [{ calls: [{ id: 'call_1', name: 'getPapers' }] }],
        finalText: '' // 总结也为空
      }
    ])
    runtime = makeRuntime(stub)
    runtime.startTurn({ sessionId, text: 'hi', contextRefs: [] })
    await waitTurnEnd()
    expect(events.filter((e) => e.kind === 'part-start')).toHaveLength(0)
    expect(events.filter((e) => e.kind === 'part-delta')).toHaveLength(0)
    const a = getMessages(db, sessionId).find((m) => m.role === 'assistant')!
    expect(a.parts.every((p) => p.type !== 'text')).toBe(true)
    expect(a.parts.filter((p) => p.type === 'data-trace')).toHaveLength(1) // getPapers trace 在（口径 C）
  })
})

describe('评审必须修 2（口径 B：turn-end.costCny = 会话累计）', () => {
  it('两个回合：第二个 turn-end = 两回合计费之和', async () => {
    stub = await startStubLlm([
      { kind: 'ok', text: '第一回合回答', usage: { prompt_tokens: 1000, completion_tokens: 500 } },
      { kind: 'ok', text: '第二回合回答', usage: { prompt_tokens: 2000, completion_tokens: 1000 } }
    ])
    runtime = makeRuntime(stub)

    runtime.startTurn({ sessionId, text: 'q1', contextRefs: [] })
    const end1 = await waitTurnEnd()
    expect(end1.kind).toBe('turn-end')
    const cost1 = sessionCost(db, sessionId)

    events.length = 0
    runtime.startTurn({ sessionId, text: 'q2', contextRefs: [] })
    const end2 = await waitTurnEnd()
    expect(end2.kind).toBe('turn-end')
    const total = sessionCost(db, sessionId)

    if (end1.kind === 'turn-end') expect(end1.costCny).toBeCloseTo(cost1, 6)
    if (end2.kind === 'turn-end') expect(end2.costCny).toBeCloseTo(total, 6)
    expect(total).toBeGreaterThan(cost1) // 累计而非单回合
  })
})

describe('评审必须修 4（计费缓存命中映射）', () => {
  it('prompt_cache_hit_tokens → inputTokenDetails.cacheReadTokens，按缓存价记账', async () => {
    stub = await startStubLlm([
      { kind: 'ok', text: '回答', usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_cache_hit_tokens: 400 } }
    ])
    runtime = makeRuntime(stub)
    runtime.startTurn({ sessionId, text: 'hi', contextRefs: [] })
    await waitTurnEnd()

    const row = db.prepare("SELECT * FROM usage_records WHERE session_id = ? AND category = 'chat'").get(sessionId) as {
      input_tokens: number
      cache_hit_tokens: number
      cost_cny: number
      occurred_at: string
      reasoning_tokens: number | null
    }
    expect(row.input_tokens).toBe(1000)
    expect(row.cache_hit_tokens).toBe(400) // 修复前恒为 0
    expect(row.reasoning_tokens).toBeNull() // D180：源响应未上报不能写成 0
    const expected = costCny({ inputTokens: 1000, cacheHitTokens: 400, outputTokens: 500 }, new Date(row.occurred_at))
    expect(row.cost_cny).toBeCloseTo(expected, 8)
  })

  it('D180：finish-step outputTokenDetails.reasoningTokens 落库', async () => {
    const usage = {
      prompt_tokens: 1000,
      completion_tokens: 500,
      prompt_cache_hit_tokens: 400,
      completion_tokens_details: { reasoning_tokens: 321 }
    } as StubUsage
    stub = await startStubLlm([{ kind: 'ok', text: '回答', usage }])
    runtime = makeRuntime(stub)
    runtime.startTurn({ sessionId, text: 'hi', contextRefs: [] })
    await waitTurnEnd()

    const row = db.prepare("SELECT output_tokens, reasoning_tokens, cost_cny FROM usage_records WHERE session_id = ? AND category = 'chat'").get(sessionId) as {
      output_tokens: number
      reasoning_tokens: number | null
      cost_cny: number
    }
    expect(row.output_tokens).toBe(500)
    expect(row.reasoning_tokens).toBe(321)
  })
})

describe('评审必须修 5（运行中删除会话先停止回合）', () => {
  it('stop + delete 后回合以 stopped 收尾，不打已删消息、不抛 FK', async () => {
    stub = await startStubLlm([{ kind: 'ok', text: '慢回答', delayMs: 300 }])
    runtime = makeRuntime(stub)
    runtime.startTurn({ sessionId, text: '问', contextRefs: [] })
    await new Promise((r) => setTimeout(r, 20))

    runtime.stop(sessionId) // IPC deleteSession 先 stop 再删
    deleteSession(db, sessionId)
    const end = await waitTurnEnd()
    expect(end.kind).toBe('stopped')
    // 回合收尾不打已删消息：库中无该会话残留
    expect(getMessages(db, sessionId)).toEqual([])
    await new Promise((r) => setTimeout(r, 100)) // 让收尾代码跑完，无未处理异常即通过
  })
})

describe('评审必须修 6（retry busy 防护 + user 消息去重）', () => {
  it('回合进行中 retryMessage 抛错（IPC reject 口径）', async () => {
    stub = await startStubLlm([{ kind: 'ok', text: '慢回答', delayMs: 300 }])
    runtime = makeRuntime(stub)
    runtime.startTurn({ sessionId, text: '问', contextRefs: [] })
    await new Promise((r) => setTimeout(r, 20))
    const assistantId = getMessages(db, sessionId).find((m) => m.role === 'assistant')!.id
    expect(() => runtime.retryMessage(sessionId, assistantId)).toThrow('进行中')
    runtime.stop(sessionId)
    await new Promise((r) => setTimeout(r, 100))
  })

  it('retry 后模型上下文里同一问题只出现一次', async () => {
    stub = await startStubLlm([
      { kind: 'status', status: 401 },
      { kind: 'ok', text: '重试成功', usage: { prompt_tokens: 10, completion_tokens: 5 } }
    ])
    runtime = makeRuntime(stub)
    runtime.startTurn({ sessionId, text: '同一个问题', contextRefs: [] })
    await waitTurnEnd()

    events.length = 0
    const failedId = getMessages(db, sessionId).find((m) => m.role === 'assistant')!.id
    runtime.retryMessage(sessionId, failedId)
    await waitTurnEnd()

    const sent = (stub.requests.at(-1)!.body as { messages: Array<{ role: string; content: string }> }).messages
    const userHits = sent.filter((m) => m.role === 'user' && m.content.includes('同一个问题'))
    expect(userHits).toHaveLength(1)
  })
})

describe('建议修 8（finish=length 截断路径）', () => {
  it('输出截断：内容保留、错误挂消息提示可重试', async () => {
    stub = await startStubLlm([{ kind: 'ok', text: '写到一半被截断', finishReason: 'length' }])
    runtime = makeRuntime(stub)
    runtime.startTurn({ sessionId, text: '写长文', contextRefs: [] })
    const end = await waitTurnEnd()
    expect(end.kind).toBe('error')
    if (end.kind === 'error') expect(end.message).toContain('截断')
    const a = getMessages(db, sessionId).find((m) => m.role === 'assistant')!
    expect(a.error).toContain('截断')
    expect(a.parts[0]).toMatchObject({ type: 'text', text: '写到一半被截断' }) // 内容保留
  })
})

describe('建议修 7（readPaper 原文分节 + 分段续读，uat3b 必须修 2 / D68）', () => {
  it('不传 section 返回原文目录（含图表号）；传章节名/序号返回该节；长节 offset 分段', async () => {
    const full = ['# 方法\n方法内容', '# 实验\n' + '实验内容很长。'.repeat(3000) + '\n表 1 列出结果。'].join('\n\n')
    mkdirSync(join(dataDir, 'papers', String(paperA), 'mineru'), { recursive: true })
    writeFileSync(join(dataDir, 'papers', String(paperA), 'mineru', 'full.md'), full, 'utf8')

    const ctx = {
      db,
      dataDir,
      sessionId,
      graphId,
      turnId: 'turn-test-1',
      model: 'm',
      promptVersion: 'agent-v7',
      emitTrace: () => {},
      onGraphChange: () => {},
      onPaperCard: () => {}
    }
    const tools = createAgentTools(ctx)

    const toc = (await tools.readPaper.execute!({ paperId: paperA } as never, {} as never)) as {
      toc: { sections: Array<{ index: number; title: string }>; figures: string[]; tables: string[] }
      totalChars: number
      note?: string
    }
    expect(toc.toc.sections.map((t) => t.title)).toEqual(['方法', '实验'])
    expect(toc.toc.tables).toEqual(['表 1'])
    expect(toc.totalChars).toBe(full.length)
    expect(toc.note).toContain('section')

    const byName = (await tools.readPaper.execute!({ paperId: paperA, section: '实验', offset: 0 } as never, {} as never)) as {
      section: { title: string }
      text: string
      hasMore: boolean
      nextOffset: number | null
    }
    expect(byName.section.title).toBe('实验')
    expect(byName.hasMore).toBe(true)
    expect(byName.text.length).toBeLessThanOrEqual(20_000)

    // 续读：offset 链最终读完（hasMore=false）
    let cur = byName
    let guard = 0
    while (cur.hasMore && guard++ < 10) {
      cur = (await tools.readPaper.execute!({ paperId: paperA, section: '实验', offset: cur.nextOffset! } as never, {} as never)) as never
    }
    expect(cur.hasMore).toBe(false)

    const byIndex = (await tools.readPaper.execute!({ paperId: paperA, section: '1' } as never, {} as never)) as { section: { title: string }; text: string }
    expect(byIndex.section.title).toBe('方法')
    expect(byIndex.text).toContain('方法内容')

    const missing = (await tools.readPaper.execute!({ paperId: paperA, section: '不存在的节' } as never, {} as never)) as { error: string }
    expect(missing.error).toContain('没有章节')
  })

  it('无 full.md：返回结构化说明，不回退详情解读（D68）', async () => {
    db.prepare(
      `INSERT INTO paper_details (paper_id, parts, model, prompt_version, generated_at, created_at, updated_at)
       VALUES (?, '[{"type":"text","text":"详情解读正文"}]', 'deepseek-flash', 'detail-v2', ?, ?, ?)`
    ).run(paperB, now(), now(), now())
    const ctx = { db, dataDir, sessionId, graphId, turnId: 't', model: 'm', promptVersion: 'agent-v7', emitTrace: () => {}, onGraphChange: () => {}, onPaperCard: () => {} }
    const tools = createAgentTools(ctx)
    const r = (await tools.readPaper.execute!({ paperId: paperB } as never, {} as never)) as { fullText: null; note: string; detail?: string }
    expect(r.fullText).toBeNull()
    expect(r.note).toContain('还没有解析出全文')
    expect(r.detail).toBeUndefined() // 绝不把详情解读当原文
  })

  it('parseFullMarkdown：标题前引言作为首节、无标题整文一节', () => {
    expect(parseFullMarkdown('引言段\n# 甲\nA').map((s) => s.title)).toEqual(['引言', '甲'])
    expect(parseFullMarkdown('全文无标题')).toEqual([{ index: 1, title: '引言', level: 1, text: '全文无标题' }])
  })
})
