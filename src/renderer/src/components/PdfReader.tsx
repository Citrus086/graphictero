import { useEffect, useMemo, useRef, useState } from 'react'
import { createPluginRegistration, setDocumentError, setDocumentLoaded, startLoadingDocument } from '@embedpdf/core'
import { EmbedPDF } from '@embedpdf/core/react'
import { usePdfiumEngine } from '@embedpdf/engines/react'
import { ViewportPluginPackage } from '@embedpdf/plugin-viewport'
import { Viewport } from '@embedpdf/plugin-viewport/react'
import { ScrollPluginPackage, ScrollStrategy } from '@embedpdf/plugin-scroll'
import { Scroller, useScroll } from '@embedpdf/plugin-scroll/react'
import { RenderPluginPackage } from '@embedpdf/plugin-render'
import { RenderLayer } from '@embedpdf/plugin-render/react'
import { ZoomMode, ZoomPluginPackage } from '@embedpdf/plugin-zoom'
import { useZoom, useZoomCapability } from '@embedpdf/plugin-zoom/react'
import type { PdfBookmarkObject, PdfDocumentObject, PdfEngine, PdfPageObject, PdfTextRectObject, SearchResult } from '@embedpdf/models'
import pdfiumWasmUrl from '@embedpdf/pdfium/pdfium.wasm?url'
import type { AnnotationColor, AnnotationView, FigureView } from '../../../shared/ipc/pdf'
import { ANNOTATION_COLORS, figureNormUnion, mineruNormRectToPageRect, resolveFigureByNo } from '../../../shared/ipc/pdf'
import type { PaperSummary } from '../../../shared/ipc'
import { Ic } from '../lib/icons'
import { useNotify } from '../lib/notify'
import { flattenBookmarks } from '../lib/readerOutline'
import { noteCardTop } from '../lib/noteCard'
import { cleanReaderText, copyText } from '../lib/readerText'
import { selectionTextWithin } from '../lib/selectionText'
import { clipRectContent, textSpanStyle } from '../lib/readerTextLayer'
import { cycleHit, groupSearchMarks, searchResultQuads, type SearchMark } from '../lib/readerSearch'
import { currentMotionDisabled } from '../lib/motion'

/**
 * 内置 PDF 阅读器（D27 + D105 按原型 07）：
 * - 渲染与滚动用 EmbedPDF 插件（RenderLayer/Scroller/Viewport/Zoom）；
 * - 文本层用引擎 getPageTextRects 自建（透明可选中），划选弹「高亮/笔记/发给 agent」
 *   三按钮（发给 agent M5 禁用占位，D105①）；改色在编辑态里；
 * - 工具栏「笔记」模式下点页面建独立笔记锚点 + 页边笔记卡（D105②，数据层 type='note'）；
 * - 左侧栏「缩略图 / 目录 / 标注 / 图」分段控件（D105③；原型为三 tab，「图」为第四批
 *   既有功能并入），右侧不保留单独标注栏；
 * - 入口：详情页「打开 PDF」（D105④，M4 lane/detail 批 1 接线）；库列表行「阅读」
 *   并存（D113：批 2 移除）；两个入口的返回位都回各自的来源页。
 *
 * worker: false —— worker 模式用 blob: URL 建 Worker，会被渲染进程 CSP
 * script-src 'self' 拦下；直引擎在当前线程跑（wasm 编译一次，~百毫秒级）。
 */

const DOC_ID = 'paper'

const plugins = [
  createPluginRegistration(ViewportPluginPackage, { viewportGap: 16 }),
  createPluginRegistration(ScrollPluginPackage, { defaultStrategy: ScrollStrategy.Vertical }),
  createPluginRegistration(RenderPluginPackage),
  createPluginRegistration(ZoomPluginPackage, { defaultZoomLevel: ZoomMode.FitWidth })
]

/** 高亮底色（固定四色；选区弹层不再露出，改色在编辑态） */
const COLOR_BG: Record<AnnotationColor, string> = {
  yellow: 'rgba(255, 212, 0, 0.45)',
  green: 'rgba(120, 220, 120, 0.45)',
  blue: 'rgba(100, 170, 255, 0.45)',
  pink: 'rgba(255, 150, 200, 0.45)'
}
const COLOR_SOLID: Record<AnnotationColor, string> = {
  yellow: '#e6c200',
  green: '#4caf50',
  blue: '#448aff',
  pink: '#e060a8'
}

/** 独立笔记锚点边长（PDF 页面坐标，口径同 Q6 裁定） */
const NOTE_MARK_SIZE = 18

type Quad = [number, number, number, number]

interface SelectionInfo {
  pageIndex: number
  text: string
  quads: Quad[]
  bbox: Quad
  /** 鼠标抬起位置（弹层定位用，视口坐标） */
  x: number
  y: number
}

function unionQuad(quads: Quad[]): Quad {
  const x1 = Math.min(...quads.map((q) => q[0]))
  const y1 = Math.min(...quads.map((q) => q[1]))
  const x2 = Math.max(...quads.map((q) => q[0] + q[2]))
  const y2 = Math.max(...quads.map((q) => q[1] + q[3]))
  return [x1, y1, x2 - x1, y2 - y1]
}

const api = window.graphictero

/**
 * 图号（data-figure 口径 = 论文自身图号，uat2 起按图注解析寻址）→ 图块。
 * 找不到对应图块（含越界 / 非整数 / 缺省）返回 null（正常打开不跳、不崩）。导出供单测。
 */
export function figureForNo(figures: FigureView[], figureNo: number | undefined): FigureView | null {
  if (figureNo == null) return null
  return resolveFigureByNo(figures, figureNo)
}

/** 把 PDF 字节灌进 core store（v2.15 无 loader 插件，按官方 action 手动装载） */
function useLoadDocument(registry: unknown, engine: PdfEngine, bytes: Uint8Array | null): PdfDocumentObject | null {
  const [doc, setDoc] = useState<PdfDocumentObject | null>(null)
  useEffect(() => {
    const reg = registry as {
      getStore: () => { dispatch: (a: unknown) => void }
    } | null
    if (!reg || !bytes) return
    let cancelled = false
    const store = reg.getStore()
    store.dispatch(startLoadingDocument(DOC_ID, 'paper.pdf'))
    // IPC 来的 Uint8Array 可能带 byteOffset，拷贝成独立 ArrayBuffer
    const content = new Uint8Array(bytes).buffer as ArrayBuffer
    engine.openDocumentBuffer({ id: DOC_ID, content }, {}).toPromise().then(
      (d) => {
        if (cancelled) return
        store.dispatch(setDocumentLoaded(DOC_ID, d))
        setDoc(d)
      },
      (err: unknown) => {
        if (cancelled) return
        store.dispatch(setDocumentError(DOC_ID, err instanceof Error ? err.message : String(err)))
      }
    )
    return () => {
      cancelled = true
    }
  }, [registry, engine, bytes])
  return doc
}

