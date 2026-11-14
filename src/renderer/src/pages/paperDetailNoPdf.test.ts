// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, beforeAll } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement as h } from 'react'
import type { DetailView, PaperMetaView } from '../../../shared/ipc/detail'
import type { CandProgressEvent, PdfAttemptView } from '../../../shared/ipc/cand'
import { NotifyContext } from '../lib/notify'

afterEach(cleanup)

// PaperDetailPage 在模块顶层捕获 window.graphictero——先装 mock 再动态 import
let PaperDetailPage: typeof import('./PaperDetailPage').PaperDetailPage

type CandCb = (e: CandProgressEvent) => void

let candCb: CandCb | null = null
let attachCalls: Array<{ paperId: number; filePath: string }> = []
let retryCalls: number[] = []
let metaCalls = 0
let perPaperCalls = new Map<number, number>()
/** getPaperMeta 翻真阈值。组件模块级 api 捕获的是 beforeAll 的 firstMock，
 *  所以阈值必须是 firstMock 闭包在调用时读到的可变值，不能关死在第一次 installMock 的参数里。 */
let hasPdfFlipAt = 2
/** beforeAll 装的第一个 mock 对象（组件模块级 api 捕获的就是它） */
let firstMock: Record<string, unknown> | null = null

const META_NO_PDF: PaperMetaView = {
  paperId: 7,
  title: '无 PDF 的论文',
  authors: ['张三'],
  year: 2025,
  venue: '某会议',
  doi: '10.1/abc',
  zoteroItemKey: null,
  source: 'zotero',
  hasPdf: false,
  pdfSource: null,
  pdfUnresolved: false,
  abstract: '摘要文本',
  abstractSource: 'openalex',
  oneLiner: null
}

const ATTEMPTS: PdfAttemptView[] = [
  { source: 'arxiv', result: 'not_found', at: '2026-10-26T10:00:00Z' },
  { source: 'openalex', url: 'https://oa.example/x.pdf', result: 'error', at: '2026-10-26T10:01:00Z' }
]

function installMock(opts: { hasPdfFromCall?: number } = {}): void {
  hasPdfFlipAt = opts.hasPdfFromCall ?? 2
  candCb = null
  attachCalls = []
  retryCalls = []
  metaCalls = 0
  const unsub = () => {}
  perPaperCalls = new Map()
  const obj: Record<string, unknown> = {
    getPaperMeta: vi.fn(async (id: number) => {
      const n = (perPaperCalls.get(id) ?? 0) + 1
      perPaperCalls.set(id, n)
      metaCalls++
      // 第 hasPdfFlipAt 次起 hasPdf 翻真（调用时读可变阈值，firstMock 与后装的 mock 同一口径）
      return { ...META_NO_PDF, paperId: id, hasPdf: n >= hasPdfFlipAt }
    }),
    getDetail: vi.fn(async () => null),
    getPapersStatus: vi.fn(async () => []),
    getMineruStatus: vi.fn(async () => ({
      state: 'unavailable', version: null, port: null, pid: null, error: null,
      installProgress: null, modelsPath: null, modelsReady: false
    })),
    onParseProgress: vi.fn(() => unsub),
    onMineruStatus: vi.fn(() => unsub),
    onDetailUpdated: vi.fn(() => unsub),
    pdfAttempts: vi.fn(async () => ATTEMPTS),
    onCandProgress: vi.fn((cb: CandCb) => {
      candCb = cb
      return () => {
        candCb = null
      }
    }),
    attachPdf: vi.fn(async (input: { paperId: number; filePath: string }) => {
      attachCalls.push(input)
    }),
    retryFindPdf: vi.fn(async (input: { paperId: number }) => {
      retryCalls.push(input.paperId)
    }),
    getPathForFile: vi.fn(() => '/tmp/fixture.pdf')
  }
  firstMock ??= obj
  ;(window as unknown as { graphictero: unknown }).graphictero = obj
}

function fire(e: CandProgressEvent): void {
  act(() => candCb?.(e))
}

function renderPage(): void {
  render(h(PaperDetailPage, { paperId: 7, onBack: () => {} }))
}

