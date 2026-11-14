import type { EChartsCoreOption } from 'echarts/core'
import { USAGE_CATEGORIES, type UsageAgg, type UsageByCategory, type UsageCategory, type UsageSeriesView, type UsageSummaryView } from '../../../../shared/ipc'
import { BACKGROUND_POST_CATEGORIES, usageSourceColor } from '../../../../shared/usageMeta'

// D186：映射本体在 src/shared/usageMeta.ts（主进程 / 渲染层唯一来源），此处再导出
// 保持渲染层各组件 / 测试从 usageChart 一处取。
export { USAGE_SOURCE_COLORS, FALLBACK_USAGE_SOURCE_COLOR, usageSourceColor } from '../../../../shared/usageMeta'

export const USAGE_CATEGORY_LABELS: Record<UsageCategory, string> = {
  chat: 'Agent 对话',
  web: '联网搜索 / 抓取',
  detail: '详情生成',
  relation: '关系生成',
  card: '名片',
  overview: '导出概览'
}

export type UsageMetric = 'cost' | 'tokens'
export type UsageTokenKind = 'all' | 'input' | 'output' | 'reasoning'
export type UsageSortKey = 'category' | 'calls' | 'costCny' | 'inputTokens' | 'cacheHitTokens' | 'outputTokens' | 'reasoningTokens'
export interface UsageSort { key: UsageSortKey; direction: 'asc' | 'desc' }

/** 非系列元素的灰阶调色板（坐标轴 / 网格线 / 文本）。系列色走 D186 的
 *  usageSourceColor，不在这里（uat7b：移除灰阶阶梯 colors）。 */
export interface UsagePalette {
  accent: string
  text: string
  line: string
  /** tooltip 底，跟随 --panel，深浅主题都可读 */
  panel: string
}

export const FALLBACK_USAGE_PALETTE: UsagePalette = {
  accent: '#2F6FEB',
  text: '#262626',
  line: '#d3d3d3',
  panel: '#ffffff'
}

export const DARK_FALLBACK_USAGE_PALETTE: UsagePalette = {
  accent: '#4C8BF5',
  text: '#ECECEE',
  line: '#3A3A3C',
  panel: '#1F1F21'
}

export function readUsagePalette(doc: Document = document): UsagePalette {
  const css = getComputedStyle(doc.documentElement)
  const fallback = doc.documentElement.dataset.theme === 'dark' ? DARK_FALLBACK_USAGE_PALETTE : FALLBACK_USAGE_PALETTE
  const value = (name: string, fallbackValue: string): string => css.getPropertyValue(name).trim() || fallbackValue
  return {
    accent: value('--accent', fallback.accent),
    text: value('--text', fallback.text),
    line: value('--line2', fallback.line),
    panel: value('--panel', fallback.panel)
  }
}

/** 金额显示唯一口径（uat7b S6(c)：统一走 formatCny，不足 ¥0.01 显示 <¥0.01——
 *  tooltip / 表格 / 卡片一致；D178 金额只在设置页不变）。 */
export function formatCny(n: number): string {
  if (n === 0) return '¥0.00'
  if (n > 0 && n < 0.01) return '<¥0.01'
  return `¥${n.toFixed(2)}`
}

/** uat7b-fix1 S-c：表格 / 卡片里的精确 token 数（千分位整数，不走万 / 亿）——
 *  任务 S5 口径：轴与 tooltip 用万 / 亿，表格保留精确数字。 */
export function formatTokenExact(n: number): string {
  return n.toLocaleString('zh-CN')
}

/** uat7b S5：坐标轴 / 图表 tooltip 的中文大数单位（万 / 亿；<1 万原样千分位）。 */
export function formatTokenAxis(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1e8) {
    const v = n / 1e8
    return `${v.toFixed(1).replace(/\.0$/, '')} 亿`
  }
  if (abs >= 1e4) {
    const v = n / 1e4
    return `${v.toFixed(1).replace(/\.0$/, '')} 万`
  }
  return n.toLocaleString('zh-CN')
}

/** tooltip 金额 / token 显示（uat7b S5/S6(c)：token 用万/亿，金额统一 formatCny）。 */
export function formatMetricValue(n: number, metric: UsageMetric): string {
  return metric === 'cost' ? formatCny(n) : formatTokenAxis(n)
}

