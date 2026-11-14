/**
 * M4 lane/render：ECharts 按需注册（D107 只引 echarts/core + 需要的图/组件）。
 * 集中在一处，组件测试 mock 本模块即可（jsdom 无 canvas）。
 * 评审建 1：注册 SVGRenderer（与 initChart 的 { renderer: 'svg' } 对齐；
 * zrender 对未注册的 renderer 会静默回退第一个已注册 painter，不能只改一处）。
 */
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart, ScatterChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent
} from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import type { EChartsCoreOption } from 'echarts/core'

echarts.use([BarChart, LineChart, PieChart, ScatterChart, GridComponent, LegendComponent, TitleComponent, TooltipComponent, SVGRenderer])

export type ChartInstance = ReturnType<typeof echarts.init>

/** 初始化为 SVG 渲染（无 canvas 依赖；交互/提示正常，详情页图表够用）。 */
export function initChart(dom: HTMLElement, option: EChartsCoreOption): ChartInstance {
  const chart = echarts.init(dom, undefined, { renderer: 'svg' })
  chart.setOption(option)
  return chart
}
