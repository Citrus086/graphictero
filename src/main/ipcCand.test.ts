import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { progressEvents } = vi.hoisted(() => ({
  progressEvents: [] as Array<{ channel: string; payload: unknown }>
}))
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from './db/connection'
import { MIGRATIONS, runMigrations } from './db/migrations'

/**
 * M6 lane/fetch 批 1：cand:* IPC 实装穿透（模式对齐 ipcAgent.test.ts）。
 * export:* 已实装：预览不调模型，概览记 chat，保存走对话框。
 */

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()

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
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => {
            progressEvents.push({ channel, payload })
          }
        }
      }
    ]
  }
}))

import { dialog } from 'electron'
import { registerCandIpc } from './ipc/cand'
import { clearExportOverviewCache, registerExportIpc } from './ipc/export'
import { confirmCandidate } from './agent/candidates'
import { JobRunner } from './jobs/runner'
import { enqueueJob, getJob } from './jobs/store'
import type { PaperParser } from './jobs/mineru'

let dir: string
let db: Database.Database
let state: { db: Database.Database; dataDir: string }

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const h = handlers.get(channel)
  if (!h) throw new Error(`channel 未注册：${channel}`)
  return (await h({} as unknown, ...args)) as T
}

beforeEach(() => {
  handlers.clear()
  progressEvents.length = 0
  dir = mkdtempSync(join(tmpdir(), 'gt-cand-ipc-'))
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS)
  state = { db, dataDir: dir }
  const h = ((fn: (...a: unknown[]) => unknown) => fn) as never
  registerCandIpc(state as never, h)
  registerExportIpc(state as never, h)
  clearExportOverviewCache()
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('cand:* / export:* IPC（M6 lane/fetch 批 1 实装）', () => {
  it('全部通道注册', () => {
    for (const ch of [
      'cand:importConfirm', 'cand:retryFindPdf', 'cand:attachPdf', 'cand:pdfAttempts',
      'cand:getPdfSources', 'cand:setPdfSources', 'export:preview', 'export:save', 'export:overview', 'export:peekOverview'
    ]) {
      expect(handlers.has(ch), ch).toBe(true)
    }
  })

  it('export:preview 按库里的论文出 Markdown，没有的图谱拒绝', async () => {
    const now = new Date().toISOString()
    const graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('导出图谱', now, now).lastInsertRowid)
    const paperId = Number(
      db.prepare("INSERT INTO papers (title, year, doi, source, created_at, updated_at) VALUES ('导出论文', 2026, '10.2/exp', 'zotero', ?, ?)").run(now, now).lastInsertRowid
    )
    db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 1, 2, ?)').run(graphId, paperId, now)
    const opts = { graphId, overview: false, details: false, relationTypes: [] as string[], references: true }
    const md = await call<string>('export:preview', opts)
    expect(md).toContain('# 导出图谱')
    expect(md).toContain('## 导出论文（2026）')
    expect(md).toContain('https://doi.org/10.2/exp')
    expect(md).not.toContain(dir)
    await expect(call('export:preview', { ...opts, graphId: 999999 })).rejects.toThrow('图谱不存在')
  })

  it('概览只调用一次并记入 overview，预览复用缓存，保存取消返回 null', async () => {
    const now = new Date().toISOString()
    const graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('导出图谱', now, now).lastInsertRowid)
    const paperId = Number(
      db.prepare("INSERT INTO papers (title, source, created_at, updated_at) VALUES ('导出论文', 'zotero', ?, ?)").run(now, now).lastInsertRowid
    )
    db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)').run(graphId, paperId, now)
    let calls = 0
    ;(state as { exportOverview?: (prompt: string) => Promise<unknown> }).exportOverview = async (prompt) => {
      calls += 1
      expect(prompt).toContain('导出论文')
      return { text: '概览正文', model: 'deepseek-flash', usage: { inputTokens: 12, cacheHitTokens: 0, outputTokens: 8 } }
    }
    const opts = { graphId, overview: true, details: false, relationTypes: [] as string[], references: false }
    const before = await call<string>('export:preview', opts)
    expect(before).toContain('尚未生成')
    expect(calls).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM usage_records').get()).toEqual({ n: 0 })

    expect(await call<{ text: string; cached: boolean }>('export:overview', opts)).toEqual({
      text: '概览正文',
      cached: false
    })
    expect(calls).toBe(1)
    const billed = db.prepare('SELECT category, model, session_id FROM usage_records').get() as {
      category: string
      model: string
      session_id: number | null
    }
    expect(billed).toEqual({ category: 'overview', model: 'deepseek-flash', session_id: null })

    const after = await call<string>('export:preview', opts)
    expect(after).toContain('概览正文')
    expect(calls).toBe(1)

    const showSave = dialog.showSaveDialog as unknown as ReturnType<typeof vi.fn>
    showSave.mockReset()
    showSave.mockResolvedValueOnce({ canceled: true, filePath: '' })
    expect(await call('export:save', opts)).toBeNull()
    expect(calls).toBe(1)

    const dest = join(dir, 'out.md')
    showSave.mockResolvedValueOnce({ canceled: false, filePath: dest })
    expect(await call('export:save', opts)).toBe(dest)
    expect(readFileSync(dest, 'utf8')).toContain('概览正文')
    expect(calls).toBe(1)
    const dialogArg = showSave.mock.calls.at(-1) as unknown[]
    const dialogOpts = (dialogArg.length === 1 ? dialogArg[0] : dialogArg[1]) as { defaultPath: string }
    expect(dialogOpts.defaultPath).toBe('导出图谱.md')
    expect(dialogOpts.defaultPath.includes(dir)).toBe(false)

    db.prepare('UPDATE papers SET one_liner = ? WHERE id = ?').run('换过的一句话', paperId)
    expect(await call<{ text: string; cached: boolean }>('export:overview', opts)).toEqual({
      text: '概览正文',
      cached: false
    })
    expect(calls).toBe(2)
  })

  it('没有 Key 时概览失败，预览仍给出占位；空图谱不调用模型', async () => {
    const now = new Date().toISOString()
    const graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('有论文', now, now).lastInsertRowid)
    const paperId = Number(
      db.prepare("INSERT INTO papers (title, source, created_at, updated_at) VALUES ('仍可预览', 'zotero', ?, ?)").run(now, now).lastInsertRowid
    )
    db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)').run(graphId, paperId, now)
    const opts = { graphId, overview: true, details: false, relationTypes: [] as string[], references: false }
    await expect(call('export:overview', opts)).rejects.toThrow('缺少 API Key')
    expect(await call<string>('export:preview', opts)).toContain('尚未生成')
    expect(db.prepare('SELECT COUNT(*) AS n FROM usage_records').get()).toEqual({ n: 0 })

    const emptyId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('空图谱', now, now).lastInsertRowid)
    ;(state as { exportOverview?: () => Promise<unknown> }).exportOverview = () => {
      throw new Error('不应调用模型')
    }
    // uat4 建议修2：缓存命中返回 { text, cached: true }（不再计费）
    expect(await call('export:overview', { ...opts, graphId: emptyId })).toEqual({
      text: '这张图谱还没有论文。',
      cached: true
    })
  })

  it('概览记到该图谱最近一次会话（D142）', async () => {
    const now = new Date().toISOString()
    const graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('有会话', now, now).lastInsertRowid)
    const paperId = Number(
      db.prepare("INSERT INTO papers (title, source, created_at, updated_at) VALUES ('会话论文', 'zotero', ?, ?)").run(now, now).lastInsertRowid
    )
    db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)').run(graphId, paperId, now)
    const older = '2026-10-01T00:00:00.000Z'
    const newer = '2026-10-27T03:00:00.000Z'
    db.prepare("INSERT INTO sessions (graph_id, entry_type, entry_id, name, created_at, updated_at) VALUES (?, 'graph', NULL, '旧', ?, ?)").run(graphId, older, older)
    const latest = Number(
      db.prepare("INSERT INTO sessions (graph_id, entry_type, entry_id, name, created_at, updated_at) VALUES (?, 'graph', NULL, '新', ?, ?)").run(graphId, newer, newer).lastInsertRowid
    )
    ;(state as { exportOverview?: () => Promise<unknown> }).exportOverview = async () => ({
      text: '会话概览',
      model: 'deepseek-flash',
      usage: { inputTokens: 1, cacheHitTokens: 0, outputTokens: 1 }
    })
    await call('export:overview', { graphId, overview: true, details: false, relationTypes: [], references: false })
    const billed = db.prepare('SELECT category, session_id FROM usage_records').get() as { category: string; session_id: number }
    expect(billed).toEqual({ category: 'overview', session_id: latest })
  })

  it('cand:importConfirm：库外候选确认 → 立即返回 paperId + jobId（进度走事件）', async () => {
    const now = new Date().toISOString()
    const graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('g', now, now).lastInsertRowid)
    db.prepare("INSERT INTO sessions (graph_id, entry_type, entry_id, name, created_at, updated_at) VALUES (?, 'graph', NULL, 's', ?, ?)").run(graphId, now, now)
    const candidateId = Number(
      db.prepare(
        `INSERT INTO graph_candidates (graph_id, title, authors_json, year, doi, reason, x, y, status, created_at, updated_at)
         VALUES (?, 'IPC 候选', '["A"]', 2024, '10.1/ipc', 'r', 5, 6, 'pending', ?, ?)`
      ).run(graphId, now, now).lastInsertRowid
    )
    const r = await call<{ paperId: number; jobId: number }>('cand:importConfirm', { candidateId })
    expect(r.paperId).toBeGreaterThan(0)
    expect(r.jobId).toBeGreaterThan(0)
    const paper = db.prepare('SELECT source, doi FROM papers WHERE id = ?').get(r.paperId) as { source: string; doi: string }
    expect(paper).toEqual({ source: 'agent', doi: '10.1/ipc' })
    expect(db.prepare('SELECT 1 FROM graph_members WHERE graph_id = ? AND paper_id = ?').get(graphId, r.paperId)).toBeTruthy()
    const job = db.prepare('SELECT kind, status FROM jobs WHERE id = ?').get(r.jobId) as { kind: string; status: string }
    expect(job.kind).toBe('candidate_pdf')
    expect(['queued', 'running']).toContain(job.status)
  })

  it('cand:pdfAttempts / attachPdf / retryFindPdf / getPdfSources / setPdfSources 穿透', async () => {
    const now = new Date().toISOString()
    const paperId = Number(db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES ('P', 'zotero', 0, ?, ?)").run(now, now).lastInsertRowid)

    expect(await call<Array<unknown>>('cand:pdfAttempts', { paperId })).toEqual([])

    // 拖入：写一个最小假 PDF 字节（非真实论文）
    const pdfPath = join(dir, 'drop.pdf')
    writeFileSync(pdfPath, Buffer.from('%PDF-1.4\nfake\n%%EOF\n', 'utf8'))
    await call('cand:attachPdf', { paperId, filePath: pdfPath })
    const paper = db.prepare('SELECT has_pdf, pdf_source FROM papers WHERE id = ?').get(paperId) as { has_pdf: number; pdf_source: string }
    expect(paper).toEqual({ has_pdf: 1, pdf_source: 'user_drop' })
    const attempts = await call<Array<{ source: string; result: string; at: string }>>('cand:pdfAttempts', { paperId })
    expect(attempts.map((a) => [a.source, a.result])).toEqual([['user_drop', 'ok']])
    expect(attempts[0].at).toMatch(/^\d{4}-/) // ISO 时间串（D65(6) 展示用）

    // 再试一次查找：已有 PDF 时 retry 是幂等空操作（不炸、不重复排队）
    await call('cand:retryFindPdf', { paperId })
    expect(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'candidate_pdf' AND paper_id = ?").get(paperId)).toEqual({ n: 0 })

    // 无 PDF 论文：retry 排上 candidate_pdf
    const pid2 = Number(db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES ('P2', 'zotero', 0, ?, ?)").run(now, now).lastInsertRowid)
    await call('cand:retryFindPdf', { paperId: pid2 })
    expect(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'candidate_pdf' AND paper_id = ?").get(pid2)).toEqual({ n: 1 })

    // 来源设置：默认只开开放获取（D54）；保存后回读一致
    const dflt = await call<{ sources: Array<{ kind: string; enabled: boolean }> }>('cand:getPdfSources')
    expect(dflt.sources).toEqual([{ kind: 'open_access', enabled: true }])
    const input = { sources: [{ kind: 'custom', enabled: true, template: 'https://pub.example/{doi}.pdf' }], unpaywallEmail: 'p@e.com' }
    await call('cand:setPdfSources', input)
    expect(await call('cand:getPdfSources')).toEqual(input)
  })

  it('cand:attachPdf 进度按 paper_id 带上最近一条候选', async () => {
    const now = '2026-10-27T00:00:00.000Z'
    const later = '2026-10-27T01:00:00.000Z'
    const graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('g', now, now).lastInsertRowid)
    const paperId = Number(
      db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES ('拖入', 'zotero', 0, ?, ?)").run(now, now).lastInsertRowid
    )
    db.prepare(
      `INSERT INTO graph_candidates (graph_id, title, authors_json, paper_id, reason, x, y, status, created_at, updated_at)
       VALUES (?, '旧候选', '[]', ?, 'r', 0, 0, 'pending', ?, ?)`
    ).run(graphId, paperId, now, now)
    const latestId = Number(
      db
        .prepare(
          `INSERT INTO graph_candidates (graph_id, title, authors_json, paper_id, reason, x, y, status, created_at, updated_at)
           VALUES (?, '新候选', '[]', ?, 'r', 1, 1, 'pending', ?, ?)`
        )
        .run(graphId, paperId, later, later).lastInsertRowid
    )
    const pdfPath = join(dir, 'drop-cand.pdf')
    writeFileSync(pdfPath, Buffer.from('%PDF-1.4\nfake\n%%EOF\n', 'utf8'))
    await call('cand:attachPdf', { paperId, filePath: pdfPath })
    const ev = progressEvents.find((e) => e.channel === 'event:cand:progress')
    expect(ev?.payload).toMatchObject({ candidateId: latestId, paperId, phase: 'done' })

    const bareId = Number(
      db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES ('无候选', 'zotero', 0, ?, ?)").run(now, now).lastInsertRowid
    )
    progressEvents.length = 0
    await call('cand:attachPdf', { paperId: bareId, filePath: pdfPath })
    const bare = progressEvents.find((e) => e.channel === 'event:cand:progress')
    expect(bare?.payload).toMatchObject({ paperId: bareId, phase: 'done' })
    expect(bare?.payload).not.toHaveProperty('candidateId')
  })

  it('cand:attachPdf 坏文件拒绝：非 PDF 头 / 不存在', async () => {
    const now = new Date().toISOString()
    const paperId = Number(db.prepare("INSERT INTO papers (title, source, created_at, updated_at) VALUES ('P', 'zotero', ?, ?)").run(now, now).lastInsertRowid)
    const badPath = join(dir, 'bad.pdf')
    writeFileSync(badPath, Buffer.from('not a pdf', 'utf8'))
    await expect(call('cand:attachPdf', { paperId, filePath: badPath })).rejects.toThrow('不是有效的 PDF')
    await expect(call('cand:attachPdf', { paperId, filePath: join(dir, 'missing.pdf') })).rejects.toThrow('文件不存在')
  })

  it('注册 cand IPC 后，已排队的 candidate_pdf 与库内确认都能跑完，不会 failed_action', async () => {
    const parser: PaperParser = {
      available: () => false,
      async parse() {
        throw new Error('测试不解析')
      }
    }
    const runner = new JobRunner({
      db: () => db,
      dataDir: dir,
      parser,
      hasLlmKey: () => false,
      llmClient: () => {
        throw new Error('测试不调用模型')
      },
      isOnline: () => true,
      maxRetries: 0,
      baseBackoffMs: 0
    })
    const wired = state as unknown as { runner: JobRunner }
    wired.runner = runner
    const h = ((fn: (...a: unknown[]) => unknown) => fn) as never
    registerCandIpc(wired as never, h)

    const now = new Date().toISOString()
    const queuedPaper = Number(
      db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES ('排队', 'zotero', 0, ?, ?)").run(now, now).lastInsertRowid
    )
    const queuedJob = enqueueJob(db, 'candidate_pdf', { paperId: queuedPaper })

    const graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('g2', now, now).lastInsertRowid)
    const inLib = Number(
      db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES ('库内', 'zotero', 0, ?, ?)").run(now, now).lastInsertRowid
    )
    const candId = Number(
      db
        .prepare(
          `INSERT INTO graph_candidates (graph_id, title, authors_json, existing_paper_id, reason, x, y, status, created_at, updated_at)
           VALUES (?, '库内候选', '[]', ?, 'r', 1, 2, 'pending', ?, ?)`
        )
        .run(graphId, inLib, now, now).lastInsertRowid
    )
    const confirmed = confirmCandidate(db, candId)
    expect(confirmed.jobId).toBeGreaterThan(0)

    await runner.drain()

    for (const id of [queuedJob, confirmed.jobId as number]) {
      const job = getJob(db, id)
      expect(job?.status).toBe('succeeded')
      expect(job?.error ?? '').not.toContain('lane/fetch 批 1')
    }
  })

  it('zod 参数校验穿透：坏入参在 handler 层拒绝（先于「未实现」）', async () => {
    await expect(call('export:preview', { graphId: 0, overview: false, details: false, relationTypes: [], references: false })).rejects.toThrow()
    await expect(call('cand:importConfirm', { candidateId: 'x' })).rejects.toThrow()
    await expect(call('cand:attachPdf', { paperId: 1 })).rejects.toThrow() // 缺 filePath
    await expect(call('cand:setPdfSources', { sources: [{ kind: 'bogus', enabled: true }] })).rejects.toThrow()
    // 自定义来源模板：必须 https 且含 {doi}（D54 口径写进契约 zod）
    await expect(call('cand:setPdfSources', { sources: [{ kind: 'custom', enabled: true, template: 'http://x/{doi}' }] })).rejects.toThrow('https')
    await expect(call('cand:setPdfSources', { sources: [{ kind: 'custom', enabled: true, template: 'https://x/y' }] })).rejects.toThrow('{doi}')
    await expect(call('cand:setPdfSources', { sources: [{ kind: 'custom', enabled: true }] })).rejects.toThrow('请填写 URL 模板')
    // 合法模板通过 zod 并保存成功（实装后不再「未实现」）
    await expect(
      call('cand:setPdfSources', { sources: [{ kind: 'custom', enabled: true, template: 'https://x/{doi}' }] })
    ).resolves.toBeUndefined()
  })
})