/** uat8b D193：按当前度量降序，相同再按最近使用时间降序。推理是输出子集，总 token 不加推理。 */
export function sortUsageSessionRows<T extends {
  costCny: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number | null
  lastUsedAt: string
}>(rows: readonly T[], metric: UsageMetric, tokenKind: UsageTokenKind): T[] {
  const value = (row: T): number => {
    if (metric === 'cost') return row.costCny
    if (tokenKind === 'input') return row.inputTokens
    if (tokenKind === 'output') return row.outputTokens
    if (tokenKind === 'reasoning') return row.reasoningTokens ?? 0
    return row.inputTokens + row.outputTokens
  }
  return [...rows].sort((a, b) => {
    const delta = value(b) - value(a)
    if (delta !== 0) return delta
    if (a.lastUsedAt === b.lastUsedAt) return 0
    return a.lastUsedAt < b.lastUsedAt ? 1 : -1
  })
}

export function aggMetricValue(agg: UsageAgg, metric: UsageMetric, tokenKind: UsageTokenKind): number {
  if (metric === 'cost') return agg.costCny
  if (tokenKind === 'input') return agg.inputTokens
  if (tokenKind === 'output') return agg.outputTokens
  if (tokenKind === 'reasoning') return agg.reasoningTokens ?? 0
  // 推理是输出的子集：总 token 只加输入 + 输出，绝不重复加推理。
  return agg.inputTokens + agg.outputTokens
}

export function sumUsageAggs(aggs: readonly UsageAgg[]): UsageAgg {
  const knownReasoning = aggs.some((a) => a.reasoningTokens != null)
  return {
    costCny: aggs.reduce((s, a) => s + a.costCny, 0),
    calls: aggs.reduce((s, a) => s + a.calls, 0),
    inputTokens: aggs.reduce((s, a) => s + a.inputTokens, 0),
    cacheHitTokens: aggs.reduce((s, a) => s + a.cacheHitTokens, 0),
    cacheMissTokens: aggs.reduce((s, a) => s + a.cacheMissTokens, 0),
    outputTokens: aggs.reduce((s, a) => s + a.outputTokens, 0),
    reasoningTokens: knownReasoning ? aggs.reduce((s, a) => s + (a.reasoningTokens ?? 0), 0) : null
  }
}

export function usageSubtotals(totals: UsageByCategory, filter: UsageCategory | null): { chat: UsageAgg; background: UsageAgg; total: UsageAgg } {
  const categories = filter ? [filter] : USAGE_CATEGORIES
  const values = categories.map((c) => totals[c])
  const chat = sumUsageAggs(values.filter((_, i) => {
    const c = categories[i]
    return c === 'chat' || c === 'web'
  }))
  const background = sumUsageAggs(values.filter((_, i) => BACKGROUND_POST_CATEGORIES.has(categories[i])))
  return { chat, background, total: sumUsageAggs(values) }
}

export function sortUsageRows(totals: UsageByCategory, sort: UsageSort): UsageCategory[] {
  const rows = [...USAGE_CATEGORIES]
  rows.sort((a, b) => {
    let av: number | string
    let bv: number | string
    if (sort.key === 'category') {
      av = USAGE_CATEGORY_LABELS[a]
      bv = USAGE_CATEGORY_LABELS[b]
    } else {
      av = totals[a][sort.key] ?? -1
      bv = totals[b][sort.key] ?? -1
    }
    const cmp = typeof av === 'string' ? av.localeCompare(bv as string, 'zh-CN') : av - (bv as number)
    const direction = sort.direction === 'asc' ? 1 : -1
    return cmp * direction || USAGE_CATEGORIES.indexOf(a) - USAGE_CATEGORIES.indexOf(b)
  })
  return rows
}

export interface UsageChartOptions {
  metric: UsageMetric
  tokenKind: UsageTokenKind
  filter: UsageCategory | null
  palette: UsagePalette
  /** 环形图容器宽度（px）。窄于 DONUT_LABEL_MIN_WIDTH 时外标签改由图例承担。 */
  width?: number
}

/** 窄于这个宽度时，外侧标签放不进 SVG（窗口 1280×840 时 donut 列约 220px）。 */
export const DONUT_LABEL_MIN_WIDTH = 280

/** D186：系列颜色只跟来源 key 走（含过滤后单系列），不随过滤 / 顺序 / 切换变化。 */
function seriesColor(category: UsageCategory): string {
  return usageSourceColor(category)
}

