import { extractArxivId } from '../zotero/ids'

/**
 * lane/fetch 批 1：arXiv 来源（D131 内建链第一环）——纯 URL 构造，无元数据请求，
 * 拿到 arXiv ID 即给 PDF 直链；下载是否有效由 download.ts 校验。
 */

/** 测试/冒烟缝（m6_plan §3.4）：设 GRAPHICTERO_PDFSRC_BASE_URL 时替换官方域名，
 *  指向本地 fixture；生产不设 = 官方地址。 */
export function pdfSrcBase(official: string): string {
  return process.env.GRAPHICTERO_PDFSRC_BASE_URL ?? official
}

/** 归一化 arXiv ID（与 agent/candidates.normalizeArxiv 同口径：剥 URL/前缀/版本号） */
export function normalizeArxivId(raw: string): string | null {
  const extracted = extractArxivId({ archiveID: raw })
  if (extracted) return extracted
  const id = raw.trim().toLowerCase().replace(/\s+/g, '')
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(id) || /^\d{7}(v\d+)?$/.test(id)) return id.replace(/v\d+$/, '')
  return null
}

/** arXiv PDF 直链；ID 不合法返回 null（该来源记 not_found） */
export function arxivPdfUrl(arxivId: string): string | null {
  const id = normalizeArxivId(arxivId)
  if (!id) return null
  return `${pdfSrcBase('https://arxiv.org')}/pdf/${id}.pdf`
}
