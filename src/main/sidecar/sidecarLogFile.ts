import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * uat13（D207-②）：MinerU sidecar 输出落盘——stdout/stderr 除进度解析外写进
 * 数据目录下有大小上限的滚动日志（<dataDir>/logs/mineru-sidecar.log），
 * 供「上传 PDF 失败（fetch failed）」这类只在主进程可见的错误事后排查。
 *
 * - 行缓冲：chunk 按行切，残行留到下个 chunk；空行跳过；
 * - 每行加 ISO 时间戳前缀、单行长上限（防异常巨行刷爆磁盘）；
 * - 超限滚动：文件超过 maxBytes 时只保留末尾一半（简单截断，不弄多文件轮替）。
 */

const DEFAULT_MAX_BYTES = 512 * 1024
const MAX_LINE_CHARS = 2000

export class SidecarLogFile {
  private pending = ''

  constructor(
    private readonly filePath: string,
    private readonly maxBytes = DEFAULT_MAX_BYTES
  ) {}

  /** 追加一段子进程输出（可能不含完整行）。写盘失败静默（绝不因日志阻断解析）。 */
  appendChunk(chunk: string): void {
    this.pending += chunk
    const lines = this.pending.split(/\r?\n/)
    this.pending = lines.pop() ?? ''
    for (const line of lines) this.writeLine(line)
  }

  /** 进程退出时把残行收尾。 */
  flush(): void {
    if (this.pending) {
      this.writeLine(this.pending)
      this.pending = ''
    }
  }

  private writeLine(line: string): void {
    const text = line.trim()
    if (!text) return
    const stamped = `[${new Date().toISOString()}] ${text.slice(0, MAX_LINE_CHARS)}\n`
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      if (existsSync(this.filePath) && statSync(this.filePath).size > this.maxBytes) {
        const tail = readTail(this.filePath, Math.floor(this.maxBytes / 2))
        writeFileSync(this.filePath, tail, 'utf8')
      }
      appendFileSync(this.filePath, stamped, 'utf8')
    } catch {
      // 日志 best-effort：写不进不阻断 sidecar 管理
    }
  }
}

function readTail(filePath: string, maxChars: number): string {
  try {
    return readFileSync(filePath, 'utf8').slice(-maxChars)
  } catch {
    return ''
  }
}