/** 悬停 / 选中的强调：同色系加深（--accent 只用于 UI 选中 / 悬停，不当系列色，D186-1）。 */
function emphasisColorOf(category: UsageCategory): string {
  const hex = usageSourceColor(category).replace('#', '')
  const channel = (s: string): number => Math.max(0, Math.round(parseInt(s, 16) * 0.82))
  return `#${channel(hex.slice(0, 2)).toString(16).padStart(2, '0')}${channel(hex.slice(2, 4))
    .toString(16)
    .padStart(2, '0')}${channel(hex.slice(4, 6)).toString(16).padStart(2, '0')}`
}

export function buildUsageChartOption(data: UsageSeriesView, opts: UsageChartOptions): EChartsCoreOption {
  const categories = opts.filter ? [opts.filter] : [...USAGE_CATEGORIES]
  const series = categories.map((category) => ({
    name: USAGE_CATEGORY_LABELS[category],
    type: 'bar',
    stack: 'usage',
    emphasis: { focus: 'series', itemStyle: { color: emphasisColorOf(category) } },
    itemStyle: { color: seriesColor(category) },
    data: data.days.map((day) => aggMetricValue(day.byCategory[category], opts.metric, opts.tokenKind))
  }))
  // uat7b S4：6 项图例一页放下——两个 plain 图例行（每行 3 项），不再 scroll 分页。
  const names = categories.map((category) => USAGE_CATEGORY_LABELS[category])
  const legendRow = (rowNames: string[]): object => ({
    top: 0,
    left: 'center',
    type: 'plain',
    data: rowNames,
    itemWidth: 14,
    itemHeight: 9,
    itemGap: 14,
    textStyle: { color: opts.palette.text, fontSize: 11.5 },
    inactiveColor: opts.palette.line,
    borderColor: opts.palette.line, // uat7 2b7e072 口径：legend 底边收调色板灰，不带默认 #b7b9be
    icon: 'roundRect',
    // 图例色块 = 系列色（echarts 自动），选中态不显式换色（D186-1）。
    selectedMode: true
  })
  const legendRows = names.length > 3 ? [legendRow(names.slice(0, 3)), { ...legendRow(names.slice(3)), top: 20 }] : [legendRow(names)]
  return {
    animation: false,
    color: categories.map(seriesColor),
    // 坐标轴指示器在悬停后会留在 SVG 里；默认线色是 border（#b7b9be）。
    axisPointer: {
      lineStyle: { color: opts.palette.line },
      shadowStyle: { color: 'rgba(0,0,0,0.08)' },
      label: { show: false, color: opts.palette.text, backgroundColor: opts.palette.text }
    },
    legend: legendRows,
    tooltip: {
      trigger: 'axis',
      backgroundColor: opts.palette.panel,
      borderColor: opts.palette.line,
      textStyle: { color: opts.palette.text },
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(0,0,0,0.08)' } },
      formatter: (raw: unknown) => {
        const params = (Array.isArray(raw) ? raw : [raw]) as Array<{ seriesName?: string; value?: number | string }>
        const rows = params.filter((p) => p.seriesName)
        const total = rows.reduce((s, p) => s + Number(p.value ?? 0), 0)
        return [
          ...rows.map((p) => `${p.seriesName}：${formatMetricValue(Number(p.value ?? 0), opts.metric)}`),
          `合计：${formatMetricValue(total, opts.metric)}`
        ].join('<br/>')
      }
    },
    grid: { left: 52, right: 14, top: names.length > 3 ? 52 : 34, bottom: 30, borderColor: opts.palette.line },
    xAxis: {
      type: 'category',
      data: data.days.map((d) => d.date.slice(5)),
      axisLabel: { color: opts.palette.text },
      axisLine: { lineStyle: { color: opts.palette.line } },
      axisTick: { lineStyle: { color: opts.palette.line } }
    },
    yAxis: {
      type: 'value',
      // uat7b S5：Token 轴用万 / 亿；¥ 轴保持默认数字格式。
      axisLabel: {
        color: opts.palette.text,
        ...(opts.metric === 'tokens' ? { formatter: (v: number) => formatTokenAxis(v) } : {})
      },
      axisLine: { lineStyle: { color: opts.palette.line } },
      axisTick: { lineStyle: { color: opts.palette.line } },
      splitLine: { lineStyle: { color: opts.palette.line } }
    },
    series
  }
}

