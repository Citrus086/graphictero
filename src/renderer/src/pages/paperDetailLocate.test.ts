// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement as h } from 'react'
import type { DetailView, PaperMetaView } from '../../../shared/ipc/detail'

afterEach(cleanup)

// PaperDetailPage 在模块顶层捕获 window.graphictero——先装 mock 再动态 import
let PaperDetailPage: typeof import('./PaperDetailPage').PaperDetailPage

const META: PaperMetaView = {
  paperId: 7,
  title: '定位按钮测试论文',
  authors: ['张三'],
  year: 2025,
  venue: '某会议',
  doi: '10.1/abc',
  zoteroItemKey: null,
  source: 'zotero',
  hasPdf: true,
  pdfSource: 'zotero',
  pdfUnresolved: false,
  abstract: '摘要文本',
  abstractSource: 'openalex',
  oneLiner: null
}

const DETAIL: DetailView = {
  paperId: 7,
  parts: [{ type: 'text', text: '详情正文' }],
  model: 'deepseek-flash',
  generatedAt: '2026-11-04T12:00:00.000Z',
  promptVersion: 'detail-v2',
  staleReason: null
}

function installMock(): void {
  const unsub = () => {}
  ;(window as unknown as { graphictero: unknown }).graphictero = {
    getPaperMeta: vi.fn(async (id: number) => ({ ...META, paperId: id })),
    getDetail: vi.fn(async () => DETAIL),
    getPapersStatus: vi.fn(async () => []),
    getMineruStatus: vi.fn(async () => ({
      state: 'unavailable', version: null, port: null, pid: null, error: null,
      installProgress: null, modelsPath: null, modelsReady: false
    })),
    onParseProgress: vi.fn(() => unsub),
    onMineruStatus: vi.fn(() => unsub),
    onDetailUpdated: vi.fn(() => unsub),
    pdfAttempts: vi.fn(async () => []),
    onCandProgress: vi.fn(() => unsub),
    attachPdf: vi.fn(async () => {}),
    retryFindPdf: vi.fn(async () => {}),
    getPathForFile: vi.fn(() => '/tmp/fixture.pdf')
  }
}

describe('D201 详情页「定位」入口（uat12）', () => {
  beforeAll(async () => {
    installMock()
    PaperDetailPage = (await import('./PaperDetailPage')).PaperDetailPage
  })

  it('有图谱归属回调时渲染「定位」按钮，点击触发 onLocate', async () => {
    const onLocate = vi.fn()
    render(h(PaperDetailPage, { paperId: 7, onBack: () => {}, onLocate }))
    const btn = await screen.findByTestId('pd-locate')
    expect(btn.textContent).toContain('定位')
    fireEvent.click(btn)
    expect(onLocate).toHaveBeenCalledOnce()
  })

  it('无 onLocate 回调时不渲染「定位」按钮', async () => {
    render(h(PaperDetailPage, { paperId: 7, onBack: () => {} }))
    await screen.findByTestId('paper-detail-page')
    expect(screen.queryByTestId('pd-locate')).toBeNull()
  })
})
