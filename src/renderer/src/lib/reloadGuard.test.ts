import { describe, expect, it } from 'vitest'
import { currentReloadResult } from './reloadGuard'

describe('图谱 reload 序号（uat8-fix1 S1）', () => {
  it('最后一次返回详情，过期请求返回 null', () => {
    const oldDetail = { members: ['old'] }
    const newDetail = { members: ['new'] }
    expect(currentReloadResult(1, 2, oldDetail)).toBeNull()
    expect(currentReloadResult(2, 2, newDetail)).toBe(newDetail)
  })
})
