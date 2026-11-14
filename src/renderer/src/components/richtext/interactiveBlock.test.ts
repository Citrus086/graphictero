// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import type { InteractivePart } from '../../../../shared/parts'
import { formatInteractiveValue } from './InteractiveBlock'

const initChart = vi.fn((_element: HTMLElement, _option: Record<string, unknown>) => ({
  resize: vi.fn(),
  dispose: vi.fn()
}))
vi.mock('./echartsSetup', () => ({
  initChart: (...args: unknown[]) => initChart(...(args as [HTMLElement, Record<string, unknown>]))
}))

import { InteractiveBlock } from './InteractiveBlock'

const base: InteractivePart = {
  type: 'data-interactive',
  id: 'power-law',
  status: 'done',
  title: '幂律误差探索',
  params: [
    { id: 'a', label: '收敛指数 a', control: 'slider', min: 0.2, max: 3, step: 0.1, default: 1 },
    {
      id: 'C',
      label: '尺度 C',
      control: 'select',
      default: 2,
      options: [
        { label: '标准', value: 2 },
        { label: '双倍', value: 4 }
      ]
    },
    { id: 'n', label: '迭代次数 n', control: 'number', min: 1, max: 1000, step: 1, default: 4 },
    { id: 'enabled', label: '计入误差', control: 'toggle', default: 1 }
  ],
  expressions: [{ id: 'err', label: '误差', expr: 'enabled * C * n^(-a)', precision: 4, format: 'fixed' }],
  plot: {
    x: { xVar: 'n', from: 1, to: 1000, samples: 100 },
    series: [{ expr: 'err', label: '误差曲线' }],
    xLabel: 'n',
    yLabel: '误差',
    kind: 'line'
  },
  caption: '调整参数观察误差变化。',
  sourceNote: '自造 fixture：式 (1)'
}

afterEach(cleanup)
beforeEach(() => vi.clearAllMocks())

function renderBlock(part: InteractivePart = base) {
  return render(createElement(InteractiveBlock, { part }))
}

