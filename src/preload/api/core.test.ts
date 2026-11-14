import { describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async () => ({ ok: true })) }))
vi.mock('electron', () => ({ ipcRenderer: { invoke } }))

import { IPC } from '../../shared/ipc'
import { coreApi } from './core'

describe('coreApi 用量 IPC', () => {
  it('getUsageSeries 原样传 input 到 usage:series', async () => {
    invoke.mockClear()
    const input = { range: 'month', month: '2026-10', category: 'chat' } as const
    await coreApi.getUsageSeries(input)
    expect(invoke).toHaveBeenCalledWith(IPC.settingsUsageSeries, input)
    expect(IPC.settingsUsageSeries).toBe('usage:series')
  })

  it('getUsageBySession 原样传 input 到 usage:bySession', async () => {
    invoke.mockClear()
    const input = { range: '7d', category: 'relation' } as const
    await coreApi.getUsageBySession(input)
    expect(invoke).toHaveBeenCalledWith(IPC.settingsUsageBySession, input)
    expect(IPC.settingsUsageBySession).toBe('usage:bySession')
  })

  it('getUsageSummary 旧通道保持 settings:usageSummary', async () => {
    invoke.mockClear()
    await coreApi.getUsageSummary('2026-09')
    expect(invoke).toHaveBeenCalledWith(IPC.settingsUsageSummary, '2026-09')
  })
})
