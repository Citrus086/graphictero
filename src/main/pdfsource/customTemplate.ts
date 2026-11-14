import { BadRequestLlmError } from '../llm/errors'
import { normalizeDoi } from '../zotero/ids'
import { isBlockedPdfHost } from './download'

/**
 * lane/fetch 批 1：自定义 `{doi}` 模板来源（D54：默认空、用户自加、自担责）。
 *
 * 安全（m6_plan 风险 3）：{doi} 必须 URL 编码；只接受 https（契约 zod 已卡，
 * 下载端再守）；禁内网/环回主机名，防 SSRF（127.* / 10.* / 192.168.* /
 * 169.254.* / 172.16-31.* / localhost / 0.0.0.0）。
 */

const BLOCKED_HOST_RE = /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i

/** 模板 → 具体 URL；论文无 DOI 返回 null（记 not_found） */
export function customTemplateUrl(template: string, doi: string | null | undefined): string | null {
  const d = normalizeDoi(doi)
  if (!d) return null
  const url = template.replace(/\{doi\}/g, encodeURIComponent(d))
  if (!/^https:\/\//i.test(url)) throw new BadRequestLlmError('自定义来源必须是 https 链接', 400)
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    throw new BadRequestLlmError('自定义来源模板不是合法 URL', 400)
  }
  if (BLOCKED_HOST_RE.test(host) || isBlockedPdfHost(host)) {
    throw new BadRequestLlmError('自定义来源不允许指向内网或本机地址', 400)
  }
  return url
}