/** 单页文本层：引擎文本矩形铺透明 span，原生划选创建高亮 */
function TextLayer({
  engine,
  doc,
  page,
  scale,
  onSelect,
  onPageTap
}: {
  engine: PdfEngine
  doc: PdfDocumentObject
  page: PdfPageObject
  scale: number
  onSelect: (s: SelectionInfo) => void
  /** 评审建 2 / D105②：无选区单击（textlayer 盖住高亮层，页面命中只能靠这里） */
  onPageTap: (pageX: number, pageY: number) => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [items, setItems] = useState<PdfTextRectObject[] | null>(null)
  useEffect(() => {
    let live = true
    engine.getPageTextRects(doc, page).toPromise().then(
      (r) => {
        if (live) setItems(r)
      },
      () => {
        /* 文本提取失败：该页不可划选，阅读不受影响 */
      }
    )
    return () => {
      live = false
    }
  }, [engine, doc, page])

  const handleMouseUp = (e: React.MouseEvent): void => {
    const sel = window.getSelection()
    const container = ref.current
    if (!container) return
    // textlayer 在层序上盖住高亮层（划选需要），单击无选区时把点击点换算页面坐标
    // 交回上层：高亮模式命中标注 quads 进编辑；笔记模式在该点建独立笔记（D105②）
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      const pageRect = container.getBoundingClientRect()
      onPageTap((e.clientX - pageRect.left) / scale, (e.clientY - pageRect.top) / scale)
      return
    }
    const range = sel.getRangeAt(0)
    if (!container.contains(range.commonAncestorContainer)) return
    // uat3b 必须修 3：引文文本按「选区矩形 ∩ span 包围盒」视觉命中重建（DOM 顺序 ≠
    // 视觉顺序时不再带进整页文字），再走 uat3 第 6 条的清洗出口
    const text = cleanReaderText(selectionTextWithin(container, range))
    const pageRect = container.getBoundingClientRect()
    const quads: Quad[] = []
    for (const r of Array.from(range.getClientRects())) {
      if (r.width < 1 || r.height < 1) continue
      quads.push([
        (r.left - pageRect.left) / scale,
        (r.top - pageRect.top) / scale,
        r.width / scale,
        r.height / scale
      ])
    }
    // uat3 必须修 2：mouseup 不清选区——保留划选让 ⌘C 可用；清选区由弹层关闭/下一次划选负责
    if (!text || quads.length === 0) return
    onSelect({ pageIndex: page.index, text, quads, bbox: unionQuad(quads), x: e.clientX, y: e.clientY })
  }

  return (
    <div ref={ref} className="gt-textlayer" onMouseUp={handleMouseUp}>
      {(items ?? []).map((it, i) => (
        // uat3 必须修 3：span 尺寸/变换按文本矩形校正（scaleX 贴合 / 旋转戳记沿长边），
        // 容器与 span 自身裁剪（styles.css overflow:hidden）；
        // uat5 建议修 1：显示文本过 clipRectContent——引擎越界多读的行尾乱码不进
        // 文字层（划选 / 高亮 / 「发给 agent」引文都取 span 文本，同源受益）
        <span key={i} style={textSpanStyle(it, scale)}>
          {clipRectContent(it.content, it.rect.size.width * scale, it.font.size * scale)}
        </span>
      ))}
    </div>
  )
}

/** 单页高亮层：按行级矩形铺色块（点击命中走 textlayer 单击，见评审建 2） */
function HighlightLayer({ annotations, scale }: { annotations: AnnotationView[]; scale: number }): React.JSX.Element {
  return (
    <div className="gt-hllayer">
      {annotations.flatMap((a) =>
        a.quads.map((q, i) => (
          <div
            key={`${a.id}-${i}`}
            data-annid={a.id}
            className="gt-hl"
            style={{
              left: q[0] * scale,
              top: q[1] * scale,
              width: q[2] * scale,
              height: q[3] * scale,
              background: COLOR_BG[a.color]
            }}
          />
        ))
      )}
    </div>
  )
}

/** uat3 必须修 7：搜索命中高亮层（灰阶；当前命中深一档） */
function SearchMarkLayer({ marks, scale }: { marks: SearchMark[] | null; scale: number }): React.JSX.Element {
  if (!marks?.length) return <></>
  return (
    <div className="gt-hllayer">
      {marks.flatMap((m, mi) =>
        m.rects.map((q, qi) => (
          <div
            key={`${mi}-${qi}`}
            className={`gt-searchhl${m.current ? ' cur' : ''}`}
            style={{ left: q[0] * scale, top: q[1] * scale, width: q[2] * scale, height: q[3] * scale }}
          />
        ))
      )}
    </div>
  )
}

/** 单页独立笔记锚点层（D105②，原型 .nmark）：盖在文本层之上，锚点小不挡划选 */
function NoteMarkLayer({
  annotations,
  scale,
  onPick
}: {
  annotations: AnnotationView[]
  scale: number
  onPick: (id: number) => void
}): React.JSX.Element {
  return (
    <div className="gt-nmarklayer">
      {annotations
        .filter((a) => a.type === 'note' && a.bbox)
        .map((a) => (
          <div
            key={a.id}
            data-annid={a.id}
            className="gt-nmark"
            title="笔记（点击编辑）"
            style={{ left: (a.bbox as Quad)[0] * scale, top: (a.bbox as Quad)[1] * scale }}
            onClick={(e) => {
              e.stopPropagation()
              onPick(a.id)
            }}
          >
            <Ic name="note" size={11} w={1.6} />
          </div>
        ))}
    </div>
  )
}

function ReaderPage(props: {
  layout: { pageIndex: number; width: number; height: number }
  engine: PdfEngine
  doc: PdfDocumentObject
  annotations: AnnotationView[]
  /** 「跳到图」的闪烁高亮区域（PDF 页面坐标 [x,y,w,h]；本页才渲染） */
  flashRect: [number, number, number, number] | null
  /** uat3 必须修 7：搜索命中高亮（本页的命中组） */
  searchMarks: SearchMark[] | null
  onSelect: (s: SelectionInfo) => void
  onPageTap: (pageIndex: number, pageX: number, pageY: number) => void
  onPickNote: (id: number) => void
}): React.JSX.Element {
  const { layout, engine, doc, annotations } = props
  const page = doc.pages[layout.pageIndex]
  const scale = layout.width / page.size.width
  return (
    <div className="gt-page" data-page-index={layout.pageIndex} style={{ width: layout.width, height: layout.height }}>
      <RenderLayer documentId={DOC_ID} pageIndex={layout.pageIndex} style={{ width: '100%', height: '100%' }} />
      <HighlightLayer annotations={annotations.filter((a) => a.type === 'highlight')} scale={scale} />
      {props.flashRect && (
        <div
          data-testid="fig-flash"
          className="gt-fighl"
          style={{
            left: props.flashRect[0] * scale,
            top: props.flashRect[1] * scale,
            width: props.flashRect[2] * scale,
            height: props.flashRect[3] * scale
          }}
        />
      )}
      <TextLayer engine={engine} doc={doc} page={page} scale={scale} onSelect={props.onSelect} onPageTap={(x, y) => props.onPageTap(page.index, x, y)} />
      <SearchMarkLayer marks={props.searchMarks} scale={scale} />
      <NoteMarkLayer annotations={annotations} scale={scale} onPick={props.onPickNote} />
    </div>
  )
}

