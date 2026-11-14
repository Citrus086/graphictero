// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement as h } from 'react'
import type { CandidateView } from '../../../shared/ipc/agent'
import type { CandProgressEvent } from '../../../shared/ipc/cand'

afterEach(cleanup)

let CandidateNode: typeof import('./GraphPage').CandidateNode

let importCalls: number[] = []
let retryCalls: number[] = []
let holdImport = false
let releaseImport: ((v: { paperId: number; jobId: number }) => void) | null = null
let failImport = false
let confirmCalls: number[] = []
let holdConfirm = false
let releaseConfirm: ((v: unknown) => void) | null = null
let failConfirm = false

const CAND: CandidateView = {
  id: 42,
  graphId: 1,
  title: '外部候选',
  authors: ['张三'],
  year: 2025,
  doi: null,
  arxivId: null,
  existingPaperId: null,
  reason: '理由',
  x: 0,
  y: 0,
  status: 'pending',
  createdAt: 't',
  updatedAt: 't'
}

function installMock(): void {
  importCalls = []
  retryCalls = []
  confirmCalls = []
  holdImport = false
  holdConfirm = false
  failConfirm = false
  releaseImport = null
  releaseConfirm = null
  ;(window as unknown as { graphictero: unknown }).graphictero = {
    importConfirm: (input: { candidateId: number }) => {
      importCalls.push(input.candidateId)
      if (failImport) return Promise.reject(new Error('入库失败'))
      if (holdImport) {
        return new Promise<{ paperId: number; jobId: number }>((resolve) => {
          releaseImport = resolve
        })
      }
      return Promise.resolve({ paperId: 900, jobId: 1 })
    },
    retryFindPdf: async (input: { paperId: number }) => {
      retryCalls.push(input.paperId)
    },
    candidateConfirm: (candidateId: number) => {
      confirmCalls.push(candidateId)
      if (failConfirm) return Promise.reject(new Error('确认失败'))
      if (holdConfirm) {
        return new Promise((resolve) => {
          releaseConfirm = resolve
        })
      }
      return Promise.resolve({})
    }
  }
}

function nodeEl(progress: CandProgressEvent | null): React.JSX.Element {
  return h(CandidateNode, { data: { candidate: CAND, progress } } as never)
}

