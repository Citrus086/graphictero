import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { USAGE_CATEGORIES, type BalanceView, type RecentUsageCall, type UsageCategory, type UsagePeriodView, type UsageSeriesView, type UsageSessionRow, type UsageSummaryView } from '../../../../shared/ipc'
import { beijingClock, formatCallTime } from '../../lib/format'
import { useNotify } from '../../lib/notify'
import { UsageChart } from './UsageChartView'
import {
  aggMetricValue,
  buildUsageChartOption,
  buildUsageDonutOption,
  formatCny,
  formatTokenExact,
  readUsagePalette,
  sortUsageRows,
  sameUsageSeries,
  sameUsageSessions,
  sameUsageSummary,
  sortUsageSessionRows,
  USAGE_CATEGORY_LABELS,
  usageRangeIsEmpty,
  usageSubtotals,
  type UsageMetric,
  type UsageSortKey,
  type UsageTokenKind
} from './usageChart'
import { usageSourceColor } from '../../../../shared/usageMeta'
import './usage.css'

const api = window.graphictero

function monthLabel(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
function shiftMonth(label: string, delta: number): string {
  const [y, m] = label.split('-').map(Number)
  return monthLabel(new Date(y, m - 1 + delta, 1))
}

function barPct(value: number, max: number): string {
  if (max <= 0) return '0%'
  return `${Math.min(100, Math.round((value / max) * 100))}%`
}

export function UsageSection(): React.JSX.Element {
  const notify = useNotify()
  const [range, setRange] = useState<'7d' | '30d' | 'month' | 'all'>('month')
  const [month, setMonth] = useState(monthLabel())
  const [summary, setSummary] = useState<UsageSummaryView | null>(null)
  const [series, setSeries] = useState<UsageSeriesView | null>(null)
  const [sessions, setSessions] = useState<UsageSessionRow[] | null>(null)
  const [sessionsExpanded, setSessionsExpanded] = useState(false)
  const [metric, setMetric] = useState<UsageMetric>('cost')
  const [tokenKind, setTokenKind] = useState<UsageTokenKind>('all')
  const [filter, setFilter] = useState<UsageCategory | null>(null)
  const [sort, setSort] = useState<{ key: UsageSortKey; direction: 'asc' | 'desc' }>({ key: 'costCny', direction: 'desc' })
  const [balance, setBalance] = useState<BalanceView | null>(null)
  const [balanceBusy, setBalanceBusy] = useState(false)
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [period, setPeriod] = useState<UsagePeriodView | null>(null)
  const [recent, setRecent] = useState<RecentUsageCall[] | null>(null)
  const seq = useRef(0)
  const donutPanelRef = useRef<HTMLDivElement>(null)
  const [donutWidth, setDonutWidth] = useState<number | undefined>(undefined)
  const [palette, setPalette] = useState(() => readUsagePalette())

  useEffect(() => {
    const apply = (): void => setPalette(readUsagePalette())
    const obs = new MutationObserver(apply)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])

  useEffect(() => {
    const el = donutPanelRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width != null && width > 0) setDonutWidth(Math.round(width))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const load = useCallback(async () => {
    const request = ++seq.current
    try {
      const seriesInput = { range, month: range === 'month' ? month : undefined }
      const filtered = { ...seriesInput, category: filter ?? undefined }
      const [nextSeries, nextSummary, nextSessions, nextPeriod, nextRecent] = await Promise.all([
        api.getUsageSeries(seriesInput),
        api.getUsageSummary(month), // 保留原月汇总 IPC：earliestMonth 与月度对账
        // D193：来源过滤下推到同一套 SQL；¥ / Token 排序在渲染时跟随当前度量。
        api.getUsageBySession(filtered),
        api.getUsageByPeriod(filtered),
        // 最近调用只跟随来源，不跟随时间范围。
        api.getRecentUsage({ category: filter ?? undefined })
      ])
      if (request !== seq.current) return
      // uat7b M2：轮询结果与当前完全一致时不 setState（不 setOption、tooltip 不闪、
      // 图例隐藏不被复原）；数据真变了照常更新（D96-② 实时刷新保留）。
      setSeries((prev) => (sameUsageSeries(prev, nextSeries) ? prev : nextSeries))
      // uat7b-fix1 S-d：摘要未变也跳过 setSummary（与 series 同口径的「不 setState」）。
      setSummary((prev) => (sameUsageSummary(prev, nextSummary) ? prev : nextSummary))
      setSessions((prev) => (sameUsageSessions(prev, nextSessions) ? prev : nextSessions))
      setPeriod(nextPeriod)
      setRecent(nextRecent)
    } catch {
      notify('读取用量失败')
    }
  }, [range, month, filter, notify])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 3000) // D96-②：打开期间实时刷新，实例不重建
    return () => clearInterval(timer)
  }, [load])

  const queryBalance = useCallback(async () => {
    if (balanceBusy) return
    setBalanceBusy(true)
    try {
      setBalance(await api.getBalance())
    } catch {
      // 无 Key / 离线只保留余额空态，不影响本地用量图表
    } finally {
      setBalanceBusy(false)
    }
  }, [balanceBusy])

  useEffect(() => {
    let live = true
    // 只在已配置 DeepSeek Key 时查一次余额。3 秒轮询的 load() 不碰余额。
    api
      .getLlmSettings()
      .then((s) => {
        if (!live) return
        setHasKey(s.hasApiKey)
        if (s.hasApiKey) void queryBalance()
      })
      .catch(() => {
        if (live) setHasKey(false)
      })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const changeMonth = (delta: number): void => {
    const next = shiftMonth(month, delta)
    if (next > monthLabel()) return
    if (summary?.earliestMonth && next < summary.earliestMonth) return
    setMonth(next)
  }

  const subtotals = useMemo(() => (series ? usageSubtotals(series.totals, filter) : null), [series, filter])
  const periodMax = Math.max(period?.peakCny ?? 0, period?.offPeakCny ?? 0)
  const chartOption = useMemo(
    () => series ? buildUsageChartOption(series, { metric, tokenKind, filter, palette }) : null,
    [series, metric, tokenKind, filter, palette]
  )
  const donutOption = useMemo(
    () => series ? buildUsageDonutOption(series, { metric, tokenKind, filter, palette, width: donutWidth }) : null,
    [series, metric, tokenKind, filter, palette, donutWidth]
  )
  const sortedRows = useMemo(() => (series ? sortUsageRows(series.totals, sort) : []), [series, sort])
  const sortedSessions = useMemo(
    () => (sessions ? sortUsageSessionRows(sessions, metric, tokenKind) : []),
    [sessions, metric, tokenKind]
  )
  const visibleSessions = sessionsExpanded ? sortedSessions : sortedSessions.slice(0, 10)
  // uat10 评审建议 3：同图谱同名同分钟的会话行灰字会一样——撞车的加「 · #id」区分
  const sessionDupKeys = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of sortedSessions) {
      if (r.kind !== 'session') continue
      const k = `${r.graphName ?? ''}|${formatCallTime(r.lastUsedAt)}`
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    const keys = new Set<string>()
    for (const [k, n] of counts) if (n > 1) keys.add(k)
    return keys
  }, [sortedSessions])
  const visibleRows = filter ? sortedRows.filter((c) => c === filter) : sortedRows
  const totalForBars = subtotals?.total.costCny ?? 0

  const toggleFilter = useCallback((category: UsageCategory) => {
    setSessionsExpanded(false)
    setFilter((current) => current === category ? null : category)
  }, [])
  const selectDonut = useCallback((name: string) => {
    const category = USAGE_CATEGORIES.find((c) => USAGE_CATEGORY_LABELS[c] === name)
    if (category) toggleFilter(category)
  }, [toggleFilter])
  const sortBy = (key: UsageSortKey): void => {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: key === 'category' ? 'asc' : 'desc' })
  }
  const ariaSort = (key: UsageSortKey): 'ascending' | 'descending' | 'none' =>
    sort.key !== key ? 'none' : sort.direction === 'asc' ? 'ascending' : 'descending'
  const sortMark = (key: UsageSortKey): string => sort.key !== key ? '' : sort.direction === 'asc' ? ' ▲' : ' ▼'

  const header = (label: string, key: UsageSortKey): React.JSX.Element => (
    <button type="button" className="gt-usage-th" onClick={() => sortBy(key)}>{label}{sortMark(key)}</button>
  )

  return (
    <section
      className="gt-usage"
      data-testid="usage-section"
      onKeyDown={(e) => {
        const t = e.target as HTMLElement
        if (e.key === 'Escape' && filter && !t.matches('input,textarea,[contenteditable="true"]')) {
          e.preventDefault()
          e.stopPropagation()
          setSessionsExpanded(false)
          setFilter(null)
        }
      }}
    >
      <div className="gt-usage-toolbar">
        <div className="gt-usage-segments" aria-label="时间范围">
          {([['7d', '7 天'], ['30d', '30 天'], ['month', '本月'], ['all', '全部']] as const).map(([value, label]) => (
            <button key={value} type="button" data-testid={`usage-range-${value}`} className={range === value ? 'on' : ''} onClick={() => { setSessionsExpanded(false); setRange(value) }}>{label}</button>
          ))}
        </div>
        {range === 'month' && (
          <div className="gt-usage-month">
            <button className="btn bordered" disabled={summary?.earliestMonth == null || month <= summary.earliestMonth} onClick={() => changeMonth(-1)}>‹</button>
            <span>{month}</span>
            <button className="btn bordered" disabled={month >= monthLabel()} onClick={() => changeMonth(1)}>›</button>
          </div>
        )}
        <div className="gt-usage-segments" aria-label="指标">
          <button type="button" data-testid="usage-metric-cost" className={metric === 'cost' ? 'on' : ''} onClick={() => setMetric('cost')}>费用 ¥</button>
          <button type="button" data-testid="usage-metric-tokens" className={metric === 'tokens' ? 'on' : ''} onClick={() => setMetric('tokens')}>Token</button>
        </div>
        {metric === 'tokens' && (
          <div className="gt-usage-segments sm" aria-label="Token 类型">
            {([['all', '全部'], ['input', '输入'], ['output', '输出'], ['reasoning', '推理']] as const).map(([value, label]) => (
              <button key={value} type="button" data-testid={`usage-token-${value}`} className={tokenKind === value ? 'on' : ''} onClick={() => setTokenKind(value)}>{label}</button>
            ))}
          </div>
        )}
      </div>

      {filter && (
        <div className="gt-usage-filter" data-testid="usage-filter-chip">
          {/* D186：chip 小色块与图表系列同色（来源 → 颜色共享映射） */}
          <i className="gt-usage-swatch" style={{ background: usageSourceColor(filter) }} />
          来源：{USAGE_CATEGORY_LABELS[filter]}
          <button type="button" data-testid="usage-filter-clear" title="清除来源过滤" onClick={() => { setSessionsExpanded(false); setFilter(null) }}>×</button>
        </div>
      )}

      <div className="gt-usage-cards">
        <div className="gt-usage-card" data-testid="usage-subtotal-chat">
          <span>对话</span><b>{formatCny(subtotals?.chat.costCny ?? 0)}</b>
          <small>{formatTokenExact((subtotals?.chat.inputTokens ?? 0) + (subtotals?.chat.outputTokens ?? 0))} Token · {subtotals?.chat.calls ?? 0} 次</small>
        </div>
        <div className="gt-usage-card" data-testid="usage-subtotal-background">
          <span>后台</span><b>{formatCny(subtotals?.background.costCny ?? 0)}</b>
          <small>{formatTokenExact((subtotals?.background.inputTokens ?? 0) + (subtotals?.background.outputTokens ?? 0))} Token · {subtotals?.background.calls ?? 0} 次</small>
        </div>
        <div className="gt-usage-card total" data-testid="usage-total">
          <span>合计</span><b>{formatCny(subtotals?.total.costCny ?? 0)}</b>
          <small>
            输入 {formatTokenExact(subtotals?.total.inputTokens ?? 0)} · 输出 {formatTokenExact(subtotals?.total.outputTokens ?? 0)} · 推理 {subtotals?.total.reasoningTokens == null ? '—' : formatTokenExact(subtotals.total.reasoningTokens)} · {subtotals?.total.calls ?? 0} 次
          </small>
        </div>
      </div>

      <div className="gt-usage-chartgrid">
        <div className="gt-usage-panel">
          <div className="ghead">时间序列 · 按来源堆叠</div>
          {chartOption && <UsageChart option={chartOption} testId="usage-timeseries" />}
          {series && usageRangeIsEmpty(series) && <div className="gt-usage-empty">这段时间还没有用量</div>}
        </div>
        <div className="gt-usage-panel" ref={donutPanelRef}>
          <div className="ghead">按来源分布 · 点击过滤</div>
          {donutOption && <UsageChart option={donutOption} testId="usage-donut" onSelect={selectDonut} />}
        </div>
      </div>

      <div className="ghead" style={{ marginTop: 18 }}>按来源</div>
      <div className="gt-usage-tablewrap">
        <table className="gt-usage-table" data-testid="usage-table">
          <thead>
            <tr>
              <th aria-sort={ariaSort('category')}>{header('来源', 'category')}</th>
              <th aria-sort={ariaSort('calls')}>{header('调用次数', 'calls')}</th>
              <th aria-sort={ariaSort('costCny')}>{header('费用 ¥', 'costCny')}</th>
              <th aria-sort={ariaSort('inputTokens')}>{header('输入', 'inputTokens')}</th>
              <th aria-sort={ariaSort('cacheHitTokens')}>{header('其中缓存命中', 'cacheHitTokens')}</th>
              <th aria-sort={ariaSort('outputTokens')}>{header('输出', 'outputTokens')}</th>
              <th aria-sort={ariaSort('reasoningTokens')} title="早期记录未单独记录推理 token">{header('其中推理', 'reasoningTokens')}</th>
            </tr>
          </thead>
          <tbody>
            {series && visibleRows.map((category) => {
              const agg = series.totals[category]
              const pct = totalForBars > 0 ? Math.round((agg.costCny / totalForBars) * 100) : 0
              return (
                <tr key={category} data-testid={`usage-row-${category}`} className={filter === category ? 'selected' : ''} onClick={() => toggleFilter(category)}>
                  <td>
                    {/* D186：表格来源行小色块与图表系列同色 */}
                    <i className="gt-usage-swatch" style={{ background: usageSourceColor(category) }} />
                    {USAGE_CATEGORY_LABELS[category]}
                    <div className="gt-usage-sourcebar"><i style={{ width: `${pct}%` }} /></div>
                  </td>
                  <td>{agg.calls}</td>
                  <td>{formatCny(agg.costCny)}</td>
                  <td>{formatTokenExact(agg.inputTokens)}<small>未命中 {formatTokenExact(agg.cacheMissTokens)}</small></td>
                  <td>{formatTokenExact(agg.cacheHitTokens)}</td>
                  <td>{formatTokenExact(agg.outputTokens)}</td>
                  <td>{!series.reasoningKnown || agg.reasoningTokens == null ? '—' : formatTokenExact(agg.reasoningTokens)}</td>
                </tr>
              )
            })}
            {series && (
              <tr className="gt-usage-sum" data-testid="usage-table-total">
                <td>合计</td>
                <td>{subtotals?.total.calls ?? 0}</td>
                <td>{formatCny(subtotals?.total.costCny ?? 0)}</td>
                <td>{formatTokenExact(subtotals?.total.inputTokens ?? 0)}</td>
                <td>{formatTokenExact(subtotals?.total.cacheHitTokens ?? 0)}</td>
                <td>{formatTokenExact(subtotals?.total.outputTokens ?? 0)}</td>
                <td>{subtotals?.total.reasoningTokens == null ? '—' : formatTokenExact(subtotals.total.reasoningTokens)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="ghead" style={{ marginTop: 18 }}>按会话</div>
      <div data-testid="usage-by-session">
        {sessions && sortedSessions.length === 0 && (
          <div className="gt-usage-empty gt-usage-session-empty">这段时间还没有用量</div>
        )}
        {sessions && sortedSessions.length > 0 && (
          <div className="gt-usage-tablewrap">
            <table className="gt-usage-table gt-usage-sessions">
              <thead>
                <tr>
                  <th>会话</th>
                  <th>费用 ¥</th>
                  <th>调用次数</th>
                  <th>Token</th>
                </tr>
              </thead>
              <tbody>
                {visibleSessions.map((row) => (
                  <tr
                    key={row.kind === 'background' ? 'background' : `${row.kind}-${row.sessionId}`}
                    data-testid="usage-session-row"
                    data-kind={row.kind}
                    className={row.kind === 'background' ? 'is-background' : undefined}
                  >
                    <td title={row.title}>
                      {row.title}
                      {row.kind === 'session' && (
                        <small className="gt-usage-session-graph">
                          {/* uat10：无图谱名时只显示时间；撞车（同图谱同分钟）加短 id */}
                          {sessionContext(row, sessionDupKeys)}
                        </small>
                      )}
                    </td>
                    <td>{formatCny(row.costCny)}</td>
                    <td>{row.calls}</td>
                    <td>{formatTokenExact(row.inputTokens + row.outputTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {sortedSessions.length > 10 && (
          <button
            type="button"
            className="btn bordered gt-usage-session-more"
            data-testid="usage-session-more"
            onClick={() => setSessionsExpanded((open) => !open)}
          >
            {sessionsExpanded ? '收起' : `显示全部（${sortedSessions.length}）`}
          </button>
        )}
      </div>

      <div className="ghead" style={{ marginTop: 22 }}>按时段</div>
      <div className="group" data-testid="usage-by-period">
        <div className="grow-r" style={{ minHeight: 46, padding: '6px 16px' }}>
          <div className="k">
            高峰时段
            <div className="t3" style={{ fontSize: 11, fontWeight: 400 }}>北京时间 9–12 点、14–18 点</div>
          </div>
          <div className="v">
            <span className="ubar"><i style={{ width: barPct(period?.peakCny ?? 0, periodMax) }} /></span>
            <span className="num">{formatCny(period?.peakCny ?? 0)}</span>
          </div>
        </div>
        <div className="grow-r" style={{ minHeight: 46, padding: '6px 16px' }}>
          <div className="k">
            空闲时段
            <div className="t3" style={{ fontSize: 11, fontWeight: 400 }}>其余时间 · 单价为高峰的一半</div>
          </div>
          <div className="v">
            <span className="ubar"><i style={{ width: barPct(period?.offPeakCny ?? 0, periodMax) }} /></span>
            <span className="num">{formatCny(period?.offPeakCny ?? 0)}</span>
          </div>
        </div>
      </div>
      <div className="note" data-testid="usage-period-note">
        按请求发生的时间计价。现在是 {period?.nowPeak ? '高峰' : '空闲'}时段（北京时间 {beijingClock()}）。
      </div>

      <div className="ghead" style={{ marginTop: 22 }}>最近调用</div>
      <div className="group" data-testid="usage-recent">
        {recent == null ? (
          <div className="grow-r" style={{ minHeight: 36, padding: '6px 16px' }}><div className="k">…</div></div>
        ) : recent.length === 0 ? (
          <div className="gt-usage-empty">还没有调用记录</div>
        ) : (
          recent.map((row, i) => (
            <div className="grow-r" style={{ minHeight: 36, padding: '6px 16px' }} key={`${row.occurredAt}-${i}`} data-testid="usage-recent-row">
              <div className="k" style={{ fontWeight: 400, width: 'auto' }}>
                <span className="t3" style={{ display: 'inline-block', width: 128 }}>{formatCallTime(row.occurredAt)}</span>
                {USAGE_CATEGORY_LABELS[row.category as UsageCategory] ?? row.category}
              </div>
              <div className="v">
                <span className={`ptag ${row.peak ? 'pk' : ''}`}>{row.peak ? '高峰' : '空闲'}</span>
                <span className="num">{formatCny(row.costCny)}</span>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="ghead" style={{ marginTop: 22 }}>DeepSeek 账户</div>
      <div className="group">
        <div className="grow-r" style={{ minHeight: 42, padding: '6px 16px' }}>
          <div className="k">总余额</div>
          <div className="v">
            <span>{hasKey === false ? '未配置 API Key' : balance ? formatCny(balance.total) : '—'}</span>
            <button className="btn bordered" data-testid="balance-refresh" disabled={balanceBusy || hasKey === false} onClick={() => void queryBalance()}>{balanceBusy ? '查询中…' : '刷新'}</button>
          </div>
        </div>
        <div className="grow-r" style={{ minHeight: 36, padding: '6px 16px' }}>
          <div className="k">赠送余额</div><div className="v t3">{balance?.granted != null ? formatCny(balance.granted) : '—'}</div>
        </div>
        <div className="grow-r" style={{ minHeight: 36, padding: '6px 16px' }}>
          <div className="k">充值余额</div><div className="v t3">{balance?.toppedUp != null ? formatCny(balance.toppedUp) : '—'}</div>
        </div>
        {balance && (
          <div className="grow-r" style={{ minHeight: 30, padding: '4px 16px' }}>
            <div className="k" style={{ fontSize: 11.5, color: 'var(--text2)' }}>
              更新于 {new Date(balance.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}
            </div><div className="v" />
          </div>
        )}
      </div>
      <div className="note">
        费用按 API 返回的 usage 在本地换算（人民币）：高峰为北京时间 9–12 点、14–18 点，空闲时段半价。推理 token 是输出 token 的子集，只展示、不另计费；早期记录未单独记录时显示「—」。不设读取上限，不做大调用提醒。
      </div>
    </section>
  )
}

/** uat10 评审建议 3：按会话行的灰字区分串——有图谱名「图谱名 · 时间」，无图谱名只显示时间；同图谱同分钟撞车加短 id。 */
function sessionContext(row: UsageSessionRow, dupKeys: Set<string>): string {
  const time = formatCallTime(row.lastUsedAt)
  const base = row.graphName ? `${row.graphName} · ${time}` : time
  if (!base) return ''
  return dupKeys.has(`${row.graphName ?? ''}|${time}`) ? `${base} · #${row.sessionId ?? ''}` : base
}
