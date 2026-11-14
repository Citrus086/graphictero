// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { noteCardTop } from './noteCard'

/** D138（Q-M6-15）：页边笔记卡跟随锚点高度，超出视口贴边 */
describe('noteCardTop（D138 笔记卡纵向位置换算与贴边）', () => {
  it('锚点在视口内：卡片与锚点同一水平线', () => {
    // body 高 600，卡片高 220：合法区间 [8, 372]
    expect(noteCardTop(100, 600, 220)).toBe(100)
    expect(noteCardTop(8, 600, 220)).toBe(8)
    expect(noteCardTop(372, 600, 220)).toBe(372)
  })

  it('锚点超出上缘：贴顶边（margin）', () => {
    expect(noteCardTop(-50, 600, 220)).toBe(8)
    expect(noteCardTop(0, 600, 220)).toBe(8)
  })

  it('锚点超出下缘：贴底边（body 高 − 卡片高 − margin）', () => {
    expect(noteCardTop(500, 600, 220)).toBe(372)
    expect(noteCardTop(9999, 600, 220)).toBe(372)
  })

  it('视口比卡片还矮：夹紧到 margin（不跑出负值）', () => {
    expect(noteCardTop(100, 100, 220)).toBe(8)
    expect(noteCardTop(500, 100, 220)).toBe(8)
  })
})