describe('画布候选节点（失败重试 / done 不留确认按钮）', () => {
  beforeAll(async () => {
    installMock()
    CandidateNode = (await import('./GraphPage')).CandidateNode
  })

  beforeEach(() => {
    importCalls = []
    retryCalls = []
    confirmCalls = []
    holdImport = false
    holdConfirm = false
    failImport = false
    failConfirm = false
    releaseImport = null
    releaseConfirm = null
  })

  it('done 不渲染确认按钮，也不和进度转圈叠在一起', () => {
    render(nodeEl({ candidateId: 42, paperId: 9, phase: 'done' }))
    expect(screen.queryByTestId('cand-confirm')).toBeNull()
    expect(screen.queryByTestId('cand-progress')).toBeNull()
    expect(screen.queryByTestId('cand-ignore')).toBeNull()
    expect(screen.getByTestId('cand-done').textContent).toContain('已入库')
  })

  it('importConfirm 还没返回时 done 先到：不叠「完成」转圈，成功后 busy 不再把按钮留住', async () => {
    holdImport = true
    const view = render(nodeEl(null))
    fireEvent.click(screen.getByTestId('cand-confirm'))
    expect(screen.getByTestId('cand-progress').textContent).toContain('正在入库')
    view.rerender(nodeEl({ candidateId: 42, paperId: 9, phase: 'done' }))
    expect(screen.queryByTestId('cand-progress')).toBeNull()
    expect(screen.queryByTestId('cand-confirm')).toBeNull()
    expect(screen.getByTestId('cand-done')).toBeTruthy()
    await act(async () => {
      releaseImport?.({ paperId: 9, jobId: 1 })
    })
    expect(screen.queryByTestId('cand-progress')).toBeNull()
    expect(screen.queryByTestId('cand-confirm')).toBeNull()
  })

  it('importConfirm 成功后、进度事件到来前保持乐观入库中；事件到达后不再转圈', async () => {
    const view = render(nodeEl(null))
    fireEvent.click(screen.getByTestId('cand-confirm'))
    expect(importCalls).toEqual([42])
    await act(async () => {})
    expect(screen.getByTestId('cand-progress').textContent).toContain('正在入库')
    expect((screen.getByTestId('cand-confirm') as HTMLButtonElement).disabled).toBe(true)
    view.rerender(nodeEl({ candidateId: 42, paperId: 9, phase: 'done' }))
    expect(screen.queryByTestId('cand-progress')).toBeNull()
    expect(screen.queryByTestId('cand-confirm')).toBeNull()
    expect(screen.getByTestId('cand-done').textContent).toContain('已入库')
  })

  it('失败且 paperId > 0：重试走 retryFindPdf', () => {
    render(nodeEl({ candidateId: 42, paperId: 900, phase: 'failed', message: '下载中断' }))
    fireEvent.click(screen.getByTestId('cand-confirm'))
    expect(retryCalls).toEqual([900])
    expect(importCalls).toEqual([])
  })

  it('失败且 paperId 为 0：重试再 importConfirm', () => {
    render(nodeEl({ candidateId: 42, paperId: 0, phase: 'failed' }))
    fireEvent.click(screen.getByTestId('cand-confirm'))
    expect(importCalls).toEqual([42])
    expect(retryCalls).toEqual([])
  })

  it('同一 tick 连点确认入库只进一次 importConfirm', async () => {
    holdImport = true
    const view = render(nodeEl(null))
    const btn = screen.getByTestId('cand-confirm')
    fireEvent.click(btn)
    fireEvent.click(btn)
    expect(importCalls).toEqual([42])
    await act(async () => {
      releaseImport?.({ paperId: 9, jobId: 1 })
    })
    fireEvent.click(screen.getByTestId('cand-confirm'))
    expect(importCalls).toEqual([42])
    view.rerender(nodeEl({ candidateId: 42, paperId: 0, phase: 'failed' }))
    fireEvent.click(screen.getByTestId('cand-confirm'))
    expect(importCalls).toEqual([42, 42])
  })

  it('no_pdf 显示再试查找，不叠进度转圈', () => {
    render(nodeEl({ candidateId: 42, paperId: 900, phase: 'no_pdf' }))
    expect(screen.queryByTestId('cand-confirm')).toBeNull()
    expect(screen.queryByTestId('cand-progress')).toBeNull()
    expect(screen.getByTestId('cand-nopdf').textContent).toContain('未找到 PDF')
    fireEvent.click(screen.getByTestId('cand-retry-pdf'))
    expect(retryCalls).toEqual([900])
  })

  it('uat5 必须修 4：库外确认**不换节点**（保留虚线进度四态），进行中按钮禁用', async () => {
    holdImport = true
    const events: unknown[] = []
    const onStart = (e: Event): void => {
      events.push((e as CustomEvent).detail)
    }
    window.addEventListener('gt:cand-confirm-start', onStart)
    try {
      render(nodeEl(null))
      fireEvent.click(screen.getByTestId('cand-confirm'))
      // 库外入库是分钟级过程：不派发乐观 START，节点留在原地显示进度
      expect(events).toEqual([])
      expect((screen.getByTestId('cand-confirm') as HTMLButtonElement).disabled).toBe(true)
      await act(async () => {
        releaseImport?.({ paperId: 9, jobId: 1 })
      })
    } finally {
      window.removeEventListener('gt:cand-confirm-start', onStart)
    }
  })

  it('uat5 必须修 4：库外入库失败 toast 且按钮恢复可点（不换节点、无 START/ROLLBACK）', async () => {
    failImport = true
    render(nodeEl(null))
    fireEvent.click(screen.getByTestId('cand-confirm'))
    await act(async () => {})
    expect((screen.getByTestId('cand-confirm') as HTMLButtonElement).disabled).toBe(false)
  })

  it('uat5 必须修 4：已在库中候选确认——同一 tick 乐观 start（真实 paperId），进行中禁用，失败回滚', async () => {
    const inLib = { ...CAND, existingPaperId: 900 }
    const el = (progress: CandProgressEvent | null): React.JSX.Element =>
      h(CandidateNode, { data: { candidate: inLib, progress } } as never)
    const events: Array<{ kind: string; detail: unknown }> = []
    const onStart = (e: Event): void => {
      events.push({ kind: 'start', detail: (e as CustomEvent).detail })
    }
    const onRollback = (e: Event): void => {
      events.push({ kind: 'rollback', detail: (e as CustomEvent).detail })
    }
    window.addEventListener('gt:cand-confirm-start', onStart)
    window.addEventListener('gt:cand-confirm-rollback', onRollback)
    try {
      // 失败情形：派发 rollback
      failConfirm = true
      const view = render(el(null))
      fireEvent.click(screen.getByTestId('cand-confirm'))
      await act(async () => {})
      expect(confirmCalls).toEqual([42])
      expect(events.at(-1)).toEqual({ kind: 'rollback', detail: 42 })
      expect((screen.getByTestId('cand-confirm') as HTMLButtonElement).disabled).toBe(false)
      // 成功情形：start 带真实 paperId，等待返回期间按钮禁用
      failConfirm = false
      holdConfirm = true
      view.rerender(el(null))
      events.length = 0
      fireEvent.click(screen.getByTestId('cand-confirm'))
      expect(events).toEqual([
        { kind: 'start', detail: { candidateId: 42, paperId: 900, title: '外部候选', authors: ['张三'], year: 2025, x: 0, y: 0 } }
      ])
      expect((screen.getByTestId('cand-confirm') as HTMLButtonElement).disabled).toBe(true)
      await act(async () => {
        releaseConfirm?.({})
      })
    } finally {
      window.removeEventListener('gt:cand-confirm-start', onStart)
      window.removeEventListener('gt:cand-confirm-rollback', onRollback)
    }
  })
})