export function buildUsageDonutOption(data: UsageSeriesView, opts: UsageChartOptions): EChartsCoreOption {
  const total = USAGE_CATEGORIES.reduce((s, c) => s + aggMetricValue(data.totals[c], opts.metric, opts.tokenKind), 0)
  const rows = USAGE_CATEGORIES.map((category) => ({
    name: USAGE_CATEGORY_LABELS[category],
    value: aggMetricValue(data.totals[category], opts.metric, opts.tokenKind),
    itemStyle: { color: seriesColor(category) }
  }))
  const labelsOutside = opts.width == null || opts.width >= DONUT_LABEL_MIN_WIDTH
  const percentOf = (name: string): string => {
    const value = rows.find((row) => row.name === name)?.value ?? 0
    return total > 0 ? ((value / total) * 100).toFixed(2) : '0.00'
  }
  return {
    animation: false,
    tooltip: {
      trigger: 'item',
      backgroundColor: opts.palette.panel,
      borderColor: opts.palette.line,
      textStyle: { color: opts.palette.text },
      formatter: (raw: unknown) => {
        const p = raw as { name?: string; value?: number | string }
        const value = Number(p.value ?? 0)
        const pct = total > 0 ? ((value / total) * 100).toFixed(1) : '0.0'
        return `${p.name ?? ''}：${formatMetricValue(value, opts.metric)}（${pct}%）`
      }
    },
    // 窄容器不画外标签（会被 SVG 裁掉），百分比改由图例逐项写出。颜色仍是 D186 映射。
    legend: labelsOutside ? undefined : {
      type: 'plain',
      orient: 'horizontal',
      bottom: 0,
      left: 0,
      right: 0,
      itemWidth: 10,
      itemHeight: 8,
      textStyle: { color: opts.palette.text, fontSize: 11 },
      // 与柱图图例同一口径：不落 echarts 默认边框色 #b7b9be（smoke 灰阶扫描会判越界）。
      inactiveColor: opts.palette.line,
      borderColor: opts.palette.line,
      formatter: (name: string) => `${name} ${percentOf(name)}%`
    },
    series: [{
      type: 'pie',
      radius: labelsOutside ? ['42%', '62%'] : ['36%', '54%'],
      center: labelsOutside ? ['50%', '52%'] : ['50%', '42%'],
      avoidLabelOverlap: true,
      // 饼图默认描边宽 1 且不给颜色，SVG 会带上主题 border。
      itemStyle: { borderWidth: 0, borderColor: opts.palette.line },
      label: labelsOutside ? {
        show: true,
        color: opts.palette.text,
        fontSize: 11.5,
        overflow: 'none',
        formatter: '{b}\n{d}%',
        lineHeight: 14,
        align: 'center'
      } : { show: false },
      labelLine: labelsOutside
        ? { show: true, length: 10, length2: 8, lineStyle: { color: opts.palette.line } }
        : { show: false },
      emphasis: { scaleSize: 4 },
      data: rows
    }]
  }
}

export function usageRangeIsEmpty(data: UsageSeriesView): boolean {
  return USAGE_CATEGORIES.every((c) => data.totals[c].calls === 0 && data.totals[c].costCny === 0 && data.totals[c].inputTokens === 0 && data.totals[c].outputTokens === 0)
}

/** uat7b M2：聚合结果的稳定比较（主进程同一 SQL 确定性输出，序列化比较足够）。
 *  3 秒轮询拿到与当前完全相同的数据时不触发 setState → 不 setOption、图例隐藏不被复原。 */
export function sameUsageSeries(a: UsageSeriesView | null, b: UsageSeriesView): boolean {
  if (a == null) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/** uat7b-fix1 S-d：月汇总摘要的稳定比较（轮询未变同样跳过 setSummary）。 */
export function sameUsageSummary(a: UsageSummaryView | null, b: UsageSummaryView): boolean {
  if (a == null) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 按会话汇总的稳定比较：3 秒轮询未变时不 setState。 */
export function sameUsageSessions<T>(a: readonly T[] | null, b: readonly T[]): boolean {
  if (a == null) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/** uat7b M2：重建 option 时带回用户在图例里的隐藏状态。只保留仍存在的系列名；
 *  全部可见（没有 false 项）返回 null——调用方原样 setOption，不注入 legend.selected。 */
export function carryLegendSelected(
  prev: Record<string, boolean> | null,
  seriesNames: readonly string[]
): Record<string, boolean> | null {
  if (prev == null) return null
  const kept: Record<string, boolean> = {}
  for (const name of seriesNames) {
    if (prev[name] === false) kept[name] = false
  }
  return Object.keys(kept).length > 0 ? kept : null
}
