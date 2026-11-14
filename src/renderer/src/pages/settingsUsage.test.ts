// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement as h } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { USAGE_CATEGORIES, type BalanceView, type UsageSeriesView, type UsageSummaryView } from '../../../shared/ipc'

vi.mock('../components/richtext/echartsSetup', () => ({
  initChart: () => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn(), on: vi.fn(), off: vi.fn() })
}))

let formatCny: (n: number) => string
let SettingsPage: typeof import('./SettingsPage').SettingsPage
let normalizeSettingsSection: typeof import('./SettingsPage').normalizeSettingsSection
let getUsageSummary: Mock
let getUsageSeries: Mock
let getBalance: Mock
let getLlmSettings: Mock
let getUsageByPeriod: Mock
let getRecentUsage: Mock
let getLastSnapshot: Mock
let getZoteroDisplay: Mock
let getTheme: Mock
let setTheme: Mock
let zoteroUp = false

beforeAll(async () => {
  getUsageSummary = vi.fn(async (month?: string) => usageFor(month ?? '2026-10'))
  getUsageSeries = vi.fn(async () => seriesFor())
  getBalance = vi.fn(async () => BALANCE)
  getLlmSettings = vi.fn(async () => ({ provider: 'deepseek', model: 'deepseek-flash', hasApiKey: true, keyTail: 'abcd' }))
  getUsageByPeriod = vi.fn(async () => ({ peakCny: 2, offPeakCny: 1, nowPeak: false }))
  getRecentUsage = vi.fn(async () => [])
  getLastSnapshot = vi.fn(async () => ({ at: null }))
  getZoteroDisplay = vi.fn(async () => ({
    apiUp: zoteroUp,
    endpoint: 'localhost:23119',
    sqliteFallback: true,
    dataDir: '/Users/me/Zotero'
  }))
  getTheme = vi.fn(async () => ({ pref: 'system', resolved: 'light' as const }))
  setTheme = vi.fn(async (pref: string) => ({
    pref,
    resolved: pref === 'dark' ? 'dark' : 'light'
  }))
  ;(window as unknown as { graphictero: unknown }).graphictero = {
    getDataInfo: vi.fn(async () => ({
      dataDir: '/Users/me/Library/Application Support/Graphictero',
      homeDir: '/Users/me'
    })),
    getAppVersion: vi.fn(async () => '9.9.9'),
    getLlmSettings: (...args: unknown[]) => getLlmSettings(...args),
    setLlmSettings: vi.fn(async () => {}),
    setApiKey: vi.fn(async () => {}),
    clearApiKey: vi.fn(async () => {}),
    testLlmConnection: vi.fn(async () => ({ ok: true, message: '可用' })),
    getUsageSummary: (...args: unknown[]) => getUsageSummary(...args),
    getUsageSeries: (...args: unknown[]) => getUsageSeries(...args),
    getUsageBySession: async () => [],
    getUsageByPeriod: (...args: unknown[]) => getUsageByPeriod(...args),
    getRecentUsage: (...args: unknown[]) => getRecentUsage(...args),
    getBalance: (...args: unknown[]) => getBalance(...args),
    getLastSnapshot: (...args: unknown[]) => getLastSnapshot(...args),
    getZoteroDisplay: (...args: unknown[]) => getZoteroDisplay(...args),
    getOpenAlexKey: vi.fn(async () => ({ configured: false, tail: null })),
    setOpenAlexKey: vi.fn(async () => {}),
    clearOpenAlexKey: vi.fn(async () => {}),
    testOpenAlex: vi.fn(async () => ({ ok: true, message: '可用' })),
    getTheme: (...args: unknown[]) => getTheme(...args),
    setTheme: (...args: unknown[]) => setTheme(...args)
  }
  const mod = await import('./SettingsPage')
  formatCny = mod.formatCny
  SettingsPage = mod.SettingsPage
  normalizeSettingsSection = mod.normalizeSettingsSection
})
afterAll(() => { delete (window as unknown as { graphictero?: unknown }).graphictero })
beforeEach(() => {
  zoteroUp = false
  delete document.documentElement.dataset.theme
  getUsageSummary.mockClear()
  getUsageSeries.mockClear()
  getBalance.mockClear()
  getLlmSettings.mockClear()
  getUsageByPeriod.mockClear()
  getRecentUsage.mockClear()
  getLastSnapshot.mockClear()
  getZoteroDisplay.mockClear()
  getTheme.mockClear()
  setTheme.mockClear()
  getBalance.mockResolvedValue(BALANCE)
  getLlmSettings.mockResolvedValue({ provider: 'deepseek', model: 'deepseek-flash', hasApiKey: true, keyTail: 'abcd' })
  getUsageByPeriod.mockResolvedValue({ peakCny: 2, offPeakCny: 1, nowPeak: false })
  getRecentUsage.mockResolvedValue([])
  getLastSnapshot.mockResolvedValue({ at: null })
  getUsageSummary.mockImplementation(async (month?: string) => usageFor(month ?? '2026-10'))
  getUsageSeries.mockImplementation(async () => seriesFor())
})
afterEach(cleanup)

