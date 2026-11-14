import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { MissingKeyError, ParseStepError } from '../llm/errors'
import { DETAIL_PROMPT } from '../llm/prompts'
import { startStubLlm, type StubBehavior, type StubLlm } from '../llm/stubServer'
import { JobRunner } from './runner'
import { backfillProcessJobs } from '../appService'
import { enqueueJob, getJob, getJobSteps, getLlmQueuePauseReason, retryJob, setLlmQueuePaused, failStaleRunningJobs } from './store'
import type { PaperParser, ParseResult } from './mineru'
import type { ParseProgressView } from '../../shared/ipc/pdf'

/**
 * 任务调度器 / 状态机测试（D53/D70/D85）。MinerU 用可注入假实现；
 * LLM 全部走本地 HTTP stub（流式 SSE、429/5xx/401/402），不调真实 API。
 */

const ABSTRACT_TEXT =
  'This paper presents a novel approach to graph reasoning with language models. ' +
  'We describe the method, the datasets used for evaluation, and extensive experiments ' +
  'that demonstrate consistent improvements over strong baselines on three benchmarks.'
const MD = `# T\n\n## Abstract\n\n${ABSTRACT_TEXT}\n\n## 1. Introduction\n\nBody.\n`

class FakeParser implements PaperParser {
  calls: number[] = []
  progressArgs: Array<{ pdfPath: string; onProgress?: boolean }> = []
  constructor(private failFor: Set<number> = new Set()) {}
  available(): boolean {
    return true
  }

  async parse(pdfPath: string, outDir: string, onProgress?: (p: ParseProgressView) => void): Promise<ParseResult> {
    const paperId = Number(pdfPath.split('/papers/')[1]?.split('/')[0])
    this.calls.push(paperId)
    this.progressArgs.push({ pdfPath, onProgress: onProgress != null })
    if (this.failFor.has(paperId)) throw new ParseStepError('MinerU 进程异常退出（假）')
    onProgress?.({ stage: 'parse', completedFiles: 1, totalFiles: 1, pagesDone: 2, pagesTotal: 5, elapsedSec: 3 })
    return { markdown: MD, outDir }
  }
}

let dir: string
let dataDir: string
let db: Database.Database
let stub: StubLlm | null = null
let parser: FakeParser
let current: Date
let online: boolean
let hasKey: boolean

function addPaper(title: string, hasPdf = 1): number {
  const now = new Date().toISOString()
  const r = db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES (?, 'zotero', ?, ?, ?)").run(title, hasPdf, now, now)
  const id = Number(r.lastInsertRowid)
  if (hasPdf) {
    mkdirSync(join(dataDir, 'papers', String(id)), { recursive: true })
    writeFileSync(join(dataDir, 'papers', String(id), 'paper.pdf'), `%PDF-fake-${id}`)
  }
  return id
}

function makeRunner(): JobRunner {
  return new JobRunner({
    db: () => db, // 建 3：惰性取库
    dataDir,
    parser,
    hasLlmKey: () => hasKey,
    llmClient: () => ({ baseUrl: stub!.baseUrl, apiKey: 'k', model: 'deepseek-flash' }),
    isOnline: () => online,
    now: () => current,
    baseBackoffMs: 0 // 测试里自动重试立即可执行（429 用例单独验证 Retry-After）
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-jobs-'))
  dataDir = join(dir, 'Graphictero')
  mkdirSync(dataDir, { recursive: true })
  db = openDatabase(join(dataDir, 'graphictero.db'))
  runMigrations(db, MIGRATIONS)
  parser = new FakeParser()
  current = new Date('2026-10-26T12:00:00Z') // 空闲时段
  online = true
  hasKey = true
})

afterEach(async () => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
  await stub?.close()
  stub = null
})

const okBehaviors = (n: number): StubBehavior[] =>
  Array.from({ length: n }, (_, i) => ({ kind: 'ok' as const, text: i % 3 === 2 ? '["gnn"]' : `输出${i}` }))

