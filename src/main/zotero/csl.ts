import type { ZoteroCreator, ZoteroItem } from './types'

/**
 * Zotero 字段 → CSL-JSON 映射（D61）。
 *
 * 目标：与 Zotero 自带的「CSL JSON」导出（citeproc-js 映射，Zotero 7）逐字段一致。
 * 测试（csl.test.ts）用合成样例逐字段比对；preprint 的 archiveID（如 "arXiv:2608.20771"）
 * 会进 csl_json 的 number（真实导出实测，2026-10-26），papers.arxiv_id 索引列另建（D61）。
 *
 * 要点：
 * - itemType 映射走 Zotero 自己的 CSL typeMap 子集（见下）；
 * - creator：author/editor 等按 creatorType 分桶，双字段给 family/given，
 *   单字段（机构名）给 literal；
 * - date → issued['date-parts']，按 Zotero 的解析口径：完整日期给 [y,m,d]，
 *   只有年月给 [y,m]，只有年份给 [y]；无法解析则不出 issued（与 Zotero 一致）；
 *   输出时年是字符串、月日是数字（与 Zotero 导出口径一致，2026-10-26 真实对照）；
 * - accessDate → accessed['date-parts']（仅完整日期可解析时）；
 * - extra → note（Zotero 通用映射；注意是逐字映射——Zotero 导出时会先「消化」
 *   extra 里可识别的 `CSL变量: 值` 行（如 `DOI:` 覆写）再进 note，本实现逐字拷贝：
 *   将来导入带这类覆写行的条目，note 可能与 Zotero 导出有差（评审 nit，已记录））；
 *   preprint：repository → publisher、archiveID → number（真实导出实测，不导出 genre）；
 * - container-title：journalArticle/magazineArticle/newspaperArticle 取 publicationTitle，
 *   conferencePaper 取 proceedingsTitle，bookSection 取 bookTitle（与 Zotero 一致）。
 */

/** Zotero itemType → CSL type（Zotero 7 typeMap 的常用子集） */
const CSL_TYPE_MAP: Record<string, string> = {
  journalArticle: 'article-journal',
  book: 'book',
  bookSection: 'chapter',
  conferencePaper: 'paper-conference',
  thesis: 'thesis',
  report: 'report',
  webpage: 'webpage',
  magazineArticle: 'article-magazine',
  newspaperArticle: 'article-newspaper',
  preprint: 'article',
  document: 'article',
  patent: 'patent',
  manuscript: 'manuscript'
}

/** Zotero 字段名 → CSL 字段名（同名字段之外的对齐） */
const FIELD_MAP: Record<string, string> = {
  title: 'title',
  abstractNote: 'abstract',
  volume: 'volume',
  issue: 'issue',
  pages: 'page',
  DOI: 'DOI',
  url: 'URL',
  publisher: 'publisher',
  language: 'language',
  ISBN: 'ISBN',
  ISSN: 'ISSN',
  archive: 'archive',
  extra: 'note'
}

function mapCreator(c: ZoteroCreator): Record<string, string> {
  if (c.name) return { literal: c.name }
  return { family: c.lastName ?? '', given: c.firstName ?? '' }
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
}

/**
 * 按 Zotero 口径把 date 字符串解析成 CSL date-parts。
 * 支持 "2023"、"March 2023"、"2023-05-01"、"2023/5/1"、美式全日期 "May 1, 2023"、
 * 英式全日期 "1 May 2023"；带时间的 accessDate（"2023-05-01 12:00:00"、
 * "2023-05-01T12:00:00Z"）先剥掉时间部分再解析——与 Zotero 一致（评审必须修 3）。
 * 只取确定能解析的形态，解析不了返回 null（该字段不输出，与 Zotero 一致）。
 */