const BALANCE: BalanceView = { total: 12.34, granted: 2.5, toppedUp: 9.84, currency: 'CNY', at: '2026-10-27T10:20:30.000Z' }
function usageFor(month: string): UsageSummaryView {
  return {
    month, earliestMonth: '2026-08', totalCny: 1.234,
    byCategory: [
      { category: 'chat', costCny: 1.229, calls: 3 },
      { category: 'web', costCny: 0.005, calls: 1 },
      { category: 'overview', costCny: 0, calls: 0 }
    ]
  }
}
function seriesFor(): UsageSeriesView {
  const totals = Object.fromEntries(USAGE_CATEGORIES.map((category) => [category, {
    costCny: category === 'chat' ? 1.229 : category === 'web' ? 0.005 : 0,
    calls: category === 'chat' ? 3 : category === 'web' ? 1 : 0,
    inputTokens: category === 'chat' ? 1000 : 0,
    cacheHitTokens: category === 'chat' ? 400 : 0,
    cacheMissTokens: category === 'chat' ? 600 : 0,
    outputTokens: category === 'chat' ? 500 : 0,
    reasoningTokens: category === 'chat' ? 200 : null
  }])) as UsageSeriesView['totals']
  return { days: [], totals, reasoningKnown: true }
}

describe('formatCny（两位小数 / <¥0.01 / ¥0.00）', () => {
  it.each([[0, '¥0.00'], [0.005, '<¥0.01'], [0.01, '¥0.01'], [1.234, '¥1.23'], [1234.5, '¥1234.50']])('formatCny(%j) = %j', (n, expected) => {
    expect(formatCny(n)).toBe(expected)
  })
})