describe('process_paper 任务（D67/D85）', () => {
  it('全链路成功：解析→名片→详情，步骤全 succeeded，产物落库，用量记账', async () => {
    stub = await startStubLlm([
      { kind: 'ok', text: '提出图推理新方法。' }, // 一句话摘要
      { kind: 'ok', text: '["gnn", "graph reasoning"]' }, // 关键词
      { kind: 'ok', text: '详情正文 Markdown' } // 详情
    ])
    const pid = addPaper('P1')
    const jobId = enqueueJob(db, 'process_paper', { paperId: pid })
    expect(getJobSteps(db, jobId).map((s) => s.step)).toEqual(['parse', 'card', 'detail'])

    await makeRunner().drain()

    const job = getJob(db, jobId)!
    expect(job.status).toBe('succeeded')
    expect(job.progress).toBe(1)
    expect(getJobSteps(db, jobId).every((s) => s.status === 'succeeded')).toBe(true)
    expect(parser.calls).toEqual([pid])
    const paper = db.prepare('SELECT abstract_source, one_liner FROM papers WHERE id = ?').get(pid) as Record<string, unknown>
    expect(paper.abstract_source).toBe('original')
    expect(typeof paper.one_liner).toBe('string')
    const detail = db.prepare('SELECT parts, prompt_version, pdf_hash, model FROM paper_details WHERE paper_id = ?').get(pid) as Record<string, unknown>
    expect(detail.prompt_version).toBe(DETAIL_PROMPT.version) // D106：随 prompt 版本（v2）落库
    expect(detail.model).toBe('deepseek-flash')
    expect(typeof detail.pdf_hash).toBe('string') // D29 哈希已记
    const parts = JSON.parse(detail.parts as string) as Array<{ type: string }>
    expect(parts[0].type).toBe('text') // UIMessage parts 存储（渲染 M4）
    const usage = db.prepare('SELECT category FROM usage_records WHERE paper_id = ? ORDER BY id').all(pid) as Array<{ category: string }>
    expect(usage.map((u) => u.category)).toEqual(['card', 'card', 'detail'])
  })

  it('重试从失败步骤接着跑：详情失败修复后重试，MinerU 不重跑、名片不重发（D85）', async () => {
    // 名片 2 次 ok；详情 1+3 次全 500（耗尽自动重试）；重试时详情 1 次 ok
    stub = await startStubLlm([...okBehaviors(2), { kind: 'status', status: 500 }, { kind: 'status', status: 500 }, { kind: 'status', status: 500 }, { kind: 'status', status: 500 }, { kind: 'ok', text: '详情正文' }])
    const pid = addPaper('P2')
    const jobId = enqueueJob(db, 'process_paper', { paperId: pid })
    await makeRunner().drain()

    let job = getJob(db, jobId)!
    expect(job.status).toBe('failed_retryable')
    expect(job.failedStep).toBe('detail')
    expect(getJobSteps(db, jobId).find((s) => s.step === 'detail')!.attempts).toBe(4) // 1 + 自动重试 3 次
    const requestsBefore = stub.requests.length
    expect(requestsBefore).toBe(6)

    retryJob(db, jobId) // 手动重试
    expect(getJob(db, jobId)!.status).toBe('queued')
    expect(getJob(db, jobId)!.retryCount).toBe(0)
    await makeRunner().drain()

    job = getJob(db, jobId)!
    expect(job.status).toBe('succeeded')
    expect(parser.calls).toEqual([pid]) // 解析没有重跑
    expect(stub.requests.length).toBe(7) // 只补了详情 1 次，名片没重发
  })

  it('各篇互不阻塞：一篇解析失败（手动重试），另一篇照常成功（D85/D44）', async () => {
    const a = addPaper('PA')
    const b = addPaper('PB')
    parser = new FakeParser(new Set([a]))
    stub = await startStubLlm(okBehaviors(3))
    const jobA = enqueueJob(db, 'process_paper', { paperId: a })
    const jobB = enqueueJob(db, 'process_paper', { paperId: b })
    await makeRunner().drain()

    expect(getJob(db, jobA)!.status).toBe('failed_retryable')
    expect(getJob(db, jobA)!.failedStep).toBe('parse')
    expect(getJob(db, jobB)!.status).toBe('succeeded')

    // 解析步骤不自动重试（D85）：attempts 仍 1；手动重试后成功
    expect(getJobSteps(db, jobA).find((s) => s.step === 'parse')!.attempts).toBe(1)
    parser = new FakeParser() // 修好了
    retryJob(db, jobA)
    await makeRunner().drain()
    expect(getJob(db, jobA)!.status).toBe('succeeded')
    expect(parser.calls).toEqual([a]) // 重试只重跑了解析一次
  })

  it('PDF 文件不存在：failed_action，之后 backfill 不再入队（D134 bug4）', async () => {
    const pid = addPaper('缺文件')
    unlinkSync(join(dataDir, 'papers', String(pid), 'paper.pdf'))
    const jobId = enqueueJob(db, 'process_paper', { paperId: pid })
    await makeRunner().drain()
    const job = getJob(db, jobId)!
    expect(job.status).toBe('failed_action')
    expect(job.error).toContain('找不到 PDF')
    expect(backfillProcessJobs(db, dataDir, parser)).toEqual([])
    expect(backfillProcessJobs(db, dataDir, parser)).toEqual([])
    expect((db.prepare('SELECT COUNT(*) AS c FROM jobs').get() as { c: number }).c).toBe(1)
  })

  it('同一论文重复 enqueue 幂等（不产生重复任务）', () => {
    const pid = addPaper('PD')
    const j1 = enqueueJob(db, 'process_paper', { paperId: pid })
    const j2 = enqueueJob(db, 'process_paper', { paperId: pid })
    expect(j1).toBe(j2)
  })

  it('评审建 2：详情已是最新（pdf_hash + prompt_version 相同）时跳过 LLM 调用；PDF 变化则不跳过', async () => {
    stub = await startStubLlm(okBehaviors(4))
    const pid = addPaper('PSKIP')
    const job1 = enqueueJob(db, 'process_paper', { paperId: pid })
    await makeRunner().drain()
    expect(getJob(db, job1)!.status).toBe('succeeded')
    const requestsAfterFirst = stub.requests.length

    // 论文被再次入队（如恢复备份后手动重试），parse/card 已 succeeded：
    // detail 步骤开头发现 paper_details 的 pdf_hash + prompt_version 未变 → 跳过，不重发请求
    const job2 = enqueueJob(db, 'process_paper', { paperId: pid })
    db.prepare("UPDATE job_steps SET status = 'succeeded' WHERE job_id = ? AND step IN ('parse','card')").run(job2)
    await makeRunner().drain()
    expect(getJob(db, job2)!.status).toBe('succeeded')
    expect(stub.requests.length).toBe(requestsAfterFirst) // 详情没有重复调 LLM

    // PDF 内容变化（哈希不同）→ 不跳过，重新生成
    writeFileSync(join(dataDir, 'papers', String(pid), 'paper.pdf'), '%PDF-fake-changed')
    const job3 = enqueueJob(db, 'process_paper', { paperId: pid })
    db.prepare("UPDATE job_steps SET status = 'succeeded' WHERE job_id = ? AND step IN ('parse','card')").run(job3)
    await makeRunner().drain()
    expect(getJob(db, job3)!.status).toBe('succeeded')
    expect(stub.requests.length).toBe(requestsAfterFirst + 1) // 详情重发了一次
  })

  it('Q5 缓存短路（D98 恢复后无需重新解析）：full.md 在且 PDF 哈希与 paper_details.pdf_hash 一致 → 跳过解析', async () => {
    // 模拟「备份恢复后手动重试」：PDF 回来了，解析缓存（full.md）随备份恢复，
    // paper_details.pdf_hash 是上次解析时记的哈希 → 解析步骤直接短路，不调 parser
    stub = await startStubLlm(okBehaviors(2)) // 名片 2 次（摘要从 full.md 原文提取）；详情按既有跳过逻辑不重发
    const pid = addPaper('PQ5')
    const pdfPath = join(dataDir, 'papers', String(pid), 'paper.pdf')
    const pdfHash = createHash('sha256').update(readFileSync(pdfPath)).digest('hex')
    mkdirSync(join(dataDir, 'papers', String(pid), 'mineru'), { recursive: true })
    writeFileSync(join(dataDir, 'papers', String(pid), 'mineru', 'full.md'), MD)
    const iso = current.toISOString()
    db.prepare(
      `INSERT INTO paper_details (paper_id, parts, model, prompt_version, pdf_hash, generated_at, created_at, updated_at)
       VALUES (?, '[]', 'deepseek-flash', 'detail-v1', ?, ?, ?, ?)`
    ).run(pid, pdfHash, iso, iso, iso)

    const jobId = enqueueJob(db, 'process_paper', { paperId: pid })
    await makeRunner().drain()

    expect(getJob(db, jobId)!.status).toBe('succeeded')
    expect(parser.calls).toEqual([]) // 缓存命中：MinerU 一步没跑
  })

  it('Q5：PDF 哈希变了（换版）→ 缓存不短路，重新解析并覆盖 full.md', async () => {
    stub = await startStubLlm(okBehaviors(3))
    const pid = addPaper('PQ5B')
    mkdirSync(join(dataDir, 'papers', String(pid), 'mineru'), { recursive: true })
    writeFileSync(join(dataDir, 'papers', String(pid), 'mineru', 'full.md'), '# 旧缓存')
    const iso = current.toISOString()
    db.prepare(
      `INSERT INTO paper_details (paper_id, parts, model, prompt_version, pdf_hash, generated_at, created_at, updated_at)
       VALUES (?, '[]', 'deepseek-flash', 'detail-v1', '旧哈希', ?, ?, ?)`
    ).run(pid, iso, iso, iso)

    const jobId = enqueueJob(db, 'process_paper', { paperId: pid })
    await makeRunner().drain()

    expect(getJob(db, jobId)!.status).toBe('succeeded')
    expect(parser.calls).toEqual([pid]) // 哈希不一致 → 照常解析
    expect(readFileSync(join(dataDir, 'papers', String(pid), 'mineru', 'full.md'), 'utf8')).toBe(MD)
  })

  it('Q5：缓存缺失（无 full.md）→ 照常解析', async () => {
    stub = await startStubLlm(okBehaviors(3))
    const pid = addPaper('PQ5C')
    const pdfPath = join(dataDir, 'papers', String(pid), 'paper.pdf')
    const pdfHash = createHash('sha256').update(readFileSync(pdfPath)).digest('hex')
    const iso = current.toISOString()
    db.prepare(
      `INSERT INTO paper_details (paper_id, parts, model, prompt_version, pdf_hash, generated_at, created_at, updated_at)
       VALUES (?, '[]', 'deepseek-flash', 'detail-v1', ?, ?, ?, ?)`
    ).run(pid, pdfHash, iso, iso, iso)

    const jobId = enqueueJob(db, 'process_paper', { paperId: pid })
    await makeRunner().drain()

    expect(getJob(db, jobId)!.status).toBe('succeeded')
    expect(parser.calls).toEqual([pid])
  })

  it('Q5 端到端：首次解析成功 → 同一论文再次入队（恢复后手动重试），解析不再重跑', async () => {
    stub = await startStubLlm(okBehaviors(3))
    const pid = addPaper('PQ5D')
    const job1 = enqueueJob(db, 'process_paper', { paperId: pid })
    await makeRunner().drain()
    expect(getJob(db, job1)!.status).toBe('succeeded')
    expect(parser.calls).toEqual([pid])
    const requestsAfterFirst = stub.requests.length

    // 备份恢复到新环境、PDF 按 D26 重新取得（内容一致 → 哈希一致），用户手动重试：
    // 解析步骤缓存短路，名片/详情各按自身「已是最新」逻辑不重发请求
    const job2 = enqueueJob(db, 'process_paper', { paperId: pid })
    await makeRunner().drain()
    expect(getJob(db, job2)!.status).toBe('succeeded')
    expect(parser.calls).toEqual([pid]) // 解析只跑过一次
    // 名片无「已是最新」跳过逻辑会重跑（+2 次：一句话摘要 + 关键词；摘要从缓存原文提取）；
    // 详情按既有逻辑（pdf_hash + prompt_version 未变）跳过，零新增
    expect(stub.requests.length).toBe(requestsAfterFirst + 2)
  })

  it('App 启动时遗留 running 任务标为 failed_retryable（D44）', () => {
    const pid = addPaper('PS')
    const jobId = enqueueJob(db, 'process_paper', { paperId: pid })
    db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobId)
    expect(failStaleRunningJobs(db)).toBe(1)
    expect(getJob(db, jobId)!.status).toBe('failed_retryable')
  })
})

