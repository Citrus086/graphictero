// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement as h } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnnotationView, FigureView } from '../../../shared/ipc/pdf'

/**
 * uat3 阅读器渲染层单测（必须修 1/2/5/7）：mock EmbedPDF 插件时序——
 * 滚动插件「布局晚于 doc 就绪」、划选选区保留 + 复制、笔记 Esc、⌘F 搜索开合与计数。
 * 全部构造数据，不加载 wasm / 不触引擎网络。
 */

/* ---------- mock 插件（holder 模式，测试里可改写时序） ---------- */

const holder: {
  layoutReady: boolean
  currentPage: number
  layouts: Array<{ pageIndex: number; width: number; height: number }>
  scrollToPage: ReturnType<typeof vi.fn>
  listeners: Array<() => void>
  engine: unknown
} = {
  layoutReady: false,
  currentPage: 1,
  layouts: [],
  scrollToPage: vi.fn(),
  listeners: [],
  engine: null
}

vi.mock('@embedpdf/plugin-viewport/react', () => ({
  Viewport: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    h('div', { className }, children)
}))

vi.mock('@embedpdf/plugin-scroll/react', () => ({
  Scroller: ({ renderPage }: { renderPage: (l: { pageIndex: number; width: number; height: number }) => React.ReactNode }) =>
    h(
      'div',
      { 'data-testid': 'scroller' },
      holder.layouts.map((l) => h('div', { key: l.pageIndex, 'data-page-index': l.pageIndex }, renderPage(l)))
    ),
  useScroll: () => ({
    state: { currentPage: holder.currentPage, totalPages: 2 },
    provides: {
      scrollToPage: (o: { pageNumber: number; behavior: string }) => (holder.scrollToPage as (...a: unknown[]) => void)(o),
      getCurrentPage: () => holder.currentPage,
      getLayout: () => ({
        virtualItems: holder.layoutReady ? [{ index: 0 }] : [],
        totalContentSize: { width: 100, height: 100 }
      }),
      onLayoutChange: (cb: () => void) => {
        holder.listeners.push(cb)
        return () => {
          holder.listeners = holder.listeners.filter((x) => x !== cb)
        }
      }
    }
  })
}))

vi.mock('@embedpdf/plugin-render/react', () => ({
  RenderLayer: () => h('div', { 'data-testid': 'render-layer' })
}))

vi.mock('@embedpdf/plugin-zoom/react', () => ({
  useZoomCapability: () => ({ provides: null }),
  useZoom: () => ({ state: { currentZoomLevel: 1, zoomLevel: 1 } })
}))

const pageOf = (index: number) => ({ index, size: { width: 400, height: 600 } })
const FAKE_DOC = { pages: [pageOf(0), pageOf(1)] }

function makeEngine(): unknown {
  return {
    openDocumentBuffer: () => ({ toPromise: async () => FAKE_DOC }),
    getBookmarks: () => ({ toPromise: async () => ({ bookmarks: [] }) }),
    getPageTextRects: () => ({
      toPromise: async () => [
        { content: 'Hello world', rect: { origin: { x: 10, y: 10 }, size: { width: 100, height: 12 } }, font: { family: 'F', size: 10 } }
      ]
    }),
    searchAllPages: () => ({ toPromise: async () => ({ results: [], total: 0 }) })
  }
}

/** uat3b 必须修 3：两行文字的引擎（第二行不应被带进引文） */
function makeTwoLineEngine(): unknown {
  return {
    openDocumentBuffer: () => ({ toPromise: async () => FAKE_DOC }),
    getBookmarks: () => ({ toPromise: async () => ({ bookmarks: [] }) }),
    getPageTextRects: () => ({
      toPromise: async () => [
        { content: '第一行内容', rect: { origin: { x: 10, y: 10 }, size: { width: 100, height: 12 } }, font: { family: 'F', size: 10 } },
        { content: '第二行内容', rect: { origin: { x: 10, y: 40 }, size: { width: 100, height: 12 } }, font: { family: 'F', size: 10 } }
      ]
    }),
    searchAllPages: () => ({ toPromise: async () => ({ results: [], total: 0 }) })
  }
}

