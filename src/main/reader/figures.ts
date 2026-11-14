import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FigureView } from '../../shared/ipc/pdf'

/**
 * 阅读器「按 bbox 跳到图」（D27）的图块数据源。
 *
 * MinerU 4.0.12 的 zip 产物带 structured_content.json（实测；v2.15 无 content_list），
 * 其中 image 块给出归一化 bbox 与图片路径。**坐标口径（Q6 裁定）**：bbox 是
 * 0–1 归一化坐标、左上原点；用时按页宽/高（EmbedPDF 文档页尺寸，PDF 点）换算成
 * PDF 页面坐标（左上原点），与标注同一坐标系，不另存一套。
 *
 * 本模块只做纯解析；读盘在 listFigures。
 */

export interface FigureBlock {
  /** 页码（0 基；UI 显示 p.N = page + 1） */
  page: number
  /** 归一化矩形 [x0,y0,x1,y1]（0–1，左上原点） */
  bbox: [number, number, number, number]
  /** 图注文字（captions 拼接；无 null） */
  caption: string | null
  /** zip 内图片相对路径（images/...；无 null） */
  imageSource: string | null
  /**
   * uat2 图号修复：从图注解析出的**论文自身图号**（Figure N / Fig. N / 图 N，1 基）。
   * 解析不出（无图注 / 附录图 Figure S1/A1 等）为 null——无图注的图块不按文档
   * 顺序硬塞图号（绝不把错图当成图 N）。
   */
  figureNo: number | null
  /**
   * uat4 建议修 8（多子图合并显示）：兄弟子图块的归一化 bbox 列表。同页块顺序
   * 紧邻、自身无图注（uat6 S4：或仅带子图注 (a)/(b)）的 image/chart 子块并入紧随
   * 其后的带编号图（判定规则见 parseFigureBlocks 注释）；无兄弟子块时该字段不存在。
   */
  subBboxes?: [number, number, number, number][]
  /** uat9：纯子图标题的 bbox；主图注保持 D189 原口径，不进裁图并集。 */
  subCaptionBboxes?: [number, number, number, number][]
}

/**
 * MinerU 4.0.12（docvortex BlockType，已核 sidecar venv 源码）的图类块：image / chart。
 * uat4 建议修 9：table 块若其图注以 Figure/Fig./图 起头（能解出正文图号）也收成图块
 * （可「跳到图 N」/被图引用寻址）；Table/表 起头的真表格照旧不收（D155 表格跳转不做）。
 */
const FIGURE_BLOCK_TYPES = new Set(['image', 'chart'])

/** 全角字母/数字 → 半角（图号标号的大小写、全半角兼容） */
function normalizeWidth(s: string): string {
  return s.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
}