describe('LLM 错误处理（D53/D70/D85）', () => {
  it('缺 Key：LLM 步骤进 waiting_key 排队、不发请求、不配为失败；配好 Key 后自动继续', async () => {
    stub = await startStubLlm(okBehaviors(3))
    hasKey = false
    const pid = addPaper('PK')
    const jobId = enqueueJob(db, 'process_paper', { paperId: pid })
    await makeRunner().drain()

    const job = getJob(db, jobId)!
    expect(job.status).toBe('waiting_key')
    expect(job.error).toBe('缺少 API Key')
    expect(job.retryCount).toBe(0)
    expect(parser.calls).toEqual([pid]) // 解析已跑完，LLM 一步没发
    expect(stub.requests).toHaveLength(0)

    hasKey = true // 设置页填了 Key
    await makeRunner().drain()
    expect(getJob(db, jobId)!.status).toBe('succeeded')
  })

  it('401：暂停整个 LLM 队列，任务停 waiting_key，其他任务不再发请求；换 Key 后恢复（D70）', async () => {
    stub = await startStubLlm([{ kind: 'status', status: 401 }, ...okBehaviors(6)])
    const a = addPaper('A401')
    const b = addPaper('B401')
    const jobA = enqueueJob(db, 'process_paper', { paperId: a })
    const jobB = enqueueJob(db, 'process_paper', { paperId: b })
    await makeRunner().drain()

    expect(getLlmQueuePauseReason(db)).toBe('API Key 无效')
    expect(getJob(db, jobA)!.status).toBe('waiting_key')
    expect(getJob(db, jobB)!.status).toBe('waiting_key')
    expect(getJob(db, jobA)!.retryCount).toBe(0) // 不自动重试
    // 暂停生效后不再发起新请求（并发在途的允许完成）：再 drain 一轮请求数不变
    const afterFirst = stub.requests.length
    await makeRunner().drain()
    expect(stub.requests).toHaveLength(afterFirst)

    setLlmQueuePaused(db, null) // 用户在设置页保存了新 Key（IPC 层会清暂停）
    await makeRunner().drain()
    expect(getJob(db, jobA)!.status).toBe('succeeded')
    expect(getJob(db, jobB)!.status).toBe('succeeded')
  })

  it('断网：进 waiting_network、不消耗重试次数；联网后自动继续（D70）', async () => {
    stub = await startStubLlm(okBehaviors(3))
    online = false
    const pid = addPaper('PN')
    const jobId = enqueueJob(db, 'process_paper', { paperId: pid })
    await makeRunner().drain()

    const job = getJob(db, jobId)!
    expect(job.status).toBe('waiting_network')
    expect(job.error).toBe('等待联网')
    expect(job.retryCount).toBe(0) // 断网期间重试次数不减少
    expect(stub.requests).toHaveLength(0)

    online = true
    await makeRunner().drain()
    expect(getJob(db, jobId)!.status).toBe('succeeded')
  })

  it('429 遵守 Retry-After：下次可执行时间取 Retry-After（大于指数退避）', async () => {
    stub = await startStubLlm([{ kind: 'status', status: 429, retryAfter: 30 }, ...okBehaviors(3)])
    const pid = addPaper('P429')
    const jobId = enqueueJob(db, 'process_paper', { paperId: pid })
    await makeRunner().drain()

    const job = getJob(db, jobId)!
    expect(job.status).toBe('queued') // 自动重试排队中
    expect(job.retryCount).toBe(1)
    expect(job.nextRetryAt).toBe(new Date(current.getTime() + 30_000).toISOString())
    expect(stub.requests).toHaveLength(1)

    current = new Date(current.getTime() + 29_000) // 还没到点
    await makeRunner().drain()
    expect(stub.requests).toHaveLength(1)
    current = new Date(current.getTime() + 2_000) // 到点
    await makeRunner().drain()
    expect(getJob(db, jobId)!.status).toBe('succeeded')
  })

  it('5xx 自动重试 3 次仍失败 → failed_retryable，标明失败步骤', async () => {
    stub = await startStubLlm(Array.from({ length: 4 }, () => ({ kind: 'status' as const, status: 500 })))
    const pid = addPaper('P500')
    const jobId = enqueueJob(db, 'process_paper', { paperId: pid })
    await makeRunner().drain()
    const job = getJob(db, jobId)!
    expect(job.status).toBe('failed_retryable')
    expect(job.failedStep).toBe('card')
    expect(job.retryCount).toBe(4) // 初次 + 3 次自动重试
    expect(getJobSteps(db, jobId).find((s) => s.step === 'card')!.attempts).toBe(4)
  })

  it('400 → failed_action，不自动重试（D53 重试无用类）', async () => {
    stub = await startStubLlm([{ kind: 'status', status: 400, body: { error: { message: '上下文长度超限' } } }])
    const pid = addPaper('P400')
    const jobId = enqueueJob(db, 'process_paper', { paperId: pid })
    await makeRunner().drain()
    const job = getJob(db, jobId)!
    expect(job.status).toBe('failed_action')
    expect(job.error).toContain('上下文长度超限')
    expect(stub.requests).toHaveLength(1)
  })

  it('评审建 4：Key 在预检后被清空（llm() 抛 MissingKeyError）→ waiting_key，不耗自动重试', async () => {
    const pid = addPaper('PMK')
    const jobId = enqueueJob(db, 'process_paper', { paperId: pid })
    const runner = new JobRunner({
      db: () => db,
      dataDir,
      parser,
      hasLlmKey: () => true, // 步骤预检通过
      llmClient: () => {
        throw new MissingKeyError() // 调用瞬间 Key 已被清空（竞态）
      },
      isOnline: () => true,
      now: () => current,
      baseBackoffMs: 0
    })
    await runner.drain()
    const job = getJob(db, jobId)!
    expect(job.status).toBe('waiting_key') // 与预检缺 Key 同口径：排队不失败
    expect(job.error).toBe('缺少 API Key')
    expect(job.retryCount).toBe(0) // 不消耗自动重试次数
  })

  it('评审建 3：迁移/恢复失败重开库（db 换对象）后调度器仍可用', async () => {
    stub = await startStubLlm(okBehaviors(3))
    const runner = makeRunner() // db 惰性取值：换库对象不需要重建 runner
    db.close() // 模拟失败路径关旧库
    db = openDatabase(join(dataDir, 'graphictero.db')) // 重开同一文件（迁移已应用）
    const pid = addPaper('PDB')
    const jobId = enqueueJob(db, 'process_paper', { paperId: pid })
    await runner.drain()
    expect(getJob(db, jobId)!.status).toBe('succeeded')
  })

  it('LLM 步骤并发写死 ≤ 3（D85：详情并发 2–4）', async () => {
    // 5 篇同时跑，stub 每次响应拖 30ms，统计真实并发峰值
    let active = 0
    let maxActive = 0
    const behaviors: StubBehavior[] = Array.from({ length: 15 }, (_, i) => ({ kind: 'ok' as const, text: i % 3 === 2 ? '["x"]' : 'o', delayMs: 30 }))
    stub = await startStubLlm(behaviors)
    // 包一层 fetch 统计并发
    const rawFetch = fetch
    const countingFetch: typeof fetch = async (url, init) => {
      active++
      maxActive = Math.max(maxActive, active)
      try {
        return await rawFetch(url, init)
      } finally {
        active--
      }
    }
    const ids = Array.from({ length: 5 }, (_, i) => addPaper(`PC${i}`))
    const runner = new JobRunner({
      db: () => db,
      dataDir,
      parser,
      hasLlmKey: () => true,
      llmClient: () => ({ baseUrl: stub!.baseUrl, apiKey: 'k', model: 'deepseek-flash', fetchImpl: countingFetch }),
      isOnline: () => true,
      now: () => current,
      baseBackoffMs: 0
    })
    for (const pid of ids) enqueueJob(db, 'process_paper', { paperId: pid })
    await runner.drain()
    const statuses = ids.map((pid) => (db.prepare('SELECT status FROM jobs WHERE paper_id = ?').get(pid) as { status: string }).status)
    expect(statuses.every((s) => s === 'succeeded')).toBe(true)
    // fetch 的 finally 在响应头到达时释放（不含 body 读取），并发峰值按请求计数
    expect(maxActive).toBeGreaterThan(1) // 确实并发了
    expect(maxActive).toBeLessThanOrEqual(3) // 不超过写死的 3
  })
})

