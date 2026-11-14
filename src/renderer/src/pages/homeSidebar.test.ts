// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement as h } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { GraphSummary, PaperSummary } from '../../../shared/ipc'

let Home: typeof import('./Home').Home

const graphs: GraphSummary[] = [
  {
    id: 7,
    name: '最近图谱',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
    paperCount: 2,
    relationCount: 1
  },
  {
    id: 8,
    name: '另一张',
    createdAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:00.000Z',
    paperCount: 0,
    relationCount: 0
  }
]

function paper(partial: Partial<PaperSummary> & Pick<PaperSummary, 'id' | 'title' | 'inGraph'>): PaperSummary {
  return {
    firstAuthor: null,
    year: null,
    hasPdf: false,
    doi: null,
    arxivId: null,
    source: 'zotero',
    ...partial
  }
}

beforeAll(async () => {
  ;(window as unknown as { graphictero: unknown }).graphictero = {
    listGraphs: vi.fn(async () => graphs),
    listLibrary: vi.fn(async () => []),
    onLibraryChanged: () => () => {},
    getLastImport: vi.fn(async () => ({ at: null })),
    getMineruStatus: vi.fn(async () => ({ state: 'ready' })),
    onMineruStatus: () => () => {},
    getJobsOverview: vi.fn(async () => ({
      failed: [],
      failedRetryable: 0,
      failedAction: 0,
      waitingNetwork: 0,
      waitingKey: 0,
      pauseSummary: null,
      active: []
    })),
    getWaitingCount: vi.fn(async () => 0),
    getPapersStatus: vi.fn(async () => []),
    onParseProgress: () => () => {},
    startMineru: vi.fn(async () => ({ state: 'ready' }))
  }
  Home = (await import('./Home')).Home
})

afterEach(cleanup)

function caps(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.sidebar .shead .cap')].map((el) => (el.textContent ?? '').trim())
}

describe('首页侧栏（v46_01）', () => {
  it('顶部三项，论文库标题不重复，状态点在搜索前面', async () => {
    const onOpenGraph = vi.fn()
    const { container } = render(
      h(Home, {
        lastGraphId: null,
        onOpenGraph,
        onOpenSettings: () => {},
        onOpenParseSettings: () => {},
        onOpenPaper: () => {}
      })
    )
    expect((await screen.findByTestId('home-nav-all')).textContent).toContain('全部图谱')
    await waitFor(() => expect(screen.getByTestId('home-nav-all').textContent).toContain('2'))
    expect(screen.getByTestId('home-nav-recent').textContent).toContain('最近打开')
    expect(screen.getByTestId('home-nav-library').textContent).toContain('论文库')
    expect(screen.getByTestId('home-nav-library').textContent).toContain('0')
    expect(caps(container)).toEqual(['图谱'])
    expect(caps(container)).not.toContain('论文库')
    const foot = container.querySelector('.sidebar .zfoot')?.textContent ?? ''
    expect(foot).toContain('论文库')
    expect(foot).toContain('0 篇')
    expect(foot).toContain('—')
    const toolbar = container.querySelector('.toolbar')!
    const title = [...toolbar.children].find((el) => (el.textContent ?? '').includes('Graphictero'))!
    const dot = toolbar.querySelector('button[title="任务状态"]')!
    const field = toolbar.querySelector('.field')!
    expect(title.compareDocumentPosition(dot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(dot.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(screen.getByTestId('home-nav-recent'))
    expect(onOpenGraph).not.toHaveBeenCalled()
  })

  it('最近打开沿用 lastGraphId；两组论文时子标题不是重复的「论文库」', async () => {
    const api = (window as unknown as { graphictero: { listLibrary: ReturnType<typeof vi.fn> } }).graphictero
    api.listLibrary.mockResolvedValueOnce([
      paper({ id: 1, title: '在图里', inGraph: true }),
      paper({ id: 2, title: '库里其他', inGraph: false })
    ])
    const onOpenGraph = vi.fn()
    const { container } = render(
      h(Home, {
        lastGraphId: 7,
        onOpenGraph,
        onOpenSettings: () => {},
        onOpenParseSettings: () => {},
        onOpenPaper: () => {}
      })
    )
    await screen.findByText('在图里')
    expect(caps(container)).toEqual(['图谱', '本图谱', '论文库 · 其他'])
    expect(caps(container)).not.toContain('论文库')
    expect(screen.getByTestId('home-nav-library').textContent).toContain('2')
    // uat9：全部图谱页只有「全部图谱」高亮；设置独立在滚动分组外、页脚前。
    expect(screen.getByTestId('home-nav-all').classList.contains('on')).toBe(true)
    expect(screen.getAllByTestId('home-graph-row').every((el) => !el.classList.contains('on'))).toBe(true)
    const settings = screen.getByTestId('home-nav-settings')
    const foot = container.querySelector('.sidebar .zfoot')!
    expect(settings.closest('.sbody')).toBeNull()
    expect(settings.parentElement?.classList.contains('sidebar')).toBe(true)
    expect(settings.compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(screen.getByTestId('home-nav-recent'))
    expect(onOpenGraph).toHaveBeenCalledWith(7)
  })
})
