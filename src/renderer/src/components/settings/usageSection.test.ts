// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { createElement as h } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { USAGE_CATEGORIES, type UsageSeriesView, type UsageSessionRow } from '../../../../shared/ipc'

const charts = vi.hoisted(() => ({ instances: [] as any[] }))
vi.mock('../richtext/echartsSetup', () => ({
  initChart: vi.fn((_dom: HTMLElement, option: unknown) => {
    const chart = { option, setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn(), on: vi.fn(), off: vi.fn() }
    charts.instances.push(chart)
    return chart
  })
}))

let UsageSection: typeof import('./UsageSection').UsageSection
let getUsageSeries: Mock
let getUsageBySession: Mock
let getBalance: Mock
let getLlmSettings: Mock
let getUsageByPeriod: Mock
let getRecentUsage: Mock

beforeAll(async () => {
  getUsageSeries = vi.fn(async () => fixture())
  getUsageBySession = vi.fn(async () => [] as UsageSessionRow[])
  getBalance = vi.fn(async () => {
    throw new Error('no key')
  })
  getLlmSettings = vi.fn(async () => ({ provider: 'deepseek', model: 'deepseek-flash', hasApiKey: false, keyTail: null }))
  getUsageByPeriod = vi.fn(async () => ({ peakCny: 0, offPeakCny: 0, nowPeak: false }))
  getRecentUsage = vi.fn(async () => [])
  ;(window as unknown as { graphictero: unknown }).graphictero = {
    getUsageSeries: (...args: unknown[]) => getUsageSeries(...args),
    getUsageBySession: (...args: unknown[]) => getUsageBySession(...args),
    getUsageSummary: async () => ({ month: '2026-10', earliestMonth: null, totalCny: 0, byCategory: [] }),
    getUsageByPeriod: (...args: unknown[]) => getUsageByPeriod(...args),
    getRecentUsage: (...args: unknown[]) => getRecentUsage(...args),
    getLlmSettings: (...args: unknown[]) => getLlmSettings(...args),
    getBalance: (...args: unknown[]) => getBalance(...args)
  }
  UsageSection = (await import('./UsageSection')).UsageSection
})
beforeEach(() => {
  getUsageSeries.mockClear()
  getUsageSeries.mockImplementation(async () => fixture())
  getUsageBySession.mockClear()
  getUsageBySession.mockImplementation(async () => [] as UsageSessionRow[])
  getBalance.mockClear()
  getLlmSettings.mockClear()
  getLlmSettings.mockResolvedValue({ provider: 'deepseek', model: 'deepseek-flash', hasApiKey: false, keyTail: null })
  getUsageByPeriod.mockClear()
  getUsageByPeriod.mockResolvedValue({ peakCny: 0, offPeakCny: 0, nowPeak: false })
  getRecentUsage.mockClear()
  getRecentUsage.mockResolvedValue([])
  charts.instances.length = 0
})
afterEach(cleanup)

function fixture(): UsageSeriesView {
  const totals = Object.fromEntries(USAGE_CATEGORIES.map((category) => [category, {
    costCny: category === 'detail' ? 2 : category === 'chat' ? 1 : 0,
    calls: category === 'detail' ? 2 : category === 'chat' ? 1 : 0,
    inputTokens: category === 'detail' ? 100 : category === 'chat' ? 50 : 0,
    cacheHitTokens: category === 'detail' ? 40 : 0,
    cacheMissTokens: category === 'detail' ? 60 : 0,
    outputTokens: category === 'detail' ? 80 : category === 'chat' ? 20 : 0,
    reasoningTokens: category === 'detail' ? 30 : null
  }])) as UsageSeriesView['totals']
  return { days: [{ date: '2026-10-28', byCategory: totals }], totals, reasoningKnown: true }
}

