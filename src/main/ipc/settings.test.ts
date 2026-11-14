import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { UsageSeriesView, UsageSessionRow, UsageSummaryView } from '../../shared/ipc'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { recordUsage } from '../llm/usage'

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, handler)
  }
}))

import { registerSettingsIpc } from './settings'
import type { AppState, IpcWrap } from './types'

let dir: string
let db: Database.Database

beforeEach(() => {
  handlers.clear()
  dir = mkdtempSync(join(tmpdir(), 'gt-settings-ipc-'))
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS)
  const state: AppState = { db, dataDir: dir, backupDir: dir, root: dir }
  const h: IpcWrap = (fn) => async (...args) => fn(...args)
  registerSettingsIpc(state, h)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`未注册 ${channel}`)
  return (await handler({}, ...args)) as T
}

describe('settings 用量 IPC（D180）', () => {
  it('usage:series 参数透传并返回序列；monthUsageSummary IPC 保留', async () => {
    recordUsage(db, {
      category: 'chat',
      model: 'deepseek-flash',
      usage: { inputTokens: 100, cacheHitTokens: 20, outputTokens: 50, reasoningTokens: 30 }
    })
    const series = await call<UsageSeriesView>('usage:series', { range: '7d', category: 'chat' })
    expect(series.days).toHaveLength(7)
    expect(series.totals.chat).toMatchObject({ calls: 1, inputTokens: 100, outputTokens: 50, reasoningTokens: 30 })
    expect(series.totals.detail.calls).toBe(0)
    expect(series.reasoningKnown).toBe(true)

    const summary = await call<UsageSummaryView>('settings:usageSummary')
    expect(summary.byCategory).toEqual([expect.objectContaining({ category: 'chat', calls: 1 })])
  })

  it('usage:bySession 只读透传，无会话记录汇成后台行', async () => {
    recordUsage(db, {
      category: 'detail',
      model: 'deepseek-flash',
      usage: { inputTokens: 10, cacheHitTokens: 0, outputTokens: 4 }
    })
    const rows = await call<UsageSessionRow[]>('usage:bySession', { range: 'all' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'background', title: '后台任务（无会话）', calls: 1 })
  })
})
