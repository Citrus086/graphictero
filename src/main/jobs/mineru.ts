import { ParseStepError } from '../llm/errors'

/**
 * MinerU 解析步骤的可注入接口。真实现是 src/main/parser/mineruParser.ts
 * （MinerU api-server HTTP 客户端）；sidecar 的拉起/监控在 src/main/sidecar/。
 */
import type { ParseProgressView } from '../../shared/ipc/pdf'

export interface ParseResult {
  /** 解析出的正文 Markdown（按章节） */
  markdown: string
  /** MinerU 输出目录（Markdown + 按图号的图片），相对数据目录 */
  outDir: string
}

export interface PaperParser {
  /**
   * 解析一篇论文的 PDF；失败抛 ParseStepError（D85：手动重试步骤）。
   * onProgress：解析进度回调（event:pdf:parseProgress 的数据源），可选。
   * D95：解析器当前是否可用（未安装/未接入返回 false）——不可用期间导入
   * 有 PDF 的论文不入队解析任务，库中照常显示「未处理」，不产生失败任务。
   */
  available(): boolean
  parse(pdfPath: string, outDir: string, onProgress?: (p: ParseProgressView) => void): Promise<ParseResult>
}

/** 占位实现：MinerU sidecar 尚未接入（下一批）。失败信息直接给用户看（D44 可发现）。 */
export class UnavailableParser implements PaperParser {
  available(): boolean {
    return false // D95：未接入 = 不可用
  }

  async parse(): Promise<ParseResult> {
    throw new ParseStepError('MinerU 服务尚未接入（M2 后续批接入 sidecar 后可用）')
  }
}
