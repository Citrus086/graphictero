import { Component, useId, useMemo, useState, type ReactNode } from 'react'
import {
  InteractivePartSchema,
  type ChartPart,
  type InteractiveExpression,
  type InteractiveParam,
  type InteractivePart
} from '../../../../shared/parts'
import {
  compileMathExpression,
  type CompiledMathExpression
} from '../../../../shared/mathExpr'
import { ChartBlock } from './ChartBlock'

interface CompiledInteractive {
  expressions: { id: string; compiled: CompiledMathExpression }[]
  series: { id: string | null; compiled: CompiledMathExpression | null }[]
}

type InteractiveValues = Record<string, number>

function compileInteractive(part: InteractivePart): CompiledInteractive {
  const expressionIds = new Set(part.expressions.map((expression) => expression.id))
  return {
    expressions: part.expressions.map((expression) => ({
      id: expression.id,
      compiled: compileMathExpression(expression.expr)
    })),
    series: (part.plot?.series ?? []).map((series) => ({
      id: expressionIds.has(series.expr) ? series.expr : null,
      compiled: expressionIds.has(series.expr) ? null : compileMathExpression(series.expr)
    }))
  }
}

function evaluateScope(
  part: InteractivePart,
  compiled: CompiledInteractive,
  values: InteractiveValues,
  xOverride?: { id: string; value: number }
): Map<string, number> {
  const scope = new Map<string, number>()
  for (const param of part.params) scope.set(param.id, values[param.id] ?? param.default)
  if (xOverride) scope.set(xOverride.id, xOverride.value)
  for (const expression of compiled.expressions) {
    scope.set(expression.id, expression.compiled.evaluate(scope))
  }
  return scope
}

function trimFixed(value: number, precision: number): string {
  return value
    .toFixed(precision)
    .replace(/(\.\d*?[1-9])0+$/, '$1')
    .replace(/\.0+$/, '')
}

export function formatInteractiveValue(value: number, expression?: InteractiveExpression): string {
  if (!Number.isFinite(value)) return '—'
  const precision = expression?.precision ?? 4
  if (expression?.format === 'sci') return value.toExponential(precision)
  if (expression?.format === 'percent') {
    const percent = value * 100
    return Number.isFinite(percent) ? `${trimFixed(percent, precision)}%` : '—'
  }
  const abs = Math.abs(value)
  if (!expression?.format && abs > 0 && (abs >= 1e6 || abs < 1e-4)) return value.toExponential(precision)
  return trimFixed(value, precision)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function plotRange(part: InteractivePart): { id: string; from: number; to: number; samples: number } | null {
  if (!part.plot) return null
  if (typeof part.plot.x !== 'string') {
    return {
      id: part.plot.x.xVar,
      from: part.plot.x.from,
      to: part.plot.x.to,
      samples: part.plot.x.samples ?? 100
    }
  }
  const param = part.params.find((item) => item.id === part.plot?.x)
  if (!param || param.min === undefined || param.max === undefined) return null
  return { id: param.id, from: param.min, to: param.max, samples: 100 }
}

function buildPlotOption(
  part: InteractivePart,
  compiled: CompiledInteractive,
  values: InteractiveValues
): Record<string, unknown> | null {
  if (!part.plot) return null
  const range = plotRange(part)
  if (!range) throw new Error('plot.x 必须引用带 min/max 的数值参数')
  const seriesData: [number, number | null][][] = part.plot.series.map(() => [])
  for (let index = 0; index < range.samples; index++) {
    // 端点加权而非 to-from，避免有限但相反符号的极大端点相减溢出。
    const t = index / (range.samples - 1)
    const x = index === 0 ? range.from : index === range.samples - 1 ? range.to : range.from * (1 - t) + range.to * t
    if (!Number.isFinite(x)) continue
    const scope = evaluateScope(part, compiled, values, { id: range.id, value: x })
    compiled.series.forEach((series, seriesIndex) => {
      const y = series.id ? scope.get(series.id) : series.compiled?.evaluate(scope)
      if (y !== undefined && Number.isFinite(y)) {
        seriesData[seriesIndex].push([x, y])
      } else if (part.plot?.kind === 'line') {
        // line 保留空值缺口，connectNulls:false 防止跨奇点/定义域间断误连线。
        seriesData[seriesIndex].push([x, null])
      }
    })
  }
  return {
    animation: false,
    color: ['#555555', '#777777', '#999999', '#B5B5B5'],
    grid: { left: 16, right: 20, top: 28, bottom: 20, containLabel: true },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'value', name: part.plot.xLabel ?? range.id },
    yAxis: { type: 'value', name: part.plot.yLabel ?? '' },
    series: part.plot.series.map((series, index) => ({
      name: series.label,
      type: part.plot?.kind ?? 'line',
      data: seriesData[index],
      showSymbol: part.plot?.kind === 'scatter',
      symbolSize: 5,
      connectNulls: false,
      lineStyle: { width: 1.5 }
    }))
  }
}

