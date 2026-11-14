import { describe, expect, it } from 'vitest'
import { preserveMeasured } from './flowNodes'

/**
 * uat3b 4.1：candProg / papersStatus 触发的整批 setNodes 必须保留 xyflow measured，
 * 否则节点 visibility:hidden（确认入库后画布全空的根因）。
 */

describe('preserveMeasured（重建节点保留 measured）', () => {
  it('同 id 节点保留旧 measured；新节点（确认入库的新论文）不带 measured 正常进入测量队列', () => {
    const prev = [
      { id: '1', measured: { width: 180, height: 64 } },
      { id: '2', measured: { width: 180, height: 64 } }
    ]
    const next = [
      { id: '1', measured: undefined as never }, // 重建对象丢 measured
      { id: '2', measured: undefined as never },
      { id: '3', measured: undefined as never } // 新成员
    ]
    const merged = preserveMeasured(prev, next)
    expect(merged[0].measured).toEqual({ width: 180, height: 64 })
    expect(merged[1].measured).toEqual({ width: 180, height: 64 })
    expect(merged[2].measured).toBeUndefined() // 新节点走正常测量
  })

  it('旧节点无 measured 不硬塞；prev 为空原样返回', () => {
    expect(preserveMeasured([{ id: '1' }], [{ id: '1', measured: undefined }])[0].measured).toBeUndefined()
    const next = [{ id: '9', measured: { width: 1, height: 1 } }]
    expect(preserveMeasured([], next)).toBe(next)
  })

  it('候选节点（cand-*）同样保留', () => {
    const prev = [{ id: 'cand-5', measured: { width: 200, height: 120 } }]
    const next = [{ id: 'cand-5', measured: undefined as never }]
    expect(preserveMeasured(prev, next)[0].measured).toEqual({ width: 200, height: 120 })
  })
})