/* ---------- window.graphictero 与标注存储 ---------- */

const FIGS: FigureView[] = [{ page: 1, bbox: [0.1, 0.1, 0.5, 0.3], caption: 'Figure 2', imageSource: null, figureNo: 2 }]

const annStore: AnnotationView[] = []
let nextAnnId = 100
const apiMock = {
  listAnnotations: vi.fn(async () => annStore),
  listFigures: vi.fn(async () => FIGS),
  createAnnotation: vi.fn(async (_pid: number, a: Record<string, unknown>) => {
    const created = { id: nextAnnId++, ...a, note: null } as unknown as AnnotationView
    annStore.push(created)
    return created
  }),
  updateAnnotation: vi.fn(async () => {}),
  deleteAnnotation: vi.fn(async (id: number) => {
    const i = annStore.findIndex((a) => a.id === id)
    if (i >= 0) annStore.splice(i, 1)
  })
}

const PAPER = { id: 1, title: 'T', authors: '', year: null, venue: null, hasPdf: true } as never

/** PdfReader 模块顶层捕获 window.graphictero——先装 mock 再动态 import */
let ReaderInner: typeof import('./PdfReader').ReaderInner

beforeAll(async () => {
  ;(window as unknown as { graphictero: unknown }).graphictero = apiMock
  ReaderInner = (await import('./PdfReader')).ReaderInner
})

afterAll(() => {
  delete (window as unknown as { graphictero?: unknown }).graphictero
})

function renderReader(initialFigureNo?: number, onClose = vi.fn()): ReturnType<typeof render> {
  return render(
    h(ReaderInner, {
      registry: { getStore: () => ({ dispatch: vi.fn() }) },
      engine: holder.engine as import('@embedpdf/models').PdfEngine,
      bytes: new Uint8Array([1, 2, 3]),
      paper: PAPER,
      initialFigureNo,
      onClose
    })
  )
}