describe('D180 用量页交互', () => {
  it('未配置 Key 时不调用余额接口', async () => {
    render(h(UsageSection))
    expect(await screen.findByText('未配置 API Key')).toBeTruthy()
    await screen.findByTestId('usage-by-period')
    expect(getBalance).not.toHaveBeenCalled()
  })

  it('范围切换传正确 IPC 参数，轮询/切范围不重建图表实例', async () => {
    render(h(UsageSection))
    await screen.findByTestId('usage-timeseries')
    // 节点先提交，initChart 在随后的 effect 里。先等到时间序列 + 环形图都挂上，
    // 再断言切范围只改 IPC、不再新建实例（dispose 不从数组移除，重建会让长度增长）。
    await waitFor(() => expect(charts.instances.length).toBe(2))
    const initial = charts.instances.length
    fireEvent.click(screen.getByTestId('usage-range-7d'))
    await waitFor(() => expect(getUsageSeries).toHaveBeenCalledWith({ range: '7d', month: undefined }))
    await waitFor(() => expect(getUsageBySession).toHaveBeenCalledWith({ range: '7d', month: undefined, category: undefined }))
    fireEvent.click(screen.getByTestId('usage-range-30d'))
    await waitFor(() => expect(getUsageSeries).toHaveBeenCalledWith({ range: '30d', month: undefined }))
    await waitFor(() => expect(getUsageBySession).toHaveBeenCalledWith({ range: '30d', month: undefined, category: undefined }))
    fireEvent.click(screen.getByTestId('usage-range-all'))
    await waitFor(() => expect(getUsageSeries).toHaveBeenCalledWith({ range: 'all', month: undefined }))
    await waitFor(() => expect(getUsageBySession).toHaveBeenCalledWith({ range: 'all', month: undefined, category: undefined }))
    expect(charts.instances.length).toBe(initial)
  })

  it('¥⇄Token 与推理切换更新图表和摘要，推理不重复入总 token', async () => {
    render(h(UsageSection))
    await screen.findByTestId('usage-total')
    fireEvent.click(screen.getByTestId('usage-metric-tokens'))
    fireEvent.click(screen.getByTestId('usage-token-reasoning'))
    await waitFor(() => {
      const latest = charts.instances.at(-1)
      expect(latest).toBeTruthy()
    })
    const timeseries = charts.instances.find((chart: any) => chart.setOption.mock.calls.some((call: any) => call[0].series?.[0]?.type === 'bar'))
    expect(timeseries).toBeTruthy()
    expect(screen.getByTestId('usage-total').textContent).toContain('推理 30')
    expect(screen.getByTestId('usage-total').textContent).toContain('输入 150')
    expect(screen.getByTestId('usage-total').textContent).toContain('输出 100')
  })

  it('点表格行过滤：chip、单系列、单行；×清除恢复全来源', async () => {
    render(h(UsageSection))
    await screen.findByTestId('usage-table')
    fireEvent.click(screen.getByTestId('usage-row-detail'))
    expect((await screen.findByTestId('usage-filter-chip')).textContent).toContain('来源：详情生成')
    expect(screen.getByTestId('usage-row-detail').className).toContain('selected')
    expect(screen.queryByTestId('usage-row-chat')).toBeNull()
    const lastBarOption = charts.instances.flatMap((chart: any) => chart.setOption.mock.calls.map((call: any) => call[0])).filter((option: any) => option.series?.[0]?.type === 'bar').at(-1)
    expect(lastBarOption.series).toHaveLength(1)
    fireEvent.click(screen.getByTestId('usage-filter-clear'))
    expect(await screen.findByTestId('usage-row-chat')).toBeTruthy()
    expect(screen.queryByTestId('usage-filter-chip')).toBeNull()
  })

  it('点输出表头两次切换升降序与 aria-sort；合计行不参与', async () => {
    render(h(UsageSection))
    await screen.findByTestId('usage-table')
    const button = screen.getByRole('button', { name: '输出' })
    const th = button.closest('th')!
    fireEvent.click(button)
    await waitFor(() => expect(th.getAttribute('aria-sort')).toBe('descending'))
    const rows = () => Array.from(document.querySelectorAll('tbody tr:not(.gt-usage-sum)')).map((r) => r.getAttribute('data-testid'))
    expect(rows()[0]).toBe('usage-row-detail')
    fireEvent.click(button)
    await waitFor(() => expect(th.getAttribute('aria-sort')).toBe('ascending'))
    expect(rows()[0]).toBe('usage-row-relation') // 全 0 类别按 USAGE_CATEGORIES 稳定排序
    expect(document.querySelector('.gt-usage-sum')).toBeTruthy()
  })
})

