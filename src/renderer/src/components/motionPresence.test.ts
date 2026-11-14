// @vitest-environment jsdom
import { createElement } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MotionPresence } from './MotionPresence'

function content() {
  return createElement('div', { 'data-testid': 'motion-content' }, '内容')
}

beforeEach(() => {
  vi.useFakeTimers()
  document.documentElement.dataset.motion = 'on'
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: false }))
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete document.documentElement.dataset.motion
})

describe('D200 MotionPresence', () => {
  it('关闭先淡出，120ms 后才卸载；进入态 200ms 后归位', () => {
    const view = render(createElement(MotionPresence, { open: true, kind: 'pop', children: content() }))
    expect(view.getByTestId('motion-content')).toBeTruthy()
    expect(document.querySelector('.gt-motion')?.getAttribute('data-motion-state')).toBe('entering')
    act(() => vi.advanceTimersByTime(200))
    expect(document.querySelector('.gt-motion')?.getAttribute('data-motion-state')).toBe('open')

    view.rerender(createElement(MotionPresence, { open: false, kind: 'pop', children: null }))
    expect(view.getByTestId('motion-content')).toBeTruthy()
    expect(document.querySelector('.gt-motion')?.getAttribute('data-motion-state')).toBe('exiting')
    act(() => vi.advanceTimersByTime(119))
    expect(view.getByTestId('motion-content')).toBeTruthy()
    act(() => vi.advanceTimersByTime(1))
    expect(view.queryByTestId('motion-content')).toBeNull()
    expect(document.querySelector('.gt-motion')).toBeNull()
  })

  it('退出中重开会取消卸载；off 开关下立即关闭', () => {
    const view = render(createElement(MotionPresence, { open: true, kind: 'modal', children: content() }))
    view.rerender(createElement(MotionPresence, { open: false, kind: 'modal', children: null }))
    act(() => vi.advanceTimersByTime(60))
    view.rerender(createElement(MotionPresence, { open: true, kind: 'modal', children: content() }))
    act(() => vi.advanceTimersByTime(200))
    expect(view.getByTestId('motion-content')).toBeTruthy()
    expect(document.querySelector('.gt-motion')?.getAttribute('data-motion-state')).toBe('open')

    document.documentElement.dataset.motion = 'off'
    view.rerender(createElement(MotionPresence, { open: false, kind: 'modal', children: null }))
    expect(view.queryByTestId('motion-content')).toBeNull()
  })
})

describe('D202（uat12b）页面 / 视图退出层交叉淡化', () => {
  for (const kind of ['page', 'view'] as const) {
    it(`${kind}：关闭后保留退出层淡出，120ms 准时卸载、不残留 wrapper 节点`, () => {
      const view = render(createElement(MotionPresence, { open: true, kind, children: content() }))
      act(() => vi.advanceTimersByTime(200))
      expect(document.querySelector('.gt-motion')?.getAttribute('data-motion-state')).toBe('open')

      view.rerender(createElement(MotionPresence, { open: false, kind, children: null }))
      // 交叉淡化期间旧内容仍在（淡出不位移），由 CSS 负责透明度
      expect(view.getByTestId('motion-content')).toBeTruthy()
      expect(document.querySelector('.gt-motion')?.getAttribute('data-motion-state')).toBe('exiting')
      // D206：page 旧层垫底到新页淡入结束（200ms），view 仍 120ms
      const exitMs = kind === 'page' ? 200 : 120
      act(() => vi.advanceTimersByTime(exitMs - 1))
      expect(view.getByTestId('motion-content')).toBeTruthy()
      act(() => vi.advanceTimersByTime(1))
      // 时长到点卸载：内容与其 .gt-motion wrapper 都不残留，新层不会点到旧层
      expect(view.queryByTestId('motion-content')).toBeNull()
      expect(document.querySelector('.gt-motion')).toBeNull()
    })

    it(`${kind}：动效关闭时退出层立即卸载，DOM 与直接条件渲染一致`, () => {
      const view = render(createElement(MotionPresence, { open: true, kind, children: content() }))
      expect(view.getByTestId('motion-content')).toBeTruthy()
      document.documentElement.dataset.motion = 'off'
      view.rerender(createElement(MotionPresence, { open: false, kind, children: null }))
      // off 路径同步消失：无退出层、无 wrapper、无内容残留
      expect(view.queryByTestId('motion-content')).toBeNull()
      expect(document.querySelector('.gt-motion')).toBeNull()
    })
  }
})