function InteractiveFallback({ part, reason }: { part: unknown; reason: string }): React.JSX.Element {
  const raw = part != null && typeof part === 'object' ? (part as Record<string, unknown>) : {}
  const rawTitle = typeof raw.title === 'string' && raw.title ? raw.title : '交互讲解'
  const title = rawTitle.slice(0, 80)
  const expressions = Array.isArray(raw.expressions) ? raw.expressions : []
  const plot = raw.plot != null && typeof raw.plot === 'object' ? (raw.plot as Record<string, unknown>) : {}
  const series = Array.isArray(plot.series) ? plot.series : []
  const formulaOf = (value: unknown): string | null => {
    if (value == null || typeof value !== 'object') return null
    const expr = (value as Record<string, unknown>).expr
    return typeof expr === 'string' ? expr : null
  }
  const expressionFormulas = expressions.slice(0, 8).map(formulaOf)
  const seriesFormulas = series.slice(0, 4).map(formulaOf)
  const formulas = [...expressionFormulas, ...seriesFormulas]
  const truncated = expressions.length > 8 || series.length > 4 ||
    [...expressionFormulas, ...seriesFormulas].some((expr) => expr !== null && expr.length > 300) || rawTitle.length > 80
  const sourceNote = typeof raw.sourceNote === 'string' ? raw.sourceNote.slice(0, 600) : null
  return (
    <section className="gt-part-interactive" data-testid="interactive-invalid">
      <div className="gt-interactive-title">{title}</div>
      <div className="gt-part-fallback">
        <span className="gt-fallback-tag">交互讲解暂不可用</span>
        <span className="gt-fallback-reason">{reason}</span>
      </div>
      <div className="gt-interactive-formulas">
        {formulas.map((expr, index) => expr !== null ? <code key={index}>{expr.slice(0, 300)}</code> : null)}
      </div>
      {truncated ? <div className="gt-interactive-source">公式过多或过长，已省略超出部分。</div> : null}
      {sourceNote ? <div className="gt-interactive-source">出处：{sourceNote}</div> : null}
    </section>
  )
}

class InteractiveChartBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="gt-part-fallback" data-testid="interactive-chart-invalid">
          <span className="gt-fallback-tag">图表暂不可用</span>
          <span className="gt-fallback-reason">公式读数仍可参考</span>
        </div>
      )
    }
    return this.props.children
  }
}

