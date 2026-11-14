import { useEffect, useRef } from 'react'
import type { EChartsCoreOption } from 'echarts/core'
import { initChart, type ChartInstance } from '../richtext/echartsSetup'
import { carryLegendSelected } from './usageChart'

/** 只初始化一次；轮询 / 交互更新走 setOption，过滤与排序状态不被重建。 */
export function UsageChart({
  option,
  testId,
  onSelect
}: {
  option: EChartsCoreOption
  testId: string
  onSelect?: (name: string) => void
}): React.JSX.Element {
  const dom = useRef<HTMLDivElement>(null)
  const chart = useRef<ChartInstance | null>(null)
  /** uat7b M2：用户在图例里隐藏的系列（legendselectchanged 时记录），
   *  轮询重建 option（notMerge）时带回，3 秒刷新不再复原图例选择。 */
  const legendSelected = useRef<Record<string, boolean> | null>(null)

  useEffect(() => {
    if (!dom.current) return
    const instance = initChart(dom.current, option)
    chart.current = instance
    const onLegend = (e: unknown): void => {
      const selected = (e as { selected?: Record<string, boolean> }).selected
      if (selected) legendSelected.current = selected
    }
    instance.on('legendselectchanged', onLegend)
    const resize = (): void => instance.resize()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
    observer?.observe(dom.current)
    window.addEventListener('resize', resize)
    return () => {
      instance.off('legendselectchanged', onLegend)
      observer?.disconnect()
      window.removeEventListener('resize', resize)
      instance.dispose()
      chart.current = null
    }
    // 仅挂载 / 卸载初始化；数据由下一个 effect 更新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const instance = chart.current
    if (!instance) return
    const carried = carryLegendSelected(
      legendSelected.current,
      ((option as { series?: Array<{ name?: string }> }).series ?? []).map((s) => s.name ?? '')
    )
    legendSelected.current = carried
    if (carried == null) {
      instance.setOption(option, { notMerge: true })
      return
    }
    // legend 可能是多行数组（uat7b S4）：selected 注入到每一行。
    const legend = (option as { legend?: object | object[] }).legend
    const merged = Array.isArray(legend)
      ? legend.map((row) => ({ ...row, selected: carried }))
      : { ...legend, selected: carried }
    instance.setOption({ ...option, legend: merged }, { notMerge: true })
  }, [option])

  useEffect(() => {
    const instance = chart.current
    if (!instance || !onSelect) return
    const handler = (params: unknown): void => {
      const name = (params as { name?: string }).name
      if (name) onSelect(name)
    }
    instance.on('click', handler)
    return () => {
      instance.off('click', handler)
    }
  }, [onSelect])

  return <div className="gt-usage-chart" data-testid={testId} ref={dom} />
}
