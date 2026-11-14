// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement as h } from 'react'
import type { MineruStatusView } from '../../../shared/ipc/pdf'
import { installFailedText, isFirstRunGateState } from '../lib/mineruStatus'

/**
 * uat1 渲染层测试：MinerU 安装失败态（install_failed）持久可见、可重试——
 * 设置页 MineruSection（失败标签 / 通俗原因 / 重试安装 + 重新安装可用）、
 * 顶栏 StatusDot（错误色 + 弹层环境条目）、首启界面 FirstRunPage（00，原型口径）。
 *
 * MineruSection / StatusDot 在模块顶层捕获 window.graphictero——先装可变 mock
 * 再动态 import（与 paperDetailNoPdf.test.ts 同惯例）；mock 调用时读 current，
 * 各用例改 current 切换 sidecar 状态。
 */

afterEach(cleanup)

let MineruSection: typeof import('./MineruSection').MineruSection
let StatusDot: typeof import('./StatusDot').StatusDot
let FirstRunPage: typeof import('../pages/FirstRunPage').FirstRunPage

function statusOf(patch: Partial<MineruStatusView>): MineruStatusView {
  return {
    state: 'stopped',
    version: null,
    port: null,
    pid: null,
    error: null,
    installProgress: null,
    modelsPath: '/tmp/state/venv',
    modelsReady: true,
    ...patch
  }
}

const INSTALL_FAILED_MODELS = statusOf({
  state: 'install_failed',
  error: 'MinerU 安装失败（下载模型文件）：uv run 退出码 1：错误: 请传入模型仓库名或 --tier。',
  modelsReady: false
})

let current: MineruStatusView
let waitingN: number
let startMineru: ReturnType<typeof vi.fn>
let installMineru: ReturnType<typeof vi.fn>
let reinstallMineru: ReturnType<typeof vi.fn>
let getJobsOverview: ReturnType<typeof vi.fn>
let getWaitingCount: ReturnType<typeof vi.fn>
beforeAll(async () => {
  current = statusOf({})
  waitingN = 0
  startMineru = vi.fn(async () => ({ ...current }))
  installMineru = vi.fn(async () => ({ ...current }))
  reinstallMineru = vi.fn(async () => ({ ...current }))
  getJobsOverview = vi.fn(async () => ({
    failed: [],
    failedRetryable: 0,
    failedAction: 0,
    waitingNetwork: 0,
    waitingKey: 0,
    pauseSummary: null
  }))
  getWaitingCount = vi.fn(async () => waitingN)
  ;(window as unknown as { graphictero: unknown }).graphictero = {
    getMineruStatus: vi.fn(async () => ({ ...current })),
    onMineruStatus: () => () => {},
    startMineru,
    installMineru,
    reinstallMineru,
    getLastParse: vi.fn(async () => null),
    getModelDirSize: vi.fn(async () => ({ bytes: null, label: '未下载' })),
    getJobsOverview,
    getWaitingCount,
    retryJob: vi.fn(async () => {})
  }
  // 模块顶层捕获 window.graphictero：必须在赋值之后 import
  ;[MineruSection, StatusDot, FirstRunPage] = await Promise.all([
    import('./MineruSection').then((m) => m.MineruSection),
    import('./StatusDot').then((m) => m.StatusDot),
    import('../pages/FirstRunPage').then((m) => m.FirstRunPage)
  ])
})

beforeEach(() => {
  current = INSTALL_FAILED_MODELS
  waitingN = 0
  startMineru.mockClear()
  installMineru.mockClear()
  reinstallMineru.mockClear()
  getJobsOverview.mockClear()
})

describe('installFailedText：找不到 uv', () => {
  it('给出 uv 安装命令（curl 安装脚本 / brew）', () => {
    const t = installFailedText('MinerU 安装失败（安装依赖）：找不到 uv（MinerU 靠它安装和运行）。')
    expect(t.title).toBe('MinerU 安装失败：没有找到 uv。')
    expect(t.hint).toContain('curl -LsSf https://astral.sh/uv/install.sh | sh')
    expect(t.hint).toContain('brew install uv')
  })
})

