// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { selectionTextWithin } from './selectionText'

/**
 * uat3b 必须修 3：选区文本按「选区矩形 ∩ span 包围盒」视觉命中重建——
 * DOM 顺序 ≠ 视觉顺序（双栏/戳记）时不再把夹在中间的整页文字带进引文。
 * 全部 mock 矩形，不加载 PDF。
 */

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect
}

interface Line {
  text: string
  top: number
  left: number
}

/** 三行文字；另造一个 DOM 顺序在最前、视觉位置在右栏的「戳记」span */
function setup(): { container: HTMLElement; spans: HTMLElement[] } {
  const container = document.createElement('div')
  // DOM 顺序：戳记在前，然后三行（模拟引擎返回顺序乱）
  container.innerHTML =
    '<span class="stamp">侧栏戳记文字</span><span>第一行文字。</span><span>第二行文字。</span><span>第三行文字。</span>'
  document.body.appendChild(container)
  return { container, spans: Array.from(container.querySelectorAll('span')) }
}

/** 给每个 span 一个假包围盒（行高 12，行距 20；戳记在右栏 x=400） */
function mockSpanRects(spans: HTMLElement[], lines: Line[]): void {
  const byText = new Map(lines.map((l) => [l.text, l]))
  for (const span of spans) {
    const l = byText.get(span.textContent ?? '')
    const r = l ? rect(l.left, l.top, l.text.length * 12, 12) : rect(0, 0, 0, 0)
    vi.spyOn(span, 'getBoundingClientRect').mockReturnValue(r)
  }
}

function rangeWithRects(ranges: DOMRect[]): Range {
  const range = document.createRange()
  // jsdom 的 Range 无 getClientRects——own property 遮蔽
  Object.defineProperty(range, 'getClientRects', { value: () => ranges as unknown as DOMRectList, configurable: true })
  return range
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('selectionTextWithin（引文选区视觉重建）', () => {
  it('划选第 1、3 行（中间第 2 行不在选区矩形里）→ 只含 1、3 行，不含戳记与第 2 行', () => {
    const { container, spans } = setup()
    mockSpanRects(spans, [
      { text: '第一行文字。', top: 0, left: 0 },
      { text: '第二行文字。', top: 20, left: 0 },
      { text: '第三行文字。', top: 40, left: 0 }
    ])
    // 戳记视觉位置：右栏顶部
    vi.spyOn(spans[0], 'getBoundingClientRect').mockReturnValue(rect(400, 0, 72, 12))
    const range = rangeWithRects([rect(0, -1, 72, 14), rect(0, 39, 72, 14)]) // 只罩住第 1、3 行
    const text = selectionTextWithin(container, range)
    expect(text).toBe('第一行文字。\n第三行文字。')
    expect(text).not.toContain('第二行')
    expect(text).not.toContain('戳记')
  })

  it('双栏：左栏划选不与右栏混行（行聚类后行内按 left 排）', () => {
    const { container, spans } = setup()
    // 三行：第一行在左栏，第二行在右栏，第三行在左栏下一行
    mockSpanRects(spans, [
      { text: '第一行文字。', top: 0, left: 0 },
      { text: '第二行文字。', top: 0, left: 300 },
      { text: '第三行文字。', top: 20, left: 0 }
    ])
    const range = rangeWithRects([rect(-1, -1, 74, 14), rect(-1, 19, 74, 14)]) // 左栏两行
    const text = selectionTextWithin(container, range)
    expect(text).toBe('第一行文字。\n第三行文字。')
  })

  it('覆盖率 <50% 的 span 不计入；无选区矩形回退 range.toString()', () => {
    const { container, spans } = setup()
    mockSpanRects(spans, [{ text: '第一行文字。', top: 0, left: 0 }])
    const half = rangeWithRects([rect(0, 8, 72, 4)]) // 只罩住第一行下 1/3（<50% 面积）
    expect(selectionTextWithin(container, half)).toBe('') // 纵向覆盖 <50% 不计入 → 回退 toString（mock 空）
    const empty = rangeWithRects([])
    Object.defineProperty(empty, 'toString', { value: () => '回退文本', configurable: true })
    expect(selectionTextWithin(container, empty)).toBe('回退文本')
  })

  it('uat5 建议修 8.2：半行选中按字符裁剪（不再整个 span 收进来）', () => {
    const { container, spans } = setup()
    mockSpanRects(spans, [{ text: '第一行文字。', top: 0, left: 0 }]) // 6 字 × 12 = 72 宽
    // 只划过左半（36/72 = 50%）：覆盖左缘 → 前 3 字
    const leftHalf = rangeWithRects([rect(0, 0, 36, 12)])
    expect(selectionTextWithin(container, leftHalf)).toBe('第一行')
    // 只划过右半：覆盖右缘 → 后 3 字
    const rightHalf = rangeWithRects([rect(36, 0, 36, 12)])
    expect(selectionTextWithin(container, rightHalf)).toBe('文字。')
    // 纵贯全高、横向只过 1/6：≥1 字兜底
    const tiny = rangeWithRects([rect(0, 0, 12, 12)])
    expect(selectionTextWithin(container, tiny)).toBe('第')
  })

  it('uat5 建议修 8.2：回退受限——toString 超 500 字一律放弃（不再回退出整页）', () => {
    const { container, spans } = setup()
    mockSpanRects(spans, [{ text: '第一行文字。', top: 0, left: 0 }])
    const long = rangeWithRects([])
    Object.defineProperty(long, 'toString', { value: () => '字'.repeat(501), configurable: true })
    expect(selectionTextWithin(container, long)).toBe('')
    const ok = rangeWithRects([])
    Object.defineProperty(ok, 'toString', { value: () => '字'.repeat(500), configurable: true })
    expect(selectionTextWithin(container, ok)).toBe('字'.repeat(500))
  })
})