describe('D193 按会话区块', () => {
  function row(partial: Partial<UsageSessionRow> & Pick<UsageSessionRow, 'sessionId' | 'title' | 'costCny'>): UsageSessionRow {
    return {
      kind: 'session',
      graphName: null,
      calls: 1,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: null,
      lastUsedAt: '2026-10-08T00:00:00.000Z',
      ...partial
    }
  }

  it('默认 10 行、后台行发灰、显示全部展开；切 Token 后按 token 重排且不改记账请求形态', async () => {
    const many: UsageSessionRow[] = [
      row({ sessionId: 1, title: '便宜但 token 多', costCny: 0.2, inputTokens: 500, outputTokens: 500, lastUsedAt: '2026-10-01T00:00:00.000Z' }),
      row({ sessionId: 2, title: '最贵', costCny: 9, inputTokens: 1, outputTokens: 1, graphName: '综述图谱', lastUsedAt: '2026-10-02T00:00:00.000Z' }),
      ...Array.from({ length: 9 }, (_, i) => row({ sessionId: 10 + i, title: `填充 ${i}`, costCny: 1, inputTokens: 3, outputTokens: 3 })),
      { kind: 'background', sessionId: null, title: '后台任务（无会话）', graphName: null, costCny: 3, calls: 4, inputTokens: 8, outputTokens: 2, reasoningTokens: null, lastUsedAt: '2026-10-03T00:00:00.000Z' }
    ]
    getUsageBySession.mockImplementation(async () => many)
    render(h(UsageSection))
    await screen.findByTestId('usage-by-session')
    await waitFor(() => expect(document.querySelectorAll('[data-testid="usage-session-row"]')).toHaveLength(10))
    const first = document.querySelector('[data-testid="usage-session-row"]')!
    expect(first.textContent).toContain('最贵')
    expect(first.textContent).toContain('综述图谱')
    expect(first.textContent).toContain('¥9.00')
    expect(document.querySelector('[data-kind="background"]')?.classList.contains('is-background')).toBe(true)
    expect(screen.getByTestId('usage-session-more').textContent).toBe('显示全部（12）')
    fireEvent.click(screen.getByTestId('usage-session-more'))
    expect(document.querySelectorAll('[data-testid="usage-session-row"]')).toHaveLength(12)
    fireEvent.click(screen.getByTestId('usage-metric-tokens'))
    await waitFor(() => {
      expect(document.querySelector('[data-testid="usage-session-row"]')?.textContent).toContain('便宜但 token 多')
    })
    expect(getUsageBySession).toHaveBeenCalledWith({ range: 'month', month: expect.any(String), category: undefined })
  })

  it('uat9：同图谱同名会话用最近使用时间区分；表头 padding 与按来源表一致', async () => {
    getUsageBySession.mockResolvedValue([
      row({ sessionId: 21, title: '图谱对话 · 同名', graphName: '同一图谱', costCny: 2, lastUsedAt: '2026-10-08T00:00:00.000Z' }),
      row({ sessionId: 22, title: '图谱对话 · 同名', graphName: '同一图谱', costCny: 1, lastUsedAt: '2026-10-07T01:02:00.000Z' })
    ])
    render(h(UsageSection))
    await waitFor(() => expect(document.querySelectorAll('[data-testid="usage-session-row"]')).toHaveLength(2))
    const contexts = Array.from(document.querySelectorAll('.gt-usage-session-graph')).map((el) => el.textContent)
    expect(contexts).toEqual(['同一图谱 · 2026-10-08 08:00', '同一图谱 · 2026-10-07 09:02'])
    const css = readFileSync(join(fileURLToPath(import.meta.url), '..', 'usage.css'), 'utf8').replace(/\s+/g, '')
    expect(css).toContain('.gt-usage-sessionsth{padding:8px}')
  })

  it('uat10 评审建议 3：无图谱名显示时间；同图谱同分钟撞车加短 id；td 带完整名 title', async () => {
    getUsageBySession.mockResolvedValue([
      row({ sessionId: 31, title: '图谱对话 · 甲', graphName: '同一图谱', costCny: 3, lastUsedAt: '2026-10-08T00:00:00.000Z' }),
      row({ sessionId: 32, title: '图谱对话 · 乙', graphName: '同一图谱', costCny: 2, lastUsedAt: '2026-10-08T00:00:30.000Z' }), // 同一分钟
      row({ sessionId: 33, title: '图谱对话 · 丙', graphName: null, costCny: 1, lastUsedAt: '2026-10-07T01:02:00.000Z' }) // 无图谱名
    ])
    render(h(UsageSection))
    await waitFor(() => expect(document.querySelectorAll('[data-testid="usage-session-row"]')).toHaveLength(3))
    const contexts = Array.from(document.querySelectorAll('.gt-usage-session-graph')).map((el) => el.textContent)
    expect(contexts[0]).toContain('同一图谱 · ')
    expect(contexts[0]).toContain('#31')
    expect(contexts[1]).toContain('同一图谱 · ')
    expect(contexts[1]).toContain('#32')
    expect(contexts[0]).not.toBe(contexts[1]) // 同分钟两行可区分
    expect(contexts[2]).not.toContain('同一图谱') // 无图谱名：只有时间
    expect(contexts[2]).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
    const firstTd = document.querySelector('[data-testid="usage-session-row"] td')!
    expect(firstTd.getAttribute('title')).toBe('图谱对话 · 甲')
  })

  it('来源过滤下推到按会话查询；空数据用现有空态文案', async () => {
    render(h(UsageSection))
    await screen.findByTestId('usage-by-session')
    expect(screen.getByTestId('usage-by-session').textContent).toContain('这段时间还没有用量')
    fireEvent.click(screen.getByTestId('usage-row-detail'))
    await waitFor(() => expect(getUsageBySession).toHaveBeenCalledWith({ range: 'month', month: expect.any(String), category: 'detail' }))
  })
})