/** 归一化图注里「开头」的图号标号（Figure 3 / Fig. 3 / Fig 3 / 图 3，前置括号忽略） */
const ANCHORED_LABEL_RE = /^\s*[\[（(「『"'“‘]*\s*(?:figure|fig\.?|图)\s*([a-z]{0,2}\d+[a-z]?)\b/i
/** 归一化图注里任意位置的 Figure/Fig. N（fallback；中文「图 N」只认开头） */
const FALLBACK_LABEL_RE = /(?:figure|fig\.?)\s*([a-z]{0,2}\d+[a-z]?)\b/i

function labelToNo(label: string | undefined | null): number | null {
  if (!label) return null
  if (/^[a-z]/i.test(label)) return null // 附录图（S1/A1…）不可按正文图号寻址
  const digits = /\d+/.exec(label)?.[0]
  return digits ? parseInt(digits, 10) : null
}

/**
 * 从图注解析论文自身图号：
 * - 首选图注开头的标号：Figure 3 / Fig. 3 / Fig 3 / 图 3（大小写、全半角兼容；
 *   前置的 [ ( 「 “ 等括号忽略）；Figure 2(a) / 图 2(b) 等子图取主图号 2；
 * - 开头没有时退而求其次找正文里第一次出现的 Figure/Fig. N（中文「图 N」只认开头，
 *   防「架构图 3 层」这类误匹配）；
 * - Figure S1 / A1 等带字母前缀的附录图不是正文图号 → null（不按顺序顶替）。
 */
export function parseFigureNo(caption: string | null): number | null {
  if (!caption) return null
  const norm = normalizeWidth(caption)
  return labelToNo(ANCHORED_LABEL_RE.exec(norm)?.[1] ?? null) ??
    labelToNo(FALLBACK_LABEL_RE.exec(norm)?.[1] ?? null)
}

/**
 * uat6 S4：子图注判定（多面板图的每个子面板块带的是子图注而非 null）。图注（先过
 * normalizeWidth 全半角归一）以子图标号 (a)/(b)/（C） 起头，且整注解不出正文图号
 * （parseFigureNo == null——若同注还带 Figure N / 图 N 标号，如「(b) 结果见 Figure 2」，
 * 它是编号图本身，不是子块）。两者同时满足才是子图注。
 */
export function isSubFigureCaption(caption: string): boolean {
  const norm = normalizeWidth(caption)
  if (!/^\s*[\(（]\s*[a-zA-Z]\s*[\)）]/.test(norm)) return false
  return parseFigureNo(caption) == null
}

/** 主图注起始标号在**任意位置**的查找（正则同 ANCHORED_LABEL_RE 的标号部分，
 *  但不要求在开头）——uat6c S5 用于把「子图注 + 主图注」合并注截到主图注起头。 */
const MAIN_LABEL_ANYWHERE_RE = /(?:figure|fig\.?|图)\s*[a-z]{0,2}\d+[a-z]?\b/i

/**
 * uat6c-fix1 S4：主图注形态的标号——标号后须紧跟冒号（: / ：）或句点（. / 。）。
 * 「Figure 2: …」「图 3：…」「Figure 4. …」是主图注；子图注正文里提到的
 * 「fig. 1」「图 2 层」后不接冒号 / 句点，不算截断点。
 */
const MAIN_LABEL_PUNCT_RE = /(?:figure|fig\.?|图)\s*[a-z]{0,2}\d+[a-z]?\b\s*[:：.]/i

/**
 * uat6c S5：图注显示口径——MinerU 实测会把某个子面板块的 captions 同时挂上
 * 子图注与整图主图注（如「(c) Adaptive Target Error Rate … Figure 2: …」），
 * 详情图卡原样显示会子图注前置。规则：图注以子图标注 (a)/（C） 起头、且更晚
 * 位置含主图标注（Figure N / Fig. N / 图 N）→ 返回从主图标注起头的部分
 * （子图注不前置）；不满足则原样返回（纯子图注、无主图注的块不受影响）。
 * 截断点选取（uat6c-fix1 S4）：**优先**取后接冒号 / 句点的主图注形态（第一个）；
 * 没有主图注形态时退而求其次取**最后一个**普通标号（如「(b) 结果见 Figure 2」
 * 末尾的标号）——避免在子图注内部更早出现的「fig. N / 图N」处截断。
 * 图号解析（parseFigureNo）不变——截断后主图注仍在开头，figureNo 一致。
 */
export function trimLeadingSubFigureCaption(caption: string): string {
  const norm = normalizeWidth(caption)
  if (!/^\s*[\(（]\s*[a-zA-Z]\s*[\)）]/.test(norm)) return caption
  const punct = MAIN_LABEL_PUNCT_RE.exec(norm)
  const m = punct ?? lastMatch(MAIN_LABEL_ANYWHERE_RE, norm)
  if (!m || m.index <= 0) return caption
  // normalizeWidth 逐字符等长映射，归一化串的下标可直接用于原串
  return caption.slice(m.index).trimStart()
}

function lastMatch(re: RegExp, s: string): RegExpExecArray | null {
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g' // 保留 i 等标志
  const global = new RegExp(re.source, flags)
  let last: RegExpExecArray | null = null
  let m: RegExpExecArray | null
  while ((m = global.exec(s)) !== null) {
    last = m
    if (m.index === global.lastIndex) global.lastIndex++ // 防零宽死循环（本正则不会，保险）
  }
  return last
}

/** 图号寻址（resolveFigureByNo）已挪到 src/shared/ipc/pdf.ts，主进程/渲染层共用。 */

/**
 * uat4 必须修 5：图注起始标号（与 parseFigureNo 同款归一化口径——先全半角归一化
 * 再大小写不敏感匹配；标号须含数字正文图号）。captions 合并文本按这些标号切分。
 */
const CAPTION_START_RE = /[\[（(「『"'“‘]?\s*(?:figure|fig\.?|图)\s*[a-z]{0,2}\d+[a-z]?\b/gi

/**
 * uat4 必须修 5：一个块的 captions 合并文本里出现多条图注（MinerU 实测会把同页
 * 前一张图的图注也挂到后一个 image 块的 captions 上——两条 captions 或一条合并
 * 文本）时，按图注起始标号切分（全半角、大小写口径同 parseFigureNo）。
 * 少于 2 条返回 null——单图注块行为与现状完全一致。
 */
export function splitFigureCaptions(caption: string): string[] | null {
  const norm = normalizeWidth(caption)
  CAPTION_START_RE.lastIndex = 0
  const starts: number[] = []
  let m: RegExpExecArray | null
  while ((m = CAPTION_START_RE.exec(norm)) !== null) {
    starts.push(m.index)
  }
  if (starts.length < 2) return null
  // 首段从 0 起（保留标号前的括号等前缀），其余从第 2 个标号处切
  const segs: string[] = []
  let from = 0
  for (const cut of starts.slice(1)) {
    const seg = caption.slice(from, cut).trim()
    if (seg) segs.push(seg)
    from = cut
  }
  const last = caption.slice(from).trim()
  if (last) segs.push(last)
  return segs.length >= 2 ? segs : null
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function normBbox(v: unknown): [number, number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 4 || !v.every(isNum)) return null
  const [x0, y0, x1, y1] = v as number[]
  if (x1 <= x0 || y1 <= y0) return null
  return [x0, y0, x1, y1]
}

/** 解析期条目：带页内块序（ordinal），供多子图相邻判定用 */
interface RawEntry {
  page: number
  /** 在所属页 blocks 数组里的下标（页内块顺序） */
  ordinal: number
  bbox: [number, number, number, number]
  caption: string | null
  imageSource: string | null
  subCaptionBboxes: [number, number, number, number][]
}

interface RawStandaloneCaption {
  page: number
  ordinal: number
  bbox: [number, number, number, number]
}

type PendingEntry = Omit<RawEntry, 'page'>

interface FigureGroup {
  block: FigureBlock
  page: number
  firstOrdinal: number
  lastOrdinal: number
  boxes: [number, number, number, number][]
}

/** 子图标题须与某个面板横向相交，并在面板内或紧贴其下（最多 6% 页高）。 */
function captionTouchesPanel(
  caption: [number, number, number, number],
  boxes: [number, number, number, number][]
): boolean {
  return boxes.some((box) => {
    const xOverlap = Math.min(caption[2], box[2]) - Math.max(caption[0], box[0])
    if (xOverlap <= 0) return false
    const yOverlap = Math.min(caption[3], box[3]) - Math.max(caption[1], box[1])
    if (yOverlap > 0) return true
    const gapBelow = caption[1] - box[3]
    return gapBelow >= 0 && gapBelow <= 0.06
  })
}

function appendCaptionBbox(block: FigureBlock, bbox: [number, number, number, number]): void {
  const boxes = block.subCaptionBboxes ?? []
  if (boxes.some((b) => b.every((n, i) => n === bbox[i]))) return
  block.subCaptionBboxes = [...boxes, bbox]
}

/**
 * 从 structured_content.json 解析出图块列表（跨页按文档顺序；坏块跳过不炸）。
 *
 * uat4 必须修 5（同块多条图注拆分与归属）：MinerU 把同页 Fig4、Fig5 两条图注都挂到
 * 第二个 image 块的 captions 上，直接拼接会让「图 4」指向图 5 的图片、「图 5」找不到。
 * 处理口径（uat4-fix1 D173 修订）：块内 captions 合并文本拆出多条图注时，**本块只
 * 保留最后一条**（图注排版在图片下方，MinerU 列表里离本块最近、排在最后的才是本块
 * 自己的图注），其余每条按文档序**先远后近**配给**同页**前置无图注图块（最近的空块
 * 拿最后一条多余的、最远的拿第一条，保证三图三注时图 1/2/3 各归其位、不对调）；
 * **跨页不回填**（D173：归属不确定），同页没有空块的图注丢掉不硬塞：不进任何块，该
 * 图号寻址不命中，渲染层保持既有「图 N 未找到」占位（FigureBlock.tsx / PdfReader 不跳）
 * ——绝不显示错图。
 *
 * uat4 建议修 8（多子图一并显示）：同页、页内块顺序紧邻（中间无 text 等其他块）、
 * 自身无图注的连续 image/chart 子块，是紧随其后的带编号图的兄弟子图（论文多子图
 * 排版：一张图拆成左右/上下多个无图注子块，整组图共用一个编号图注）。这些子块不单独
 * 成项，其 bbox 并入带编号图的 subBboxes（阅读器「跳到图」高亮并集）；判定不了
 * （中间隔了 text 等块、或跨页）就不合并，子块照旧单独显示——不猜。
 *
 * uat6 S4：MinerU 实测多面板图的每个子面板块带的是**子图注**（如「(a) Ablation
 * results.」「（b）总体架构」）而非 null，原「无图注」条件收不到它们。带子图注
 * （isSubFigureCaption）的块与无图注块同等处理：bbox 进 pending、子图注文本不单独成项、
 * 不切断合并；其独立 bbox 由 uat9 的 subCaptionBboxes 另存并进入裁图并集。若最终被 flush
 * 单独成项（被隔断/跨页/在页尾），保留原子图注原文、figureNo null（与无图注块对称）。
 */
export function parseFigureBlocks(content: unknown): FigureBlock[] {
  if (!content || typeof content !== 'object') return []
  const pages = (content as { pages?: unknown }).pages
  if (!Array.isArray(pages)) return []
  const entries: RawEntry[] = []
  const standaloneCaptions: RawStandaloneCaption[] = []
  const standaloneCaptionOrdinals = new Set<string>()
  for (const p of pages) {
    if (!p || typeof p !== 'object') continue
    const pageIdx = (p as { page_idx?: unknown }).page_idx
    if (!Number.isInteger(pageIdx) || (pageIdx as number) < 0) continue
    const blocks = (p as { blocks?: unknown }).blocks
    if (!Array.isArray(blocks)) continue
    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi]
      if (!b || typeof b !== 'object') continue
      const block = b as { type?: unknown; bbox?: unknown; captions?: unknown; image_source?: unknown; content?: unknown }
      if (typeof block.type !== 'string') continue
      const bbox = normBbox(block.bbox)
      const rawCaptionItems = Array.isArray(block.captions)
        ? block.captions
            .filter((c): c is { content?: unknown; bbox?: unknown } => !!c && typeof c === 'object')
            .map((c) => ({ content: typeof c.content === 'string' ? c.content : '', bbox: normBbox(c.bbox) }))
            .filter((c) => c.content)
        : []
      // uat10（复测建议）：caption 项的 bbox 完全落在图块自身 bbox 内 = 图内 OCR 文本
      // （如坐标轴标签「Query: tract…」），不是图注。标签必须来自图注，图内文本剔除
      // 后再拼接；无图注项时 caption 为 null，阅读器回退「图 N / 未编号图 k」。
      const insideFigure = (cb: [number, number, number, number] | null): boolean => {
        if (!cb || !bbox) return false
        return cb[0] >= bbox[0] && cb[1] >= bbox[1] && cb[2] <= bbox[2] && cb[3] <= bbox[3]
      }
      const captionItems = rawCaptionItems.filter((c) => !insideFigure(c.bbox))
      const caption = captionItems.map((c) => c.content).join(' ') || null

      // uat9：独立 image_caption / 子图标签 text 块只作候选，稍后按文档位置与面板
      // 几何关系归属；普通正文、Figure N 主图注和其它图不会被吃进并集。
      const textContent = typeof block.content === 'string' ? block.content : ''
      if ((block.type === 'image_caption' || block.type === 'text') && bbox && isSubFigureCaption(textContent)) {
        standaloneCaptions.push({ page: pageIdx as number, ordinal: bi, bbox })
        standaloneCaptionOrdinals.add(`${pageIdx as number}:${bi}`)
      }

      if (!FIGURE_BLOCK_TYPES.has(block.type)) {
        // uat4 建议修 9：table 块仅当其图注以 Figure/Fig./图 起头（开头标号能解出正文
        // 图号）时收成图块；Table/表 起头（含「见 Figure 4」之类正文提及）照旧不收
        if (block.type !== 'table' || caption == null) continue
        if (labelToNo(ANCHORED_LABEL_RE.exec(normalizeWidth(caption))?.[1] ?? null) == null) continue
      }
      if (!bbox) continue
      entries.push({
        page: pageIdx as number,
        ordinal: bi,
        bbox,
        caption,
        imageSource: typeof block.image_source === 'string' ? block.image_source : null,
        // captions 数组里独立的 (a)/(b)/(c) 项才纳入；含 Figure N 的合并项整项排除，
        // 避免把同一 bbox 后面的主图注也裁进来。uat10 评审建议 1：纳入前同样走
        // captionTouchesPanel 距离过滤（bbox 与本面板相交或紧贴其下），远处标签不吃进并集。
        subCaptionBboxes: captionItems
          .filter((c) => c.bbox && isSubFigureCaption(c.content) && captionTouchesPanel(c.bbox!, [bbox!]))
          .map((c) => c.bbox!)
      })
    }
  }

  // 必须修 5（uat4-fix1 D173 修订）：同块多余图注按文档序**先远后近**配给**同页**
  // 前置无图注块（第 k 条多余的配给同页第 k 个空块）；跨页不回填，空块用尽的丢掉。
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (!e.caption) continue
    const segs = splitFigureCaptions(e.caption)
    if (!segs) continue // 单图注块：行为与现状一致
    e.caption = segs[segs.length - 1] // 本块保留最后一条（离本块最近的才是自己的）
    // 同页前置无图注块，文档序（先远）排成队列
    const empties: RawEntry[] = []
    for (let j = i - 1; j >= 0; j--) {
      if (entries[j].page !== e.page) break // 只同页回填（D173）：翻页即停
      if (entries[j].caption === null) empties.unshift(entries[j])
    }
    for (const seg of segs.slice(0, -1)) {
      const target = empties.shift()
      if (!target) break // 空块用尽：丢掉剩余图注（不硬塞 → 占位）
      target.caption = seg
    }
  }

  // 建议修 8：兄弟子块并入紧随其后的带编号图。独立子图标题不切断相邻关系；
  // 换页 / 普通正文等其它块仍 flush，不猜跨组归属。
  const out: FigureBlock[] = []
  const groups: FigureGroup[] = []
  let pending: PendingEntry[] = []
  let curPage = -1
  let lastOrdinal = -2
  const flushPending = (): void => {
    for (const s of pending) {
      const block: FigureBlock = { page: curPage, bbox: s.bbox, caption: s.caption, imageSource: s.imageSource, figureNo: null }
      if (s.subCaptionBboxes.length > 0) block.subCaptionBboxes = [...s.subCaptionBboxes]
      out.push(block)
      groups.push({ block, page: curPage, firstOrdinal: s.ordinal, lastOrdinal: s.ordinal, boxes: [s.bbox] })
    }
    pending = []
  }
  for (const e of entries) {
    if (e.page !== curPage) {
      flushPending()
      curPage = e.page
      lastOrdinal = -2
    }
    if (e.ordinal !== lastOrdinal + 1) {
      let captionsOnly = true
      for (let ordinal = lastOrdinal + 1; ordinal < e.ordinal; ordinal++) {
        if (!standaloneCaptionOrdinals.has(`${e.page}:${ordinal}`)) {
          captionsOnly = false
          break
        }
      }
      if (!captionsOnly) flushPending()
    }
    lastOrdinal = e.ordinal
    if (e.caption == null || isSubFigureCaption(e.caption)) {
      pending.push({
        ordinal: e.ordinal,
        bbox: e.bbox,
        imageSource: e.imageSource,
        caption: e.caption,
        subCaptionBboxes: e.subCaptionBboxes
      })
      continue
    }
    const block: FigureBlock = {
      page: e.page,
      bbox: e.bbox,
      // uat6c S5：「(c) 子图注 … Figure 2: 主图注」合并注 → 显示从主图注起头
      caption: trimLeadingSubFigureCaption(e.caption),
      imageSource: e.imageSource,
      figureNo: parseFigureNo(e.caption)
    }
    if (pending.length > 0) block.subBboxes = pending.map((s) => s.bbox)
    const subCaptionBboxes = [...pending.flatMap((s) => s.subCaptionBboxes), ...e.subCaptionBboxes]
    if (subCaptionBboxes.length > 0) block.subCaptionBboxes = subCaptionBboxes
    groups.push({
      block,
      page: e.page,
      firstOrdinal: pending[0]?.ordinal ?? e.ordinal,
      lastOrdinal: e.ordinal,
      boxes: [...pending.map((s) => s.bbox), e.bbox]
    })
    pending = []
    out.push(block)
  }
  flushPending()

  // 独立子图标题只能落在本组文档区间内，且与组内某面板相交或紧贴其下。
  // 组后的相邻正文、其它图的标题、以及任何 Figure N 主图注均不纳入。
  for (const caption of standaloneCaptions) {
    const group = groups.find((g) =>
      g.page === caption.page &&
      caption.ordinal >= g.firstOrdinal &&
      caption.ordinal <= g.lastOrdinal &&
      captionTouchesPanel(caption.bbox, g.boxes)
    )
    if (group) appendCaptionBbox(group.block, caption.bbox)
  }
  return out
}

/** 读缓存的 structured_content.json；缺失/坏 JSON 返回空列表（不炸阅读器） */
export function listFigures(dataDir: string, paperId: number): FigureView[] {
  const p = join(dataDir, 'papers', String(paperId), 'mineru', 'structured_content.json')
  if (!existsSync(p)) return []
  try {
    return parseFigureBlocks(JSON.parse(readFileSync(p, 'utf8')))
  } catch {
    return []
  }
}
