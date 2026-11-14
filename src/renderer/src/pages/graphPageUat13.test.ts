// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react'
import { createElement as h } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphDetail, PaperSummary, RelationView } from '../../../shared/ipc'
import { NotifyContext } from '../lib/notify'
import { clearCanvasViews } from '../lib/subgraphRestore'

/**
 * uat13（D207-⑤）：关系任务 waiting_key 时画布胶囊显示为明确等待态
 * 「生成关系 · 等待 <提供方> API Key」，不用「正在运行」样式（中性灰点）；
 * 正常运行仍显示「正在生成关系 …」。
 */

vi.mock('@xyflow/react', async () => {
  const React = await import('react')
  function ReactFlowStub(props: any) {
    return React.createElement('div', { 'data-testid': 'rf' }, (props.nodes ?? []).map((n: any) =>
      React.createElement('div', { key: n.id, 'data-testid': 'rf-node', 'data-id': n.id })
    ))
  }
  return {
    ReactFlow: ReactFlowStub,
    Background: () => null,
    Controls: () => null,
    BackgroundVariant: { Dots: 'dots' },
    MarkerType: { ArrowClosed: 'arrowclosed' },
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
    applyNodeChanges: (_changes: unknown[], ns: unknown[]) => ns
  }
})

const gt = vi.hoisted(() => ({
  getGraph: vi.fn(), listLibrary: vi.fn(), getPapersStatus: vi.fn(), getJobsOverview: vi.fn(), getWaitingCount: vi.fn(),
  getMineruStatus: vi.fn(), installMineru: vi.fn(), startMineru: vi.fn(), relationsStatus: vi.fn(), listCandidates: vi.fn(),
  setNodePosition: vi.fn(), removePaperFromGraph: vi.fn(), addPapersToGraph: vi.fn(), restoreRelation: vi.fn(),
  restorePaperProgress: vi.fn(), restoreRemovedPaper: vi.fn(), restoreGraphUpdatedAt: vi.fn(), undoGraphRemoval: vi.fn(),
  deletePaperFromLibrary: vi.fn(), moveCandidate: vi.fn(), relationDetail: vi.fn(), paperRelationStats: vi.fn(),
  onGenerateProgress: vi.fn(() => () => {}), onParseProgress: vi.fn(() => () => {}), onMineruStatus: vi.fn(() => () => {}),
  onLibraryChanged: vi.fn(() => () => {}), onAgentCandidates: vi.fn(() => () => {}), onCandProgress: vi.fn(() => () => {}),
  getLlmSettings: vi.fn()
}))

let GraphPage: typeof import('./GraphPage').GraphPage
let notify: (msg: string) => void

beforeAll(async () => {
  ;(window as unknown as { graphictero: unknown }).graphictero = gt
  GraphPage = (await import('./GraphPage')).GraphPage
})

function paper(id: number): PaperSummary {
  return { id, title: `论文${id}`, firstAuthor: 'A', year: 2026, hasPdf: true } as never
}
function rel(id: number, low: number, high: number): RelationView {
  return {
    id, paperLow: low, paperHigh: high, srcPaper: low, statement: '', llmTypes: ['based_on'], autoTypes: [], createdAt: '',
    sourceType: 'job', sourceJobId: 1, sourceSessionId: null, model: 'm', promptVersion: 'v', editedAt: null,
    noRefBasis: false, updatedAt: '2026-11-05T00:00:00Z'
  }
}

function fresh(): GraphDetail {
  return {
    graph: { id: 1, name: 'uat13', createdAt: '', updatedAt: '', paperCount: 2, relationCount: 1 },
    members: [1, 2].map((id) => ({ paper: paper(id), x: id * 100, y: id * 20 })),
    relations: [rel(101, 1, 2)]
  }
}

beforeEach(() => {
  for (const fn of Object.values(gt)) fn.mockClear()
  gt.getGraph.mockImplementation(async () => JSON.parse(JSON.stringify(fresh())) as GraphDetail)
  gt.listLibrary.mockImplementation(async () => fresh().members.map((m) => ({ ...m.paper, inGraph: true })))
  gt.getPapersStatus.mockResolvedValue([])
  gt.getJobsOverview.mockResolvedValue({ queued: 0, running: 0, waitingNetwork: 0, waitingKey: 0, failedRetryable: 0, failedAction: 0, pauseSummary: null, failed: [] })
  gt.getWaitingCount.mockResolvedValue(0)
  gt.getMineruStatus.mockResolvedValue({ state: 'ready' })
  gt.listCandidates.mockResolvedValue([])
  gt.paperRelationStats.mockResolvedValue({ count: 1, graphCount: 1 })
  gt.getLlmSettings.mockResolvedValue({ provider: 'deepseek', model: 'deepseek-flash', hasApiKey: false, keyTail: null })
  document.elementFromPoint = vi.fn(() => null)
  notify = vi.fn()
})

afterEach(() => {
  cleanup()
  clearCanvasViews()
})

function mount() {
  return render(
    h(NotifyContext.Provider, { value: notify },
      h(GraphPage, {
        graphId: 1, onHome: () => {}, onOpenSettings: () => {}, onOpenParseSettings: () => {},
        onOpenPaper: () => {}, chatOpen: false, onAddPaperChips: () => {}, onChatDragHover: () => {}
      })
    )
  )
}

describe('关系生成胶囊（uat13 D207-⑤：waiting_key 等待态）', () => {
  it('waiting_key：显示「生成关系 · 等待 DeepSeek API Key」，带 waiting 标记', async () => {
    gt.relationsStatus.mockResolvedValue({
      running: true,
      activeJob: { id: 9, status: 'waiting_key', currentStep: 'references', error: '缺少 API Key' },
      processedCount: 0,
      totalCount: 7
    })
    mount()
    await waitFor(() => expect(document.querySelector('[data-testid="relgen-waiting"]')?.textContent).toContain('生成关系 · 等待 DeepSeek API Key'))
    const capsule = document.querySelector('[data-testid="relgen-waiting"]')!
    expect(capsule.className).toContain('waiting')
    expect(capsule.textContent).not.toContain('正在生成关系')
    expect(capsule.textContent).not.toContain('0/7')
  })

  it('正常运行：仍显示「正在生成关系」', async () => {
    gt.relationsStatus.mockResolvedValue({
      running: true,
      activeJob: { id: 9, status: 'running', currentStep: 'generate', error: null },
      processedCount: 3,
      totalCount: 7
    })
    mount()
    await waitFor(() => expect(document.querySelector('.relgen')?.textContent).toContain('正在生成关系'))
    expect(document.querySelector('.relgen.waiting')).toBeNull()
    expect(document.querySelector('.relgen')?.textContent).toContain('3/7')
  })

  it('无活动任务：不显示胶囊', async () => {
    gt.relationsStatus.mockResolvedValue({ running: false, activeJob: null, processedCount: 7, totalCount: 7 })
    mount()
    await waitFor(() => expect(gt.relationsStatus).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 50))
    expect(document.querySelector('.relgen')).toBeNull()
  })
})
