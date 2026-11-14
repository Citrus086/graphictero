import { z } from 'zod'

/**
 * M6 共享契约：候选入库与 PDF 来源（m6_plan §4-3；D124/D130/D131/D133）。
 *
 * 通道名一律 `cand:` 前缀；推送事件 `event:cand:progress`。骨架由 M6 预备提交
 * （维护者）建立，主进程实装归 lane/fetch 批 1（src/main/ipc/cand.ts 替换
 * 「未实现」桩）；lane/ui 批 1 消费（03e 进度态 / 设置「PDF 来源」组）。
 * 签名变更走维护者同步两车道（M4/M5 先例）。
 *
 * - importConfirm：库外候选确认 → 开始入库（立即返回 paperId + jobId，进度走事件）；
 * - retryFindPdf / attachPdf：03e「再试一次查找」/ 拖入（复制进数据目录，不移动原文件）；
 * - pdfAttempts：03e「尝试过的来源 + 时间」（D65(6)）；
 * - get/setPdfSources：来源有序列表 + Unpaywall 邮箱（D54/D131，默认只开开放获取）。
 */

export const IPC_CAND = {
  /** 库外候选确认入库：立即返回 { paperId, jobId }，后续进度走 event:cand:progress */
  importConfirm: 'cand:importConfirm',
  /** 03e「再试一次查找」：按当前设置的来源顺序重跑 PDF 查找（D133） */
  retryFindPdf: 'cand:retryFindPdf',
  /** 拖入 / 选择 PDF：主进程校验扩展名、大小、%PDF- 头后复制进数据目录（pdf_source='user_drop'） */
  attachPdf: 'cand:attachPdf',
  /** 某论文「尝试过的来源 + 结果 + 时间」列表（03e 展示，D65(6)） */
  pdfAttempts: 'cand:pdfAttempts',
  getPdfSources: 'cand:getPdfSources',
  setPdfSources: 'cand:setPdfSources',
  /** 入库/查 PDF 进度推送（候选卡片四态、03e 进度、画布虚线→实线） */
  eventProgress: 'event:cand:progress'
} as const

/** PDF 来源项：open_access = arXiv→OpenAlex→Unpaywall 内建链；custom = 用户 {doi} 模板（默认空，D54） */
export const PdfSourceItemSchema = z.object({
  kind: z.enum(['open_access', 'custom']),
  enabled: z.boolean(),
  /** custom 必填：https 模板且含 {doi}（D54 口径；SSRF 内网防线归 lane/fetch 下载端） */
  template: z.string().max(2000).optional()
}).superRefine((v, ctx) => {
  if (v.kind === 'custom') {
    const t = v.template?.trim()
    if (!t) {
      ctx.addIssue({ code: 'custom', message: '请填写 URL 模板（https 链接，含 {doi}）' })
    } else if (!/^https:\/\//i.test(t)) {
      ctx.addIssue({ code: 'custom', message: 'URL 模板必须是 https 链接' })
    } else if (!t.includes('{doi}')) {
      ctx.addIssue({ code: 'custom', message: 'URL 模板需包含 {doi}' })
    }
  }
})
export type PdfSourceItem = z.infer<typeof PdfSourceItemSchema>

export const PdfSourcesSchema = z.object({
  /** 有序列表：先尝试排前面；保存后立即生效 */
  sources: z.array(PdfSourceItemSchema).max(20),
  /** Unpaywall 联系邮箱（默认取 .env 的 OPENALEX_MAILTO，设置页可改，D131） */
  unpaywallEmail: z.string().max(500).optional()
})
export type PdfSources = z.infer<typeof PdfSourcesSchema>

export const ImportConfirmInputSchema = z.object({ candidateId: z.number().int().positive() })
export type ImportConfirmInput = z.infer<typeof ImportConfirmInputSchema>
export const RetryFindPdfInputSchema = z.object({ paperId: z.number().int().positive() })
export type RetryFindPdfInput = z.infer<typeof RetryFindPdfInputSchema>
export const AttachPdfInputSchema = z.object({
  paperId: z.number().int().positive(),
  /** 渲染层经 webUtils.getPathForFile 拿到的绝对路径（不读字节过 IPC） */
  filePath: z.string().min(1).max(4000)
})
export type AttachPdfInput = z.infer<typeof AttachPdfInputSchema>
export const PdfAttemptsInputSchema = z.object({ paperId: z.number().int().positive() })
export type PdfAttemptsInput = z.infer<typeof PdfAttemptsInputSchema>

export interface ImportConfirmView {
  /** 新入库（或去重命中）的论文 id */
  paperId: number
  /** 排入的 candidate_pdf 任务 id（PDF 查找下载，D130） */
  jobId: number
}

export interface PdfAttemptView {
  /** 来源标识：arxiv / openalex / unpaywall / custom:<模板> 等（lane/fetch 定口径） */
  source: string
  url?: string
  result: 'not_found' | 'error' | 'ok'
  at: string
}

/** event:cand:progress 载荷（候选卡片四态与 03e 进度共用一个通道） */
export interface CandProgressEvent {
  /** 库外候选入库链路时带 */
  candidateId?: number
  paperId: number
  phase: 'importing' | 'locating' | 'downloading' | 'parsing' | 'done' | 'no_pdf' | 'failed'
  message?: string
}

/** lane/fetch 暴露给渲染进程的 API 片段；GraphicteroApi 由 src/shared/ipc/index.ts 组合 */
export interface CandApi {
  importConfirm(input: ImportConfirmInput): Promise<ImportConfirmView>
  retryFindPdf(input: RetryFindPdfInput): Promise<void>
  attachPdf(input: AttachPdfInput): Promise<void>
  pdfAttempts(input: PdfAttemptsInput): Promise<PdfAttemptView[]>
  getPdfSources(): Promise<PdfSources>
  setPdfSources(input: PdfSources): Promise<void>
  onCandProgress(cb: (e: CandProgressEvent) => void): () => void
}
