// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  CAND_CONFIRM_ROLLBACK,
  CAND_CONFIRM_START,
  dispatchCandConfirmRollback,
  dispatchCandConfirmStart,
  optimisticPaperOf,
  pruneCandOptimistic,
  withCandConfirmRollback,
  withCandConfirmStart,
  type CandOptimisticEntry
} from './candOptimistic'

/** uat5 必须修 4：候选确认乐观更新的纯函数层。 */

const ENTRY: CandOptimisticEntry = {
  candidateId: 42,
  paperId: null,
  title: '外部候选',
  authors: ['张三'],
  year: 2025,
  x: 10,
  y: 20
}

describe('候选确认乐观更新（uat5 必须修 4）', () => {
  it('start：候选进入乐观集合；rollback：撤出（回滚）', () => {
    let m = new Map<number, CandOptimisticEntry>()
    m = withCandConfirmStart(m, ENTRY)
    expect(m.has(42)).toBe(true)
    expect(m.get(42)).toEqual(ENTRY)
    m = withCandConfirmRollback(m, 42)
    expect(m.has(42)).toBe(false)
    // 回滚不存在的 id 是空操作
    expect(withCandConfirmRollback(m, 999).size).toBe(0)
  })

  it('start 用新条目覆盖同候选旧条目（防重复计数）', () => {
    let m = withCandConfirmStart(new Map(), ENTRY)
    m = withCandConfirmStart(m, { ...ENTRY, paperId: 900 })
    expect(m.size).toBe(1)
    expect(m.get(42)?.paperId).toBe(900)
  })

  it('optimisticPaperOf：库外用占位负 id，已在库中用真实 paperId', () => {
    expect(optimisticPaperOf(ENTRY)).toMatchObject({ id: -42, title: '外部候选', firstAuthor: '张三', year: 2025, hasPdf: false })
    expect(optimisticPaperOf({ ...ENTRY, paperId: 900 })).toMatchObject({ id: 900, inGraph: true })
  })

  it('派发事件：GraphPage 监听同名 CustomEvent（round-trip）', () => {
    const got: { start?: CandOptimisticEntry; rollback?: number } = {}
    const onStart = (e: Event): void => {
      got.start = (e as CustomEvent<CandOptimisticEntry>).detail
    }
    const onRollback = (e: Event): void => {
      got.rollback = (e as CustomEvent<number>).detail
    }
    window.addEventListener(CAND_CONFIRM_START, onStart)
    window.addEventListener(CAND_CONFIRM_ROLLBACK, onRollback)
    dispatchCandConfirmStart(ENTRY)
    dispatchCandConfirmRollback(42)
    window.removeEventListener(CAND_CONFIRM_START, onStart)
    window.removeEventListener(CAND_CONFIRM_ROLLBACK, onRollback)
    expect(got.start).toEqual(ENTRY)
    expect(got.rollback).toBe(42)
  })

  it('uat5-fix1 M2 pruneCandOptimistic：确认成功（候选不再 pending）撤占位；仍 pending 保留；空 Map 原样返回', () => {
    let m = withCandConfirmStart(new Map(), ENTRY)
    m = withCandConfirmStart(m, { ...ENTRY, candidateId: 43, paperId: 900 })
    // 42 确认成功（不在 pending 集）→ 撤掉；43 仍 pending → 保留
    const pruned = pruneCandOptimistic(m, new Set([43]))
    expect(pruned.has(42)).toBe(false)
    expect(pruned.has(43)).toBe(true)
    expect(pruned.size).toBe(1)
    // 无变化时返回原引用（不无谓重渲）
    const again = pruneCandOptimistic(pruned, new Set([43]))
    expect(again).toBe(pruned)
    // 空 Map 直接返回
    const empty = new Map<number, CandOptimisticEntry>()
    expect(pruneCandOptimistic(empty, new Set())).toBe(empty)
  })
})