/** 「标注」tab：跳转 / 编辑笔记 / 改色 / 删除（高亮与独立笔记同列表，D105②） */
function AnnotationList({
  annotations,
  editingId,
  noteDraft,
  onJump,
  onEdit,
  onCancel,
  onDraft,
  onSave,
  onColor,
  onDelete
}: {
  annotations: AnnotationView[]
  editingId: number | null
  noteDraft: string
  onJump: (a: AnnotationView) => void
  onEdit: (a: AnnotationView | null) => void
  /** uat5 必须修 3：Esc 走「保留草稿」语义（保存非空草稿 / 删空锚点），不是裸退出 */
  onCancel: () => void
  onDraft: (v: string) => void
  onSave: () => void
  onColor: (a: AnnotationView, c: AnnotationColor) => void
  onDelete: (a: AnnotationView) => void
}): React.JSX.Element {
  return (
    <div className="gt-annlist" data-testid="annlist">
      <div className="k">标注 · {annotations.length}</div>
      {annotations.length === 0 && (
        <div className="t3 emptynote">选中正文文字即可创建高亮；工具栏「笔记」模式下点页面可写独立笔记；点页面上的高亮或笔记锚点可编辑。</div>
      )}
      {annotations.map((a) => (
        <div key={a.id} className={`gt-annitem ${editingId === a.id ? 'on' : ''}`}>
          <div
            className="hd"
            onClick={() => {
              onJump(a)
              onEdit(editingId === a.id ? null : a)
            }}
          >
            {a.type === 'note' ? (
              <span className="nicon">
                <Ic name="note" size={12} />
              </span>
            ) : (
              <span className="dot" style={{ background: COLOR_SOLID[a.color] }} />
            )}
            <span className="pg">{a.type === 'note' ? '笔记' : `p.${a.page + 1}`}</span>
            {/* uat3 必须修 6：列表显示走清洗后文本（旧数据里的软连字符/乱码一并清洗） */}
            <span className="tx" title={cleanReaderText(a.text)}>
              {a.type === 'note' ? (a.note ?? '（空笔记）').slice(0, 80) : cleanReaderText(a.text).slice(0, 80) || '（无文字）'}
            </span>
          </div>
          {editingId !== a.id && a.type === 'highlight' && a.note && <div className="nt">{a.note}</div>}
          {editingId === a.id && (
            <div className="edit">
              <textarea
                // uat6b S1：进入编辑即聚焦（选区弹层「笔记」建高亮后直接打字；此前要再点一次）
                autoFocus
                className="tin"
                rows={3}
                placeholder="笔记（可留空）"
                value={noteDraft}
                onChange={(e) => onDraft(e.target.value)}
                onKeyDown={(e) => {
                  // uat3 必须修 5 + uat5 必须修 3：Esc 只退出编辑（保留草稿），不关阅读器
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    onCancel()
                  }
                }}
              />
              <div className="row">
                {a.type === 'highlight' &&
                  ANNOTATION_COLORS.map((c) => (
                    <button
                      key={c}
                      className={`gt-colordot ${a.color === c ? 'on' : ''}`}
                      style={{ background: COLOR_SOLID[c] }}
                      title={c}
                      onClick={() => onColor(a, c)}
                    />
                  ))}
                <span style={{ flex: 1 }} />
                <button className="btn bordered sm" onClick={onSave}>
                  保存
                </button>
                <button className="btn bordered sm danger" onClick={() => onDelete(a)}>
                  删除
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

type SideTab = 'thumb' | 'toc' | 'ann' | 'fig'
type Tool = 'highlight' | 'note'

/** 缩略图小图宽度（CSS px；scale 按页宽算出固定值，不随主视图缩放重渲） */
const THUMB_WIDTH = 96

/** 缩略图：IntersectionObserver 懒渲染（进入侧栏视口才渲染，渲染后保留），
 * RenderLayer 传固定小 scale——不再随主视图 zoom 整批重渲（评审建 1） */
function Thumb({ pageIndex, pageWidth }: { pageIndex: number; pageWidth: number }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [show, setShow] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || show) return
    if (typeof IntersectionObserver === 'undefined') {
      setShow(true)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShow(true)
          io.disconnect()
        }
      },
      { rootMargin: '120px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [show])
  return (
    <div ref={ref} className="gt-thumbimg">
      {show && (
        <RenderLayer documentId={DOC_ID} pageIndex={pageIndex} scale={THUMB_WIDTH / pageWidth} style={{ width: '100%', height: '100%' }} />
      )}
    </div>
  )
}

/** ReaderInner 导出供 uat3 渲染层单测（mock 滚动/缩放插件时序） */
export function ReaderInner({
  registry,
  engine,
  bytes,
  paper,
  initialFigureNo,
  onClose,
  onSendToAgent,
  onOpenChat
}: {
  registry: unknown
  engine: PdfEngine
  bytes: Uint8Array
  paper: PaperSummary
  /** 打开时定位到的图号（1 基；图号不存在则正常打开不跳） */
  initialFigureNo?: number
  onClose: () => void
  /** D105-①：选区「发给 agent」回调（宿主注入才启用按钮） */
  onSendToAgent?: (quote: { text: string; page: number }) => void
  /** M5 lane/chat 批 3：阅读器工具栏「对话」按钮（原型 07，宿主注入才渲染） */
  onOpenChat?: () => void
}): React.JSX.Element {
  const notify = useNotify()
  const doc = useLoadDocument(registry, engine, bytes)
  const [annotations, setAnnotations] = useState<AnnotationView[]>([])
  const [figures, setFigures] = useState<FigureView[]>([])
  const [bookmarks, setBookmarks] = useState<PdfBookmarkObject[] | null>(null)
  const [tab, setTab] = useState<SideTab>('thumb') // D105③：默认缩略图
  const [tool, setTool] = useState<Tool>('highlight') // D105②：工具栏高亮/笔记
  /** D138：笔记卡跟随锚点高度——滚动/换编辑对象/缩放后按视口重算 */
  const bodyRef = useRef<HTMLDivElement>(null)
  const notecardRef = useRef<HTMLDivElement>(null)
  /** uat3 建议修 2：缩略图列表容器——当前页缩略图滚动到可见 */
  const thumbsRef = useRef<HTMLDivElement>(null)
  const [, setPosTick] = useState(0)
  // 文档未就绪时 ReaderInner 提前 return，body 还没挂上。依赖 [] 会在 bodyRef 为空时
  // 直接 return，之后不再绑定。等 doc 提交、body 已在 DOM 里再绑视口滚动。
  useEffect(() => {
    if (!doc) return
    const vp = bodyRef.current?.querySelector('.gt-reader-viewport')
    if (!vp) return
    let raf = 0
    const onScroll = (): void => {
      if (raf !== 0) return
      raf = requestAnimationFrame(() => {
        raf = 0
        setPosTick((n) => n + 1)
      })
    }
    vp.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      vp.removeEventListener('scroll', onScroll)
      if (raf !== 0) cancelAnimationFrame(raf)
    }
  }, [doc])
  const [flash, setFlash] = useState<{ page: number; rect: [number, number, number, number] } | null>(null)
  /** 待定位图号（初始定位只做一次；文档/图列表就绪后消费） */
  const [pendingFigureNo, setPendingFigureNo] = useState<number | null>(initialFigureNo ?? null)
  const [sel, setSel] = useState<SelectionInfo | null>(null)
  // uat3 必须修 7：阅读器内搜索（引擎 searchAllPages 匹配/计数，命中矩形引擎直接给）
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Array<{ page: number; quads: Quad[] }>>([])
  const [activeHit, setActiveHit] = useState(-1)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  // uat6b-fix1 必须修 M1：全局 Esc 的 window listener 不随每次渲染重绑（打字时
  // editingId 不变、listener 不重绑），若直接闭包捕获 cancelNoteEdit 会用到打开
  // 编辑那一刻的旧草稿/旧标注——失焦后 Esc 把刚写的笔记静默删掉（违背 uat5 S5/
  // D171「草稿非空按保存、绝不丢文字」）。用 ref 保存每轮渲染最新的取消函数。
  const cancelNoteEditRef = useRef<() => void>(() => {})
  useEffect(() => {
    // D138：卡片挂载后量到真实高度，再夹紧一次（编辑对象变化时重算位置）
    setPosTick((t) => t + 1)
  }, [editingId])
  const { provides: zoom } = useZoomCapability()
  const { state: zoomState } = useZoom(DOC_ID)
  // 缩放不触发阅读器重渲染，页内锚点的屏幕位置变了也要重算一次
  useEffect(() => {
    if (!doc) return
    setPosTick((n) => n + 1)
  }, [doc, zoomState.currentZoomLevel])
  const scroll = useScroll(DOC_ID)
  const currentPage = scroll.state.currentPage || 1
  // uat3 建议修 2：当前页变化 → 缩略图滚动到可见（仅缩略图 tab 打开时）
  const tabRef = useRef(tab)
  tabRef.current = tab
  useEffect(() => {
    if (tabRef.current !== 'thumb') return
    thumbsRef.current
      ?.querySelector(`[data-testid="thumb-${currentPage}"]`)
      ?.scrollIntoView?.({ block: 'nearest' }) // jsdom 无 scrollIntoView，可选调用
  }, [currentPage])

  // uat3 建议修 1：页码输入跳页（回车跳，失焦还原）
  const [pageInput, setPageInput] = useState(String(currentPage))
  useEffect(() => setPageInput(String(currentPage)), [currentPage])
  const submitPageInput = (): void => {
    const total = doc?.pages.length ?? 0
    const n = parseInt(pageInput, 10)
    if (Number.isFinite(n) && n >= 1 && n <= total && n !== currentPage) jumpToPage(n - 1)
    else setPageInput(String(currentPage))
  }

  // uat3 必须修 7：搜索执行（输入即搜；清洗后的匹配交给引擎自己的文本索引）
  useEffect(() => {
    if (!searchOpen || !doc) return
    const q = query.trim()
    if (!q) {
      setHits([])
      setActiveHit(-1)
      return
    }
    let live = true
    engine.searchAllPages(doc, q).toPromise().then(
      (r) => {
        if (!live) return
        const hs = (r.results ?? []).map((s: SearchResult) => ({ page: s.pageIndex, quads: searchResultQuads(s) }))
        setHits(hs)
        setActiveHit(hs.length ? 0 : -1)
      },
      () => {
        if (live) {
          setHits([])
          setActiveHit(-1)
        }
      }
    )
    return () => {
      live = false
    }
  }, [searchOpen, query, engine, doc])

  // 打开搜索框自动聚焦
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  const closeSearch = (): void => {
    setSearchOpen(false)
    setQuery('')
    setHits([])
    setActiveHit(-1)
  }

  // 当前命中变化 → 跳到命中所在页
  useEffect(() => {
    const h = hits[activeHit]
    if (h) scroll.provides?.scrollToPage({ pageNumber: h.page + 1, behavior: currentMotionDisabled() ? 'instant' : 'smooth' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeHit])

  useEffect(() => {
    let live = true
    api.listAnnotations(paper.id).then((list) => {
      if (live) setAnnotations(list)
    })
    api.listFigures(paper.id).then((list) => {
      if (live) setFigures(list)
    })
    return () => {
      live = false
    }
  }, [paper.id])

  // 评审建 2：选区弹层 UX——弹层外点击 / 任意滚动即关闭；uat3 必须修 2：关闭时一起清选区
  const dismissSel = (): void => {
    window.getSelection()?.removeAllRanges()
    setSel(null)
  }
  useEffect(() => {
    if (!sel) return
    const onDown = (e: MouseEvent): void => {
      if (!(e.target as HTMLElement | null)?.closest?.('.gt-selpop')) dismissSel()
    }
    const onScroll = (): void => dismissSel()
    window.addEventListener('mousedown', onDown)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', onScroll, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel])

  const textSelectionFromLayer = (): string | null => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null
    const range = selection.getRangeAt(0)
    const node = range.commonAncestorContainer
    const el = node instanceof Element ? node : node.parentElement
    const container = el?.closest?.('.gt-textlayer')
    if (!container) return null
    const text = cleanReaderText(selectionTextWithin(container as HTMLElement, range))
    return text || null
  }

  // uat3 必须修 5/7：Esc 优先级——搜索框开 → 关搜索；焦点在输入框/textarea（编辑中）→
  // 交给输入框自己的 Esc（不关阅读器）；有选区弹层 → 关弹层；否则才关阅读器。
  // ⌘F 开搜索（阅读器打开时拦截）；⌘+ / ⌘- 缩放。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (searchOpen) {
          closeSearch()
          return
        }
        const t = e.target as HTMLElement | null
        if (t?.closest?.('textarea, input, [contenteditable="true"]')) return // 编辑中：不响应
        // uat6b S1：有正在编辑的笔记（焦点不在 textarea 里）→ 先取消笔记编辑（空锚点
        // 静默删除，非空按保存/保留原文口径），本次 Esc 不再关阅读器；再按 Esc 才关。
        // uat6b-fix1 M1：经 ref 调最新实现（见 cancelNoteEditRef 注释），不得直接闭包捕获。
        if (editingId != null) {
          cancelNoteEditRef.current()
          return
        }
        if (sel) dismissSel()
        else onClose()
        return
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        const k = e.key.toLowerCase()
        if (k === 'f') {
          e.preventDefault() // 阅读器内 ⌘F 拦截，不触发应用其它搜索
          setSearchOpen(true)
        } else if (k === 'c') {
          // uat5 建议修 2：⌘C 与「复制」按钮同口径——清洗后文本 + 「已复制」toast
          // （输入框 / textarea 里让浏览器默认复制行为）
          const t = e.target as HTMLElement | null
          if (t?.closest?.('textarea, input, [contenteditable="true"]')) return
          const text = sel?.text ?? textSelectionFromLayer()
          if (text) {
            e.preventDefault()
            void copyText(text).then((ok) => notify(ok ? '已复制' : '复制失败'))
          }
        } else if (k === '=' || k === '+') {
          e.preventDefault()
          zoom?.zoomIn()
        } else if (k === '-') {
          e.preventDefault()
          zoom?.zoomOut()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, onClose, searchOpen, zoom, editingId])

  // 目录（D105③）：PDF outline；无/失败为空列表（tab 显示空态）
  useEffect(() => {
    if (!doc) return
    let live = true
    engine.getBookmarks(doc).toPromise().then(
      (r) => {
        if (live) setBookmarks(r.bookmarks ?? [])
      },
      () => {
        if (live) setBookmarks([])
      }
    )
    return () => {
      live = false
    }
  }, [engine, doc])

  const refresh = async (): Promise<void> => {
    setAnnotations(await api.listAnnotations(paper.id))
  }

  const startEdit = (a: AnnotationView | null): void => {
    setEditingId(a?.id ?? null)
    setNoteDraft(a?.note ?? '')
  }

  /** 选区弹层「高亮」：默认色直接建（改色在编辑态，D105①） */
  const createHighlightFromSel = async (): Promise<void> => {
    if (!sel) return
    try {
      await api.createAnnotation(paper.id, {
        page: sel.pageIndex,
        type: 'highlight',
        text: sel.text,
        color: 'yellow',
        bbox: sel.bbox,
        quads: sel.quads
      })
      dismissSel()
      await refresh()
    } catch (e) {
      notify(e instanceof Error ? e.message : '创建高亮失败')
    }
  }

  /** 选区弹层「笔记」：建带笔记的高亮并直接进入编辑（D105①） */
  const createNoteFromSel = async (): Promise<void> => {
    if (!sel) return
    try {
      const created = await api.createAnnotation(paper.id, {
        page: sel.pageIndex,
        type: 'highlight',
        text: sel.text,
        color: 'yellow',
        bbox: sel.bbox,
        quads: sel.quads
      })
      dismissSel()
      await refresh()
      setTab('ann')
      startEdit(created)
    } catch (e) {
      notify(e instanceof Error ? e.message : '创建笔记失败')
    }
  }

  /** 笔记工具模式下单击页面：建独立笔记锚点并打开笔记卡（D105②） */
  const createNoteAt = async (pageIndex: number, x: number, y: number): Promise<void> => {
    const size = doc?.pages[pageIndex]?.size
    if (!size) return
    const ax = Math.max(0, Math.min(x, size.width - NOTE_MARK_SIZE))
    const ay = Math.max(0, Math.min(y, size.height - NOTE_MARK_SIZE))
    try {
      const created = await api.createAnnotation(paper.id, {
        page: pageIndex,
        type: 'note',
        text: '',
        color: 'yellow',
        bbox: [ax, ay, NOTE_MARK_SIZE, NOTE_MARK_SIZE],
        quads: []
      })
      await refresh()
      startEdit(created)
      setTool('highlight') // uat3 建议修 3：点一次建一条笔记后退出笔记模式
    } catch (e) {
      notify(e instanceof Error ? e.message : '创建笔记失败')
    }
  }

  // uat6b S1：笔记卡打开即自动聚焦 textarea（工具栏「笔记」与选区弹层「笔记」两个入口）——
  // 没聚焦时 Esc 会走全局处理器误关整个阅读器；PDF 渲染后时序用 effect（editingId 变化）保证
  const noteTextareaRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (editingId != null) noteTextareaRef.current?.focus()
  }, [editingId])

  /** D138：笔记卡 top = 锚点（页面坐标 bbox.y × scale + 页在 body 中的位置），超出视口贴边 */
  const noteCardTopOf = (a: AnnotationView): number => {
    const body = bodyRef.current
    const page = doc?.pages[a.page]
    if (!body || !page || !a.bbox) return 56
    const pageEl = body.querySelector(`[data-page-index="${a.page}"]`)
    if (!pageEl) return 56
    const pr = pageEl.getBoundingClientRect()
    const br = body.getBoundingClientRect()
    const scale = pr.width / page.size.width
    const anchorTop = pr.top - br.top + (a.bbox as Quad)[1] * scale
    return noteCardTop(anchorTop, br.height, notecardRef.current?.offsetHeight ?? 220)
  }

  const saveNote = async (): Promise<void> => {
    if (editingId == null) return
    const a = annotations.find((x) => x.id === editingId)
    // uat3 建议修 3：空笔记不保存——独立锚点无引用文字且草稿为空 → 删除而非存空
    // uat6b S4(c)：与 Esc 同口径静默删除（不弹可撤销 toast）；删除按钮 / 侧栏删除仍走 D171 toast
    if (a?.type === 'note' && !a.text && !noteDraft.trim()) {
      await remove(a, { silent: true })
      return
    }
    try {
      await api.updateAnnotation(editingId, { note: noteDraft.trim() || null })
      setEditingId(null)
      await refresh()
    } catch (e) {
      notify(e instanceof Error ? e.message : '保存笔记失败')
    }
  }

  /** uat5 必须修 3：Esc 保留草稿——草稿非空按保存处理（绝不丢文字、绝不产生空笔记）；
   *  草稿为空时：从未有过内容的独立空锚点删掉（不落库），其余（高亮 / 已有笔记）
   *  保持原文退出编辑（编辑成空不删除，D171 删除走删除按钮 + 可撤销 toast）。 */
  const cancelNoteEdit = (): void => {
    const a = annotations.find((x) => x.id === editingId) ?? null
    // 高亮 / 独立笔记通用：草稿非空 → 按保存处理（saveNote 里空锚点另有删除分支）
    if (a && noteDraft.trim()) {
      void saveNote()
      return
    }
    setEditingId(null)
    // uat5-fix1 S5：新建空锚点（无引用文字、无内容）Esc 静默删除——不弹撤销 toast、
    // 不进撤销栈（撤销会把刚丢掉的空锚点造回来，界面上是「（空笔记）」）；D171 的
    // 删除按钮路径不变（无确认框 + 可撤销 toast）。
    if (a?.type === 'note' && !a.text && !a.note) void remove(a, { silent: true })
  }
  // uat6b-fix1 M1：每轮渲染把最新的取消函数装进 ref（全局 Esc listener 经它调用，
  // 保证读到当前 noteDraft / annotations）
  useEffect(() => {
    cancelNoteEditRef.current = cancelNoteEdit
  })

  // D171：删除标注不弹确认，给可撤销 toast（数秒内可恢复，原样重建）
  const [undoSnapshot, setUndoSnapshot] = useState<AnnotationView | null>(null)
  const undoTimer = useRef(0)
  const undoRemove = async (): Promise<void> => {
    const s = undoSnapshot
    window.clearTimeout(undoTimer.current)
    setUndoSnapshot(null)
    if (!s) return
    try {
      await api.createAnnotation(paper.id, {
        page: s.page,
        type: s.type,
        text: s.text,
        color: s.color,
        bbox: s.bbox,
        quads: s.quads,
        note: s.note
      })
      await refresh()
    } catch (e) {
      notify(e instanceof Error ? e.message : '恢复失败')
    }
  }

  const changeColor = async (a: AnnotationView, c: AnnotationColor): Promise<void> => {
    try {
      await api.updateAnnotation(a.id, { color: c })
      await refresh()
    } catch (e) {
      notify(e instanceof Error ? e.message : '改色失败')
    }
  }

  const remove = async (a: AnnotationView, opts?: { silent?: boolean }): Promise<void> => {
    try {
      await api.deleteAnnotation(a.id)
      if (editingId === a.id) setEditingId(null)
      await refresh()
      if (opts?.silent === true) return // uat5-fix1 S5：空锚点 Esc 的静默删除——无撤销 toast
      // D171：删除无确认框，给可撤销 toast（几秒内可恢复）
      window.clearTimeout(undoTimer.current)
      setUndoSnapshot(a)
      undoTimer.current = window.setTimeout(() => setUndoSnapshot(null), 5000)
    } catch (e) {
      notify(e instanceof Error ? e.message : '删除失败')
    }
  }

  const jumpToPage = (pageIndex: number): void => {
    scroll.provides?.scrollToPage({ pageNumber: pageIndex + 1, behavior: currentMotionDisabled() ? 'instant' : 'smooth' })
  }

  // uat3 必须修 1：初始图号定位——等滚动插件布局就绪（onLayoutChange 报告 virtualItems）
  // 再跳：首次非 smooth（instant），之后检查 currentPage 是否真的到达，没到再跳，最多 6 次
  //（200ms 间隔，不死循环）；到达后才亮闪烁高亮（时长从真正到达起算，保证在视口内）。
  const [pendingJump, setPendingJump] = useState<{
    pageIndex: number
    rect: [number, number, number, number] | null
  } | null>(null)
  /** 布局就绪信号：未就绪时订阅 onLayoutChange，就绪后 bump 触发本效果重跑 */
  const [jumpTick, setJumpTick] = useState(0)
  const scrollRef = useRef(scroll)
  scrollRef.current = scroll
  useEffect(() => {
    if (!pendingJump || !doc) return
    const scope = scrollRef.current.provides
    if (!scope) {
      const t = window.setTimeout(() => setJumpTick((n) => n + 1), 100)
      return () => window.clearTimeout(t)
    }
    if (scope.getLayout().virtualItems.length === 0) {
      return scope.onLayoutChange(() => setJumpTick((n) => n + 1))
    }
    const target = pendingJump.pageIndex + 1
    const MAX_ATTEMPTS = 6
    let attempts = 0
    const tryScroll = (): void => {
      scope.scrollToPage({ pageNumber: target, behavior: 'instant' })
    }
    tryScroll() // 首次非 smooth
    const iv = window.setInterval(() => {
      if (scope.getCurrentPage() === target) {
        window.clearInterval(iv)
        if (pendingJump.rect) {
          setFlash({ page: pendingJump.pageIndex, rect: pendingJump.rect })
          window.setTimeout(() => setFlash(null), 1500)
        }
        setPendingJump(null)
      } else if (attempts >= MAX_ATTEMPTS) {
        window.clearInterval(iv)
        setPendingJump(null) // 放弃重试：保持现状正常打开，不死循环
      } else {
        attempts += 1
        tryScroll()
      }
    }, 200)
    return () => window.clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingJump, doc, jumpTick])

  const jumpTo = (a: AnnotationView): void => {
    jumpToPage(a.page)
  }

  /** 页面单击（textlayer 冒泡上来）：笔记模式建锚点；高亮模式命中高亮进编辑 */
  const handlePageTap = (pageIndex: number, x: number, y: number): void => {
    if (tool === 'note') {
      void createNoteAt(pageIndex, x, y)
      return
    }
    const hit = (annsByPage.get(pageIndex) ?? []).find(
      (a) =>
        a.type === 'highlight' &&
        a.quads.some((q) => x >= q[0] && x <= q[0] + q[2] && y >= q[1] && y <= q[1] + q[3])
    )
    if (hit) {
      setTab('ann')
      startEdit(hit)
    }
  }

  /** 「跳到图 N」（D27）：滚到该页 + 按页尺寸把归一化 bbox 换算成页面坐标闪烁高亮
   *  uat4 建议修 8：多子图块对 bbox 与全部 subBboxes 取并集，整组图一起高亮 */
  const jumpToFigure = (f: FigureView): void => {
    const size = doc?.pages[f.page]?.size
    if (!size) return
    setFlash({ page: f.page, rect: mineruNormRectToPageRect(figureNormUnion(f), size.width, size.height) })
    jumpToPage(f.page)
    window.setTimeout(() => setFlash(null), 1500)
  }

  // 初始图号定位（详情页 onOpenFigure 进入）：文档与图列表就绪后交给 pendingJump——
  // uat3 必须修 1：不直接跳（布局未就绪时 smooth 滚动被吞）；等布局就绪 instant 跳 + 有限重试。
  // 图号不存在（figureForNo → null）则正常打开不跳、不崩
  useEffect(() => {
    if (pendingFigureNo == null || !doc || figures.length === 0) return
    const f = figureForNo(figures, pendingFigureNo)
    setPendingFigureNo(null)
    if (!f) return
    const size = doc.pages[f.page]?.size
    if (!size) return
    setPendingJump({ pageIndex: f.page, rect: mineruNormRectToPageRect(figureNormUnion(f), size.width, size.height) })
  }, [doc, figures, pendingFigureNo])

  const annsByPage = useMemo(() => {
    const m = new Map<number, AnnotationView[]>()
    for (const a of annotations) {
      const list = m.get(a.page) ?? []
      list.push(a)
      m.set(a.page, list)
    }
    return m
  }, [annotations])

  const outline = useMemo(() => flattenBookmarks(bookmarks ?? []), [bookmarks])

  // uat3 必须修 7：命中高亮按页分组（当前命中深一档）
  const searchMarksByPage = useMemo(() => {
    if (!hits.length || activeHit < 0) return null
    const perPage = new Map<number, Quad[][]>()
    for (const h of hits) {
      const l = perPage.get(h.page) ?? []
      l.push(h.quads)
      perPage.set(h.page, l)
    }
    return groupSearchMarks(perPage, activeHit)
  }, [hits, activeHit])

  if (!doc) {
    return <div className="gt-reader-loading">正在解析 PDF…</div>
  }

  const editingNote = annotations.find((a) => a.id === editingId && a.type === 'note') ?? null

  return (
    <>
      <div className="gt-reader-toolbar">
        {/* D105④→②：返回位接「论文详情」——详情页入口 onClose 关回详情页；
            库列表入口 onClose 关回库列表（各来源自洽） */}
        <button className="btn" title="返回论文详情" style={{ color: 'var(--text2)', paddingLeft: 6 }} onClick={onClose}>
          <Ic name="back" size={15} />
          论文详情
        </button>
        <span className="sep" />
        <span className="ttl" title={paper.title}>
          {paper.title}
        </span>
        {/* M5 lane/chat 批 3（评审建 5，原型 07）：阅读器内直接开 paper 会话 */}
        {onOpenChat && (
          <button className="btn icon" data-testid="reader-chat" title="对话" onClick={onOpenChat}>
            <Ic name="chat" size={15} />
          </button>
        )}
        {/* uat3 必须修 7：搜索入口（⌘F 或点按钮）；打开时展开搜索框 */}
        <button
          className={`btn icon ${searchOpen ? 'on' : ''}`}
          title="搜索（⌘F）"
          data-testid="search-toggle"
          onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
        >
          <Ic name="search" size={15} />
        </button>
        {searchOpen && (
          <span className="gt-rsearch" data-testid="search-box">
            <input
              ref={searchInputRef}
              data-testid="search-input"
              placeholder="在 PDF 中搜索…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  setActiveHit((i) => cycleHit(i < 0 ? 0 : i, hits.length, e.shiftKey ? -1 : 1))
                }
                // uat5 建议修 3：搜索框聚焦时 Esc 也要关搜索（全局 handler 因焦点在
                // 输入框被「编辑中不响应」跳过）；其余按键照旧不冒泡。
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  closeSearch()
                  return
                }
                e.stopPropagation() // 输入框按键不冒泡到阅读器全局快捷键
              }}
            />
            <span className="t3 gt-hitcount" data-testid="hitcount">
              {query.trim() ? `${activeHit >= 0 ? Math.min(activeHit + 1, hits.length) : 0} / ${hits.length}` : ''}
            </span>
            <button
              className="btn icon sm"
              title="上一个（⇧Enter）"
              data-testid="search-prev"
              disabled={!hits.length}
              onClick={() => setActiveHit((i) => cycleHit(i < 0 ? 0 : i, hits.length, -1))}
            >
              <Ic name="chevU" size={13} />
            </button>
            <button
              className="btn icon sm"
              title="下一个（Enter）"
              data-testid="search-next"
              disabled={!hits.length}
              onClick={() => setActiveHit((i) => cycleHit(i < 0 ? 0 : i, hits.length, 1))}
            >
              <Ic name="chevD" size={13} />
            </button>
            <button className="btn icon sm" title="关闭搜索（Esc）" data-testid="search-close" onClick={closeSearch}>
              <Ic name="close" size={13} />
            </button>
          </span>
        )}
        <span className="t3 gt-pageno" data-testid="pageno">
          {/* uat3 建议修 1：页码输入跳页 */}
          <input
            className="gt-pageinput"
            data-testid="page-input"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitPageInput()
              e.stopPropagation()
            }}
            onBlur={submitPageInput}
          />{' '}
          / {doc.pages.length}
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn icon" title="缩小（⌘-）" onClick={() => zoom?.zoomOut()}>
          <Ic name="zoomOut" size={15} />
        </button>
        <button className="btn icon" title="放大（⌘+）" onClick={() => zoom?.zoomIn()}>
          <Ic name="zoomIn" size={15} />
        </button>
        {/* uat3 建议修 1：缩放百分比 / 适合宽度显示（对照原型 07） */}
        <span className="t3 gt-zoompct" data-testid="zoompct">
          {zoomState.zoomLevel === ZoomMode.FitWidth ? '适合宽度' : `${Math.round((zoomState.currentZoomLevel || 1) * 100)}%`}
        </span>
        <button
          className="btn icon"
          title="适合宽度"
          onClick={() => zoom?.requestZoom(ZoomMode.FitWidth)}
        >
          <Ic name="arrowD" size={15} />
        </button>
        <span className="sep" />
        {/* D105②：高亮 / 笔记 两个工具模式（原型工具栏） */}
        <button
          className={`btn icon ${tool === 'highlight' ? 'on' : ''}`}
          title="高亮"
          data-testid="tool-highlight"
          onClick={() => setTool('highlight')}
        >
          <Ic name="marker" size={15} />
        </button>
        <button
          className={`btn icon ${tool === 'note' ? 'on' : ''}`}
          title="笔记"
          data-testid="tool-note"
          onClick={() => setTool('note')}
        >
          <Ic name="note" size={15} />
        </button>
        <span className="sep" />
        <button className="btn icon" title="关闭" onClick={onClose}>
          <Ic name="close" size={15} />
        </button>
      </div>
      <div className="gt-reader-body" ref={bodyRef}>
        {/* D105③：左侧栏「缩略图 / 目录 / 标注 / 图」，默认缩略图 */}
        <div className="gt-lside">
          <div className="gt-tabs">
            {(
              [
                ['thumb', '缩略图'],
                ['toc', '目录'],
                ['ann', '标注'],
                ['fig', '图']
              ] as Array<[SideTab, string]>
            ).map(([k, label]) => (
              <button key={k} className={`gt-tab ${tab === k ? 'on' : ''}`} data-testid={`tab-${k}`} onClick={() => setTab(k)}>
                {label}
                {k === 'ann' ? ` · ${annotations.length}` : k === 'fig' ? ` · ${figures.length}` : ''}
              </button>
            ))}
          </div>
          {tab === 'thumb' && (
            <div className="gt-thumbs" data-testid="thumbs" ref={thumbsRef}>
              {doc.pages.map((p, i) => (
                <div
                  key={i}
                  className={`gt-thumb ${currentPage === i + 1 ? 'on' : ''}`}
                  data-testid={`thumb-${i + 1}`}
                  onClick={() => jumpToPage(i)}
                >
                  <Thumb pageIndex={i} pageWidth={p.size.width} />
                  <div className="tno">{i + 1}</div>
                </div>
              ))}
            </div>
          )}
          {tab === 'toc' && (
            <div className="gt-toclist" data-testid="toclist">
              {outline.length === 0 && <div className="t3 emptynote">这份 PDF 没有目录。</div>}
              {outline.map((it, i) => (
                <div
                  key={i}
                  className="gt-tocitem"
                  style={{ paddingLeft: 10 + it.depth * 14 }}
                  title={it.pageIndex != null ? `跳到 p.${it.pageIndex + 1}` : ''}
                  onClick={() => it.pageIndex != null && jumpToPage(it.pageIndex)}
                >
                  {it.title}
                </div>
              ))}
            </div>
          )}
          {tab === 'ann' && (
            <AnnotationList
              annotations={annotations}
              editingId={editingId}
              noteDraft={noteDraft}
              onJump={jumpTo}
              onEdit={startEdit}
              onCancel={cancelNoteEdit}
              onDraft={setNoteDraft}
              onSave={() => void saveNote()}
              onColor={(a, c) => void changeColor(a, c)}
              onDelete={(a) => void remove(a)}
            />
          )}
          {tab === 'fig' && (
            <div className="gt-annlist" data-testid="figlist">
              {figures.length === 0 && <div className="t3 emptynote">这篇论文还没有解析出图（解析完成后自动出现）。</div>}
              {(() => {
                // uat2-fix1 建议修 6：无图注块不按序号冒充图号，用「未编号图 k」单独编号，
                // 避免与真实图号（图 N）撞车
                let unnumbered = 0
                return figures.map((f, i) => {
                  const label = f.figureNo != null ? `图 ${f.figureNo}` : `未编号图 ${++unnumbered}`
                  return (
                    <div key={i} className="gt-annitem" onClick={() => jumpToFigure(f)}>
                      <div className="hd">
                        <span className="dot fig" />
                        <span className="pg">{label}</span>
                        <span className="tx" title={f.caption ?? ''}>
                          p.{f.page + 1}
                          {f.caption ? ` · ${f.caption.slice(0, 40)}` : ''}
                        </span>
                      </div>
                    </div>
                  )
                })
              })()}
            </div>
          )}
        </div>
        <Viewport documentId={DOC_ID} className="gt-reader-viewport">
          <Scroller
            documentId={DOC_ID}
            renderPage={(layout) => (
              <ReaderPage
                layout={layout}
                engine={engine}
                doc={doc}
                annotations={annsByPage.get(layout.pageIndex) ?? []}
                flashRect={flash && flash.page === layout.pageIndex ? flash.rect : null}
                searchMarks={searchMarksByPage?.get(layout.pageIndex) ?? null}
                onSelect={setSel}
                onPageTap={handlePageTap}
                onPickNote={(id) => {
                  const a = annotations.find((x) => x.id === id)
                  if (a) {
                    setTab('ann')
                    startEdit(a)
                  }
                }}
              />
            )}
          />
        </Viewport>
        {/* D105②：独立笔记卡（页边，原型 .ncard）；编辑高亮仍在标注列表行内。
            D138：跟随锚点高度（按锚点页面坐标换算），超出视口贴边 */}
        {editingNote && (
          <div
            ref={notecardRef}
            className="gt-ncard"
            data-testid="notecard"
            style={{ top: noteCardTopOf(editingNote) }}
          >
            <div className="k">我的笔记 · p.{editingNote.page + 1}</div>
            <textarea
              ref={noteTextareaRef}
              className="tin"
              rows={4}
              placeholder="写笔记…"
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              onKeyDown={(e) => {
                // uat3 必须修 5：Esc 只取消当前编辑（空锚点删除），不关阅读器
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  cancelNoteEdit()
                }
              }}
            />
            <div className="row" style={{ marginTop: 8 }}>
              <span style={{ flex: 1 }} />
              <button className="btn bordered sm" onClick={() => void saveNote()}>
                保存
              </button>
              <button
                className="btn bordered sm danger"
                onClick={() => {
                  setEditingId(null)
                  void remove(editingNote)
                }}
              >
                删除
              </button>
            </div>
          </div>
        )}
      </div>
      {/* D105①：选区弹层「高亮 / 笔记 / 发给 agent」三按钮（原型 .selpop）；
          评审建 2：靠视口左右缘夹紧、靠下缘翻转到选区上方，不溢出 */}
      {sel && (() => {
        const popLeft = Math.min(Math.max(sel.x, 110), Math.max(110, window.innerWidth - 110))
        const flipUp = sel.y + 76 > window.innerHeight
        return (
          <div
            className={`gt-selpop ${flipUp ? 'up' : ''}`}
            style={{ left: popLeft, top: flipUp ? sel.y - 10 : sel.y + 8 }}
            data-testid="selpop"
          >
            <button className="btn" data-testid="sel-highlight" onClick={() => void createHighlightFromSel()}>
              <Ic name="marker" size={14} />
              高亮
            </button>
            <button className="btn" data-testid="sel-note" onClick={() => void createNoteFromSel()}>
              <Ic name="note" size={14} />
              笔记
            </button>
            {/* uat3 必须修 2 + uat5 建议修 2：选区「复制」——写的是清洗后的文本；
                与 ⌘C 同口径，成功后都给「已复制」toast */}
            <button
              className="btn"
              data-testid="sel-copy"
              onClick={() => {
                if (!sel) return
                void copyText(sel.text).then((ok) => notify(ok ? '已复制' : '复制失败'))
                dismissSel()
              }}
            >
              <Ic name="copy" size={14} />
              复制
            </button>
            {/* D105①（M5 lane/chat 批 2 解禁）：选中文字 → quote chip → paper 入口抽屉；
                宿主（PaperDetailPage 经 App）注入回调时才启用，否则保持禁用占位 */}
            <button
              className="btn"
              data-testid="sel-agent"
              disabled={!onSendToAgent}
              title={onSendToAgent ? '把选中的文字发给 agent' : '对话功能 M5 接入'}
              onClick={() => {
                if (!onSendToAgent || !sel) return
                onSendToAgent({ text: sel.text, page: sel.pageIndex })
                dismissSel()
              }}
            >
              <Ic name="chat" size={14} />
              发给 agent
            </button>
          </div>
        )
      })()}
      {/* D171：删除标注后的可撤销 toast（数秒内可恢复原样重建） */}
      {undoSnapshot && (
        <div className="gt-undo-toast" data-testid="ann-undo-toast">
          已删除标注
          <button type="button" className="btn bordered sm" data-testid="ann-undo" onClick={() => void undoRemove()}>
            撤销
          </button>
        </div>
      )}
    </>
  )
}