describe('drain 只捞 process_paper（D101 接线：两种 kind 互不抢跑）', () => {
  it('relation_gen 排队任务不被 runner drain 触碰（不伪步骤执行、不烧重试）', async () => {
    const relJob = enqueueJob(db, 'relation_gen', { graphId: null, payload: { paperIds: null } })
    await makeRunner().drain()
    const job = getJob(db, relJob)!
    expect(job.status).toBe('queued') // 原样留给 RelationGenEngine
    expect(job.retryCount).toBe(0)
    expect(getJobSteps(db, relJob)).toHaveLength(0) // 没替它插/跑 process_paper 的步骤
    // 同表并存不互相阻塞：process_paper 照常调度
    stub = await startStubLlm(okBehaviors(3))
    const pid = addPaper('MixKind')
    const parseJob = enqueueJob(db, 'process_paper', { paperId: pid })
    await makeRunner().drain()
    expect(getJob(db, parseJob)!.status).toBe('succeeded')
    expect(getJob(db, relJob)!.status).toBe('queued')
  })
})

describe('uat2：串行队列状态口径（排队等并发额度的任务保持 queued）', () => {
  it('解析并发 1：第二个任务等额度时保持 queued（不提前写 running），轮到后才 running', async () => {
    stub = await startStubLlm(okBehaviors(6))
    const pid1 = addPaper('Serial-1')
    const pid2 = addPaper('Serial-2')
    const j1 = enqueueJob(db, 'process_paper', { paperId: pid1 })
    const j2 = enqueueJob(db, 'process_paper', { paperId: pid2 })
    // 阻塞式解析器：第一篇不放行，第二篇必在解析信号量外排队
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const blocking: PaperParser = {
      available: () => true,
      parse: async (_pdfPath: string, outDir: string) => {
        await gate
        return { markdown: MD, outDir }
      }
    }
    const runner = new JobRunner({
      db: () => db,
      dataDir,
      parser: blocking,
      hasLlmKey: () => hasKey,
      llmClient: () => ({ baseUrl: stub!.baseUrl, apiKey: 'k', model: 'deepseek-flash' }),
      isOnline: () => online,
      now: () => current,
      baseBackoffMs: 0
    })
    const draining = runner.drain()
    // j1 拿到解析额度 → running；j2 还在等额度
    await vi.waitFor(() => expect(getJob(db, j1)!.status).toBe('running'))
    expect(getJob(db, j2)!.status).toBe('queued') // uat2 修复点：不得是 running
    release()
    await draining
    expect(getJob(db, j1)!.status).toBe('succeeded')
    expect(getJob(db, j2)!.status).toBe('succeeded')
  })
})