describe('03e 无 PDF 页（M6 lane/ui 批 1，D111/D133）', () => {
  beforeAll(async () => {
    installMock()
    PaperDetailPage = (await import('./PaperDetailPage')).PaperDetailPage
  })

  it('换页后在途的 getDetail 不写回新页', async () => {
    const detailOf = (id: number, model: string, text: string): DetailView => ({
      paperId: id,
      parts: [{ type: 'text', text }],
      model,
      generatedAt: '2026-10-26T12:00:00.000Z',
      promptVersion: 'detail-v2',
      staleReason: null
    })
    let release: (d: DetailView | null) => void = () => {}
    const originalDetail = firstMock!.getDetail
    const originalMeta = firstMock!.getPaperMeta
    ;(firstMock as { getPaperMeta: (id: number) => Promise<PaperMetaView> }).getPaperMeta = async (id) => ({
      ...META_NO_PDF,
      paperId: id,
      title: `论文${id}`,
      hasPdf: true
    })
    ;(firstMock as { getDetail: (id: number) => Promise<DetailView | null> }).getDetail = (id) => {
      if (id === 7) return new Promise((resolve) => { release = resolve })
      return Promise.resolve(detailOf(id, 'new-model', '新详情正文'))
    }
    try {
      const view = render(h(PaperDetailPage, { paperId: 7, onBack: () => {} }))
      view.rerender(h(PaperDetailPage, { paperId: 8, onBack: () => {} }))
      await waitFor(() => expect(screen.getByText(/new-model/)).toBeTruthy())
      await act(async () => {
        release(detailOf(7, 'old-model', '旧详情迟到'))
      })
      expect(screen.queryByText(/old-model/)).toBeNull()
      expect(screen.queryByText('旧详情迟到')).toBeNull()
      expect(screen.getByText(/new-model/)).toBeTruthy()
    } finally {
      ;(firstMock as { getDetail: unknown }).getDetail = originalDetail
      ;(firstMock as { getPaperMeta: unknown }).getPaperMeta = originalMeta
    }
  })

  it('换页后在途的来源列表不写回新页', async () => {
    installMock()
    const g = (window as unknown as { graphictero: { pdfAttempts: (input: { paperId: number }) => Promise<PdfAttemptView[]> } }).graphictero
    let calls7 = 0
    let release: (list: PdfAttemptView[]) => void = () => {}
    g.pdfAttempts = ({ paperId }) => {
      if (paperId === 8) {
        return Promise.resolve([{ source: 'fresh-src', result: 'not_found', at: '2026-10-26T10:00:00Z' }])
      }
      calls7 += 1
      if (calls7 === 1) return Promise.resolve(ATTEMPTS)
      return new Promise((resolve) => { release = resolve })
    }
    const { rerender } = render(h(PaperDetailPage, { paperId: 7, onBack: () => {} }))
    await screen.findByTestId('nopdf-tried')
    fire({ paperId: 7, phase: 'no_pdf' })
    expect(calls7).toBe(2)
    rerender(h(PaperDetailPage, { paperId: 8, onBack: () => {} }))
    await waitFor(() => expect(screen.getByTestId('nopdf-tried').textContent).toContain('fresh-src'))
    await act(async () => {
      release([{ source: 'late-src', result: 'error', at: '2026-10-26T10:02:00Z' }])
    })
    const tried = screen.getByTestId('nopdf-tried').textContent ?? ''
    expect(tried).toContain('fresh-src')
    expect(tried).not.toContain('late-src')
  })

  it('换页后在途的 getPaperMeta 不写回新页', async () => {
    let release: (m: PaperMetaView) => void = () => {}
    const original = firstMock!.getPaperMeta
    ;(firstMock as { getPaperMeta: unknown }).getPaperMeta = (id: number) => {
      if (id === 7) return new Promise<PaperMetaView>((resolve) => { release = resolve })
      return Promise.resolve({ ...META_NO_PDF, paperId: id, title: '新论文', hasPdf: false })
    }
    const title = (): string =>
      screen.getByTestId('paper-detail-page').querySelector('.ttl')?.textContent ?? ''
    try {
      const view = render(h(PaperDetailPage, { paperId: 7, onBack: () => {} }))
      view.rerender(h(PaperDetailPage, { paperId: 8, onBack: () => {} }))
      await waitFor(() => expect(title()).toBe('新论文'))
      await act(async () => {
        release({ ...META_NO_PDF, paperId: 7, title: '旧论文迟到', hasPdf: false })
      })
      expect(title()).toBe('新论文')
      expect(screen.queryByText('旧论文迟到')).toBeNull()
    } finally {
      ;(firstMock as { getPaperMeta: unknown }).getPaperMeta = original
    }
  })

  it('渲染拖入区 + 「尝试过的来源」列表（来源 + 结果 + 时间）', async () => {
    installMock()
    renderPage()
    expect(await screen.findByTestId('nopdf-drop')).toBeTruthy()
    const tried = await screen.findByTestId('nopdf-tried')
    expect(tried.textContent).toContain('arxiv')
    expect(tried.textContent).toContain('未找到')
    expect(tried.textContent).toContain('openalex')
    expect(tried.textContent).toContain('出错')
    expect(screen.getByTestId('nopdf-retry')).toBeTruthy()
  })

  it('选择文件：经 getPathForFile 拿路径发 cand:attachPdf，不读字节', async () => {
    installMock()
    renderPage()
    const input = (await screen.findByTestId('nopdf-file-input')) as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['%PDF-x'], 'paper.pdf', { type: 'application/pdf' })] } })
    await waitFor(() => expect(attachCalls).toEqual([{ paperId: 7, filePath: '/tmp/fixture.pdf' }]))
  })

  it('只收 .pdf：非 PDF 文件不发 attachPdf', async () => {
    installMock()
    renderPage()
    const input = (await screen.findByTestId('nopdf-file-input')) as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], 'notes.txt')] } })
    await new Promise((r) => setTimeout(r, 50))
    expect(attachCalls).toEqual([])
  })

  it('「再试一次查找」发 cand:retryFindPdf', async () => {
    installMock()
    renderPage()
    fireEvent.click(await screen.findByTestId('nopdf-retry'))
    await waitFor(() => expect(retryCalls).toEqual([7]))
  })

  it('进度事件：parsing 显示进度行并重拉元数据；done 后切到正常详情视图', async () => {
    // 第 3 次（done 当场重拉）才翻真：parsing 那次重拉仍停在 03e
    installMock({ hasPdfFromCall: 3 })
    renderPage()
    await screen.findByTestId('nopdf-drop')
    fire({ paperId: 7, phase: 'parsing' })
    expect(screen.getByTestId('nopdf-progress').textContent).toContain('解析')
    expect(metaCalls).toBeGreaterThanOrEqual(2)
    expect(screen.getByTestId('nopdf-drop')).toBeTruthy()
    // done：hasPdf 翻真 → 03e 视图消失、出现正常详情的「打开 PDF」
    fire({ paperId: 7, phase: 'done' })
    await waitFor(() => expect(screen.queryByTestId('nopdf-drop')).toBeNull())
    const openPdf = screen.getByTestId('paper-detail-page').querySelector('.gt-pd-bar button') as HTMLButtonElement
    expect(openPdf.disabled).toBe(false)
  })

  it('no_pdf 进度 → 刷新尝试记录并显示「未找到 PDF」', async () => {
    installMock()
    renderPage()
    await screen.findByTestId('nopdf-drop')
    fire({ paperId: 7, phase: 'locating' })
    expect(screen.getByTestId('nopdf-progress').textContent).toContain('查找 PDF')
    fire({ paperId: 7, phase: 'no_pdf' })
    expect(screen.getByTestId('nopdf-progress').textContent).toContain('未找到 PDF')
    expect(await screen.findByTestId('nopdf-tried')).toBeTruthy()
  })

  it('done 当场重拉仍停在 03e，1.5s 兜底的下一次 getPaperMeta 才翻真', async () => {
    installMock({ hasPdfFromCall: 99 })
    renderPage()
    await screen.findByTestId('nopdf-drop')
    fire({ paperId: 7, phase: 'parsing' })
    expect(screen.getByTestId('nopdf-progress').textContent).toContain('解析')
    expect(screen.getByTestId('nopdf-drop')).toBeTruthy()
    fire({ paperId: 7, phase: 'done' })
    expect(screen.getByTestId('nopdf-progress').textContent).toContain('完成，正在打开详情')
    expect(screen.getByTestId('nopdf-drop')).toBeTruthy()
    const n = perPaperCalls.get(7) ?? 0
    expect(n).toBeGreaterThanOrEqual(2)
    // 下一次（只能是 1.5s 兜底）才翻真；阈值作用在组件实际打到的 firstMock 上
    hasPdfFlipAt = n + 1
    await waitFor(() => expect(screen.queryByTestId('nopdf-drop')).toBeNull(), { timeout: 4000 })
    expect(perPaperCalls.get(7)).toBe(n + 1)
  })

  it('换页后 done 的 1.5s 兜底不把上一篇元数据写进新页', async () => {
    installMock({ hasPdfFromCall: 99 })
    const original = firstMock?.getPaperMeta
    if (firstMock) {
      const base = firstMock.getPaperMeta as (id: number) => Promise<PaperMetaView>
      firstMock.getPaperMeta = async (id: number) => {
        const m = await base(id)
        return { ...m, title: `论文${id}` }
      }
    }
    const pageTitle = (): string =>
      screen.getByTestId('paper-detail-page').querySelector('.gt-pd-title')?.textContent ?? ''
    try {
      const { rerender } = render(h(PaperDetailPage, { paperId: 7, onBack: () => {} }))
      await waitFor(() => expect(pageTitle()).toBe('论文7'))
      fire({ paperId: 7, phase: 'done' })
      rerender(h(PaperDetailPage, { paperId: 8, onBack: () => {} }))
      await waitFor(() => expect(pageTitle()).toBe('论文8'))
      await new Promise((r) => setTimeout(r, 1700))
      expect(pageTitle()).toBe('论文8')
    } finally {
      if (firstMock && original) firstMock.getPaperMeta = original
    }
  })

  it('拿不到路径（getPathForFile 返回空串）：toast 提示且不发 cand:attachPdf（建议修 3）', async () => {
    installMock()
    // 组件模块级 api 捕获的是 beforeAll 的第一个 mock 对象——直接改它的方法
    const original = firstMock?.getPathForFile
    if (firstMock) firstMock.getPathForFile = () => ''
    const toasts: string[] = []
    render(
      h(NotifyContext.Provider, { value: (m) => toasts.push(m) }, h(PaperDetailPage, { paperId: 7, onBack: () => {} }))
    )
    const input = (await screen.findByTestId('nopdf-file-input')) as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['%PDF-x'], 'paper.pdf', { type: 'application/pdf' })] } })
    await waitFor(() => expect(toasts.some((t) => t.includes('路径'))).toBe(true))
    expect(attachCalls).toEqual([])
    if (firstMock) firstMock.getPathForFile = original
  })

  it('同一页换 paperId：上一篇的进度与尝试记录复位（评审必须修 2）', async () => {
    installMock()
    const { rerender } = render(h(PaperDetailPage, { paperId: 7, onBack: () => {} }))
    await screen.findByTestId('nopdf-drop')
    fire({ paperId: 7, phase: 'locating' })
    expect(screen.getByTestId('nopdf-progress').textContent).toContain('查找 PDF')
    // 候选卡「打开论文」在同页换 paperId（App 不加 key）——旧进度不能画到新论文上
    rerender(h(PaperDetailPage, { paperId: 8, onBack: () => {} }))
    await screen.findByTestId('nopdf-drop')
    expect(screen.queryByTestId('nopdf-progress')).toBeNull()
  })

  it('别人的论文进度不干扰本页', async () => {
    installMock()
    renderPage()
    await screen.findByTestId('nopdf-drop')
    fire({ paperId: 99, phase: 'downloading' })
    expect(screen.queryByTestId('nopdf-progress')).toBeNull()
  })
})


