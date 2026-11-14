import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { DETAIL_PROMPT } from '../llm/prompts'
import type { AppState } from './types'

/**
 * lane/detail 车道 IPC 接线测试（M4 批 1）：通道注册 + 参数透传 + 视图形状。
 * electron mock（ipcMain.handle 收进 handlers 表），不走窗口/网络/LLM。
 */

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler)
    }
  }
}))

import { registerDetailIpc } from './detail'
import { IPC_DETAIL, type DetailView, type PaperMetaView } from '../../shared/ipc/detail'

let dir: string
let db: Database.Database
let state: AppState

const call = (channel: string, ...args: unknown[]): Promise<unknown> => {
  const h = handlers.get(channel)
  if (!h) throw new Error(`channel ${channel} 未注册`)
  // 同步抛错也包成 rejection（与 ipcMain.handle 的 async 语义一致）
  return Promise.resolve().then(() => h({ sender: { isDestroyed: () => true, send: vi.fn() } }, ...args))
}

function addPaper(title: string, opts: { hasPdf?: number; pdfHash?: string | null } = {}): number {
  const now = new Date().toISOString()
  const r = db
    .prepare("INSERT INTO papers (title, source, has_pdf, pdf_hash, created_at, updated_at) VALUES (?, 'zotero', ?, ?, ?, ?)")
    .run(title, opts.hasPdf ?? 1, opts.pdfHash ?? null, now, now)
  return Number(r.lastInsertRowid)
}

beforeEach(() => {
  handlers.clear()
  dir = mkdtempSync(join(tmpdir(), 'gt-detail-ipc-'))
  db = openDatabase(join(dir, 'graphictero.db'))
  runMigrations(db, MIGRATIONS)
  state = { db, dataDir: dir, backupDir: join(dir, 'backups'), root: dir, runner: null }
  registerDetailIpc(state, <T, A extends unknown[]>(fn: (...a: A) => T | Promise<T>) => async (...a: A): Promise<T> => fn(...a))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('registerDetailIpc（M4 批 1）', () => {
  it('注册 detail:get / detail:getMeta / detail:regenerate 三通道', () => {
    expect(handlers.has(IPC_DETAIL.get)).toBe(true)
    expect(handlers.has(IPC_DETAIL.getMeta)).toBe(true)
    expect(handlers.has(IPC_DETAIL.regenerate)).toBe(true)
  })

  it('detail:get 返回 DetailView（含 staleReason）；无详情返回 null', async () => {
    const pid = addPaper('IPC Paper', { pdfHash: 'h1' })
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO paper_details (paper_id, parts, model, prompt_version, pdf_hash, generated_at, created_at, updated_at)
       VALUES (?, '[{"type":"text","text":"正文"}]', 'deepseek-flash', ?, 'h1', ?, ?, ?)`
    ).run(pid, DETAIL_PROMPT.version, now, now, now)
    const v = (await call(IPC_DETAIL.get, pid)) as DetailView | null
    expect(v?.paperId).toBe(pid)
    expect(v?.staleReason).toBeNull()
    expect(v?.parts).toEqual([{ type: 'text', text: '正文' }])
    expect(await call(IPC_DETAIL.get, 9999)).toBeNull()
  })

  it('detail:getMeta 返回元数据视图；论文不存在返回 null', async () => {
    const pid = addPaper('Meta Paper')
    const m = (await call(IPC_DETAIL.getMeta, pid)) as PaperMetaView | null
    expect(m?.title).toBe('Meta Paper')
    expect(m?.hasPdf).toBe(true)
    expect(await call(IPC_DETAIL.getMeta, 9999)).toBeNull()
  })

  it('detail:regenerate 入队 detail_regen（D42/D108），返回任务 id', async () => {
    const pid = addPaper('Regen Paper')
    const jobId = (await call(IPC_DETAIL.regenerate, pid)) as number
    expect(typeof jobId).toBe('number')
    const job = db.prepare('SELECT kind, paper_id, status FROM jobs WHERE id = ?').get(jobId) as {
      kind: string
      paper_id: number
      status: string
    }
    expect(job).toEqual({ kind: 'detail_regen', paper_id: pid, status: 'queued' })
    const steps = db.prepare('SELECT step, status FROM job_steps WHERE job_id = ?').all(jobId) as Array<{ step: string }>
    expect(steps.map((s) => s.step)).toEqual(['detail'])
  })

  it('detail:regenerate 幂等：同论文未终结任务不重复入队', async () => {
    const pid = addPaper('Regen Idem')
    const j1 = (await call(IPC_DETAIL.regenerate, pid)) as number
    const j2 = (await call(IPC_DETAIL.regenerate, pid)) as number
    expect(j2).toBe(j1)
  })

  it('detail:regenerate 对不存在/已删除/无 PDF 论文抛错', async () => {
    await expect(call(IPC_DETAIL.regenerate, 9999)).rejects.toThrow('不存在')
    const pid = addPaper('Deleted')
    db.prepare('UPDATE papers SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), pid)
    await expect(call(IPC_DETAIL.regenerate, pid)).rejects.toThrow('不存在')
    const noPdf = addPaper('NoPdf', { hasPdf: 0 })
    await expect(call(IPC_DETAIL.regenerate, noPdf)).rejects.toThrow('没有 PDF')
  })

  it('三个 handler 都校验 paperId：字符串/负数/小数/零一律拒绝（pdf.ts 同口径）', async () => {
    const pid = addPaper('Valid')
    for (const bad of ['1', 0, -1, 1.5, NaN, null]) {
      await expect(call(IPC_DETAIL.get, bad)).rejects.toThrow('不合法')
      await expect(call(IPC_DETAIL.getMeta, bad)).rejects.toThrow('不合法')
      await expect(call(IPC_DETAIL.regenerate, bad)).rejects.toThrow('不合法')
    }
    // 合法调用不受校验影响
    expect((await call(IPC_DETAIL.getMeta, pid)) != null).toBe(true)
  })
})
