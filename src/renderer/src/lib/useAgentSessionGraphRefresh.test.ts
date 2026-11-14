// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentApi, AgentStreamEvent } from '../../../shared/ipc/agent'
import { useAgentSession } from './useAgentSession'

function graphChangePartDone(): AgentStreamEvent {
  return {
    sessionId: 1,
    turnId: 't1',
    kind: 'part-done',
    part: {
      type: 'data-graph-change', id: 'g1', status: 'done', changeType: 'addRelation',
      relationIds: [7], paperIds: [1, 2], summary: '新增关系'
    }
  } as unknown as AgentStreamEvent
}

function setup() {
  let emit: ((e: AgentStreamEvent) => void) | null = null
  const api = {
    onAgentStream: (cb: (e: AgentStreamEvent) => void) => {
      emit = cb
      return () => {}
    },
    getMessages: vi.fn().mockResolvedValue([]),
    sessionCost: vi.fn().mockResolvedValue(0),
    sessionCostBreakdown: vi.fn().mockResolvedValue({ chat: 0, background: 0, total: 0 })
  } as unknown as AgentApi
  const hook = renderHook(() => useAgentSession({ graphId: null, entry: null, api }))
  const changed = vi.fn()
  window.addEventListener('gt:graph-changed', changed)
  return {
    emit: (e: AgentStreamEvent) => act(() => emit!(e)),
    changed,
    async close() {
      hook.unmount()
      window.removeEventListener('gt:graph-changed', changed)
    }
  }
}

describe('Agent 改图刷新收敛（uat8-fix1 S2）', () => {
  it('纯文本 turn-end 不刷新画布', async () => {
    const s = setup()
    await s.emit({ sessionId: 1, turnId: 't1', kind: 'turn-end', costCny: 0 } as AgentStreamEvent)
    expect(s.changed).not.toHaveBeenCalled()
    await s.close()
  })

  it('正常与被早退的改图 part-done 都各刷新一次，turn-end 不重复刷新', async () => {
    const normal = setup()
    await normal.emit({ sessionId: 1, turnId: 't1', kind: 'turn-start' } as AgentStreamEvent)
    await normal.emit(graphChangePartDone())
    await normal.emit({ sessionId: 1, turnId: 't1', kind: 'turn-end', costCny: 0 } as AgentStreamEvent)
    expect(normal.changed).toHaveBeenCalledTimes(1)
    await normal.close()

    const skipped = setup()
    await skipped.emit(graphChangePartDone())
    await skipped.emit({ sessionId: 1, turnId: 't1', kind: 'turn-end', costCny: 0 } as AgentStreamEvent)
    expect(skipped.changed).toHaveBeenCalledTimes(1)
    await skipped.close()
  })
})