describe('detail_regen 收编进 JobRunner（D108 / D42）', () => {
  it('单步 detail 强制覆盖（绕过版本+哈希未变跳过），relation_gen 仍不被抢跑', async () => {
    stub = await startStubLlm([...okBehaviors(3), { kind: 'ok', text: '新详情' }])
    const pid = addPaper('Regen')
    const first = enqueueJob(db, 'process_paper', { paperId: pid })
    await makeRunner().drain()
    expect(getJob(db, first)!.status).toBe('succeeded')
    const before = stub.requests.length
    const relJob = enqueueJob(db, 'relation_gen', { graphId: null, payload: { paperIds: null } })
    const regen = enqueueJob(db, 'detail_regen', { paperId: pid })
    expect(getJobSteps(db, regen).map((s) => s.step)).toEqual(['detail'])
    await makeRunner().drain()
    expect(getJob(db, regen)!.status).toBe('succeeded')
    expect(stub.requests.length).toBe(before + 1) // 只打一次详情请求，未重跑解析/名片
    expect(parser.calls.filter((c) => c === pid)).toHaveLength(1)
    const row = db.prepare('SELECT parts FROM paper_details WHERE paper_id = ?').get(pid) as { parts: string }
    expect(row.parts).toContain('新详情')
    expect(getJob(db, relJob)!.status).toBe('queued')
    expect(getJobSteps(db, relJob)).toHaveLength(0)
  })
})

