/**
 * uat3b 必须修 2：readPaper 读 MinerU 原文（full.md）的纯函数层（D68 + 设计文档 6.7）。
 *
 * - 章节目录：按 Markdown 标题行（#{1,4}）切节，标题原文保留（含原文章节号，
 *   不重新编号）；标题前引言作为首节「引言」；
 * - 图号/表号：全文扫 `图 N / Figure N / Fig. N / 表 N / Table N`，按出现顺序去重，
 *   目录里一并返回，回复里可写「表 3」「图 2」「§4.2」等原书出处；
 * - 长节分段：readFullSection 按 offset 窗口返回，断点回退到窗口内最后一个换行
 *   （不在单词/行中间截断），hasMore/nextOffset 供模型继续读；
 * - locateInFullText：searchLibrary 原文命中后定位章节号 + 上下文片段。
 */

export interface FullSection {
  /** 目录序号（1 起，含「引言」） */
  index: number
  /** 标题原文（含章节号，不重新编号） */
  title: string
  /** Markdown 标题层级（# 数） */
  level: number
  /** 该节全文（从标题行起） */
  text: string
}

/** 把 full.md 按标题行切成节；标题前引言（若有）作为首节「引言」。坏输入不炸。 */
export function parseFullMarkdown(markdown: string): FullSection[] {
  const sections: FullSection[] = []
  let current: FullSection | null = null
  for (const line of markdown.split('\n')) {
    const m = /^(#{1,4})\s+(.+)$/.exec(line)
    if (m) {
      current = { index: sections.length + 1, title: m[2].trim(), level: m[1].length, text: line }
      sections.push(current)
    } else if (current) {
      current.text += '\n' + line
    } else if (line.trim()) {
      current = { index: sections.length + 1, title: '引言', level: 1, text: line }
      sections.push(current)
    }
  }
  return sections
}

/** 全文图号/表号扫描：按出现顺序去重（保留原文写法，便于引用原书编号） */
export function collectFigureTableNos(markdown: string): { figures: string[]; tables: string[] } {
  const figures: string[] = []
  const tables: string[] = []
  const push = (list: string[], label: string): void => {
    if (!list.includes(label)) list.push(label)
  }
  const re = /(图|Figure|Fig\.?|表|Table)\s*(\d+(?:\.\d+)?)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(markdown)) != null) {
    const label = `${m[1]} ${m[2]}`.replace(/\s+/g, ' ')
    if (m[1] === '表' || m[1].toLowerCase() === 'table') push(tables, label)
    else push(figures, label)
  }
  return { figures, tables }
}

export interface FullToc {
  sections: Array<{ index: number; title: string; level: number; chars: number }>
  figures: string[]
  tables: string[]
  totalChars: number
}

export function fullMarkdownToc(markdown: string): FullToc {
  const sections = parseFullMarkdown(markdown)
  const { figures, tables } = collectFigureTableNos(markdown)
  return {
    sections: sections.map((s) => ({ index: s.index, title: s.title, level: s.level, chars: s.text.length })),
    figures,
    tables,
    totalChars: markdown.length
  }
}

/**
 * 按节分段读取：section 为目录序号（1 起）或标题模糊匹配；offset 为节内字符偏移
 * （首次 0，续读传上次返回的 nextOffset）。返回 null = 没有该节。
 */
export function readFullSection(
  markdown: string,
  section: string,
  offset = 0,
  maxChars = 20_000
): { index: number; title: string; text: string; offset: number; endOffset: number; hasMore: boolean; nextOffset: number | null } | null {
  const sections = parseFullMarkdown(markdown)
  const idx = /^(\d+)$/.test(section.trim()) ? Number(section.trim()) - 1 : -1
  // 数字越界时回退标题模糊匹配（模型常把章节号「5」当序号传）
  const hit = (idx >= 0 ? sections[idx] : undefined) ?? sections.find((s) => s.title.toLowerCase().includes(section.trim().toLowerCase()))
  if (!hit) return null
  const start = Math.max(0, Math.min(offset, hit.text.length))
  let end = Math.min(start + maxChars, hit.text.length)
  let hasMore = end < hit.text.length
  if (hasMore) {
    // 断点回退到窗口内最后一个换行，不在单词/行中间截断
    const nl = hit.text.lastIndexOf('\n', end)
    if (nl > start + maxChars * 0.5) {
      end = nl
    }
  }
  hasMore = end < hit.text.length
  return {
    index: hit.index,
    title: hit.title,
    text: hit.text.slice(start, end),
    offset: start,
    endOffset: end,
    hasMore,
    nextOffset: hasMore ? end : null
  }
}

export interface FullTextLocation {
  /** 命中的节（含原文章节号的标题原文） */
  section: string | null
  /** 命中点上下文片段（±window 字符） */
  snippet: string
  /** 命中点在全文中的字符偏移 */
  offset: number
}

/** 在 full.md 里定位第一个命中词：章节号 + 上下文片段（searchLibrary 原文命中用） */
export function locateInFullText(markdown: string, query: string, windowChars = 80): FullTextLocation | null {
  const lower = markdown.toLowerCase()
  const terms = query
    .split(/\s+/)
    .flatMap((t) => (t.includes('-') ? t.split('-') : [t]))
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
  let offset = -1
  for (const t of terms) {
    const i = lower.indexOf(t)
    if (i >= 0) {
      offset = i
      break
    }
  }
  if (offset < 0) return null
  const sections = parseFullMarkdown(markdown)
  const before = sections.filter((s) => markdown.indexOf(s.text) <= offset)
  const section = before.length ? before[before.length - 1].title : null
  const from = Math.max(0, offset - windowChars)
  const to = Math.min(markdown.length, offset + windowChars)
  const snippet = markdown
    .slice(from, to)
    .replace(/\n{2,}/g, ' ¶ ')
    .replace(/\s+/g, ' ')
    .trim()
  return { section, snippet, offset }
}
