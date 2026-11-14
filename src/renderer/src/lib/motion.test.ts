import { describe, expect, it, vi } from 'vitest'
import {
  GRAPH_POSITION_ANIMATION_LIMIT,
  clampMotionProgress,
  createInterruptibleAnimation,
  currentMotionDisabled,
  easeMotion,
  interpolatePosition,
  planNodeTransitions,
  shouldAnimateNodePositions,
  shouldDisableMotion,
  shouldRunPositionTween
} from './motion'

describe('D200 motion helpers', () => {
  it('位置插值覆盖起止、中点与标准缓动', () => {
    const from = { x: 10, y: -20 }
    const to = { x: 110, y: 80 }
    expect(interpolatePosition(from, to, 0)).toEqual(from)
    expect(interpolatePosition(from, to, 1)).toEqual(to)
    expect(easeMotion(0.5)).toBeCloseTo(0.875)
    expect(interpolatePosition(from, to, 0.5)).toEqual({ x: 97.5, y: 67.5 })
  })

  it('t 截断到 [0,1]，非法值不回吐出 NaN 坐标', () => {
    const from = { x: 0, y: 0 }
    const to = { x: 20, y: 40 }
    expect(clampMotionProgress(-0.5)).toBe(0)
    expect(clampMotionProgress(1.5)).toBe(1)
    expect(interpolatePosition(from, to, -1)).toEqual(from)
    expect(interpolatePosition(from, to, 2)).toEqual(to)
    expect(interpolatePosition(from, to, Number.NaN)).toEqual(from)
    expect(interpolatePosition(from, to, Number.POSITIVE_INFINITY)).toEqual(to)
  })

  it('节点数 >300 或显式关闭时跳过位置动画，300 仍允许', () => {
    expect(shouldAnimateNodePositions(GRAPH_POSITION_ANIMATION_LIMIT, false)).toBe(true)
    expect(shouldAnimateNodePositions(GRAPH_POSITION_ANIMATION_LIMIT + 1, false)).toBe(false)
    expect(shouldAnimateNodePositions(1, true)).toBe(false)
  })

  it('reduced-motion 与确定性开关分别及同时关闭', () => {
    expect(shouldDisableMotion({})).toBe(false)
    expect(shouldDisableMotion({ forcedOff: true })).toBe(true)
    expect(shouldDisableMotion({ reducedMotion: true })).toBe(true)
    expect(shouldDisableMotion({ forcedOff: true, reducedMotion: true })).toBe(true)
  })

  it('无 DOM 环境默认关闭；data-motion=off 不依赖 matchMedia', () => {
    expect(currentMotionDisabled()).toBe(true)
    const originalDocument = globalThis.document
    const originalWindow = globalThis.window
    try {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { dataset: { motion: 'off' } } } })
      Object.defineProperty(globalThis, 'window', { configurable: true, value: { matchMedia: vi.fn() } })
      expect(currentMotionDisabled()).toBe(true)
      expect(globalThis.window.matchMedia).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument })
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
    }
  })
})

describe('D200 node transitions', () => {
  const node = (id: string, x: number, y = x) => ({ id, position: { x, y } })

  it('新增直接在目标位进入，删除保留旧快照，既有节点给起止位置', () => {
    const old = [node('a', 0), node('b', 20)]
    const next = [node('a', 100, 120), node('c', 40)]
    const plan = planNodeTransitions(old, next)
    expect(plan.entering).toEqual(['c'])
    expect(plan.exiting).toEqual([node('b', 20)])
    expect(plan.moves).toEqual([{ id: 'a', from: { x: 0, y: 0 }, to: { x: 100, y: 120 } }])
    expect(interpolatePosition(plan.moves[0].from, plan.moves[0].to, 1)).toEqual(next[0].position)
  })

  it('拖拽中的节点不参与插值；未变坐标不产生任务', () => {
    const plan = planNodeTransitions([node('a', 0), node('b', 10)], [node('a', 90), node('b', 10)], new Set(['a']))
    expect(plan.moves).toEqual([])
    expect(plan.entering).toEqual([])
    expect(plan.exiting).toEqual([])
  })

  it('新动画打断旧动画：旧帧与旧完成回调都不再生效', () => {
    let seq = 0
    const callbacks = new Map<number, (time: number) => void>()
    const cancelled: number[] = []
    const request = (cb: (time: number) => void): number => {
      const id = ++seq
      callbacks.set(id, cb)
      return id
    }
    const animation = createInterruptibleAnimation(request, (id) => cancelled.push(id))
    const oldFrames: number[] = []
    const newFrames: number[] = []
    const oldDone = vi.fn()
    const newDone = vi.fn()

    animation.run(200, (t) => oldFrames.push(t), oldDone)
    const oldHandle = seq
    animation.run(200, (t) => newFrames.push(t), newDone)
    const newHandle = seq
    expect(cancelled).toEqual([oldHandle])

    callbacks.get(oldHandle)!(0)
    expect(oldFrames).toEqual([])
    expect(oldDone).not.toHaveBeenCalled()
    callbacks.get(newHandle)!(100)
    const secondHandle = seq
    callbacks.get(secondHandle)!(200)
    expect(newFrames).toEqual([0, 0.5])
    expect(newDone).not.toHaveBeenCalled()
    const lastHandle = seq
    callbacks.get(lastHandle)!(300)
    expect(newFrames).toEqual([0, 0.5, 1])
    expect(newDone).toHaveBeenCalledOnce()
    expect(animation.isActive()).toBe(false)
  })

  it('uat12 建议修 1：动效关闭 / 无可动 move 时不启动位置 tween', () => {
    expect(shouldRunPositionTween(0, false)).toBe(false)
    expect(shouldRunPositionTween(3, true)).toBe(false)
    expect(shouldRunPositionTween(3, false)).toBe(true)
  })

  it('零时长同步落终态；cancel 使待执行帧失效', () => {
    let cb: ((time: number) => void) | undefined
    const animation = createInterruptibleAnimation((next) => {
      cb = next
      return 1
    }, vi.fn())
    const frame = vi.fn()
    const done = vi.fn()
    animation.run(0, frame, done)
    expect(frame).toHaveBeenCalledWith(1)
    expect(done).toHaveBeenCalledOnce()

    animation.run(200, frame)
    animation.cancel()
    cb?.(100)
    expect(frame).toHaveBeenCalledTimes(1)
    expect(animation.isActive()).toBe(false)
  })
})
