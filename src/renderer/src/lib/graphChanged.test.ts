// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { AgentStreamEvent } from '../../../shared/ipc/agent'
import { dispatchGraphChangedIfNeeded, isGraphChangePartDone } from './graphChanged'

/**
 * uat3b 必须修 1：Agent 改图小结（data-graph-change part-done）→ gt:graph-changed；
 * 其它事件（被拒不发小结 → 无 part-done；纯文本/候选卡片/trace）不触发。
 */

const graphChangeDone = {
  sessionId: 1,
  turnId: 't1',
  kind: 'part-done',
  part: { type: 'data-graph-change', id: 'g1', status: 'done', changeType: 'addRelation', relationIds: [7], paperIds: [1, 2], summary: '新增关系 #7' }
} as unknown as AgentStreamEvent

describe('dispatchGraphChangedIfNeeded（Agent 改图 → 画布刷新事件）', () => {
  it('改图小结 part-done → 派发 gt:graph-changed', () => {
    const spy = vi.fn()
    window.addEventListener('gt:graph-changed', spy)
    expect(dispatchGraphChangedIfNeeded(graphChangeDone)).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
    window.removeEventListener('gt:graph-changed', spy)
  })

  it('纯文本 part-done 不派发', () => {
    const spy = vi.fn()
    window.addEventListener('gt:graph-changed', spy)
    const textDone = { ...graphChangeDone, part: { type: 'text', text: '你好' } } as unknown as AgentStreamEvent
    expect(dispatchGraphChangedIfNeeded(textDone)).toBe(false)
    expect(spy).not.toHaveBeenCalled()
    window.removeEventListener('gt:graph-changed', spy)
  })

  it('候选卡片 / trace / turn-end / part-delta 都不派发（被拒的 addRelation 无小结，同理）', () => {
    const events = [
      { sessionId: 1, turnId: 't1', kind: 'part-done', part: { type: 'data-paper-card', id: 'c1', status: 'done', title: 'T', authors: [], reason: 'r', cardStatus: 'candidate' } },
      { sessionId: 1, turnId: 't1', kind: 'part-done', part: { type: 'data-trace', text: '读取记录' } },
      { sessionId: 1, turnId: 't1', kind: 'turn-end', costCny: 0.01 },
      { sessionId: 1, turnId: 't1', kind: 'part-delta', partId: 'text', delta: 'x' }
    ] as unknown as AgentStreamEvent[]
    for (const e of events) expect(isGraphChangePartDone(e)).toBe(false)
  })
})