export function parseDateParts(date: string | undefined): number[] | null {
  if (!date) return null
  let s = date
    .trim()
    // 去掉时间部分：sqlite 里 accessDate 是 "2023-05-01 12:00:00"，Local API 是 "2023-05-01T12:00:00Z"
    .replace(/[T ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/, '')
    .trim()
  // YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD（月日可缺）
  let m = /^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?$/.exec(s)
  if (m) {
    const parts = [Number(m[1])]
    if (m[2]) parts.push(Number(m[2]))
    if (m[3]) parts.push(Number(m[3]))
    return parts
  }
  const monthOf = (name: string): number | null => MONTHS[name.slice(0, 3).toLowerCase()] ?? null
  // 美式全日期 "May 1, 2023" / "May 1st, 2023"
  m = /^([A-Za-z]+)\.?,?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s)
  if (m) {
    const month = monthOf(m[1])
    return month ? [Number(m[3]), month, Number(m[2])] : null
  }
  // 英式全日期 "1 May 2023" / "1st May 2023"
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?,?\s+(\d{4})$/.exec(s)
  if (m) {
    const month = monthOf(m[2])
    return month ? [Number(m[3]), month, Number(m[1])] : null
  }
  // "March 2023" / "Mar. 2023"
  m = /^([A-Za-z]+)\.?,?\s+(\d{4})$/.exec(s)
  if (m) {
    const month = monthOf(m[1])
    return month ? [Number(m[2]), month] : [Number(m[2])]
  }
  m = /^(\d{4})\s+([A-Za-z]+)\.?$/.exec(s)
  if (m) {
    const month = monthOf(m[2])
    return month ? [Number(m[1]), month] : [Number(m[1])]
  }
  // 纯年份
  if (/^\d{4}$/.test(s)) return [Number(s)]
  return null
}

/** Zotero 条目 → CSL-JSON（D61）。 */
export function itemToCsl(item: ZoteroItem): Record<string, unknown> {
  const csl: Record<string, unknown> = { id: item.key, type: CSL_TYPE_MAP[item.itemType] ?? 'article' }

  for (const [zoteroField, cslField] of Object.entries(FIELD_MAP)) {
    const v = (item as unknown as Record<string, unknown>)[zoteroField]
    if (typeof v === 'string' && v.trim() !== '') csl[cslField] = v
  }

  // preprint（真实 Zotero 7 导出实测，2026-10-26 对照）：repository → publisher，
  // archiveID（如 "arXiv:2608.20771"）→ number；不导出 genre
  if (item.itemType === 'preprint') {
    if (item.repository?.trim()) csl.publisher = item.repository
    if (item.archiveID?.trim()) csl.number = item.archiveID
  }

  // container-title 按条目类型取源字段
  const container =
    item.itemType === 'conferencePaper'
      ? item.proceedingsTitle
      : item.itemType === 'bookSection'
        ? item.bookTitle
        : item.publicationTitle
  if (container?.trim()) csl['container-title'] = container
  if (item.place?.trim()) csl['publisher-place'] = item.place

  // 创作者按 creatorType 分桶（Zotero 导出顺序即条目内顺序）
  const byType = new Map<string, ZoteroCreator[]>()
  for (const c of item.creators ?? []) {
    if (byType.has(c.creatorType)) byType.get(c.creatorType)!.push(c)
    else byType.set(c.creatorType, [c])
  }
  for (const [creatorType, creators] of byType) {
    csl[creatorType] = creators.map(mapCreator)
  }

  // date-parts 按 Zotero 导出口径：年是字符串、月日是数字（["2026", 2, 7]）
  const issued = parseDateParts(item.date)
  if (issued) csl.issued = { 'date-parts': [[String(issued[0]), ...issued.slice(1)]] }
  const accessed = parseDateParts(item.accessDate)
  if (accessed) csl.accessed = { 'date-parts': [[String(accessed[0]), ...accessed.slice(1)]] }

  return csl
}

/**
 * 导出 CSL JSON 时把裸 itemKey 拼成 Zotero 完整 URI（D97，关闭 Q1）。
 * 库里 csl_json.id 只存裸 itemKey，导出给用户时才拼 URI，与 D61 真实对照的
 * Zotero 导出口径一致：用户库 `http://zotero.org/users/<userID>/items/<itemKey>`，
 * 群组库 `http://zotero.org/groups/<groupID>/items/<itemKey>`。
 */
export function cslExportId(
  itemKey: string,
  libraryType: 'user' | 'group',
  libraryId: string | number
): string {
  return `http://zotero.org/${libraryType}s/${libraryId}/items/${itemKey}`
}