/** 连冲几个微任务回合，把引擎 promise 链全部落定 */
async function flush(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

beforeEach(() => {
  holder.layoutReady = false
  holder.currentPage = 1
  holder.layouts = []
  holder.scrollToPage = vi.fn()
  holder.listeners = []
  holder.engine = makeEngine()
  annStore.length = 0
  nextAnnId = 100
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('uat3 必须修 1：布局晚于 doc 就绪仍能跳到目标页', () => {
  it('virtualItems 未建立时不跳；布局就绪后 instant 跳到图所在页，到达后亮闪烁', async () => {
    renderReader(2)
    await flush()
    // doc 就绪但布局未就绪：不发起跳转
    expect(holder.scrollToPage).not.toHaveBeenCalled()
    // 布局就绪（滚动插件排好页）→ onLayoutChange 触发
    holder.layoutReady = true
    holder.layouts = [
      { pageIndex: 0, width: 400, height: 600 },
      { pageIndex: 1, width: 400, height: 600 }
    ]
    await act(async () => {
      holder.listeners.forEach((cb) => cb())
    })
    expect(holder.scrollToPage).toHaveBeenCalledWith({ pageNumber: 2, behavior: 'instant' })
    // 还没到达 → 有限重试
    await act(async () => {
      vi.advanceTimersByTime(450)
    })
    expect(holder.scrollToPage.mock.calls.length).toBeGreaterThan(1)
    // 到达目标页 → 闪烁高亮出现（到达才亮，保证在视口内）
    holder.currentPage = 2
    await act(async () => {
      vi.advanceTimersByTime(250)
    })
    expect(screen.getByTestId('fig-flash')).toBeTruthy()
    // 高亮 1.5s 后消失
    await act(async () => {
      vi.advanceTimersByTime(1600)
    })
    expect(screen.queryByTestId('fig-flash')).toBeNull()
  })

  it('重试有上限：一直不到达也会停止，不死循环', async () => {
    renderReader(2)
    await flush()
    holder.layoutReady = true
    await act(async () => {
      holder.listeners.forEach((cb) => cb())
    })
    await act(async () => {
      vi.advanceTimersByTime(60 * 1000)
    })
    const calls = holder.scrollToPage.mock.calls.length
    expect(calls).toBeGreaterThanOrEqual(1)
    expect(calls).toBeLessThanOrEqual(8) // 首次 + 6 次重试以内
  })
})

describe('uat3 必须修 2：mouseup 保留选区 + 弹层「复制」', () => {
  it('mouseup 后选区仍在；点「复制」写剪贴板并关弹层', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true })
    holder.layoutReady = true
    holder.layouts = [{ pageIndex: 0, width: 400, height: 600 }]
    renderReader()
    await flush()
    const layer = document.querySelector('.gt-textlayer') as HTMLElement
    expect(layer).toBeTruthy()
    const span = layer.querySelector('span') as HTMLElement
    // 构造真实选区
    // jsdom 的 Range 无 getClientRects——补一个桩再构造选区
    const fakeRect = { left: 12, top: 12, width: 96, height: 12, right: 108, bottom: 24, x: 12, y: 12, toJSON: () => ({}) } as DOMRect
    Range.prototype.getClientRects = (() => [fakeRect]) as unknown as () => DOMRectList
    const range = document.createRange()
    range.selectNodeContents(span)
    const sel = window.getSelection() as Selection
    sel.removeAllRanges()
    sel.addRange(range)
    fireEvent.mouseUp(layer, { clientX: 60, clientY: 30 })
    // 选区未被清除（⌘C 可用）
    expect(window.getSelection()?.rangeCount).toBe(1)
    expect(window.getSelection()?.toString()).toBe('Hello world')
    // 弹层四个按钮：高亮 / 笔记 / 复制 / 发给 agent
    expect(screen.getAllByTestId(/^sel-/).map((b) => b.getAttribute('data-testid'))).toEqual([
      'sel-highlight',
      'sel-note',
      'sel-copy',
      'sel-agent'
    ])
    fireEvent.click(screen.getByTestId('sel-copy'))
    await flush(2)
    expect(writeText).toHaveBeenCalledWith('Hello world')
    expect(screen.queryByTestId('selpop')).toBeNull()
    // 弹层关闭后选区被清掉
    expect(window.getSelection()?.rangeCount ?? 0).toBe(0)
  })

  it('uat5 建议修 2：⌘C 与「复制」按钮同口径——复制清洗后文本（软连字符已去）', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true })
    // 引擎文本里带软连字符 \u0002（pdfium 断词标记）：清洗后应为 'hyphenated'
    holder.engine = {
      ...(makeEngine() as Record<string, unknown>),
      getPageTextRects: () => ({
        toPromise: async () => [
          { content: 'hy\u0002phenated', rect: { origin: { x: 10, y: 10 }, size: { width: 100, height: 12 } }, font: { family: 'F', size: 10 } }
        ]
      })
    }
    holder.layoutReady = true
    holder.layouts = [{ pageIndex: 0, width: 400, height: 600 }]
    renderReader()
    await flush()
    const layer = document.querySelector('.gt-textlayer') as HTMLElement
    const span = layer.querySelector('span') as HTMLElement
    const fakeRect = { left: 12, top: 12, width: 96, height: 12, right: 108, bottom: 24, x: 12, y: 12, toJSON: () => ({}) } as DOMRect
    Range.prototype.getClientRects = (() => [fakeRect]) as unknown as () => DOMRectList
    const range = document.createRange()
    range.selectNodeContents(span)
    const sel = window.getSelection() as Selection
    sel.removeAllRanges()
    sel.addRange(range)
    fireEvent.mouseUp(layer, { clientX: 60, clientY: 30 })
    // ⌘C：与「复制」按钮同口径（sel.text 已是清洗后文本）
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true, cancelable: true }))
    })
    await flush(2)
    expect(writeText).toHaveBeenCalledWith('hyphenated')
  })
})