describe('uat1b：详情页来源行按真实 PDF 状态显示', () => {
  it('无 PDF 条目：「条目没有 PDF 附件」；有附件没找到文件：如实文案 + 补齐提示；item key 不进主文案', async () => {
    installMock()
    const original = firstMock!.getPaperMeta

    // 态 1：Zotero 条目确实没有 PDF 附件
    ;(firstMock as { getPaperMeta: (id: number) => Promise<PaperMetaView> }).getPaperMeta = async (id: number) => ({
      ...META_NO_PDF,
      paperId: id,
      pdfUnresolved: false
    })
    const v1 = render(h(PaperDetailPage, { paperId: 7, onBack: () => {} }))
    await waitFor(() => expect(screen.getByText(/（条目没有 PDF 附件）/)).toBeTruthy())
    expect(screen.queryByText(/没找到文件/)).toBeNull()
    v1.unmount()

    // 态 2：条目有 PDF 附件但导入时没取到文件（papers.pdf_unresolved=1）
    ;(firstMock as { getPaperMeta: (id: number) => Promise<PaperMetaView> }).getPaperMeta = async (id: number) => ({
      ...META_NO_PDF,
      paperId: id,
      pdfUnresolved: true
    })
    render(h(PaperDetailPage, { paperId: 7, onBack: () => {} }))
    await waitFor(() => expect(screen.getByText(/（条目有 PDF 附件，但没找到文件）/)).toBeTruthy())
    expect(screen.getByText(/重新导入该分类补齐/)).toBeTruthy()
    // item key 是开发者字段：只在 tooltip，不在主文案
    expect(screen.queryByText(/item key/)).toBeNull()
    expect(screen.getByTestId('paper-detail-page').textContent).not.toContain('（条目没有附带 PDF）')

    ;(firstMock as { getPaperMeta: unknown }).getPaperMeta = original
  })

  it('有 PDF 时来源行如实写 PDF 来自哪里（Zotero / 开放获取）', async () => {
    installMock()
    const original = firstMock!.getPaperMeta
    ;(firstMock as { getPaperMeta: (id: number) => Promise<PaperMetaView> }).getPaperMeta = async (id: number) => ({
      ...META_NO_PDF,
      paperId: id,
      hasPdf: true,
      pdfSource: 'open_access'
    })
    const v = render(h(PaperDetailPage, { paperId: 7, onBack: () => {} }))
    // 无详情 → 处理中视图，head 元信息行含来源
    await waitFor(() => expect(screen.getByText(/PDF 来自 开放获取/)).toBeTruthy())
    v.unmount()

    ;(firstMock as { getPaperMeta: (id: number) => Promise<PaperMetaView> }).getPaperMeta = async (id: number) => ({
      ...META_NO_PDF,
      paperId: id,
      hasPdf: true,
      pdfSource: 'zotero'
    })
    render(h(PaperDetailPage, { paperId: 7, onBack: () => {} }))
    await waitFor(() => expect(screen.getByText(/PDF 来自 Zotero/)).toBeTruthy())
    ;(firstMock as { getPaperMeta: unknown }).getPaperMeta = original
  })
})


