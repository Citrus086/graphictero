import { fileURLToPath } from 'node:url'
import type { ZoteroAttachmentRef, ZoteroCollection, ZoteroItem } from './types'

/**
 * Zotero Local API 客户端（D26，只读）。
 *
 * - 只走本机 23119 端口的只读端点，绝不写 Zotero；
 * - 需 Zotero 设置里开启「允许本机其他应用与 Zotero 通信」；
 * - fetch 可注入：测试用假响应，不碰真实 Zotero。
 *
 * 附件文件路径：Local API 不直接给绝对路径，调
 * `/items/<attachmentKey>/file/view/url` 取（返回 file:// URL）。
 */

export const LOCAL_API_BASE = 'http://localhost:23119/api'

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** Local API 条目 JSON → 中间表示：data 子集 + 子附件（children）挂到 attachments */
export interface RawZoteroApiItem {
  key: string
  version: number
  data: Record<string, unknown> & { itemType?: string }
  meta?: Record<string, unknown>
}

export class ZoteroLocalApi {
  constructor(
    private readonly baseUrl: string = LOCAL_API_BASE,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  /** Zotero 是否运行中且 Local API 可用（连不上视为未运行，走 sqlite 副本路径）。 */
  async available(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/users/0/items?limit=1&format=json`)
      return res.ok
    } catch {
      return false
    }
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`)
    if (!res.ok) throw new Error(`Zotero Local API ${path} 返回 ${res.status}`)
    return (await res.json()) as T
  }

  /** 分类树（平铺返回，parentKey 表达层级）。 */
  async collections(): Promise<ZoteroCollection[]> {
    const raw = await this.getJson<Array<{ key: string; data: { name: string; parentCollection?: string | false } }>>(
      '/users/0/collections?format=json'
    )
    return raw.map((c) => ({
      key: c.key,
      name: c.data.name,
      parentKey: c.data.parentCollection ? String(c.data.parentCollection) : null
    }))
  }

  /** 分类下的顶层条目（不含附件/笔记条目本身；附件作为 children 挂到父条目）。 */
  async collectionItems(collectionKey: string): Promise<ZoteroItem[]> {
    // 真实 Local API 实测（2026-10-26 冒烟）：`-attachment || note` 这种含 `||` 的
    // itemType 查询在本机端点上不生效（返回全部条目，附件会漏进来被当成论文），
    // 只有单项 `-attachment` 生效；note 再在这里客户端过滤兜住。
    const raw = await this.getJson<RawZoteroApiItem[]>(
      `/users/0/collections/${collectionKey}/items/top?format=json&itemType=-attachment`
    )
    return Promise.all(
      raw
        .filter((item) => item.data.itemType !== 'attachment' && item.data.itemType !== 'note')
        .map((item) => this.withChildren(item))
    )
  }

  private async withChildren(item: RawZoteroApiItem): Promise<ZoteroItem> {
    let children: RawZoteroApiItem[] = []
    try {
      children = await this.getJson<RawZoteroApiItem[]>(`/users/0/items/${item.key}/children?format=json`)
    } catch {
      children = [] // 个别条目取不到 children 不阻断整个导入
    }
    return apiItemToZoteroItem(item, children)
  }

  /**
   * 附件的本地文件绝对路径（file:// URL 解码）；取不到返回 null。
   * uat1b：Zotero 7 实测该端点（即便带 ?format=json）返回**纯文本** file:// URL，
   * 不是 JSON——两种格式都接受：去空白后以 file:// 开头直接当 URL，否则尝试
   * JSON.parse 取 url 字段；非 file://（http 重定向/空串）返回 null。不依赖
   * Content-Type。百分号编码（空格、中文等）由 fileURLToPath 解码。
   */
  async attachmentFilePath(attachmentKey: string): Promise<string | null> {
    try {
      const res = await this.fetchImpl(
        `${this.baseUrl}/users/0/items/${attachmentKey}/file/view/url?format=json`
      )
      if (!res.ok) return null
      const text = (await res.text()).trim()
      if (text === '') return null
      const urlText = text.startsWith('file://') ? text : (JSON.parse(text) as { url?: string }).url
      if (!urlText?.startsWith('file://')) return null
      return fileURLToPath(urlText)
    } catch {
      return null
    }
  }
}

/** Local API 条目（含 children）→ 中间表示。 */
export function apiItemToZoteroItem(item: RawZoteroApiItem, children: RawZoteroApiItem[]): ZoteroItem {
  const d = item.data as Record<string, unknown>
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
  const creators = Array.isArray(d.creators)
    ? d.creators.map((c) => {
        const o = c as Record<string, unknown>
        return {
          creatorType: String(o.creatorType ?? 'author'),
          firstName: str(o.firstName),
          lastName: str(o.lastName),
          name: str(o.name)
        }
      })
    : []

  const attachments: ZoteroAttachmentRef[] = children
    .filter((c) => c.data.itemType === 'attachment')
    .map((c) => ({
      key: c.key,
      title: str(c.data.title) ?? '',
      contentType: str(c.data.contentType) ?? '',
      path: undefined // Local API 来源的附件路径需另行调 file/view/url 获取
    }))

  return {
    key: item.key,
    version: item.version,
    itemType: String(d.itemType ?? 'document'),
    title: str(d.title),
    creators,
    abstractNote: str(d.abstractNote),
    publicationTitle: str(d.publicationTitle),
    proceedingsTitle: str(d.proceedingsTitle),
    bookTitle: str(d.bookTitle),
    volume: str(d.volume),
    issue: str(d.issue),
    pages: str(d.pages),
    DOI: str(d.DOI),
    url: str(d.url),
    date: str(d.date),
    publisher: str(d.publisher),
    place: str(d.place),
    extra: str(d.extra),
    accessDate: str(d.accessDate),
    language: str(d.language),
    ISBN: str(d.ISBN),
    ISSN: str(d.ISSN),
    archive: str(d.archive),
    archiveID: str(d.archiveID),
    repository: str(d.repository),
    attachments
  }
}
