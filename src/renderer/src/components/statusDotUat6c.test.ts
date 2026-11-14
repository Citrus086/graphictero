// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement as h } from 'react'
import type { JobsOverview } from '../../../shared/ipc'

/**
 * uat6c M2 / D183：failed_action 任务 =「需要你处理，但可手动重试」——
 * 状态弹层「需要你处理」分组列出标题 + 失败步骤 + 失败原因，并带「重试」按钮
 * （同一 retryJob 通路、防同 tick 双击）；成功后行从分组消失；可重试分组行为不变。
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
let retryCalls: number[]
let retryImpl: (() => Promise<void>) | null = null

beforeAll(async () => {
  current = overview({})
  retryCalls = []
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
    retryJob: vi.fn(async (jobId: number) => {
      retryCalls.push(jobId)
      if (retryImpl) await retryImpl()
    })
  }
  StatusDot = (await import('./StatusDot')).StatusDot
})

beforeEach(() => {
  current = overview({})
  retryCalls = []
  retryImpl = null
})

describe('StatusDot 弹层（uat6c M2 / D183：failed_action 可手动重试）', () => {
  it('「需要你处理」分组列出标题 + 失败步骤（中文）+ 失败原因，并带「重试」按钮', async () => {
    current = overview({
      failedAction: 1,
      // uat6c-fix1 M1：relation_gen 真实形状——paper_id 为 NULL，标题由主进程从
      // payload.paperIds 解析（多篇 =「N 篇论文」）
      failed: [{ jobId: 45, paperId: null, paperTitle: '3 篇论文', failedStep: 'generate', error: 'OpenAlex 400', status: 'failed_action' }]
    })
    render(h(StatusDot, {}))
    fireEvent.click(screen.getByTitle('任务状态'))
    const row = await screen.findByTestId('stpop-actionable')
    expect(row.textContent).toContain('3 篇论文')
    expect(row.textContent).toContain('生成关系') // STEP_LABELS 中文，不出现英文字 generate
    expect(row.textContent).not.toContain('generate')
    expect(row.textContent).toContain('请求参数被服务拒绝（HTTP 400）')
    expect(row.textContent).toContain('请检查设置后重试')
    expect(row.querySelector('.e')?.getAttribute('title')).toContain('OpenAlex 400')
    expect(screen.getByTestId('stpop-retry-actionable').textContent).toBe('重试')
  })

  it('B2：重复失败显示 ×N，原因是人话，原文在 title 且不含密钥', async () => {
    current = overview({
      failedAction: 3,
      failed: [{
        jobId: 9,
        paperId: null,
        paperTitle: 'Self-RAG',
        failedStep: 'generate',
        error: 'OpenAlex 错误（429）：https://api.openalex.org/works?api_key=SECRET&mailto=a@b.c',
        status: 'failed_action',
        count: 3
      }]
    })
    render(h(StatusDot, {}))
    fireEvent.click(screen.getByTitle('任务状态'))
    const row = await screen.findByTestId('stpop-actionable')
    expect(row.textContent).toContain('Self-RAG ×3')
    // D197：原始任务数 3 合并成一个显示条目；角标=1，×3 独立不收缩。
    expect(document.querySelector('.stdot .n')?.textContent).toBe('1')
    expect(row.querySelector('.t')?.textContent).toBe('Self-RAG')
    const mult = row.querySelector('.strow-mult')
    expect(mult?.textContent).toBe(' ×3')
    expect(mult?.parentElement?.querySelector('.t')).not.toBe(mult)
    expect(row.textContent).toContain('OpenAlex 请求失败（429 请求过多）')
    expect(row.textContent).not.toContain('SECRET')
    const title = row.querySelector('.e')?.getAttribute('title') ?? ''
    expect(title).toContain('api_key=***')
    expect(title).not.toContain('SECRET')
    expect(title).not.toContain('a@b.c')
  })

  it('同 tick 双击「重试」只发一次 retryJob；进行中按钮禁用显示「重试中…」，settle 后恢复', async () => {
    let release: (() => void) | null = null
    retryImpl = () => new Promise<void>((resolve) => {
      release = resolve
    })
    current = overview({
      failedAction: 1,
      failed: [{ jobId: 45, paperId: null, paperTitle: '整个图谱', failedStep: 'references', error: '400', status: 'failed_action' }]
    })
    render(h(StatusDot, {}))
    fireEvent.click(screen.getByTitle('任务状态'))
    const btn = await screen.findByTestId('stpop-retry-actionable')
    expect(btn.parentElement!.textContent).toContain('读取引用') // references 中文步骤
    fireEvent.click(btn)
    fireEvent.click(btn) // 同 tick 第二击：守卫挡住
    expect(retryCalls).toEqual([45])
    await waitFor(() => expect(btn.textContent).toBe('重试中…'))
    expect((btn as HTMLButtonElement).disabled).toBe(true)
    release!()
    await waitFor(() => expect(btn.textContent).toBe('重试'))
    expect((btn as HTMLButtonElement).disabled).toBe(false)
  })

  it('重试成功后行从分组消失（retryJob → 刷新 overview）', async () => {
    current = overview({
      failedAction: 1,
      failed: [{ jobId: 45, paperId: null, paperTitle: '2 篇论文', failedStep: 'generate', error: '400', status: 'failed_action' }]
    })
    retryImpl = async () => {
      current = overview({}) // 重试受理后任务回到 queued：失败分组清空
    }
    render(h(StatusDot, {}))
    fireEvent.click(screen.getByTitle('任务状态'))
    fireEvent.click(await screen.findByTestId('stpop-retry-actionable'))
    await waitFor(() => expect(screen.queryByTestId('stpop-actionable')).toBeNull())
    expect(retryCalls).toEqual([45])
  })

  it('可重试分组行为不变：仍有「重试」按钮且走同一 retryJob 通路', async () => {
    current = overview({
      failedRetryable: 1,
      failed: [{ jobId: 30, paperId: 10, paperTitle: '旧失败论文', failedStep: 'parse', error: '网络错误', status: 'failed_retryable' }]
    })
    render(h(StatusDot, {}))
    fireEvent.click(screen.getByTitle('任务状态'))
    const btn = await screen.findByText('重试')
    fireEvent.click(btn)
    await waitFor(() => expect(retryCalls).toEqual([30]))
  })
})