describe('uat1b D144：详情页「等待解析组件」', () => {
  it('MinerU 已停止 + 有 PDF 未处理：显示原因 + 「去设置（PDF 解析）」直达', async () => {
    installMock()
    const original = firstMock!.getPaperMeta
    const originalStatus = (firstMock as Record<string, unknown>).getPapersStatus
    const g = window as unknown as { graphictero: Record<string, unknown> }
    const originalMineru = g.graphictero.getMineruStatus
    const opened: string[] = []
    ;(firstMock as { getPaperMeta: (id: number) => Promise<PaperMetaView> }).getPaperMeta = async (id: number) => ({
      ...META_NO_PDF,
      paperId: id,
      hasPdf: true,
      pdfSource: 'zotero'
    })
    // getPapersStatus 返回 unprocessed（usePapersStatus 捕获的是 firstMock）；
    // sidecar 已停止 → mineruReason 非空（useMineruStatus 走 mineruApi() 读 window.graphictero 新对象）
    ;(firstMock as { getPapersStatus: unknown }).getPapersStatus = async () => [
      { paperId: 7, jobId: null, state: 'unprocessed', currentStep: null, failedStep: null, error: null, updatedAt: null, detailRegen: null }
    ]
    g.graphictero.getMineruStatus = async () => ({
      state: 'stopped', version: '4.0.12', port: null, pid: null, error: null,
      installProgress: null, modelsPath: '/tmp/v', modelsReady: true
    })
    render(h(PaperDetailPage, { paperId: 7, onBack: () => {}, onOpenSettings: () => opened.push('settings') }))
    const box = await screen.findByTestId('pd-wait-parse')
    expect(box.textContent).toContain('解析组件已停止')
    expect(box.textContent).toContain('可用后会自动开始处理')
    expect(screen.getByText('等待解析组件')).toBeTruthy()
    fireEvent.click(screen.getByText('去设置（PDF 解析）'))
    expect(opened).toEqual(['settings'])
    ;(firstMock as { getPaperMeta: unknown }).getPaperMeta = original
    ;(firstMock as Record<string, unknown>).getPapersStatus = originalStatus
    g.graphictero.getMineruStatus = originalMineru
  })

  it('MinerU 可用（ready）时回到原「未处理」口径，不显示等待解析组件', async () => {
    installMock()
    const original = firstMock!.getPaperMeta
    const originalStatus = (firstMock as Record<string, unknown>).getPapersStatus
    const g = window as unknown as { graphictero: Record<string, unknown> }
    ;(firstMock as { getPaperMeta: (id: number) => Promise<PaperMetaView> }).getPaperMeta = async (id: number) => ({
      ...META_NO_PDF,
      paperId: id,
      hasPdf: true,
      pdfSource: 'zotero'
    })
    ;(firstMock as { getPapersStatus: unknown }).getPapersStatus = async () => [
      { paperId: 7, jobId: null, state: 'unprocessed', currentStep: null, failedStep: null, error: null, updatedAt: null, detailRegen: null }
    ]
    // getMineruStatus 默认返回 unavailable（installMock）→ 占位态不适用 D144，保持「未处理」口径
    render(h(PaperDetailPage, { paperId: 7, onBack: () => {} }))
    await waitFor(() => expect(screen.getByText('等待处理')).toBeTruthy())
    expect(screen.queryByTestId('pd-wait-parse')).toBeNull()
    expect(screen.getByText('未处理：MinerU 可用后会自动开始处理。')).toBeTruthy()
    ;(firstMock as { getPaperMeta: unknown }).getPaperMeta = original
    ;(firstMock as Record<string, unknown>).getPapersStatus = originalStatus
  })
})