describe('SettingsPage 用量与费用（D178/D180）', () => {
  it('进入用量组自动查一次余额，三行显示并带更新时间', async () => {
    render(h(SettingsPage, { onBack: () => {}, initialSection: 'usage' }))
    await waitFor(() => expect(getBalance).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('¥12.34')).toBeTruthy()
    expect(screen.getByText('¥2.50')).toBeTruthy()
    expect(screen.getByText('¥9.84')).toBeTruthy()
    expect(screen.getByText(/更新于/)).toBeTruthy()
    expect(screen.queryByText(/CNY/)).toBeNull()
  })

  it('赠送/充值缺字段显示「—」，总余额照常；按钮可再查', async () => {
    getBalance.mockResolvedValue({ ...BALANCE, granted: null, toppedUp: null })
    render(h(SettingsPage, { onBack: () => {}, initialSection: 'usage' }))
    expect(await screen.findByText('¥12.34')).toBeTruthy()
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2)
    fireEvent.click(screen.getByTestId('balance-refresh'))
    await waitFor(() => expect(getBalance).toHaveBeenCalledTimes(2))
  })

  it('未配置 API Key 时不查余额', async () => {
    getLlmSettings.mockResolvedValue({ provider: 'deepseek', model: 'deepseek-flash', hasApiKey: false, keyTail: null })
    render(h(SettingsPage, { onBack: () => {}, initialSection: 'usage' }))
    expect(await screen.findByText('未配置 API Key')).toBeTruthy()
    expect((screen.getByTestId('balance-refresh') as HTMLButtonElement).disabled).toBe(true)
    expect(getBalance).not.toHaveBeenCalled()
  })

  it('进入用量后表格出现，3 秒轮询不再查余额', async () => {
    render(h(SettingsPage, { onBack: () => {}, initialSection: 'usage' }))
    await waitFor(() => expect(getBalance).toHaveBeenCalledTimes(1))
    await screen.findByTestId('usage-table')
    await screen.findByTestId('usage-by-period')
    expect(screen.getByTestId('usage-by-period').textContent).toContain('高峰时段')
    expect(screen.getByTestId('usage-by-period').textContent).toContain('¥2.00')
    expect(screen.getByTestId('usage-recent').textContent).toContain('还没有调用记录')
    expect(screen.getByTestId('usage-period-note').textContent).toMatch(/空闲时段（北京时间 \d{2}:\d{2}）/)
    await new Promise((r) => setTimeout(r, 3200))
    expect(getBalance).toHaveBeenCalledTimes(1)
  })

  it('全部六类含 0 均列出；对话/后台小计与合计一致，token 与推理显示', async () => {
    render(h(SettingsPage, { onBack: () => {}, initialSection: 'usage' }))
    await screen.findByTestId('usage-table')
    for (const c of USAGE_CATEGORIES) expect(screen.getByTestId(`usage-row-${c}`)).toBeTruthy()
    expect(screen.getByTestId('usage-row-chat').textContent).toContain('Agent 对话')
    expect(screen.getByTestId('usage-row-web').textContent).toContain('联网搜索 / 抓取')
    expect(screen.getByTestId('usage-row-web').textContent).toContain('<¥0.01')
    expect(screen.getByTestId('usage-row-overview').textContent).toContain('¥0.00')
    expect(screen.getByTestId('usage-row-chat').textContent).toContain('200')
    expect(screen.getByTestId('usage-subtotal-chat').textContent).toContain('¥1.23')
    expect(screen.getByTestId('usage-subtotal-background').textContent).toContain('¥0.00')
    expect(screen.getByTestId('usage-total').textContent).toContain('¥1.23')
  })

  it('每类来源行带占比条（chat≈100%，web 四舍五入 0）', async () => {
    render(h(SettingsPage, { onBack: () => {}, initialSection: 'usage' }))
    await screen.findByTestId('usage-table')
    const chatBar = screen.getByTestId('usage-row-chat').querySelector('.gt-usage-sourcebar i') as HTMLElement
    const webBar = screen.getByTestId('usage-row-web').querySelector('.gt-usage-sourcebar i') as HTMLElement
    expect(chatBar.style.width).toBe('100%')
    expect(webBar.style.width).toBe('0%')
  })

  it('点击 ‹ 切换上个月并重拉 monthSummary 与 usage:series', async () => {
    const now = new Date()
    const monthOf = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const currentMonth = monthOf(now)
    const previousMonth = monthOf(new Date(now.getFullYear(), now.getMonth() - 1, 1))
    render(h(SettingsPage, { onBack: () => {}, initialSection: 'usage' }))
    await screen.findByTestId('usage-table')
    expect(getUsageSummary).toHaveBeenCalledWith(currentMonth)
    fireEvent.click(screen.getByText('‹'))
    await waitFor(() => expect(getUsageSummary).toHaveBeenCalledWith(previousMonth))
    expect(getUsageSeries).toHaveBeenCalledWith({ range: 'month', month: previousMonth })
  })

  it('七个分组按 D195 排列，用量紧跟语言模型，侧栏没有「通用」', async () => {
    const { container } = render(h(SettingsPage, { onBack: () => {} }))
    await screen.findByTestId('open-usage')
    const labels = Array.from(container.querySelectorAll('.sidebar .sitem')).map((el) => (el.textContent ?? '').trim())
    expect(labels).toEqual(['返回', '语言模型', '用量与费用', '导入来源', 'PDF 来源', 'PDF 解析', '数据与备份', '外观'])
    expect(labels).not.toContain('通用')
    expect(labels.indexOf('用量与费用')).toBe(labels.indexOf('语言模型') + 1)
    expect(container.querySelector('.setmain .h1')?.textContent).toBe('语言模型')
    expect(container.querySelector('.ghead')?.textContent).toBe('DeepSeek')
    expect(screen.getAllByText('服务商').length).toBeGreaterThan(0)
    expect([...container.querySelectorAll('.ghead')].some((el) => (el.textContent ?? '').trim() === '语言模型')).toBe(false)
    expect((await screen.findByTestId('settings-version')).textContent).toContain('9.9.9')
    fireEvent.click(screen.getByTestId('open-usage'))
    expect(await screen.findByTestId('usage-section')).toBeTruthy()
  })

  it('旧深链 gen 与未知值都落到语言模型', () => {
    expect(normalizeSettingsSection('gen')).toBe('llm')
    expect(normalizeSettingsSection(undefined)).toBe('llm')
    expect(normalizeSettingsSection('')).toBe('llm')
    expect(normalizeSettingsSection('nope')).toBe('llm')
    expect(normalizeSettingsSection('usage')).toBe('usage')
    expect(normalizeSettingsSection('appearance')).toBe('appearance')
  })

  it('initialSection=gen 打开语言模型页', async () => {
    render(h(SettingsPage, { onBack: () => {}, initialSection: 'gen' }))
    expect(await screen.findByTestId('open-usage')).toBeTruthy()
    expect(screen.getByTestId('settings-nav-llm').className).toContain('on')
  })

  it('导入来源只展示 Zotero 与 OpenAlex，重新检测再读一次', async () => {
    const { container } = render(h(SettingsPage, { onBack: () => {}, initialSection: 'import' }))
    expect(await screen.findByText('Zotero · 单向导入')).toBeTruthy()
    expect((await screen.findByTestId('zotero-api')).textContent).toContain('不可用')
    expect(screen.getByTestId('zotero-api').textContent).toContain('localhost:23119')
    expect(screen.getByText('读取 zotero.sqlite 的只读副本')).toBeTruthy()
    expect(container.querySelector('[data-testid="import-zotero"]')?.textContent ?? '').not.toContain('更改')
    expect(screen.getByText('OpenAlex API Key')).toBeTruthy()
    expect(screen.getByText(/不会进入备份/)).toBeTruthy()
    const before = getZoteroDisplay.mock.calls.length
    zoteroUp = true
    fireEvent.click(screen.getByTestId('zotero-recheck'))
    await waitFor(() => expect(getZoteroDisplay.mock.calls.length).toBeGreaterThan(before))
    await waitFor(() => expect(screen.getByTestId('zotero-api').textContent).toContain('可用'))
  })

  it('外观页切到深色再切回浅色', async () => {
    render(h(SettingsPage, { onBack: () => {}, initialSection: 'appearance' }))
    expect(await screen.findByText('跟随系统时随 macOS 外观自动切换。')).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId('theme-system').className).toContain('on'))
    fireEvent.click(screen.getByTestId('theme-dark'))
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'))
    fireEvent.click(screen.getByTestId('theme-light'))
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBeNull())
  })

  it('数据与备份 note 与 D175(c) 保持原口径', async () => {
    render(h(SettingsPage, { onBack: () => {}, initialSection: 'data' }))
    const note = await screen.findByText(/完整备份包含：数据库快照/)
    expect(note.textContent).toContain('论文解析结果（Markdown 与图片）')
    expect(note.textContent).toContain('无 DOI 论文 PDF')
    expect(note.textContent).toContain('不含 API Key（.env）')
    expect((await screen.findByTestId('backup-pdf-note')).textContent).toContain('有 DOI 的论文 PDF 不包含在备份中')
    expect((await screen.findByTestId('auto-backup')).textContent).toContain('每天一次 · 保留最近 7 份 · 已开启')
    expect(screen.getByTestId('auto-backup').querySelector('input,button')).toBeNull()
    expect((await screen.findByTestId('last-snapshot')).textContent).toBe('尚未备份')
    const path = document.querySelector('.pathm')
    expect(path?.getAttribute('title')).toBe('/Users/me/Library/Application Support/Graphictero')
    expect(path?.textContent).toContain('~/Library/Application Support/')
    expect(path?.textContent).toContain('Graphictero/')
  })
})
