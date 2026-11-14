// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createElement as h } from 'react'
import type { ChatMessageView } from '../../../../shared/ipc/agent'
import { MessageList } from './MessageList'

/** uat5 建议修 5：assistant 回复文本的 P0x 显示层替换（只展示，不改消息数据）。 */

const MSGS: ChatMessageView[] = [
  { id: 1, role: 'user', parts: [{ type: 'text', text: 'P01 和 P02 有什么关系？' }], createdAt: 't' },
  { id: 2, role: 'assistant', parts: [{ type: 'text', text: 'P01 基于 P02 的框架（P01→P02）。' }], createdAt: 't' },
  { id: 3, role: 'system', parts: [{ type: 'text', text: '用户已撤销上一轮对图谱的 2 条改动' }], createdAt: 't' }
]

const replace = (text: string): string => text.replace(/P0\d/g, (m) => `《论文${m}》`)

afterEach(cleanup)

describe('MessageList（uat5 建议修 5 + D172）', () => {
  it('assistant 回复的 P0x 显示时替换为《短标题》，消息数据不被改写', () => {
    render(h(MessageList, { messages: MSGS, running: false, replaceText: replace }))
    const ai = screen.getByTestId('chat-msg-ai')
    expect(ai.textContent).toContain('《论文P01》')
    expect(ai.textContent).not.toMatch(/P01 基于/)
    // 数据源不动（显示层克隆）
    expect((MSGS[1].parts[0] as { text: string }).text).toContain('P01')
    // 用户消息气泡不走替换（保持原输入）
    expect(screen.getByTestId('chat-msg-user').textContent).toContain('P01 和 P02')
  })

  it('D172：system 记录渲染为居中灰行，不作用户消息也不走 PartsView', () => {
    render(h(MessageList, { messages: MSGS, running: false }))
    const sys = screen.getByTestId('chat-msg-system')
    expect(sys.textContent).toContain('用户已撤销上一轮对图谱的 2 条改动')
    expect(sys.className).toContain('gt-msg-system')
    expect(screen.getAllByTestId('chat-msg-user')).toHaveLength(1)
  })

  it('不传 replaceText 时原样显示（旧宿主兼容）', () => {
    render(h(MessageList, { messages: MSGS, running: false }))
    expect(screen.getByTestId('chat-msg-ai').textContent).toContain('P01 基于 P02')
  })
})