describe('uat3b 必须修 3：引文只含选区实际划过的文字', () => {
  it('选区 DOM 跨两行、但选区矩形只罩住第一行 → 发给 agent 的引文只有第一行', async () => {
    holder.engine = makeTwoLineEngine()
    holder.layoutReady = true
    holder.layouts = [{ pageIndex: 0, width: 400, height: 600 }]
    const onSendToAgent = vi.fn()
    render(
      h(ReaderInner, {
        registry: { getStore: () => ({ dispatch: vi.fn() }) },
        engine: holder.engine as import('@embedpdf/models').PdfEngine,
        bytes: new Uint8Array([1]),
        paper: PAPER,
        onClose: vi.fn(),
        onSendToAgent
      })
    )
    await flush()
    const layer = document.querySelector('.gt-textlayer') as HTMLElement
    const spans = Array.from(layer.querySelectorAll('span'))
    expect(spans).toHaveLength(2)
    // 视觉包围盒：第一行 y=10，第二行 y=40
    spans.forEach((s, i) => {
      const top = i === 0 ? 10 : 40
      Object.defineProperty(s, 'getBoundingClientRect', {
        value: () => ({ left: 10, top, width: 100, height: 12, right: 110, bottom: top + 12, x: 10, y: top, toJSON: () => ({}) }),
        configurable: true
      })
    })
    // 选区：DOM 上从第一行跨到第二行（旧行为会两行都发）
    const range = document.createRange()
    range.setStart(spans[0].firstChild as Node, 0)
    range.setEnd(spans[1].firstChild as Node, (spans[1].textContent ?? '').length)
    // 但浏览器画的选区矩形只罩住第一行（用户只划过第一行）
    Object.defineProperty(range, 'getClientRects', {
      value: () => [{ left: 9, top: 9, width: 102, height: 14, right: 111, bottom: 23 }],
      configurable: true
    })
    const sel = window.getSelection() as Selection
    sel.removeAllRanges()
    sel.addRange(range)
    fireEvent.mouseUp(layer, { clientX: 60, clientY: 15 })
    expect(screen.getByTestId('selpop')).toBeTruthy()
    fireEvent.click(screen.getByTestId('sel-agent'))
    expect(onSendToAgent).toHaveBeenCalledWith({ text: '第一行内容', page: 0 })
  })
})

