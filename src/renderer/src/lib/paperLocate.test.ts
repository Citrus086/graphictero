import { describe, expect, it } from 'vitest'
import { consumePaperLocateNonce, decidePaperLocate, resetPaperLocateNonceForTests } from './paperLocate'

describe('D201 详情页定位：就绪判定（decidePaperLocate）', () => {
  const ready = { graphLoaded: true, rfReady: true, isMember: true, nodeMeasured: true }

  it('图谱详情未加载 → 等待（不提前消费 / 移动）', () => {
    expect(decidePaperLocate({ ...ready, graphLoaded: false })).toBe('wait')
  })

  it('画布 rf 未就绪 → 等待', () => {
    expect(decidePaperLocate({ ...ready, rfReady: false })).toBe('wait')
  })

  it('论文不在当前图谱 → 跳过（不移动、不报错，nonce 照常消费）', () => {
    expect(decidePaperLocate({ ...ready, isMember: false, nodeMeasured: false })).toBe('skip')
  })

  it('成员节点尚未测量完成 → 等待；测量完成后 → 移动', () => {
    expect(decidePaperLocate({ ...ready, nodeMeasured: false })).toBe('wait')
    expect(decidePaperLocate(ready)).toBe('move')
  })
})

describe('D201 已消费 nonce：只移动一次，之后回到画布不再拽视口', () => {
  it('同一 nonce 只消费一次；新 nonce 可再次消费', () => {
    resetPaperLocateNonceForTests()
    expect(consumePaperLocateNonce(101)).toBe(true)
    expect(consumePaperLocateNonce(101)).toBe(false)
    expect(consumePaperLocateNonce(102)).toBe(true)
    expect(consumePaperLocateNonce(102)).toBe(false)
  })

  it('reset 后同一 nonce 重新可消费（单测隔离）', () => {
    resetPaperLocateNonceForTests()
    expect(consumePaperLocateNonce(7)).toBe(true)
    resetPaperLocateNonceForTests()
    expect(consumePaperLocateNonce(7)).toBe(true)
  })
})