describe('mineruStatus 纯函数（uat1）', () => {
  it('installFailedText 按阶段归类通俗文案，原始 stderr 不进主文案', () => {
    const models = installFailedText(INSTALL_FAILED_MODELS.error ?? '')
    expect(models.title).toContain('下载模型文件时出错')
    expect(models.title).not.toContain('退出码')
    expect(models.hint).toContain('重试')
    const deps = installFailedText('MinerU 安装失败（安装依赖）：uv sync 退出码 1：Could not resolve')
    expect(deps.title).toContain('安装依赖时出错')
    const reuse = installFailedText('MinerU 安装失败（复用模型文件）：EACCES')
    expect(reuse.title).toContain('复用已下载的模型时出错')
    expect(reuse.title).not.toContain('EACCES')
  })

  it('isFirstRunGateState：三态进门，已安装族与 unavailable 不进', () => {
    expect(isFirstRunGateState('not_installed')).toBe(true)
    expect(isFirstRunGateState('installing')).toBe(true)
    expect(isFirstRunGateState('install_failed')).toBe(true)
    expect(isFirstRunGateState('stopped')).toBe(false)
    expect(isFirstRunGateState('ready')).toBe(false)
    expect(isFirstRunGateState('crashed')).toBe(false)
    expect(isFirstRunGateState('unavailable')).toBe(false)
    expect(isFirstRunGateState(undefined)).toBe(false)
  })
})

describe('MineruSection 安装失败态（uat1）', () => {
  it('失败态显示「安装失败」标签 + 通俗原因（不含开发者原文），不再显示「未安装」', async () => {
    render(h(MineruSection))
    await waitFor(() => expect(screen.getByTestId('mineru-install-failed')).toBeTruthy())
    expect(screen.getAllByText('安装失败').length).toBeGreaterThan(0)
    const failText = screen.getByTestId('mineru-install-failed').textContent ?? ''
    expect(failText).toContain('MinerU 安装失败：下载模型文件时出错。')
    expect(failText).toContain('可能是网络中断或磁盘空间不足')
    expect(failText).not.toContain('退出码 1')
    expect(failText).not.toContain('未安装')
    // 开发者原文只在可展开的「详细信息」里（默认收起）
    expect(failText).toContain('详细信息')
    expect(failText).not.toContain('请传入模型仓库名或 --tier')
    fireEvent.click(screen.getByText('详细信息'))
    expect(screen.getByTestId('mineru-install-failed').textContent).toContain('请传入模型仓库名或 --tier')
  })

  it('「重试安装」与「重新安装…」在失败态都可用；重试调 startMineru', async () => {
    render(h(MineruSection))
    const retry = (await screen.findByTestId('mineru-retry-install')) as HTMLButtonElement
    const reinstall = screen.getByText('重新安装…') as HTMLButtonElement
    expect(retry.disabled).toBe(false)
    expect(reinstall.disabled).toBe(false)
    fireEvent.click(retry)
    await waitFor(() => expect(startMineru).toHaveBeenCalledTimes(1))
    // 重新安装仍保留二次确认
    fireEvent.click(reinstall)
    expect(screen.getByText('重新安装 MinerU？')).toBeTruthy()
    const dialog = screen.getByText(/已有模型会保留/)
    expect(dialog.textContent).toContain('不会重新下载')
    expect(dialog.textContent).toContain('几分钟')
    expect(dialog.textContent).toContain('重新安装依赖')
    expect(dialog.textContent).not.toContain('模型文件')
    expect(screen.getByTitle(/模型存放在 App 数据目录，首次从 ~\/\.mineru\/models 克隆复用或下载/)).toBeTruthy()
    const reinstallOk = [...document.querySelectorAll('.modal.cfm button')].find((b) => b.textContent === '重新安装')
    expect(reinstallOk).toBeTruthy()
    fireEvent.click(reinstallOk!)
    await waitFor(() => expect(reinstallMineru).toHaveBeenCalledTimes(1))
  })
})

describe('StatusDot MinerU 环境错误（uat1）', () => {
  it('无失败任务时：安装失败让状态点变红，弹层出「环境」条目，不再说没有失败任务', async () => {
    const { container } = render(h(StatusDot, {}))
    await waitFor(() => expect(getJobsOverview).toHaveBeenCalled())
    const dot = container.querySelector('.dot')
    expect(dot?.className).toContain('red')
    fireEvent.click(screen.getByTitle('任务状态'))
    const row = await screen.findByTestId('stpop-mineru-env')
    expect(row.textContent).toContain('解析组件（MinerU）安装失败')
    expect(row.textContent).toContain('重试')
    expect(screen.queryByText('没有失败或排队的任务')).toBeNull()
    // 弹层「重试」→ startMineru（uat1-fix1：统一 start() 到 ready；不再走 installMineru 停 stopped）
    fireEvent.click(row.querySelector('button')!)
    await waitFor(() => expect(startMineru).toHaveBeenCalledTimes(1))
    expect(installMineru).not.toHaveBeenCalled()
  })
})