describe('uat3 必须修 5：写笔记时 Esc 只取消编辑', () => {
  it('笔记卡编辑中 Esc → 阅读器仍打开；空锚点被删除、不留空笔记', async () => {
    holder.layoutReady = true
    holder.layouts = [{ pageIndex: 0, width: 400, height: 600 }]
    renderReader()
    await flush()
    // 进笔记工具模式 → 在文本层上点页面 → 建空锚点 → 笔记卡出现
    fireEvent.click(screen.getByTestId('tool-note'))
    fireEvent.mouseUp(document.querySelector('.gt-textlayer') as HTMLElement, { clientX: 50, clientY: 50 })
    await flush()
    expect(screen.getByTestId('notecard')).toBeTruthy()
    // Esc：阅读器不关、空锚点删除
    fireEvent.keyDown(screen.getByTestId('notecard').querySelector('textarea') as HTMLElement, { key: 'Escape' })
    await flush(2)
    expect(apiMock.deleteAnnotation).toHaveBeenCalledWith(100)
    expect(screen.queryByTestId('notecard')).toBeNull()
    expect(screen.getByTestId('pageno')).toBeTruthy() // 阅读器仍开着
  })

  it('uat5 必须修 3：草稿非空时 Esc 按保存处理——文字不丢、笔记卡关闭、无（空笔记）', async () => {
    holder.layoutReady = true
    holder.layouts = [{ pageIndex: 0, width: 400, height: 600 }]
    renderReader()
    await flush()
    fireEvent.click(screen.getByTestId('tool-note'))
    fireEvent.mouseUp(document.querySelector('.gt-textlayer') as HTMLElement, { clientX: 50, clientY: 50 })
    await flush()
    const ta = screen.getByTestId('notecard').querySelector('textarea') as HTMLElement
    fireEvent.change(ta, { target: { value: '这段值得再读' } } as never)
    fireEvent.keyDown(ta, { key: 'Escape' })
    await flush(2)
    // Esc = 保存：updateAnnotation 落了草稿，deleteAnnotation 没被调（不是空笔记）
    expect(apiMock.updateAnnotation).toHaveBeenCalledWith(100, { note: '这段值得再读' })
    expect(apiMock.deleteAnnotation).not.toHaveBeenCalled()
    expect(screen.queryByTestId('notecard')).toBeNull()
    expect(screen.getByTestId('pageno')).toBeTruthy() // 阅读器仍开着
    // 侧栏列表不出现「（空笔记）」
    expect(screen.queryByText('（空笔记）')).toBeNull()
  })

  it('uat5 必须修 3：侧栏笔记编辑 Esc 同样保留草稿', async () => {
    annStore.push({ id: 200, paperId: 1, page: 0, type: 'note', text: '', note: '旧笔记', color: 'yellow', bbox: [1, 1, 8, 8], quads: [], createdAt: 't', updatedAt: 't' })
    holder.layoutReady = true
    holder.layouts = [{ pageIndex: 0, width: 400, height: 600 }]
    renderReader()
    await flush()
    fireEvent.click(screen.getByTestId('tab-ann'))
    await flush()
    fireEvent.click(screen.getByTestId('annlist').querySelector('.gt-annitem .hd') as HTMLElement)
    await flush()
    const ta = screen.getByTestId('annlist').querySelector('textarea') as HTMLElement
    fireEvent.change(ta, { target: { value: '旧笔记，补充一句' } } as never)
    fireEvent.keyDown(ta, { key: 'Escape' })
    await flush(2)
    expect(apiMock.updateAnnotation).toHaveBeenCalledWith(200, { note: '旧笔记，补充一句' })
  })

  it('uat5 必须修 3：新建后什么都不输入就 Esc → 无笔记行、无「（空笔记）」', async () => {
    holder.layoutReady = true
    holder.layouts = [{ pageIndex: 0, width: 400, height: 600 }]
    renderReader()
    await flush()
    fireEvent.click(screen.getByTestId('tool-note'))
    fireEvent.mouseUp(document.querySelector('.gt-textlayer') as HTMLElement, { clientX: 50, clientY: 50 })
    await flush()
    fireEvent.keyDown(screen.getByTestId('notecard').querySelector('textarea') as HTMLElement, { key: 'Escape' })
    await flush(2)
    expect(annStore).toHaveLength(0) // 空锚点没落库
    fireEvent.click(screen.getByTestId('tab-ann'))
    await flush()
    expect(screen.queryByText('（空笔记）')).toBeNull()
  })

  it('uat5-fix1 S5：空锚点 Esc 静默删除——不弹撤销 toast（D171 删除按钮路径才有）', async () => {
    holder.layoutReady = true
    holder.layouts = [{ pageIndex: 0, width: 400, height: 600 }]
    renderReader()
    await flush()
    fireEvent.click(screen.getByTestId('tool-note'))
    fireEvent.mouseUp(document.querySelector('.gt-textlayer') as HTMLElement, { clientX: 50, clientY: 50 })
    await flush()
    fireEvent.keyDown(screen.getByTestId('notecard').querySelector('textarea') as HTMLElement, { key: 'Escape' })
    await flush(2)
    expect(apiMock.deleteAnnotation).toHaveBeenCalledWith(100) // 空锚点已删
    expect(screen.queryByTestId('ann-undo-toast')).toBeNull() // 静默：不进撤销栈
    // 对照：删除按钮路径仍给可撤销 toast（D171 不变）
    annStore.push({ id: 301, paperId: 1, page: 0, type: 'note', text: '', note: '有内容', color: 'yellow', bbox: [1, 1, 8, 8], quads: [], createdAt: 't', updatedAt: 't' })
    fireEvent.click(screen.getByTestId('tab-ann'))
    await flush()
    fireEvent.click(screen.getByTestId('annlist').querySelector('.gt-annitem .hd') as HTMLElement)
    await flush()
    // 侧栏行内与页边笔记卡都有「删除」——点侧栏行内那个（同一 remove 路径）
    const delBtn = screen.getAllByRole('button', { name: '删除' })[0]
    fireEvent.click(delBtn)
    await flush(2)
    expect(screen.getByTestId('ann-undo-toast')).toBeTruthy() // 按钮路径照旧
  })

  it('uat6b S1：笔记卡打开即自动聚焦 textarea（工具栏「笔记」入口）', async () => {
    holder.layoutReady = true
    holder.layouts = [{ pageIndex: 0, width: 400, height: 600 }]
    renderReader()
    await flush()
    fireEvent.click(screen.getByTestId('tool-note'))
    fireEvent.mouseUp(document.querySelector('.gt-textlayer') as HTMLElement, { clientX: 50, clientY: 50 })
    await flush()
    const ta = screen.getByTestId('notecard').querySelector('textarea') as HTMLTextAreaElement
    expect(document.activeElement).toBe(ta) // 复测现场 activeElement=BODY（截图 15b/21）
  })

  it('uat6b S1：选区弹层「笔记」入口同样自动聚焦（侧栏行内编辑框）', async () => {
    holder.layoutReady = true
    holder.layouts = [{ pageIndex: 0, width: 400, height: 600 }]
    renderReader()
    await flush()
    const layer = document.querySelector('.gt-textlayer') as HTMLElement
    const span = layer.querySelector('span') as HTMLElement
    Object.defineProperty(span, 'getBoundingClientRect', {
      value: () => ({ left: 10, top: 10, width: 100, height: 12, right: 110, bottom: 22, x: 10, y: 10, toJSON: () => ({}) }),
      configurable: true
    })
    const range = document.createRange()
    range.setStart(span.firstChild as Node, 0)
    range.setEnd(span.firstChild as Node, 5)
    Object.defineProperty(range, 'getClientRects', {
      value: () => [{ left: 9, top: 9, width: 60, height: 14, right: 69, bottom: 23 }],
      configurable: true
    })
    const sel = window.getSelection() as Selection
    sel.removeAllRanges()
    sel.addRange(range)
    fireEvent.mouseUp(layer, { clientX: 30, clientY: 15 })
    await flush()
    fireEvent.click(screen.getByTestId('sel-note'))
    await flush()
    // 选区「笔记」= 建高亮 + 侧栏行内编辑框（不是页边独立笔记卡）
    const ta = screen.getByTestId('annlist').querySelector('textarea') as HTMLTextAreaElement
    expect(ta).toBeTruthy()
    expect(document.activeElement).toBe(ta)
  })

  it('uat6b S1：焦点不在 textarea 时 Esc 先取消笔记编辑——空锚点静默删除、阅读器仍开；再按 Esc 才关', async () => {
    const onClose = vi.fn()
    holder.layoutReady = true
    holder.layouts = [{ pageIndex: 0, width: 400, height: 600 }]
    renderReader(undefined, onClose)
    await flush()
    fireEvent.click(screen.getByTestId('tool-note'))
    fireEvent.mouseUp(document.querySelector('.gt-textlayer') as HTMLElement, { clientX: 50, clientY: 50 })
    await flush()
    expect(screen.getByTestId('notecard')).toBeTruthy()
    ;(document.activeElement as HTMLElement | null)?.blur?.() // 复现复测现场：未手动聚焦
    expect(document.activeElement).toBe(document.body)
    fireEvent.keyDown(document.body, { key: 'Escape' }) // 全局处理器：先 cancelNoteEdit，不关阅读器
    await flush(2)
    expect(apiMock.deleteAnnotation).toHaveBeenCalledWith(100) // 空锚点已删
    expect(screen.queryByTestId('notecard')).toBeNull()
    expect(screen.getByTestId('pageno')).toBeTruthy() // 阅读器仍开着
    expect(screen.queryByTestId('ann-undo-toast')).toBeNull() // 静默：无 toast
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('tab-ann'))
    await flush()
    expect(screen.queryByText('（空笔记）')).toBeNull() // 不留空笔记行
    fireEvent.keyDown(document.body, { key: 'Escape' }) // 没有编辑中的笔记 → 行为不变
    expect(onClose).toHaveBeenCalled()
  })

  it('uat6b S4(c)：空锚点点「保存」与 Esc 同口径静默删除——不弹可撤销 toast（删除按钮路径仍有）', async () => {
    holder.layoutReady = true
    holder.layouts = [{ pageIndex: 0, width: 400, height: 600 }]
    renderReader()
    await flush()
    fireEvent.click(screen.getByTestId('tool-note'))
    fireEvent.mouseUp(document.querySelector('.gt-textlayer') as HTMLElement, { clientX: 50, clientY: 50 })
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await flush(2)
    expect(apiMock.deleteAnnotation).toHaveBeenCalledWith(100)
    expect(screen.queryByTestId('ann-undo-toast')).toBeNull() // 静默删除（uat5 之前弹可撤销 toast）
    expect(screen.getByTestId('pageno')).toBeTruthy() // 阅读器不关
  })

  it('uat6b-fix1 M1(a)：空锚点输入文字 → blur → 对 body 发 Esc：按保存处理（updateAnnotation 收到文字），不静默删除', async () => {
    holder.layoutReady = true
    holder.layouts = [{ pageIndex: 0, width: 400, height: 600 }]
    renderReader()
    await flush()
    fireEvent.click(screen.getByTestId('tool-note'))
    fireEvent.mouseUp(document.querySelector('.gt-textlayer') as HTMLElement, { clientX: 50, clientY: 50 })
    await flush()
    const ta = screen.getByTestId('notecard').querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '刚写的笔记' } } as never)
    ta.blur() // 焦点离开 textarea（uat5 复测现场形态）
    expect(document.activeElement).toBe(document.body)
    fireEvent.keyDown(document.body, { key: 'Escape' }) // 全局 Esc：必须按**最新草稿**保存
    await flush(2)
    expect(apiMock.updateAnnotation).toHaveBeenCalledWith(100, { note: '刚写的笔记' })
    expect(apiMock.deleteAnnotation).not.toHaveBeenCalled() // 不静默删除（旧闭包会删）
    expect(screen.getByTestId('pageno')).toBeTruthy() // 阅读器仍开
    expect(screen.queryByTestId('notecard')).toBeNull() // 编辑态退出
  })

  it('uat6b-fix1 M1(b)：已有笔记改草稿 → 失焦 → 对 body 发 Esc：保存新文字（不用打开编辑时的旧草稿）', async () => {
    annStore.push({ id: 200, paperId: 1, page: 0, type: 'note', text: '', note: '旧笔记', color: 'yellow', bbox: [1, 1, 8, 8], quads: [], createdAt: 't', updatedAt: 't' })
    holder.layoutReady = true
    holder.layouts = [{ pageIndex: 0, width: 400, height: 600 }]
    renderReader()
    await flush()
    fireEvent.click(screen.getByTestId('tab-ann'))
    await flush()
    fireEvent.click(screen.getByTestId('annlist').querySelector('.gt-annitem .hd') as HTMLElement)
    await flush()
    const ta = screen.getByTestId('annlist').querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '旧笔记，补充的新一句' } } as never)
    ta.blur()
    fireEvent.keyDown(document.body, { key: 'Escape' }) // 失焦后走全局 Esc
    await flush(2)
    expect(apiMock.updateAnnotation).toHaveBeenCalledWith(200, { note: '旧笔记，补充的新一句' })
    expect(apiMock.deleteAnnotation).not.toHaveBeenCalled()
  })

  it('D171：删除标注无确认框，给可撤销 toast，撤销后原样恢复', async () => {
    annStore.push({ id: 300, paperId: 1, page: 0, type: 'highlight', text: 'Hello world', note: '重要', color: 'yellow', bbox: [1, 1, 50, 10], quads: [[1, 1, 50, 10]], createdAt: 't', updatedAt: 't' })
    holder.layoutReady = true
    holder.layouts = [{ pageIndex: 0, width: 400, height: 600 }]
    renderReader()
    await flush()
    fireEvent.click(screen.getByTestId('tab-ann'))
    await flush()
    fireEvent.click(screen.getByTestId('annlist').querySelector('.gt-annitem .hd') as HTMLElement)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await flush(2)
    expect(apiMock.deleteAnnotation).toHaveBeenCalledWith(300)
    expect(screen.getByTestId('ann-undo-toast')).toBeTruthy() // 无确认框，直接删 + toast
    fireEvent.click(screen.getByTestId('ann-undo'))
    await flush(2)
    expect(apiMock.createAnnotation).toHaveBeenCalledWith(1, {
      page: 0,
      type: 'highlight',
      text: 'Hello world',
      color: 'yellow',
      bbox: [1, 1, 50, 10],
      quads: [[1, 1, 50, 10]],
      note: '重要'
    })
    expect(screen.queryByTestId('ann-undo-toast')).toBeNull()
  })

  it('无编辑时 Esc 照旧关阅读器', async () => {
    holder.layoutReady = true
    holder.layouts = [{ pageIndex: 0, width: 400, height: 600 }]
    const onClose = vi.fn()
    renderReader(undefined, onClose)
    await flush()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('uat3 必须修 7：⌘F 打开搜索、Esc 关闭搜索（不关阅读器）', () => {
  it('⌘F → 搜索框出现并聚焦；Esc → 搜索框关闭、阅读器仍开', async () => {
    holder.layoutReady = true
    holder.layouts = [{ pageIndex: 0, width: 400, height: 600 }]
    const onClose = vi.fn()
    renderReader(undefined, onClose)
    await flush()
    expect(screen.queryByTestId('search-box')).toBeNull()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }))
    })
    expect(screen.getByTestId('search-box')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByTestId('search-input'))
    // Esc 先关搜索框，不关阅读器
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(screen.queryByTestId('search-box')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    // 再无编辑时 Esc 才关阅读器
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('uat5 建议修 3：焦点在搜索框里按 Esc 也关搜索（不关阅读器）', async () => {
    holder.layoutReady = true
    holder.layouts = [{ pageIndex: 0, width: 400, height: 600 }]
    const onClose = vi.fn()
    renderReader(undefined, onClose)
    await flush()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }))
    })
    expect(screen.getByTestId('search-box')).toBeTruthy()
    // 焦点在输入框内按 Esc（此前 stopPropagation 挡住全局 handler，搜索框关不掉）
    fireEvent.keyDown(screen.getByTestId('search-input'), { key: 'Escape' })
    expect(screen.queryByTestId('search-box')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('搜索命中计数 n / N，跨页命中高亮、当前命中唯一，下一个循环', async () => {
    holder.engine = {
      ...(makeEngine() as Record<string, unknown>),
      searchAllPages: () => ({
        toPromise: async () => ({
          results: [
            { pageIndex: 0, charIndex: 0, charCount: 5, rects: [{ origin: { x: 1, y: 1 }, size: { width: 10, height: 5 } }], context: {} },
            { pageIndex: 1, charIndex: 0, charCount: 5, rects: [{ origin: { x: 2, y: 2 }, size: { width: 10, height: 5 } }], context: {} }
          ],
          total: 2
        })
      })
    }
    holder.layoutReady = true
    holder.layouts = [
      { pageIndex: 0, width: 400, height: 600 },
      { pageIndex: 1, width: 400, height: 600 }
    ]
    renderReader()
    await flush()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }))
    })
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'test' } } as never)
    await flush()
    expect(screen.getByTestId('hitcount').textContent).toBe('1 / 2')
    expect(document.querySelectorAll('.gt-searchhl').length).toBe(2)
    expect(document.querySelectorAll('.gt-searchhl.cur').length).toBe(1)
    fireEvent.click(screen.getByTestId('search-next'))
    expect(screen.getByTestId('hitcount').textContent).toBe('2 / 2')
    fireEvent.click(screen.getByTestId('search-next'))
    expect(screen.getByTestId('hitcount').textContent).toBe('1 / 2') // 循环
  })
})
