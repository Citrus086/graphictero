import { useEffect, useRef, useState } from 'react'
import type { ChartPart } from '../../../../shared/parts'
import { sanitizeChartOption } from './chartOption'
import { initChart } from './echartsSetup'

/**
 * M4 lane/render：data-chart 图表块（D19）。
 *
 * - option 先过白名单校验（chartOption.ts：纯 JSON 语义，拒绝函数/超长/循环引用，
 *   绝不 eval），不过 → 灰色降级块。
 * - 标题 + 数据来源小字必显（D19：防「看似有据实为编造」）。
 */
export function ChartBlock({ part }: { part: ChartPart }): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  const [reason, setReason] = useState<string | null>(null)
  const optionRef = useRef<Record<string, unknown> | null>(null)

  const sanitized = sanitizeChartOption(part.option)
  const option = sanitized.ok ? sanitized.option : null
  optionRef.current = option
  const invalidReason = sanitized.ok ? null : sanitized.reason

  useEffect(() => {
    if (invalidReason || !optionRef.current || !boxRef.current) return
    const chart = initChart(boxRef.current, optionRef.current)
    const onResize = (): void => chart.resize()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chart.dispose()
    }
    // option 是生成物（每篇一次），不随交互变；只在 part.id 变化时重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [part.id, invalidReason])

  return (
    <div className="gt-part-chart" data-testid="part-chart">
      <div className="gt-chart-title">{part.title}</div>
      {invalidReason ? (
        <div className="gt-part-fallback" data-testid="chart-invalid">
          <span className="gt-fallback-tag">图表配置无效</span>
          <span className="gt-fallback-reason">{invalidReason}</span>
        </div>
      ) : (
        <div className="gt-chart-box" ref={boxRef} data-testid="chart-box" />
      )}
      <div className="gt-chart-source">数据来源：{part.dataSource}</div>
    </div>
  )
}