describe('FirstRunPage 首启安装界面（原型 00，uat1）', () => {
  it('installing：标题 + 进度条 + 中文阶段说明 + 原型固定两行说明', async () => {
    current = statusOf({ state: 'installing', installProgress: { phase: 'models', detail: 'Downloading 42%' }, modelsReady: false })
    render(h(FirstRunPage, { onSkip: () => {} }))
    const page = await screen.findByTestId('first-run-page')
    expect(page.textContent).toContain('正在安装解析组件（MinerU）')
    expect(page.querySelector('.pbar')).toBeTruthy()
    expect(page.textContent).toContain('正在下载模型文件…')
    // uv/pip 原始输出不上主界面
    expect(page.textContent).not.toContain('Downloading 42%')
    // 原型固定两行（照原型断行）
    expect(page.textContent).toContain('Graphictero 首次启动会在本机安装 Python 和 MinerU，')
    expect(page.textContent).toContain('并下载模型文件（几 GB），只需一次。')
    expect(screen.queryByTestId('first-run-failed')).toBeNull()
  })

  it('install_failed：失败说明 + 重试（installMineru）+ 跳过出口', async () => {
    current = INSTALL_FAILED_MODELS
    const onSkip = vi.fn()
    render(h(FirstRunPage, { onSkip }))
    const failed = await screen.findByTestId('first-run-failed')
    expect(failed.textContent).toContain('MinerU 安装失败：下载模型文件时出错。')
    expect(failed.querySelector('.pbar')).toBeNull() // 进度条处换成失败说明
    fireEvent.click(screen.getByTestId('first-run-retry'))
    await waitFor(() => expect(installMineru).toHaveBeenCalledTimes(1))
    // 详细信息默认收起，点开可见开发者原文
    expect(screen.getByTestId('first-run-page').textContent).not.toContain('退出码 1')
    fireEvent.click(screen.getByText('详细信息'))
    expect(screen.getByTestId('first-run-page').textContent).toContain('退出码 1')
    fireEvent.click(screen.getByTestId('first-run-skip'))
    expect(onSkip).toHaveBeenCalledTimes(1)
  })
})


let openParseCalls: number[] = []

describe('StatusDot D144 等待解析组件汇总（uat1b）', () => {
  beforeEach(() => {
    openParseCalls = []
  })
  it('已停止 + N 篇等待：弹层「环境」组一行「解析组件不可用 · 影响 N 篇 · 去设置」，状态点红色', async () => {
    current = statusOf({ state: 'stopped', error: null, modelsReady: true })
    waitingN = 2
    const { container } = render(h(StatusDot, { onOpenParseSettings: () => openParseCalls.push(1) }))
    await waitFor(() => expect(getWaitingCount).toHaveBeenCalled())
    const dot = container.querySelector('.dot')
    expect(dot?.className).toContain('red') // 已停止按错误色
    fireEvent.click(screen.getByTitle('任务状态'))
    const row = await screen.findByTestId('stpop-mineru-waiting')
    expect(row.textContent).toContain('解析组件不可用 · 影响 2 篇')
    // 环境组与 uat1 错误行合并不重复：已停止只有一行环境条目
    expect(screen.getByTestId('stpop-mineru-env').textContent).toContain('已停止')
    expect(screen.queryByText('没有失败或排队的任务')).toBeNull()
    fireEvent.click(row.querySelector('button')!)
    await waitFor(() => expect(openParseCalls.length).toBe(1)) // 直达 设置 → PDF 解析
  })

  it('未安装（不点红，中性提示态）+ 无等待论文：只有错误环境语义不出现、空态文案正常', async () => {
    current = statusOf({ state: 'not_installed', modelsReady: false })
    waitingN = 0
    const { container } = render(h(StatusDot, {}))
    await waitFor(() => expect(getWaitingCount).toHaveBeenCalled())
    const dot = container.querySelector('.dot')
    expect(dot?.className).toContain('hollow') // D95 不点红
    expect(dot?.className).not.toContain('red')
    fireEvent.click(screen.getByTitle('任务状态'))
    expect(screen.queryByTestId('stpop-mineru-waiting')).toBeNull()
    expect(screen.queryByTestId('stpop-mineru-env')).toBeNull()
  })
})
