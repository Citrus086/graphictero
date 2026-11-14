import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { NetworkLlmError } from '../llm/errors'
import { installFetchGuard, minimalPdfBytes, startFixtureHttp, type FetchGuard, type FixtureHttp } from '../testing/fixtureHttp'
import { makeFakeOpenAlex } from '../openalex/testing'
import { setPdfSources } from '../pdfsource/settings'
import { listPdfAttempts } from '../pdfsource/attempts'
import type { CandProgressEvent } from '../../shared/ipc/cand'
import type { ParseProgressView } from '../../shared/ipc/pdf'
import { JobRunner } from './runner'
import { createCandidatePdfExecutor } from './candidatePdf'
import { clearCandidatePdfStepCache } from './candidatePdf'
import { enqueueJob, getJob, getJobSteps } from './store'
import type { PaperParser, ParseResult } from './mineru'

/**
 * lane/fetch 批 1：candidate_pdf 执行器测试（经真实 JobRunner 驱动，D130）。
 * 断言：成功链路（下载→has_pdf→尝试记录→衔接 process_paper）、来源顺序找到即停、
 * 非 PDF 拒收继续下一来源、无 PDF 路径（succeeded + no_pdf）、超时→failed_retryable、
 * 断网→waiting_network（D70）。全部请求打本地 fixture（出网守卫兜底）。
 */

class FakeParser implements PaperParser {
  calls: number[] = []
  available(): boolean {
    return true
  }
  async parse(pdfPath: string, outDir: string, _onProgress?: (p: ParseProgressView) => Promise<void> | void): Promise<ParseResult> {
    this.calls.push(Number(pdfPath.split('/papers/')[1]?.split('/')[0]))
    return { markdown: '# T\n\n## Abstract\n\nA.\n', outDir }
  }
}

let dir: string
let dataDir: string
let db: Database.Database
let fixture: FixtureHttp
let guard: FetchGuard
let parser: FakeParser
let online: boolean
let events: CandProgressEvent[]