describe('InteractiveBlock（D211 安全交互讲解）', () => {
  it('四类控件键盘可达，默认读数与 line 曲线正确，动画关闭', () => {
    renderBlock()
    expect(screen.getByRole('slider', { name: /收敛指数/ })).toBeTruthy()
    expect(screen.getByRole('spinbutton', { name: /迭代次数/ })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: /尺度/ })).toBeTruthy()
    expect(screen.getByRole('switch', { name: /计入误差/ })).toBeTruthy()
    expect(screen.getByTestId('interactive-value-err').textContent).toBe('0.5')
    expect(screen.getByTestId('part-interactive').textContent).toContain('enabled * C * n^(-a)')
    expect(initChart).toHaveBeenCalledTimes(1)
    const option = initChart.mock.calls[0][1] as unknown as {
      animation: boolean
      series: { type: string; data: [number, number][] }[]
    }
    expect(option.animation).toBe(false)
    expect(option.series[0].type).toBe('line')
    expect(option.series[0].data).toHaveLength(100)
    expect(option.series[0].data[0]).toEqual([1, 2])
  })

  it('参数变化只重算并重建既有 ChartBlock，读数实时更新', async () => {
    renderBlock()
    const firstDispose = initChart.mock.results[0].value.dispose as ReturnType<typeof vi.fn>
    fireEvent.change(screen.getByTestId('interactive-param-a'), { target: { value: '2' } })
    expect(screen.getByTestId('interactive-value-err').textContent).toBe('0.125')
    expect(initChart).toHaveBeenCalledTimes(2)
    expect(firstDispose).toHaveBeenCalledTimes(1)
    fireEvent.change(screen.getByTestId('interactive-param-C'), { target: { value: '4' } })
    expect(screen.getByTestId('interactive-value-err').textContent).toBe('0.25')
    expect(initChart).toHaveBeenCalledTimes(3)
    fireEvent.change(screen.getByTestId('interactive-param-n'), { target: { value: '8' } })
    expect(screen.getByTestId('interactive-value-err').textContent).toBe('0.0625')
    // n 是曲线采样变量，改当前读数不改变整条曲线，无需重建。
    expect(initChart).toHaveBeenCalledTimes(3)
    fireEvent.click(screen.getByTestId('interactive-param-enabled'))
    expect(screen.getByTestId('interactive-value-err').textContent).toBe('0')
    await waitFor(() => expect(initChart).toHaveBeenCalledTimes(4))
  })

  it('number 输入夹到 min/max；scatter 只生成 scatter series', () => {
    const scatter: InteractivePart = { ...base, plot: { ...base.plot!, kind: 'scatter' } }
    renderBlock(scatter)
    const number = screen.getByTestId('interactive-param-n')
    fireEvent.change(number, { target: { value: '10000' } })
    expect((number as HTMLInputElement).value).toBe('1000')
    const latest = initChart.mock.calls.at(-1)![1] as unknown as { series: { type: string }[] }
    expect(latest.series[0].type).toBe('scatter')
  })

  it('NaN / Infinity 显示为 —，非法点不进入曲线', () => {
    const part: InteractivePart = {
      ...base,
      expressions: [{ id: 'err', label: '误差', expr: '1 / (n - n)' }],
      plot: { ...base.plot!, series: [{ expr: '1 / (n - n)', label: '非有限值' }] }
    }
    renderBlock(part)
    expect(screen.getByTestId('interactive-value-err').textContent).toBe('—')
    const option = initChart.mock.calls[0][1] as unknown as { series: { data: [number, number | null][] }[] }
    expect(option.series[0].data).toHaveLength(100)
    expect(option.series[0].data.every((point) => point[1] === null)).toBe(true)
    expect(formatInteractiveValue(Number.NaN)).toBe('—')
    expect(formatInteractiveValue(Number.POSITIVE_INFINITY)).toBe('—')
  })

  it('字符串 plot.x 引用数值参数时按 min/max 采样', () => {
    const part: InteractivePart = { ...base, plot: { ...base.plot!, x: 'n' } }
    renderBlock(part)
    const option = initChart.mock.calls[0][1] as unknown as { series: { data: [number, number][] }[] }
    expect(option.series[0].data).toHaveLength(100)
    expect(option.series[0].data[0][0]).toBe(1)
    expect(option.series[0].data.at(-1)![0]).toBe(1000)
  })

  it('无 plot 时仍显示读数与出处，不初始化图表', () => {
    const part: InteractivePart = { ...base }
    delete part.plot
    renderBlock(part)
    expect(screen.queryByTestId('interactive-chart')).toBeNull()
    expect(screen.getByTestId('part-interactive').textContent).toContain('出处：自造 fixture：式 (1)')
    expect(initChart).not.toHaveBeenCalled()
  })

  it('非法规格局部降级：保留标题与全部公式原文，不崩、不初始化图表', () => {
    const bad = {
      ...base,
      params: [base.params[0], { ...base.params[1], id: 'a' }],
      expressions: [{ id: 'err', label: '误差', expr: 'a + missing' }],
      plot: { ...base.plot!, series: [{ expr: 'missing + n', label: '坏曲线' }] }
    } as unknown as InteractivePart
    renderBlock(bad)
    const fallback = screen.getByTestId('interactive-invalid')
    expect(fallback.textContent).toContain('幂律误差探索')
    expect(fallback.textContent).toContain('a + missing')
    expect(fallback.textContent).toContain('missing + n')
    expect(fallback.textContent).toContain('交互讲解暂不可用')
    expect(initChart).not.toHaveBeenCalled()
  })

  it('降级路径仍执行条数与字符串上限，并明确省略', () => {
    const bad = {
      ...base,
      title: '超'.repeat(100),
      expressions: Array.from({ length: 20 }, () => ({ id: 'x', label: 'x', expr: 'x'.repeat(400) })),
      plot: { ...base.plot!, series: Array.from({ length: 6 }, () => ({ expr: 'y'.repeat(400), label: 'y' })) }
    } as unknown as InteractivePart
    renderBlock(bad)
    const fallback = screen.getByTestId('interactive-invalid')
    const formulas = fallback.querySelectorAll('.gt-interactive-formulas code')
    expect(formulas).toHaveLength(12)
    for (const formula of formulas) expect((formula.textContent ?? '').length).toBe(300)
    expect(fallback.querySelector('.gt-interactive-title')?.textContent).toHaveLength(80)
    expect(fallback.textContent).toContain('已省略超出部分')
    expect(initChart).not.toHaveBeenCalled()
  })

  it('line 在非有限采样点保留 null 缺口，不跨间断点连线', () => {
    const part: InteractivePart = {
      ...base,
      params: [base.params[2]],
      expressions: [{ id: 'recip', label: '倒数', expr: '1 / (n - 2)' }],
      plot: {
        x: { xVar: 'n', from: 1, to: 3, samples: 3 },
        series: [{ expr: 'recip', label: '间断曲线' }],
        kind: 'line'
      }
    }
    renderBlock(part)
    const option = initChart.mock.calls[0][1] as unknown as {
      series: { data: [number, number | null][]; connectNulls: boolean }[]
    }
    expect(option.series[0].data).toEqual([[1, -1], [2, null], [3, 1]])
    expect(option.series[0].connectNulls).toBe(false)
  })

  it('恶意表达式不执行且友好降级', () => {
    for (const expr of ['constructor', '__proto__', 'a.b', 'x[0]', '"str"', '1;2', 'sin.call(a)', 'process']) {
      cleanup()
      vi.clearAllMocks()
      const bad = { ...base, expressions: [{ id: 'err', label: '误差', expr }] } as InteractivePart
      renderBlock(bad)
      expect(screen.getByTestId('interactive-invalid')).toBeTruthy()
      expect(initChart).not.toHaveBeenCalled()
    }
  })

  it('percent / sci / fixed 格式化保持简单且精确定界', () => {
    expect(formatInteractiveValue(0.125, { ...base.expressions[0], format: 'percent', precision: 2 })).toBe('12.5%')
    expect(formatInteractiveValue(12, { ...base.expressions[0], format: 'sci', precision: 2 })).toBe('1.20e+1')
    expect(formatInteractiveValue(0.5, { ...base.expressions[0], format: 'fixed', precision: 4 })).toBe('0.5')
    expect(formatInteractiveValue(Number.MAX_VALUE, { ...base.expressions[0], format: 'percent' })).toBe('—')
  })
})
