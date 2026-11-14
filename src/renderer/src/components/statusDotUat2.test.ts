// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement as h } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { JobsOverview } from '../../../shared/ipc'

/**
 * uat2 渲染层测试：任务弹层（StatusDot）的排队/处理中口径——
 * 有 running / queued 任务时必须出现「处理中/排队中」汇总行，且不得写
 * 「没有失败或排队的任务」。mock 调用时读 current，各用例切换任务概览。
 */

afterEach(cleanup)

let StatusDot: typeof import('./StatusDot').StatusDot

function overview(patch: Partial<JobsOverview>): JobsOverview {
  return {
    queued: 0,
    running: 0,
    waitingNetwork: 0,
    waitingKey: 0,
    failedRetryable: 0,
    failedAction: 0,
    pauseSummary: null,
    failed: [],
    ...patch
  }
}

let current: JobsOverview

beforeAll(async () => {
  current = overview({})
  ;(window as unknown as { graphictero: unknown }).graphictero = {
    getMineruStatus: vi.fn(async () => ({
      state: 'ready',
      version: '4.0.12',
      port: 1,
      pid: 1,
      error: null,
      installProgress: null,
      modelsPath: null,
      modelsReady: true
    })),
    getJobsOverview: vi.fn(async () => current),
    getWaitingCount: vi.fn(async () => 0),
    onMineruStatus: () => () => {},
    retryJob: vi.fn(async () => {})
  }
  StatusDot = (await import('./StatusDot')).StatusDot
})

beforeEach(() => {
  current = overview({})
})

describe('StatusDot 弹层（uat2：running/queued 可见）', () => {
  it('有 running/queued 任务：显示「处理中/排队中」汇总行，不写「没有失败或排队的任务」', async () => {
    current = overview({ running: 1, queued: 3 })
    render(h(StatusDot, {}))
    fireEvent.click(screen.getByTitle('任务状态'))
    await waitFor(() => expect(screen.getByTestId('stpop-active')).toBeTruthy())
    const line = screen.getByTestId('stpop-active').textContent ?? ''
    expect(line).toContain('处理中 1 个任务')
    expect(line).toContain('排队中 3 个任务')
    expect(screen.queryByText('没有失败或排队的任务')).toBeNull()
  })

  it('只有 queued：写「排队中」，不写「没有失败或排队的任务」', async () => {
    current = overview({ queued: 2 })
    render(h(StatusDot, {}))
    fireEvent.click(screen.getByTitle('任务状态'))
    await waitFor(() => expect(screen.getByTestId('stpop-active')).toBeTruthy())
    expect(screen.getByTestId('stpop-active').textContent).toContain('排队中 2 个任务')
    expect(screen.queryByText('没有失败或排队的任务')).toBeNull()
  })

  it('全空闲（含 waitingCount=0）：才写「没有失败或排队的任务」', async () => {
    current = overview({})
    render(h(StatusDot, {}))
    fireEvent.click(screen.getByTitle('任务状态'))
    await waitFor(() => expect(screen.getByText('没有失败或排队的任务')).toBeTruthy())
    expect(screen.queryByTestId('stpop-active')).toBeNull()
  })

  it('uat4 D167：除计数外列出正在处理 / 排队的论文简称', async () => {
    current = overview({
      running: 1,
      queued: 1,
      active: [
        { jobId: 1, paperId: 11, paperTitle: '论文甲', status: 'running', step: 'parse' },
        { jobId: 2, paperId: 12, paperTitle: '论文乙', status: 'queued', step: 'detail' }
      ]
    })
    render(h(StatusDot, {}))
    fireEvent.click(screen.getByTitle('任务状态'))
    const names = await screen.findByTestId('stpop-active-names')
    expect(names.textContent).toContain('论文甲')
    expect(names.textContent).toContain('论文乙（排队中）')
  })
})

describe('StatusDot 弹层（uat6 S6：Esc 关闭）', () => {
  it('弹层打开时按 Escape 关闭', async () => {
    current = overview({ running: 1, active: [{ jobId: 1, paperId: 11, paperTitle: '论文甲', status: 'running', step: 'parse' }] })
    render(h(StatusDot, {}))
    fireEvent.click(screen.getByTitle('任务状态'))
    await waitFor(() => expect(screen.getByTestId('stpop-active')).toBeTruthy())
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('stpop-active')).toBeNull())
  })

  it('其它按键（如 a / Enter）不关闭弹层', async () => {
    current = overview({ running: 1 })
    render(h(StatusDot, {}))
    fireEvent.click(screen.getByTitle('任务状态'))
    await waitFor(() => expect(screen.getByTestId('stpop-active')).toBeTruthy())
    fireEvent.keyDown(window, { key: 'a' })
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(screen.getByTestId('stpop-active')).toBeTruthy()
  })

  it('弹层未打开时 Escape 不触发任何状态变化（监听仅在 open 时挂）', () => {
    current = overview({})
    render(h(StatusDot, {}))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByText('没有失败或排队的任务')).toBeNull() // 弹层没开
  })
})

/**
 * uat6 S6：任务状态弹层不遮关系面板标题——CSS 锁定。
 * 口径：.stpop（顶栏 .stdot 下悬垂，z-index:90）保持不动；.panel（关系/处理进度面板，
 * .ws 右侧，底色不透明）抬到 z-index:95，弹层自然滑到面板下方被遮挡，标题 .ph 始终可见。
 * jsdom 不算样式，这里直接锁 styles.css 规则文本。
 */
describe('StatusDot 弹层（uat6 S6：不遮面板标题，CSS 锁定）', () => {
  const STYLES = readFileSync(join(fileURLToPath(import.meta.url), '..', '..', 'styles.css'), 'utf8')

  const COMPACT = STYLES.replace(/\s+/g, '')

  function ruleZIndex(selector: string): number {
    const re = new RegExp(`\\.${selector}\\{[^}]*?z-index:(\\d+)`)
    return Number(re.exec(COMPACT)?.[1] ?? NaN)
  }

  it('.panel 的 z-index 高于 .stpop（弹层在面板下方，不遮标题区）', () => {
    expect(ruleZIndex('stpop')).toBe(90)
    expect(ruleZIndex('panel')).toBeGreaterThan(ruleZIndex('stpop'))
  })

  it('D197：合并次数 ×N 是独立且不收缩的文本，标题继续单独省略', () => {
    expect(COMPACT).toContain('.strow.strow-mult{flex:none;white-space:nowrap}')
    expect(COMPACT).toContain('.strow.t{flex:11auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}')
  })

  it('uat10：失败原因独占一行可换行（flex 100% basis），×N 与标题同行不被挤', () => {
    expect(COMPACT).toContain('.strow{display:flex;flex-wrap:wrap;')
    expect(COMPACT).toContain('.strow.e{flex:10100%;font-size:11.5px;color:var(--text3);white-space:normal;overflow-wrap:anywhere}')
  })

  it('uat10（评审建议 4）：.gt-tab 计数三位数时 ellipsis 不叠字，保持单行', () => {
    const rule = /\.gt-tab\{([^}]*)\}/.exec(COMPACT)?.[1] ?? ''
    expect(rule).toContain('white-space:nowrap')
    expect(rule).toContain('overflow:hidden')
    expect(rule).toContain('text-overflow:ellipsis')
  })

  it('.panel 为定位上下文（position:relative），z-index 生效', () => {
    const rule = /\.panel\{([^}]*)\}/.exec(COMPACT)?.[1] ?? ''
    expect(rule).toContain('position:relative')
    expect(rule).toContain('z-index:95')
  })
})
