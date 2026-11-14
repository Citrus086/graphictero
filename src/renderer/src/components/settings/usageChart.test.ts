import { describe, expect, it } from 'vitest'
import { USAGE_CATEGORIES, type UsageAgg, type UsageSeriesView } from '../../../../shared/ipc'
import {
  aggMetricValue,
  FALLBACK_USAGE_PALETTE,
  FALLBACK_USAGE_SOURCE_COLOR,
  formatCny,
  formatMetricValue,
  formatTokenAxis,
  formatTokenExact,
  sameUsageSummary,
  sortUsageRows,
  sortUsageSessionRows,
  usageSubtotals,
  USAGE_CATEGORY_LABELS,
  buildUsageChartOption,
  buildUsageDonutOption,
  USAGE_SOURCE_COLORS
} from './usageChart'

function agg(input: Partial<UsageAgg> = {}): UsageAgg {
  return { costCny: 0, calls: 0, inputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, outputTokens: 0, reasoningTokens: null, ...input }
}
const totals = Object.fromEntries([
  ['chat', agg({ costCny: 1, calls: 3, inputTokens: 10000, cacheHitTokens: 4000, cacheMissTokens: 6000, outputTokens: 2000, reasoningTokens: 500 })],
  ['web', agg({ costCny: 0.005, calls: 1 })],
  ['detail', agg({ costCny: 2, calls: 2, inputTokens: 100, outputTokens: 50, reasoningTokens: 10 })],
  ['relation', agg({ costCny: 3, calls: 1 })],
  ['card', agg({ costCny: 4, calls: 1 })],
  ['overview', agg()]
]) as UsageSeriesView['totals']
const data: UsageSeriesView = {
  days: [{ date: '2026-10-01', byCategory: totals }, { date: '2026-10-02', byCategory: Object.fromEntries(USAGE_CATEGORIES.map((c) => [c, agg()])) as UsageSeriesView['totals'] }],
  totals,
  reasoningKnown: true
}

describe('D180 图表值与小计', () => {
  it('总 token = 输入 + 输出，推理是输出子集不重复累加', () => {
    expect(aggMetricValue(totals.chat, 'tokens', 'all')).toBe(12000)
    expect(aggMetricValue(totals.chat, 'tokens', 'reasoning')).toBe(500)
    expect(aggMetricValue(totals.web, 'tokens', 'all')).toBe(0)
  })
  it('对话 = chat+web；后台 = card/detail/relation/overview；总计一致', () => {
    const sub = usageSubtotals(totals, null)
    expect(sub.chat.costCny).toBeCloseTo(1.005)
    expect(sub.background.costCny).toBe(9)
    expect(sub.total.costCny).toBeCloseTo(10.005)
    expect(sub.total.costCny).toBeCloseTo(sub.chat.costCny + sub.background.costCny)
    expect(usageSubtotals(totals, 'detail').total.costCny).toBe(2)
    expect(usageSubtotals(totals, 'detail').chat.costCny).toBe(0)
  })
  it('uat7b S6(c)：不足 ¥0.01 统一 <¥0.01（tooltip / 表格 / 卡片同口径，走 formatCny）', () => {
    expect(formatCny(0)).toBe('¥0.00')
    expect(formatCny(0.005)).toBe('<¥0.01')
    expect(formatMetricValue(0.005, 'cost')).toBe('<¥0.01') // 原 formatCnyTwo 会是 ¥0.01，已统一
    expect(formatCny(1.234)).toBe('¥1.23')
  })
  it('uat7b S5：token 轴万 / 亿边界；uat7b-fix1 S-c：表格 / 卡片精确千分位整数', () => {
    expect(formatTokenAxis(0)).toBe('0')
    expect(formatTokenAxis(9999)).toBe('9,999')
    expect(formatTokenAxis(10000)).toBe('1 万')
    expect(formatTokenAxis(1200000)).toBe('120 万')
    expect(formatTokenAxis(123456789)).toBe('1.2 亿')
    expect(formatTokenAxis(1e8)).toBe('1 亿')
    // 表格 / 卡片（formatTokenExact）：精确整数千分位，不走万 / 亿
    expect(formatTokenExact(0)).toBe('0')
    expect(formatTokenExact(9999)).toBe('9,999')
    expect(formatTokenExact(10000)).toBe('10,000')
    expect(formatTokenExact(1200000)).toBe('1,200,000')
    expect(formatTokenExact(123456789)).toBe('123,456,789')
  })
  it('uat7b-fix1 S-d：sameUsageSummary 稳定比较（未变跳过 setSummary）', async () => {
    const { USAGE_CATEGORIES: cats } = await import('../../../../shared/ipc')
    const summary = { month: '2026-10', earliestMonth: '2026-08', totalCny: 1.234, byCategory: cats.map((c) => ({ category: c, costCny: 0, calls: 0 })) }
    const same = JSON.parse(JSON.stringify(summary)) as typeof summary
    expect(sameUsageSummary(summary, same)).toBe(true)
    expect(sameUsageSummary(null, summary)).toBe(false)
    expect(sameUsageSummary(summary, { ...summary, totalCny: 2 })).toBe(false)
  })
})

