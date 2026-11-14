/**
 * Zotero 条目的中间表示：Local API 响应和 zotero.sqlite 副本读取器
 * 都归一化成这个形状，下游（CSL 映射、去重入库）只面向它。
 * 只保留导入所需的字段子集。
 */

export interface ZoteroCreator {
  creatorType: string // author | editor | ...
  firstName?: string
  lastName?: string
  /** 单字段创作者（机构名等）：有 name 时忽略 firstName/lastName */
  name?: string
}

export interface ZoteroAttachmentRef {
  key: string
  title: string
  contentType: string
  /**
   * 附件文件位置（仅 sqlite 来源能直接给出）：
   * - "storage:<文件名>"：Zotero data dir 下 storage/<itemKey>/<文件名>；
   * - 绝对路径：linked file。
   * Local API 来源走 /items/:key/file/view/url 现取，见 localApi.ts。
   */
  path?: string
}

export interface ZoteroItem {
  key: string
  version: number
  /** sqlite 来源的库 ID（Local API 固定 users/0，不填）；D75 复合键的一部分 */
  libraryID?: number
  itemType: string
  title?: string
  creators?: ZoteroCreator[]
  abstractNote?: string
  publicationTitle?: string
  proceedingsTitle?: string
  bookTitle?: string
  volume?: string
  issue?: string
  pages?: string
  DOI?: string
  url?: string
  date?: string
  publisher?: string
  place?: string
  extra?: string
  accessDate?: string
  language?: string
  ISBN?: string
  ISSN?: string
  archive?: string
  archiveID?: string
  /** preprint 的仓库名（如 "arXiv"）；CSL 导出时 → publisher（D61 真实对照） */
  repository?: string
  attachments: ZoteroAttachmentRef[]
}

export interface ZoteroCollection {
  key: string
  name: string
  /** 所属库 ID：1 = 用户个人库；>1 = 群组库（sqlite 来源才有；Local API 固定 users/0 不填） */
  libraryID?: number
  parentKey: string | null
}
