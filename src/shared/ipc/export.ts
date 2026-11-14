import { z } from 'zod'

/**
 * M6 共享契约：导出 Markdown（原型 08；D31/D60/D132）。
 *
 * 通道名一律 `export:` 前缀。骨架由 M6 预备提交（维护者）建立：生成器（纯函数）
 * 与 IPC 实装归 lane/fetch 批 2（src/main/export/markdown.ts + src/main/ipc/export.ts
 * 替换「未实现」桩）；弹窗 UI 归 lane/ui 批 2（components/export/**）。
 *
 * - preview：按选项生成 Markdown 字符串（弹窗内实时预览用）；
 * - save：同参数弹系统保存框写文件，返回路径（取消为 null）；
 * - overview：「研究线概览」——可选 LLM 调用（D132：默认不勾、勾选显示预计 ¥。
 *   D142：category='overview'，记在对应会话的后台项；没有会话则 session_id 为空。
 *   仍不加 'export'）。
 */

export const IPC_EXPORT = {
  preview: 'export:preview',
  save: 'export:save',
  overview: 'export:overview',
  /** uat4-fix1 S4：只读查询主进程概览缓存（不调模型） */
  peekOverview: 'export:peekOverview'
} as const

export const ExportOptionsSchema = z.object({
  graphId: z.number().int().positive(),
  /** 研究线概览（LLM，D132：默认 false） */
  overview: z.boolean(),
  /** 附每篇详情解读（耗导出体积，不额外调 LLM） */
  details: z.boolean(),
  /** 只导出这些关系类型的边（uat4 建议修 1：空数组 = 0 条关系，不再表示「全部」） */
  relationTypes: z.array(z.enum(['based_on', 'implements', 'compares', 'cites', 'same_author'])).max(5),
  /** 文末参考文献（「作者, 年份, 标题」+ DOI 链接，D60） */
  references: z.boolean()
})
export type ExportOptions = z.infer<typeof ExportOptionsSchema>

/** lane/fetch 暴露给渲染进程的 API 片段；GraphicteroApi 由 src/shared/ipc/index.ts 组合 */
export interface ExportApi {
  preview(options: ExportOptions): Promise<string>
  /** 弹系统保存框写文件；返回保存路径，取消返回 null */
  save(options: ExportOptions): Promise<string | null>
  /** 研究线概览文本（D132/D142：一次 LLM 调用，category=overview）。
   *  uat4 建议修 2：返回 { text, cached }——cached=true 表示命中主进程缓存、本次未调模型。 */
  overview(options: ExportOptions): Promise<{ text: string; cached: boolean }>
  /** uat4-fix1 S4：打开对话框时只读查询主进程是否已有该图谱的概览缓存（不调模型） */
  peekOverview(graphId: number): Promise<{ cached: boolean }>
}