function ParamControl({
  param,
  value,
  inputId,
  onChange
}: {
  param: InteractiveParam
  value: number
  inputId: string
  onChange: (value: number) => void
}): React.JSX.Element {
  const valueText = `${formatInteractiveValue(value)}${param.unit ? ` ${param.unit}` : ''}`
  const label = (
    <>
      <span>{param.label}</span>
      <output data-testid={`interactive-param-${param.id}-value`}>{valueText}</output>
    </>
  )
  if (param.control === 'toggle') {
    return (
      <label className="gt-interactive-control gt-interactive-toggle" htmlFor={inputId}>
        {label}
        <input
          id={inputId}
          data-testid={`interactive-param-${param.id}`}
          type="checkbox"
          role="switch"
          checked={value === 1}
          onChange={(event) => onChange(event.currentTarget.checked ? 1 : 0)}
        />
      </label>
    )
  }
  return (
    <div className="gt-interactive-control">
      <label htmlFor={inputId}>{label}</label>
      {param.control === 'select' ? (
        <select
          id={inputId}
          data-testid={`interactive-param-${param.id}`}
          value={String(value)}
          onChange={(event) => onChange(Number(event.currentTarget.value))}
        >
          {(param.options ?? []).map((option) => (
            <option key={String(option.value)} value={String(option.value)}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={inputId}
          data-testid={`interactive-param-${param.id}`}
          type={param.control === 'slider' ? 'range' : 'number'}
          min={param.min}
          max={param.max}
          step={param.step}
          value={value}
          onChange={(event) => {
            const next = Number(event.currentTarget.value)
            if (Number.isFinite(next)) onChange(clamp(next, param.min ?? next, param.max ?? next))
          }}
        />
      )}
    </div>
  )
}

function ValidInteractiveBlock({ part }: { part: InteractivePart }): React.JSX.Element {
  const reactId = useId()
  const [values, setValues] = useState<InteractiveValues>(() =>
    Object.fromEntries(part.params.map((param) => [param.id, param.default]))
  )
  const compiledResult = useMemo(() => {
    try {
      return { ok: true as const, compiled: compileInteractive(part) }
    } catch (error) {
      return { ok: false as const, reason: error instanceof Error ? error.message : '表达式无效' }
    }
  }, [part])
  const calculated = useMemo(() => {
    if (!compiledResult.ok) return { error: compiledResult.reason }
    try {
      const scope = evaluateScope(part, compiledResult.compiled, values)
      const option = buildPlotOption(part, compiledResult.compiled, values)
      return { scope, option }
    } catch (error) {
      return { error: error instanceof Error ? error.message : '表达式计算失败' }
    }
  }, [compiledResult, part, values])

  if ('error' in calculated) return <InteractiveFallback part={part} reason={calculated.error ?? '表达式计算失败'} />
  const chartPart: ChartPart | null = calculated.option
    ? {
        type: 'data-chart',
        id: part.id,
        status: part.status,
        title: '参数变化曲线',
        option: calculated.option,
        dataSource: part.sourceNote
      }
    : null

  return (
    <section className="gt-part-interactive" data-testid="part-interactive">
      <div className="gt-interactive-title">{part.title}</div>
      <div className="gt-interactive-controls">
        {part.params.map((param) => (
          <ParamControl
            key={param.id}
            param={param}
            inputId={`${reactId}-${param.id}`}
            value={values[param.id] ?? param.default}
            onChange={(value) => setValues((current) => ({ ...current, [param.id]: value }))}
          />
        ))}
      </div>
      <div className="gt-interactive-readouts">
        {part.expressions.map((expression) => (
          <div className="gt-interactive-readout" key={expression.id} data-testid={`interactive-readout-${expression.id}`}>
            <div className="gt-interactive-value-line">
              <span>{expression.label}</span>
              <span className="gt-interactive-equals">=</span>
              <strong data-testid={`interactive-value-${expression.id}`}>
                {formatInteractiveValue(scopeValue(calculated.scope, expression.id), expression)}
              </strong>
              {expression.unit ? <span>{expression.unit}</span> : null}
            </div>
            <code>{expression.expr}</code>
          </div>
        ))}
      </div>
      {chartPart && calculated.option ? (
        <div className="gt-interactive-chart" data-testid="interactive-chart">
          <InteractiveChartBoundary key={JSON.stringify(calculated.option)}>
            <ChartBlock part={chartPart} />
          </InteractiveChartBoundary>
        </div>
      ) : null}
      {part.caption ? <p className="gt-interactive-caption">{part.caption}</p> : null}
      {!chartPart ? <div className="gt-interactive-source">出处：{part.sourceNote}</div> : null}
    </section>
  )
}

function scopeValue(scope: Map<string, number>, id: string): number {
  return scope.get(id) ?? Number.NaN
}

/** D211：结构化交互讲解。无效规格也只在局部降级，不影响详情页其它 part。 */
export function InteractiveBlock({ part }: { part: InteractivePart }): React.JSX.Element {
  const parsed = InteractivePartSchema.safeParse(part)
  if (!parsed.success) return <InteractiveFallback part={part} reason="交互规格或表达式未通过校验" />
  return <ValidInteractiveBlock key={JSON.stringify(parsed.data.params)} part={parsed.data} />
}