function addPaper(fields: { doi?: string | null; arxivId?: string | null; wid?: string | null }): number {
  const now = new Date().toISOString()
  const r = db
    .prepare('INSERT INTO papers (title, source, doi, arxiv_id, openalex_wid, has_pdf, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
    .run('P-' + Math.random(), 'agent', fields.doi ?? null, fields.arxivId ?? null, fields.wid ?? null, now, now)
  return Number(r.lastInsertRowid)
}

function makeRunner(executorDeps: Partial<Parameters<typeof createCandidatePdfExecutor>[0]> = {}): JobRunner {
  const executor = createCandidatePdfExecutor({
    db: () => db,
    dataDir,
    parser: () => parser,
    onProgress: (e) => events.push(e),
    ...executorDeps
  })
  return new JobRunner({
    db: () => db,
    dataDir,
    parser,
    hasLlmKey: () => true,
    llmClient: () => ({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'deepseek-flash' }),
    isOnline: () => online,
    candidatePdf: executor,
    maxRetries: 2,
    baseBackoffMs: 0
  })
}

beforeEach(async () => {
  guard = installFetchGuard()
  dir = mkdtempSync(join(tmpdir(), 'gt-candpdf-'))
  dataDir = join(dir, 'Graphictero')
  mkdirSync(dataDir, { recursive: true })
  db = openDatabase(join(dataDir, 'graphictero.db'))
  runMigrations(db, MIGRATIONS)
  parser = new FakeParser()
  online = true
  events = []
  clearCandidatePdfStepCache() // 每用例清步骤暂存（executor 模块级，防同号任务串味）
  fixture = await startFixtureHttp({
    works: [
      { wid: 'W1', doi: '10.8/hasoa', title: 'OA', oaUrl: '{{BASE}}/pdf/fake' }, // 故意 HTML 冒充
      { wid: 'W2', doi: '10.8/nooa', title: 'No OA', oaUrl: null },
      { wid: 'W3', doi: '10.8/slowoa', title: 'Slow OA', oaUrl: '{{BASE}}/pdf/sleepy' },
      { wid: 'W4', doi: '10.8/allhtml', title: 'All HTML', oaUrl: '{{BASE}}/pdf/fake' }
    ],
    unpaywall: {
      '10.8/hasoa': { pdfUrl: '{{BASE}}/pdf/good' },
      '10.8/allhtml': { pdfUrl: '{{BASE}}/pdf/fake' }
    },
    pdfRoutes: { good: 'good', fake: 'html', sleepy: 'slow', '2501.99999': 'good', '2501.55555': 'slow' },
    slowDelayMs: 600
  })
  process.env.GRAPHICTERO_OPENALEX_BASE_URL = fixture.baseUrl
  process.env.GRAPHICTERO_PDFSRC_BASE_URL = fixture.baseUrl
})

afterEach(async () => {
  delete process.env.GRAPHICTERO_OPENALEX_BASE_URL
  delete process.env.GRAPHICTERO_PDFSRC_BASE_URL
  db.close()
  rmSync(dir, { recursive: true, force: true })
  await fixture.close()
  for (const url of guard.urls) expect(new URL(url).hostname).toBe('127.0.0.1')
  guard.restore()
})

describe('candidate_pdf 执行器（lane/fetch 批 1，D130）', () => {
  it('arXiv 来源成功：下载→has_pdf/pdf_hash→衔接 process_paper→任务 succeeded', async () => {
    const pid = addPaper({ doi: '10.8/nooa', arxivId: '2501.99999' }) // arxiv 直链（fixture 兜底 good）
    const jobId = enqueueJob(db, 'candidate_pdf', { paperId: pid })
    const runner = makeRunner()
    await runner.drain()

    const job = getJob(db, jobId)!
    expect(job.status).toBe('succeeded')
    expect(getJobSteps(db, jobId).map((s) => [s.step, s.status])).toEqual([
      ['locate', 'succeeded'],
      ['download', 'succeeded']
    ])
    const paper = db.prepare('SELECT has_pdf, pdf_source, pdf_hash, pdf_unresolved FROM papers WHERE id = ?').get(pid) as Record<string, unknown>
    expect(paper.has_pdf).toBe(1)
    expect(paper.pdf_source).toBe('open_access')
    expect(paper.pdf_hash).toMatch(/^[0-9a-f]{64}$/)
    // uat1-fix1 建议修 1：查找下载补齐 PDF 后清「条目有附件没找到文件」标记
    expect(paper.pdf_unresolved).toBe(0)
    // 落到 papers/<id>/paper.pdf 且字节与 fixture 一致
    expect(readFileSync(join(dataDir, 'papers', String(pid), 'paper.pdf')).equals(minimalPdfBytes())).toBe(true)

    // 衔接 process_paper：第二轮 drain 跑完（解析→名片/详情走 stub 之外的假 parser + 无 LLM 调用仅验排队）
    await runner.drain()
    const proc = db.prepare("SELECT id, status FROM jobs WHERE kind = 'process_paper' AND paper_id = ?").get(pid) as { id: number; status: string } | undefined
    expect(proc).toBeDefined()

    expect(events.map((e) => e.phase)).toEqual(['locating', 'downloading', 'parsing'])
    // 找到即停：arXiv 直链在内建链最前，不再问 OpenAlex / Unpaywall
    expect(listPdfAttempts(db, pid).map((a) => [a.source, a.result])).toEqual([['arxiv', 'ok']])
    expect(fixture.requests.some((r) => r.url.startsWith('/works'))).toBe(false)
  })

  it('非 PDF 拒收继续下一来源：openalex(html) error → unpaywall(good) ok', async () => {
    setPdfSources(db, { sources: [{ kind: 'open_access', enabled: true }], unpaywallEmail: 'p@example.com' })
    const pid = addPaper({ doi: '10.8/hasoa' }) // openalex 给 html 链接，unpaywall 给 good
    const jobId = enqueueJob(db, 'candidate_pdf', { paperId: pid })
    await makeRunner().drain()

    expect(getJob(db, jobId)?.status).toBe('succeeded')
    const paper = db.prepare('SELECT has_pdf FROM papers WHERE id = ?').get(pid) as { has_pdf: number }
    expect(paper.has_pdf).toBe(1)
    expect(listPdfAttempts(db, pid).map((a) => [a.source, a.result])).toEqual([
      ['arxiv', 'not_found'],
      ['openalex', 'error'],
      ['unpaywall', 'ok']
    ])
  })

  it('无 PDF 路径：全来源未命中 → 任务 succeeded + no_pdf 事件，has_pdf 保持 0', async () => {
    const pid = addPaper({ doi: '10.8/nooa' }) // 无 oaUrl、无 arXiv、无邮箱（unpaywall 跳过）
    const jobId = enqueueJob(db, 'candidate_pdf', { paperId: pid })
    await makeRunner().drain()

    expect(getJob(db, jobId)?.status).toBe('succeeded')
    expect(db.prepare('SELECT has_pdf FROM papers WHERE id = ?').get(pid)).toEqual({ has_pdf: 0 })
    expect(events.map((e) => e.phase)).toEqual(['locating', 'no_pdf'])
    expect(listPdfAttempts(db, pid).map((a) => a.result)).toEqual(['not_found', 'not_found', 'not_found'])
  })

  it('noPdfCache 核对 paperId：同一 jobId 换论文不会直接收成无 PDF', async () => {
    const a = addPaper({ doi: '10.8/nooa' })
    const jobId = enqueueJob(db, 'candidate_pdf', { paperId: a })
    await makeRunner().drain()
    expect(db.prepare('SELECT has_pdf FROM papers WHERE id = ?').get(a)).toEqual({ has_pdf: 0 })

    const b = addPaper({ arxivId: '2501.99999' })
    const job = getJob(db, jobId)!
    const executor = createCandidatePdfExecutor({
      db: () => db,
      dataDir,
      parser: () => parser,
      onProgress: (e) => events.push(e)
    })
    await executor.runStep({ ...job, paperId: b }, 'download')
    expect(db.prepare('SELECT has_pdf, pdf_source FROM papers WHERE id = ?').get(b)).toEqual({
      has_pdf: 1,
      pdf_source: 'open_access'
    })
    expect(db.prepare('SELECT has_pdf FROM papers WHERE id = ?').get(a)).toEqual({ has_pdf: 0 })
    expect(events.some((e) => e.paperId === b && e.phase === 'no_pdf')).toBe(false)
  })

  it('超时（在线）→ 自动重试耗尽 → failed_retryable，每次尝试记 error', async () => {
    // 注：自定义模板契约强制 https（zod），本地 http fixture 走不通模板，
    // 这里用 arXiv 来源（pdfsrc 缝指 fixture）的慢路由验超时分类
    const pid = addPaper({ arxivId: '2501.55555' }) // fixture pdfRoutes: sleepy
    const jobId = enqueueJob(db, 'candidate_pdf', { paperId: pid })
    await makeRunner({ downloadTimeoutMs: 150 }).drain()

    const job = getJob(db, jobId)!
    expect(job.status).toBe('failed_retryable')
    expect(job.failedStep).toBe('download')
    const arxivAttempts = listPdfAttempts(db, pid).filter((a) => a.source === 'arxiv')
    expect(arxivAttempts.length).toBeGreaterThanOrEqual(3) // 初次 + 2 次自动重试
    expect(arxivAttempts.every((a) => a.result === 'error')).toBe(true)
  })

  it('断网（NetworkLlmError + 离线）→ waiting_network（D70，不消耗重试）', async () => {
    online = false
    const fake = makeFakeOpenAlex({
      async fetchWorkFullByDoi() {
        throw new NetworkLlmError('离线（假）')
      }
    })
    const pid = addPaper({ doi: '10.8/hasoa' })
    const jobId = enqueueJob(db, 'candidate_pdf', { paperId: pid })
    await makeRunner({ openAlex: fake }).drain()

    const job = getJob(db, jobId)!
    expect(job.status).toBe('waiting_network')
    expect(job.retryCount).toBe(0)
    expect(events.map((e) => e.phase)).toEqual(['locating'])
    expect(events.some((e) => e.phase === 'failed')).toBe(false)
  })

  it('有链接但全是 HTML → succeeded + no_pdf，不自动重试', async () => {
    setPdfSources(db, { sources: [{ kind: 'open_access', enabled: true }], unpaywallEmail: 'p@example.com' })
    const pid = addPaper({ doi: '10.8/allhtml' })
    const jobId = enqueueJob(db, 'candidate_pdf', { paperId: pid })
    await makeRunner().drain()

    expect(getJob(db, jobId)?.status).toBe('succeeded')
    expect(db.prepare('SELECT has_pdf FROM papers WHERE id = ?').get(pid)).toEqual({ has_pdf: 0 })
    expect(events.map((e) => e.phase)).toEqual(['locating', 'downloading', 'no_pdf'])
    expect(listPdfAttempts(db, pid).map((a) => [a.source, a.result])).toEqual([
      ['arxiv', 'not_found'],
      ['openalex', 'error'],
      ['unpaywall', 'error']
    ])
  })

  it('内容错误之后的断网保持 NetworkLlmError，不广播 failed', async () => {
    online = false
    setPdfSources(db, { sources: [{ kind: 'open_access', enabled: true }], unpaywallEmail: 'p@example.com' })
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.includes('/v2/')) throw new NetworkLlmError('unpaywall 断网')
      return fetch(input, init)
    }
    const pid = addPaper({ doi: '10.8/hasoa' })
    const jobId = enqueueJob(db, 'candidate_pdf', { paperId: pid })
    await makeRunner({ fetchImpl }).drain()

    const job = getJob(db, jobId)!
    expect(job.status).toBe('waiting_network')
    expect(job.retryCount).toBe(0)
    expect(events.map((e) => e.phase)).toEqual(['locating', 'downloading'])
    expect(listPdfAttempts(db, pid).map((a) => [a.source, a.result])).toEqual([
      ['arxiv', 'not_found'],
      ['openalex', 'error'],
      ['unpaywall', 'error']
    ])
  })

  it('只有非法自定义模板 → failed_action，并广播 failed', async () => {
    setPdfSources(db, { sources: [{ kind: 'custom', enabled: true, template: 'https://127.0.0.1/{doi}' }] })
    const pid = addPaper({ doi: '10.8/nooa' })
    const jobId = enqueueJob(db, 'candidate_pdf', { paperId: pid })
    await makeRunner().drain()
    expect(getJob(db, jobId)?.status).toBe('failed_action')
    expect(events.map((e) => e.phase)).toEqual(['locating', 'failed'])
  })

  it('来源顺序：坏模板记 error 后继续；开放获取在前则不再问后面的来源', async () => {
    const pid = addPaper({ doi: '10.8/nooa', arxivId: '2501.99999' })
    setPdfSources(db, {
      sources: [
        { kind: 'custom', enabled: true, template: 'https://127.0.0.1/{doi}' },
        { kind: 'open_access', enabled: true }
      ]
    })
    enqueueJob(db, 'candidate_pdf', { paperId: pid })
    await makeRunner().drain()
    expect(listPdfAttempts(db, pid).map((a) => [a.source, a.result])).toEqual([
      ['custom:127.0.0.1', 'error'],
      ['arxiv', 'ok']
    ])
    expect(fixture.requests.some((r) => r.url.startsWith('/works'))).toBe(false)

    clearCandidatePdfStepCache()
    events = []
    const pid2 = addPaper({ doi: '10.8/nooa-b', arxivId: '2501.99999v2' })
    setPdfSources(db, { sources: [{ kind: 'open_access', enabled: true }] })
    enqueueJob(db, 'candidate_pdf', { paperId: pid2 })
    await makeRunner().drain()
    expect(listPdfAttempts(db, pid2).map((a) => [a.source, a.result])).toEqual([['arxiv', 'ok']])
    expect(db.prepare('SELECT has_pdf FROM papers WHERE id = ?').get(pid2)).toEqual({ has_pdf: 1 })
  })

  it('parsing 事件发出时 has_pdf 已经写成 1；有候选行时进度带 candidateId', async () => {
    const pid = addPaper({ doi: '10.8/nooa', arxivId: '2501.99999' })
    const now = new Date().toISOString()
    const graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('g', now, now).lastInsertRowid)
    const candId = Number(
      db
        .prepare(
          `INSERT INTO graph_candidates (graph_id, title, authors_json, year, doi, reason, x, y, status, paper_id, created_at, updated_at)
           VALUES (?, 'c', '[]', 2024, '10.8/nooa', 'r', 0, 0, 'pending', ?, ?, ?)`
        )
        .run(graphId, pid, now, now).lastInsertRowid
    )
    let hasPdfAtParsing: number | null = null
    const jobId = enqueueJob(db, 'candidate_pdf', { paperId: pid })
    await makeRunner({
      onProgress: (e) => {
        events.push(e)
        if (e.phase === 'parsing' || e.phase === 'done') {
          hasPdfAtParsing = (db.prepare('SELECT has_pdf FROM papers WHERE id = ?').get(pid) as { has_pdf: number }).has_pdf
        }
      }
    }).drain()
    expect(getJob(db, jobId)?.status).toBe('succeeded')
    expect(hasPdfAtParsing).toBe(1)
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.paperId === pid && e.candidateId === candId)).toBe(true)
  })

  it('论文不存在 → 执行器 400（不自动重试；jobs.paper_id 外键在入队层就挡住坏 id）', async () => {
    // jobs.paper_id REFERENCES papers(id)：入队即 FK 拒绝，执行器的 400 是双保险
    expect(() => enqueueJob(db, 'candidate_pdf', { paperId: 99999 })).toThrow('FOREIGN KEY')
  })
})
