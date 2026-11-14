import type { DetailPart } from '../parts'

/**
 * lane/detail 车道的 IPC 契约（M4）。
 *
 * 通道名一律 `detail:` 前缀；推送事件 `event:detail:*`。骨架由 M4 预备提交建立，
 * lane/detail 可在本文件内增补通道与类型（GraphicteroApi 组合处冻结）。
 */
export const IPC_DETAIL = {
  /** 读论文详情（缓存 parts + 元信息 + 过期原因，D29） */
  get: 'detail:get',
  /** 读论文元数据（详情页头部 03 / 03e 简版用：csl_json 解析 + 摘要，lane/detail 批 1 增补） */
  getMeta: 'detail:getMeta',
  /** 手动重新生成（D42：覆盖、不保留旧版；入队 detail_regen，D108；不进撤销历史，D50） */
  regenerate: 'detail:regenerate',
  /** 详情更新推送 */
  eventUpdated: 'event:detail:updated'
} as const

/** D29：PDF 哈希变化 / prompt 版本变化 → 「可能已过期」；换模型不提示 */
export type DetailStaleReason = null | 'pdf' | 'prompt'

export interface DetailView {
  paperId: number
  parts: DetailPart[]
  model: string
  generatedAt: string
  promptVersion: string
  staleReason: DetailStaleReason
}

/** 摘要来源（papers.abstract_source，D46/D54） */
export type AbstractSource = 'original' | 'ai' | 'openalex'

/**
 * 详情页元数据视图（03 头部 / 03e 简版，lane/detail 批 1 增补）：
 * 主进程解析 papers.csl_json + paper_authors，渲染层不做 CSL 解析。
 */
export interface PaperMetaView {
  paperId: number
  title: string
  /** 全名列表（paper_authors 按 position；空表回退 csl_json / first_author） */
  authors: string[]
  year: number | null
  /** 出处（csl_json container-title） */
  venue: string | null
  doi: string | null
  zoteroItemKey: string | null
  source: 'zotero' | 'agent'
  hasPdf: boolean
  /** uat1b：PDF 来源（papers.pdf_source，无 PDF 为 null）——详情页来源行如实显示 */
  pdfSource: 'zotero' | 'open_access' | 'institution_proxy' | 'custom' | 'user_drop' | null
  /** uat1b：Zotero 条目有 PDF 附件但导入时没取到文件（papers.pdf_unresolved） */
  pdfUnresolved: boolean
  abstract: string | null
  abstractSource: AbstractSource | null
  oneLiner: string | null
}

export interface DetailApi {
  /** 无详情返回 null */
  getDetail(paperId: number): Promise<DetailView | null>
  /** 论文不存在或已删除返回 null */
  getPaperMeta(paperId: number): Promise<PaperMetaView | null>
  /** 入队重新生成，返回任务 id */
  regenerateDetail(paperId: number): Promise<number>
  onDetailUpdated(cb: (paperId: number) => void): () => void
}