export function PdfReader({
  paper,
  initialFigureNo,
  onClose,
  onSendToAgent,
  onOpenChat
}: {
  paper: PaperSummary
  /** 打开时定位到的图号（1 基，与 data-figure 图号同口径）；缺省不定位 */
  initialFigureNo?: number
  onClose: () => void
  /** D105-①：选区「发给 agent」回调（宿主注入才启用该按钮） */
  onSendToAgent?: (quote: { text: string; page: number }) => void
  /** M5 lane/chat 批 3：工具栏「对话」按钮（宿主注入才渲染） */
  onOpenChat?: () => void
}): React.JSX.Element {
  const [bytes, setBytes] = useState<Uint8Array | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // worker: false —— blob Worker 被 CSP script-src 'self' 拦截；直引擎在当前线程跑
  const { engine, isLoading, error } = usePdfiumEngine({ wasmUrl: pdfiumWasmUrl, worker: false, fontFallback: null })

  useEffect(() => {
    let live = true
    api
      .getPdfDocument(paper.id)
      .then((b) => {
        if (live) setBytes(b)
      })
      .catch((e: unknown) => {
        if (live) setLoadError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      live = false
    }
  }, [paper.id])

  const err = error?.message ?? loadError
  return (
    <div className="gt-reader-mask" data-testid="pdf-reader">
      <div className="gt-reader">
        {err ? (
          <div className="gt-reader-loading">
            <Ic name="warn" size={18} /> 打开失败：{err}
          </div>
        ) : !engine || isLoading ? (
          <div className="gt-reader-loading">正在加载 PDF 引擎…</div>
        ) : !bytes ? (
          <div className="gt-reader-loading">正在读取 PDF…</div>
        ) : (
          <EmbedPDF engine={engine} plugins={plugins}>
            {(state) => (
              <ReaderInner
                registry={state.registry}
                engine={engine}
                bytes={bytes}
                paper={paper}
                initialFigureNo={initialFigureNo}
                onClose={onClose}
                onSendToAgent={onSendToAgent}
                onOpenChat={onOpenChat}
              />
            )}
          </EmbedPDF>
        )}
      </div>
    </div>
  )
}
