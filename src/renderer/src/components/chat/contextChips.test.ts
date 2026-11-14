// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement as h } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContextChips, type ChatChip } from "./ContextChips"

/**
 * uat3b 必须修 3：引文 chip——悬停 title 看全文（既有）+ 字数徽标 + 点击展开/收起。
 */

afterEach(cleanup)

const QUOTE_TEXT = '这是用户从 PDF 里划选的一段引文，用来发给 agent 做上下文。'

const CHIPS: ChatChip[] = [
  { ref: { kind: 'quote', paperId: 3, page: 4, text: QUOTE_TEXT }, label: `p.5「${QUOTE_TEXT.slice(0, 24)}…」` }
]

describe('ContextChips 引文 chip（uat3b 必须修 3）', () => {
  it('引文 chip 显示字数徽标；点击展开看全文、再点收起', () => {
    render(h(ContextChips, { chips: CHIPS, onRemove: () => {}, onDropPaper: () => {} }))
    const chip = screen.getByTestId('chat-chip')
    // 悬停看全文（title）
    expect(chip.getAttribute('title')).toBe(QUOTE_TEXT)
    // 字数徽标
    const badge = screen.getByTestId('chip-expand')
    expect(badge.textContent).toBe(`${QUOTE_TEXT.length}字`)
    // 点击展开 → label 变全文
    fireEvent.click(badge)
    expect(screen.getByTestId('chat-chip').querySelector('.gt-chip-label')?.textContent).toBe(QUOTE_TEXT)
    expect(screen.getByTestId('chip-expand').textContent).toBe('收起')
    // 再点收起
    fireEvent.click(screen.getByTestId('chip-expand'))
    expect(screen.getByTestId('chat-chip').querySelector('.gt-chip-label')?.textContent).toBe(CHIPS[0].label)
  })

  it('论文 chip 不显示字数徽标', () => {
    render(h(ContextChips, { chips: [{ ref: { kind: 'paper', paperId: 1 }, label: '某论文' }], onRemove: () => {}, onDropPaper: () => {} }))
    expect(screen.queryByTestId('chip-expand')).toBeNull()
    expect(vi.fn()).not.toHaveBeenCalled()
  })
})