describe('uat5 D170：详情「可能已过期」提示——灰色小字 + 「重新生成」按钮', () => {
  it('staleReason 非空时渲染低调提示条（无警告样式类名），含「重新生成」入口', async () => {
    installMock()
    const originalMeta = firstMock!.getPaperMeta
    const originalDetail = firstMock!.getDetail
    ;(firstMock as { getPaperMeta: (id: number) => Promise<PaperMetaView> }).getPaperMeta = async (id: number) => ({
      ...META_NO_PDF,
      paperId: id,
      hasPdf: true
    })
    ;(firstMock as { getDetail: (id: number) => Promise<DetailView | null> }).getDetail = async (id: number) => ({
      paperId: id,
      parts: [{ type: 'text', text: '详情正文' }],
      model: 'deepseek-flash',
      generatedAt: '2026-10-26T12:00:00.000Z',
      promptVersion: 'detail-v2',
      staleReason: 'prompt'
    })
    try {
      render(h(PaperDetailPage, { paperId: 7, onBack: () => {} }))
      const bar = await screen.findByTestId('stale-bar')
      expect(bar.className).toBe('gt-pd-stale') // 灰阶样式类（D170：不用警告样式）
      expect(bar.textContent).toContain('可能已过期')
      expect(bar.textContent).toContain('重新生成')
      expect(bar.querySelector('.gt-pd-linkbtn')?.textContent).toBe('重新生成')
    } finally {
      if (firstMock) {
        firstMock.getPaperMeta = originalMeta
        firstMock.getDetail = originalDetail
      }
    }
  })
})