describe('uat7b D186 来源 → 颜色映射', () => {
  it('六个来源各有颜色、两两不同、都不等于 --accent、未知来源走兜底灰', async () => {
    const { usageSourceColor } = await import('../../../../shared/usageMeta')
    const colors = USAGE_CATEGORIES.map((c) => USAGE_SOURCE_COLORS[c])
    expect(colors).toHaveLength(6)
    expect(new Set(colors).size).toBe(6)
    for (const c of colors) {
      expect(c).toMatch(/^#[0-9a-fA-F]{6}$/)
      expect(c.toUpperCase()).not.toBe('#2F6FEB') // --accent 不当系列色
    }
    expect(usageSourceColor('mystery')).toBe(FALLBACK_USAGE_SOURCE_COLOR)
  })
  it('各色对白底对比度 ≥ 3:1（WCAG 图形对象）', () => {
    for (const c of USAGE_CATEGORIES) {
      const hex = USAGE_SOURCE_COLORS[c].replace('#', '')
      const lum =
        [0, 2, 4].map((i) => {
          const v = parseInt(hex.slice(i, i + 2), 16) / 255
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
        })
      const l = 0.2126 * lum[0] + 0.7152 * lum[1] + 0.0722 * lum[2]
      const ratio = 1.05 / (l + 0.05) // 对白底
      expect(ratio, `${c} 对比度`).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('D186 时间序列与来源分布 option', () => {
  it('六系列颜色 = 映射；过滤单系列 / 切 ¥-Token 后颜色不漂移', () => {
    const all = buildUsageChartOption(data, { metric: 'cost', tokenKind: 'all', filter: null, palette: FALLBACK_USAGE_PALETTE }) as any
    expect(all.series).toHaveLength(6)
    all.series.forEach((s: any) => {
      const key = USAGE_CATEGORIES.find((c) => USAGE_CATEGORY_LABELS[c] === s.name)!
      expect(s.itemStyle.color).toBe(USAGE_SOURCE_COLORS[key])
    })
    // 过滤后单系列：仍用来源色，不换成 --accent（D186-1）
    const one = buildUsageChartOption(data, { metric: 'tokens', tokenKind: 'output', filter: 'detail', palette: FALLBACK_USAGE_PALETTE }) as any
    expect(one.series).toHaveLength(1)
    expect(one.series[0].name).toBe('详情生成')
    expect(one.series[0].itemStyle.color).toBe(USAGE_SOURCE_COLORS.detail)
    expect(one.series[0].data).toEqual([50, 0])
    // ¥ → Token 全系列：颜色不变
    const tokens = buildUsageChartOption(data, { metric: 'tokens', tokenKind: 'all', filter: null, palette: FALLBACK_USAGE_PALETTE }) as any
    tokens.series.forEach((s: any) => {
      const key = USAGE_CATEGORIES.find((c) => USAGE_CATEGORY_LABELS[c] === s.name)!
      expect(s.itemStyle.color).toBe(USAGE_SOURCE_COLORS[key])
    })
  })
  it('uat7b S4：6 项图例不分页——两个 plain 行，每行 3 项；非系列元素仍灰阶', () => {
    const option = buildUsageChartOption(data, { metric: 'cost', tokenKind: 'all', filter: null, palette: FALLBACK_USAGE_PALETTE }) as any
    expect(Array.isArray(option.legend)).toBe(true)
    expect(option.legend).toHaveLength(2)
    for (const row of option.legend) expect(row.type).toBe('plain')
    expect(option.legend[0].data).toHaveLength(3)
    expect(option.legend[1].data).toHaveLength(3)
    expect(option.legend[0].data).not.toContain(option.legend[1].data[0])
    // 坐标轴 / 网格线 / 图例文字仍是调色板灰阶（D186-1 其余 UI 灰阶不变）
    expect(option.xAxis.axisLabel.color).toBe(FALLBACK_USAGE_PALETTE.text)
    expect(option.yAxis.splitLine.lineStyle.color).toBe(FALLBACK_USAGE_PALETTE.line)
    expect(option.legend[0].textStyle.color).toBe(FALLBACK_USAGE_PALETTE.text)
  })
  it('uat7b S5：Token 轴 axisLabel 走万 / 亿；¥ 轴保持默认', () => {
    const cost = buildUsageChartOption(data, { metric: 'cost', tokenKind: 'all', filter: null, palette: FALLBACK_USAGE_PALETTE }) as any
    expect(cost.yAxis.axisLabel.formatter).toBeUndefined()
    const tokens = buildUsageChartOption(data, { metric: 'tokens', tokenKind: 'all', filter: null, palette: FALLBACK_USAGE_PALETTE }) as any
    expect(tokens.yAxis.axisLabel.formatter(1200000)).toBe('120 万')
    expect(tokens.yAxis.axisLabel.formatter(123456789)).toBe('1.2 亿')
  })
  it('axis tooltip 含每来源值与当天合计（金额统一 formatCny）', () => {
    const option = buildUsageChartOption(data, { metric: 'cost', tokenKind: 'all', filter: null, palette: FALLBACK_USAGE_PALETTE }) as any
    const text = option.tooltip.formatter([{ seriesName: 'Agent 对话', value: 1 }, { seriesName: '联网搜索 / 抓取', value: 0.005 }])
    expect(text).toContain('Agent 对话：¥1.00')
    expect(text).toContain('联网搜索 / 抓取：<¥0.01')
    expect(text).toContain('合计：¥1.00') // 原生浮点 1.005 的两位显示；分类值逐项保留两位
  })
  it('uat7b S3：环形图标签两行 + overflow none（不截成「…」），六扇区 = 映射色', () => {
    const option = buildUsageDonutOption(data, { metric: 'cost', tokenKind: 'all', filter: null, palette: FALLBACK_USAGE_PALETTE }) as any
    const rows = option.series[0].data
    expect(rows).toHaveLength(6)
    rows.forEach((r: any) => {
      const key = USAGE_CATEGORIES.find((c) => USAGE_CATEGORY_LABELS[c] === r.name)!
      expect(r.itemStyle.color).toBe(USAGE_SOURCE_COLORS[key])
    })
    expect(option.series[0].label.overflow).toBe('none')
    expect(option.series[0].label.formatter).toBe('{b}\n{d}%')
    expect(option.legend).toBeUndefined()
    expect(option.tooltip.formatter(rows.find((r: any) => r.name === '详情生成'))).toContain('详情生成：¥2.00（20.0%）')
  })
  it('B1：窄宽度关掉外标签，图例带百分比，系列色仍是 D186', () => {
    const option = buildUsageDonutOption(data, { metric: 'cost', tokenKind: 'all', filter: null, palette: FALLBACK_USAGE_PALETTE, width: 220 }) as any
    expect(option.series[0].label.show).toBe(false)
    expect(option.series[0].labelLine.show).toBe(false)
    expect(option.series[0].radius).toEqual(['36%', '54%'])
    const legendText = option.legend.formatter('关系生成')
    expect(legendText).toContain('关系生成')
    expect(legendText).toContain('%')
    expect(option.legend.formatter('名片')).toMatch(/名片 \d+\.\d+%/)
    expect(option.legend.borderColor).toBe(FALLBACK_USAGE_PALETTE.line)
    expect(option.legend.inactiveColor).toBe(FALLBACK_USAGE_PALETTE.line)
    expect(option.legend.textStyle.color).toBe(FALLBACK_USAGE_PALETTE.text)
    option.series[0].data.forEach((r: any) => {
      const key = USAGE_CATEGORIES.find((c) => USAGE_CATEGORY_LABELS[c] === r.name)!
      expect(r.itemStyle.color).toBe(USAGE_SOURCE_COLORS[key])
    })
    const wide = buildUsageDonutOption(data, { metric: 'cost', tokenKind: 'all', filter: null, palette: FALLBACK_USAGE_PALETTE, width: 360 }) as any
    expect(wide.series[0].label.show).toBe(true)
    expect(wide.legend).toBeUndefined()
  })
})

describe('D193 按会话排序跟随当前度量', () => {
  const rows = [
    { id: 'low', costCny: 1, inputTokens: 100, outputTokens: 10, reasoningTokens: 9, lastUsedAt: '2026-10-08T00:00:00.000Z' },
    { id: 'tie-old', costCny: 2, inputTokens: 1, outputTokens: 1, reasoningTokens: 0, lastUsedAt: '2026-10-01T00:00:00.000Z' },
    { id: 'tie-new', costCny: 2, inputTokens: 1, outputTokens: 80, reasoningTokens: 1, lastUsedAt: '2026-10-07T00:00:00.000Z' }
  ]
  it('¥ 降序，同额按最近使用降序', () => {
    expect(sortUsageSessionRows(rows, 'cost', 'all').map((r) => r.id)).toEqual(['tie-new', 'tie-old', 'low'])
  })
  it('Token 全部 = 输入 + 输出，推理不重复计入；推理度量单独排序', () => {
    expect(sortUsageSessionRows(rows, 'tokens', 'all').map((r) => r.id)).toEqual(['low', 'tie-new', 'tie-old'])
    expect(sortUsageSessionRows(rows, 'tokens', 'reasoning').map((r) => r.id)[0]).toBe('low')
  })
})

describe('D180 可排序表格（合计行不入排序）', () => {
  it('费用默认降序、调用/输出/来源切换升序，未知推理排作 -1', () => {
    expect(sortUsageRows(totals, { key: 'costCny', direction: 'desc' })[0]).toBe('card')
    expect(sortUsageRows(totals, { key: 'calls', direction: 'asc' })[0]).toBe('overview')
    expect(sortUsageRows(totals, { key: 'outputTokens', direction: 'desc' })[0]).toBe('chat')
    expect(sortUsageRows(totals, { key: 'reasoningTokens', direction: 'asc' })[0]).toBe('relation') // 未知值同分按类别常量顺序
    const labels = sortUsageRows(totals, { key: 'category', direction: 'asc' }).map((c) => USAGE_CATEGORY_LABELS[c])
    expect(labels).toHaveLength(6)
    expect(new Set(labels).size).toBe(6)
  })
})
