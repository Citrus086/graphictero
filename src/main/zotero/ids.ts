/**
 * DOI / arXiv ID 规范化与提取（D55/D82：只按 DOI 和 arXiv ID 精确去重）。
 *
 * - DOI：小写、去首尾空白、去常见的 resolver 前缀（https://doi.org/、doi:）；
 * - arXiv ID：小写、去版本号后缀（2501.12345v2 与 2501.12345 视为同一条）；
 *   来源优先级：archiveID 字段 → 条目 URL（arxiv.org/abs/...）→ extra 里的 "arXiv: ..."。
 */

export function normalizeDoi(doi: string | null | undefined): string | null {
  if (!doi) return null
  let s = String(doi).trim()
  if (!s) return null
  s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '')
  s = s.trim().toLowerCase()
  return s || null
}

/** 从 free-form 文本（URL / archiveID / extra）里提取并规范化 arXiv ID；提取不到返回 null。 */
export function extractArxivId(fields: { archiveID?: string; url?: string; extra?: string } = {}): string | null {
  const candidates: Array<string | undefined> = [fields.archiveID, fields.url, fields.extra]
  for (const raw of candidates) {
    if (!raw) continue
    const m = /arxiv\.org\/(?:abs|pdf)\/([^\s/?#]+)/i.exec(raw) ?? /(?:^|\s)arXiv\s*[:=]\s*([^\s]+)/i.exec(raw)
    if (!m) continue
    const id = m[1].replace(/\.pdf$/i, '').toLowerCase().replace(/v\d+$/, '')
    if (/^\d{4}\.\d{4,5}$/.test(id) || /^\d{7}$/.test(id)) return id
  }
  return null
}

/** 从 Zotero 的 date 字符串提取年份（取第一个 4 位年份；失败返回 null）。 */
export function extractYear(date: string | null | undefined): number | null {
  if (!date) return null
  const m = /(?:^|\D)(\d{4})(?:\D|$)/.exec(String(date))
  return m ? Number(m[1]) : null
}