describe('详情更新回调（event:detail:updated 数据源，M4 合并批）', () => {
  it('含 detail 步的任务成功后以 paperId 回调一次（process_paper 与 detail_regen）；失败不回调', async () => {
    // process_paper 一次成功（3 次 LLM ok）；detail_regen 强制覆盖再成功 1 次；最后 400 失败一次
    stub = await startStubLlm([...okBehaviors(3), { kind: 'ok', text: '新详情' }, { kind: 'status', status: 400 }])
    const updated: number[] = []
    const runner = new JobRunner({
      db: () => db,
      dataDir,
      parser,
      hasLlmKey: () => true,
      llmClient: () => ({ baseUrl: stub!.baseUrl, apiKey: 'k', model: 'deepseek-flash' }),
      isOnline: () => true,
      onDetailUpdated: (paperId) => updated.push(paperId),
      now: () => current,
      baseBackoffMs: 0
    })
    const pid = addPaper('PEV')
    enqueueJob(db, 'process_paper', { paperId: pid })
    await runner.drain()
    expect(updated).toEqual([pid])
    enqueueJob(db, 'detail_regen', { paperId: pid })
    await runner.drain()
    expect(updated).toEqual([pid, pid])
    const failedPid = addPaper('PEVF')
    const failedJob = enqueueJob(db, 'process_paper', { paperId: failedPid })
    await runner.drain()
    expect(getJob(db, failedJob)!.status).toBe('failed_action')
    expect(updated).toEqual([pid, pid]) // 失败不回调
  })
})