describe('uat7b M2 图例隐藏保留 + 数据未变不更新', () => {
  function timeseriesChart(): any {
    const chart = charts.instances.find((c: any) => c.setOption.mock.calls.some((call: any[]) => call[0]?.series?.[0]?.type === 'bar'))
    expect(chart, '时间序列图表实例').toBeTruthy()
    return chart
  }

  it('点图例隐藏系列 → 轮询数据未变不 setOption → 数据变了照常更新且隐藏仍保留', async () => {
    vi.useFakeTimers()
    try {
      render(h(UsageSection))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) }) // 初次 load 落定
      screen.getByTestId('usage-timeseries')
      const chart = timeseriesChart()
      const callsBefore = chart.setOption.mock.calls.length
      // 模拟 echarts 图例点击：隐藏「详情生成」
      const legendHandler = chart.on.mock.calls.find((call: any[]) => call[0] === 'legendselectchanged')?.[1]
      expect(legendHandler).toBeTypeOf('function')
      await act(async () => legendHandler({ selected: { 详情生成: false } }))
      // ① 数据未变：推进 3 秒轮询 → 不 setOption（图例隐藏不被复原，M2 回归）
      await act(async () => { await vi.advanceTimersByTimeAsync(3100) })
      expect(getUsageSeries.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(chart.setOption.mock.calls.length).toBe(callsBefore)
      // ② 数据真变了：照常刷新，且新 option 带回 legend.selected 隐藏状态
      getUsageSeries.mockImplementation(async () => {
        const next = fixture()
        next.totals = {
          ...next.totals,
          chat: { ...next.totals.chat, costCny: 5, calls: 9, inputTokens: 900, cacheHitTokens: 0, cacheMissTokens: 900, outputTokens: 90, reasoningTokens: null }
        }
        next.days = [{ date: '2026-10-28', byCategory: next.totals }]
        return next
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(3100) })
      expect(chart.setOption.mock.calls.length).toBeGreaterThan(callsBefore)
      const lastOption = chart.setOption.mock.calls.at(-1)![0]
      expect(lastOption.series.length).toBe(6)
      // legend 是多行数组（uat7b S4）：selected 注入每一行
      for (const row of lastOption.legend) expect(row.selected).toEqual({ 详情生成: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('过滤掉只剩一个系列时，图例隐藏对仍存在系列保留；全恢复后不再注入 selected', async () => {
    render(h(UsageSection))
    await screen.findByTestId('usage-timeseries')
    const chart = timeseriesChart()
    const legendHandler = chart.on.mock.calls.find((call: any[]) => call[0] === 'legendselectchanged')?.[1]
    legendHandler({ selected: { 详情生成: false, 名片: false } })
    // 过滤到只剩「详情生成」：名片已消失被丢弃，详情生成仍隐藏
    fireEvent.click(screen.getByTestId('usage-row-detail'))
    await waitFor(() => {
      const last = chart.setOption.mock.calls.at(-1)![0]
      expect(last.series).toHaveLength(1)
      for (const row of last.legend) expect(row.selected).toEqual({ 详情生成: false })
    })
    // 全部重新显示（echarts 回传全 true）→ 后续更新不再注入 selected
    legendHandler({ selected: { 详情生成: true, 名片: true } })
    fireEvent.click(screen.getByTestId('usage-filter-clear'))
    await waitFor(() => {
      const last = chart.setOption.mock.calls.at(-1)![0]
      expect(last.series).toHaveLength(6)
      for (const row of last.legend) expect(row).not.toHaveProperty('selected')
    })
  })

  it('过滤 chip 与表格行小色块颜色 = 来源映射（D186）', async () => {
    const { USAGE_SOURCE_COLORS } = await import('../../../../shared/usageMeta')
    // jsdom 把内联 hex 归一化成 rgb，期望值同步换算
    const rgb = (hex: string): string => {
      const v = hex.replace('#', '')
      return `rgb(${parseInt(v.slice(0, 2), 16)}, ${parseInt(v.slice(2, 4), 16)}, ${parseInt(v.slice(4, 6), 16)})`
    }
    render(h(UsageSection))
    await screen.findByTestId('usage-table')
    // 表格每行色块
    for (const c of USAGE_CATEGORIES) {
      const row = screen.getByTestId(`usage-row-${c}`)
      const swatch = row.querySelector('.gt-usage-swatch') as HTMLElement
      expect(swatch, `usage-row-${c} 色块`).toBeTruthy()
      expect(swatch.style.background).toBe(rgb(USAGE_SOURCE_COLORS[c]))
    }
    // 过滤 chip 色块
    fireEvent.click(screen.getByTestId('usage-row-detail'))
    const chip = await screen.findByTestId('usage-filter-chip')
    const chipSwatch = chip.querySelector('.gt-usage-swatch') as HTMLElement
    expect(chipSwatch.style.background).toBe(rgb(USAGE_SOURCE_COLORS.detail))
  })
})
