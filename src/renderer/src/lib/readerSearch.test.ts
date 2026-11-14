import { describe, expect, it } from 'vitest'
import { cycleHit, groupSearchMarks, searchResultQuads } from './readerSearch'

/**
 * 阅读器搜索（uat3 必须修 7）：纯函数单测——上下一个循环、按页分组、矩形换算。
 * 匹配/计数本身由引擎 searchAllPages 负责（pdfium），这里不重复造轮子。
 */

describe('cycleHit（搜索命中 上/下一个 循环）', () => {
  it('向前循环：0→1→2→0', () => {
    expect(cycleHit(0, 3, 1)).toBe(1)
    expect(cycleHit(2, 3, 1)).toBe(0)
  })
  it('向后循环：0→2，2→1', () => {
    expect(cycleHit(0, 3, -1)).toBe(2)
    expect(cycleHit(2, 3, -1)).toBe(1)
  })
  it('无命中返回 -1（不崩）', () => {
    expect(cycleHit(0, 0, 1)).toBe(-1)
  })
})

describe('groupSearchMarks（命中按页分组 + 当前命中区分）', () => {
  it('按页归组、全局第 activeIndex 条标为 current', () => {
    const perPage = new Map<number, Array<Array<[number, number, number, number]>>>([
      [0, [[[0, 0, 10, 5]], [[20, 0, 10, 5]]]],
      [2, [[[0, 0, 10, 5]]]]
    ])
    const marks = groupSearchMarks(perPage, 2)
    expect([...marks.keys()]).toEqual([0, 2])
    expect(marks.get(0)?.map((m) => m.current)).toEqual([false, false])
    expect(marks.get(2)?.map((m) => m.current)).toEqual([true])
  })
  it('activeIndex=0 时第一页第一条为 current', () => {
    const marks = groupSearchMarks(new Map([[1, [[[0, 0, 1, 1]]]]]), 0)
    expect(marks.get(1)?.[0].current).toBe(true)
  })
})

describe('searchResultQuads（引擎矩形 → Quad）', () => {
  it('Rect {origin,size} → [x,y,w,h]', () => {
    const q = searchResultQuads({
      pageIndex: 0,
      charIndex: 0,
      charCount: 1,
      rects: [{ origin: { x: 10, y: 20 }, size: { width: 30, height: 5 } }],
      context: {} as never
    })
    expect(q).toEqual([[10, 20, 30, 5]])
  })
})