describe('解析进度透传（event:pdf:parseProgress 数据源，lane/pdf）', () => {
  it('parser 的 onProgress 经 RunnerDeps.onParseProgress 带上 paperId 发出', async () => {
    stub = await startStubLlm(okBehaviors(2))
    const pid = addPaper('进度')
    enqueueJob(db, 'process_paper', { paperId: pid })
    const seen: Array<{ paperId: number; p: ParseProgressView }> = []
    const runner = new JobRunner({
      db: () => db,
      dataDir,
      parser,
      hasLlmKey: () => true,
      llmClient: () => ({ baseUrl: stub!.baseUrl, apiKey: 'k', model: 'deepseek-flash' }),
      isOnline: () => true,
      onParseProgress: (paperId, p) => seen.push({ paperId, p }),
      now: () => current,
      baseBackoffMs: 0
    })
    await runner.drain()
    // 假 parser 在 parse 步骤回调一次进度；带正确 paperId
    expect(seen.length).toBe(1)
    expect(seen[0].paperId).toBe(pid)
    expect(seen[0].p).toMatchObject({ stage: 'parse', completedFiles: 1, pagesDone: 2, pagesTotal: 5 })
    // parser 确实收到了回调（接口第三参）
    expect(parser.progressArgs.length).toBe(1)
    expect(parser.progressArgs[0].onProgress).toBe(true)
  })
})
describe('candidate_pdf 进 JobRunner（M6 前置 2c，D130）', () => {
  it('未接执行器时安全失败 failed_action（不空转重试）；relation_gen 仍不被抢跑', async () => {
    const relJob = enqueueJob(db, 'relation_gen', { graphId: null, payload: { paperIds: null } })
    const pid = addPaper('CandStub')
    const jobId = enqueueJob(db, 'candidate_pdf', { paperId: pid })
    expect(getJobSteps(db, jobId).map((s) => s.step)).toEqual(['locate', 'download']) // 步骤接线
    await makeRunner().drain() // hasLlmKey=false 也不该挡 candidate_pdf 的失败路径
    const job = getJob(db, jobId)!
    expect(job.status).toBe('failed_action')
    expect(job.error).toContain('lane/fetch 批 1')
    expect(job.retryCount).toBe(0) // BadRequest 口径：不自动重试
    expect(getJob(db, relJob)!.status).toBe('queued')
    expect(getJobSteps(db, relJob)).toHaveLength(0)
  })

  it('注入执行器后 locate/download 顺序执行并 succeeded；无 Key 不阻挡（联网任务）', async () => {
    const calls: string[] = []
    const pid = addPaper('CandExec')
    const jobId = enqueueJob(db, 'candidate_pdf', { paperId: pid })
    const runner = new JobRunner({
      db: () => db,
      dataDir,
      parser,
      hasLlmKey: () => false, // candidate_pdf 不该进 waiting_key
      llmClient: () => ({ baseUrl: 'http://127.0.0.1:9', apiKey: 'k', model: 'deepseek-flash' }),
      isOnline: () => true,
      now: () => current,
      baseBackoffMs: 0,
      candidatePdf: {
        runStep: async (_job, step) => {
          calls.push(step)
        }
      }
    })
    await runner.drain()
    expect(calls).toEqual(['locate', 'download'])
    expect(getJob(db, jobId)!.status).toBe('succeeded')
    expect(getJobSteps(db, jobId).every((s) => s.status === 'succeeded')).toBe(true)
  })
})
