import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ParseProgressView, ParseStage } from '../../shared/ipc/pdf'
import { ParseStepError } from '../llm/errors'
import type { ParseResult, PaperParser } from '../jobs/mineru'
import type { MineruSidecar } from '../sidecar/mineruSidecar'
import { isSafeEntryName, readZipBuffer } from './unzip'

/**
 * 真正的 PaperParser 实现：通过 MinerU api-server 的 HTTP 接口解析
 * （docs/mineru-server-api.md 实测口径）：
 *   POST /v1/uploads → PUT 字节 → complete → POST /v1/parse/jobs
 *   → 轮询 GET /v1/parse/jobs/{id} → GET /v1/files/{file_id}/content 取正文。
 *
 * - 输出：markdown 由调用方写 full.md（processPaper 步骤约定）；zip 里的
 *   images/** 按图号解到 outDir/images/（D74 缓存：Markdown/图片按论文落盘，
 *   第二次打开不重复解析）。
 * - 进度：stage + 服务端文件级进度 + best-effort 页码（sidecar 从子进程输出
 *   解析 window 行，D72：API 本身无页级）；解析不到页码就回退阶段+已用时长。
 * - 失败一律抛 ParseStepError（中文原因，D85 手动重试步骤）：
 *   服务不可用 / 服务端 job failed / 超过总超时（D73 总超时兜底）。
 *
 * fetch 可注入，单测走本地 HTTP stub（不真起 MinerU）。
 */

export interface MineruParserDeps {
  sidecar: Pick<MineruSidecar, 'isReady' | 'baseUrl' | 'pageProgress'>
  fetchImpl?: typeof fetch
  /** job 状态轮询间隔（毫秒），默认 2000 */
  pollMs?: number
  /** 单篇解析总超时（D73），默认 20 分钟 */
  totalTimeoutMs?: number
  now?: () => number
}

interface UploadResponse {
  id: string
  status: string
  upload_url?: string
  upload_headers?: Record<string, string>
  file?: { id: string } | null
}

interface JobFile {
  status: string
  error?: string | null
  output_files?: {
    markdown?: { file_id: string } | null
    zip?: { file_id: string } | null
  } | null
}

interface JobResponse {
  status: string
  progress?: { completed: number; failed: number; total: number }
  files?: JobFile[]
}

/** 各步骤 fetch 超时（建 2：不加的话 undici 默认 300s，D73 判崩/总超时名存实亡） */
const FETCH_TIMEOUT = {
  /** 小型 JSON 往返（uploads 登记 / complete / 建 job） */
  json: 10_000,
  /** 传 PDF 字节 / 取解析产物 */
  transfer: 60_000,
  /** job 状态轮询 */
  poll: 10_000
} as const

/** 轮询对连续 5xx 的容忍次数（4xx 仍立即失败） */
const POLL_5XX_LIMIT = 3

/** uat13（D207-②）：错误详情展示上限，防异常长消息刷爆任务错误列 */
const DETAIL_MAX_CHARS = 160

function errCause(e: unknown): unknown {
  return e instanceof Error ? (e as Error & { cause?: unknown }).cause : undefined
}

function errCode(e: unknown): string | null {
  const from = (v: unknown): string | null => {
    if (v && typeof v === 'object' && typeof (v as { code?: unknown }).code === 'string') {
      return (v as { code: string }).code
    }
    return null
  }
  // AggregateError（如 EADDRNOTAVAIL/解析失败成组）取第一个子错误
  const agg = e as { errors?: unknown[] } | null
  if (agg && Array.isArray(agg.errors) && agg.errors.length > 0) {
    return from(agg.errors[0]) ?? from(e)
  }
  return from(e)
}

function errMessage(e: unknown): string | null {
  return e instanceof Error && e.message ? e.message : null
}

/**
 * uat13（D207-②）：把 fetch 底层错误整理成可展示的一行——保留 cause 的
 * code / message（ECONNREFUSED、UND_ERR_*、ETIMEDOUT 等），脱敏（去掉 URL /
 * 查询串 / key 形态内容），限长。例：`fetch failed: ECONNRESET`。
 * 只用于展示进 ParseStepError.message，绝不打印 key 本体。
 */
export function sanitizeFetchDetail(e: unknown): string {
  const msg = errMessage(e) ?? String(e)
  if (/timed? ?out|aborted/i.test(msg) && !errCode(e)) return '请求超时或被中断'
  const code = errCode(e) ?? errCode(errCause(e))
  const causeMsg = errMessage(errCause(e))
  let text: string
  if (msg === 'fetch failed') {
    // 保留「fetch failed」骨架 + cause 的 code / message（uat13 示例口径）
    const inner = [code && !causeMsg?.includes(code) ? code : '', causeMsg ?? ''].filter(Boolean).join(' ')
    text = inner ? `fetch failed: ${inner}` : 'fetch failed'
  } else {
    text = msg
  }
  // 脱敏：URL / 查询串 / key=value 形态一律去掉（本地 127.0.0.1:端口保留，便于排查）
  text = text
    .replace(/https?:\/\/\S+/gi, '[地址已隐藏]')
    .replace(/[?&][A-Za-z0-9_-]+=[^\s&]*/g, '')
    .replace(/\b[A-Za-z0-9_]*(?:key|token|secret)[A-Za-z0-9_]*\s*=\s*\S+/gi, '[参数已隐藏]')
    .replace(/\s+/g, ' ')
    .trim()
  if (code) text = text.includes(code) ? text : `${code} ${text}`.trim()
  if (!text) text = '未知网络错误'
  return text.length > DETAIL_MAX_CHARS ? `${text.slice(0, DETAIL_MAX_CHARS)}…` : text
}

/** 请求路径（method + pathname），拼进步骤错误；查询串不带 */
function requestLabel(url: string, init: RequestInit): string {
  let pathname = url
  try {
    pathname = new URL(url).pathname
  } catch {
    // 非标准 URL：用原串，sanitize 已在 detail 侧做过
  }
  const method = init.method ?? 'GET'
  return `${method} ${pathname}`
}

export class MineruParser implements PaperParser {
  private pollMs: number
  private totalTimeoutMs: number

  constructor(private deps: MineruParserDeps) {
    this.pollMs = deps.pollMs ?? 2000
    this.totalTimeoutMs = deps.totalTimeoutMs ?? 20 * 60_000
  }

  available(): boolean {
    return this.deps.sidecar.isReady()
  }

  async parse(pdfPath: string, outDir: string, onProgress?: (p: ParseProgressView) => void): Promise<ParseResult> {
    if (!this.available()) throw new ParseStepError('MinerU 服务不可用（未安装或未启动）')
    const base = this.deps.sidecar.baseUrl()
    if (!base) throw new ParseStepError('MinerU 服务地址未知')
    const fetchImpl = this.deps.fetchImpl ?? fetch
    const t0 = this.now()
    const emit = (stage: ParseStage): void => {
      onProgress?.({
        stage,
        completedFiles: 0,
        totalFiles: 1,
        ...this.deps.sidecar.pageProgress(),
        elapsedSec: Math.round((this.now() - t0) / 1000)
      })
    }

    // 1. 上传 PDF（同 sha 服务端秒传）
    emit('upload')
    const bytes = readFileSync(pdfPath)
    const sha = createHash('sha256').update(bytes).digest('hex')
    const fileId = await this.uploadPdf(fetchImpl, base, pdfPath, bytes, sha)

    // 2. 建解析 job（markdown + zip：zip 拿按图号的图片）
    emit('parse')
    const jobId = await this.createJob(fetchImpl, base, fileId)

    // 3. 轮询直到终态（总超时兜底，D73）
    const deadline = this.now() + this.totalTimeoutMs
    const job = await this.pollJob(fetchImpl, base, jobId, deadline, (completed, total) => {
      onProgress?.({
        stage: 'parse',
        completedFiles: completed,
        totalFiles: total,
        ...this.deps.sidecar.pageProgress(),
        elapsedSec: Math.round((this.now() - t0) / 1000)
      })
    })

    // 4. 取正文 + 解图片
    emit('download')
    const file = job.files?.[0]
    const mdRef = file?.output_files?.markdown
    if (!mdRef) throw new ParseStepError('MinerU 未返回 Markdown 结果')
    const markdown = await this.fetchText(fetchImpl, base, mdRef.file_id)
    const zipRef = file?.output_files?.zip
    if (zipRef) {
      const zipBytes = Buffer.from(await this.fetchBytes(fetchImpl, base, zipRef.file_id))
      this.extractZipArtifacts(zipBytes, outDir)
    }

    return { markdown, outDir }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** 带超时的 fetch：超时/网络错误统一抛 ParseStepError（步骤原因，D85 手动重试） */
  private async req(
    fetchImpl: typeof fetch,
    url: string,
    what: string,
    init: RequestInit = {},
    timeoutMs: number = FETCH_TIMEOUT.json
  ): Promise<Response> {
    let res: Response
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      // uat13（D207-②）：保留脱敏后的底层原因（cause.code/message）+ 请求路径，不再只剩「fetch failed」
      throw new ParseStepError(`${what}（${requestLabel(url, init)}：${sanitizeFetchDetail(e)}）`)
    }
    return res
  }

  private async uploadPdf(fetchImpl: typeof fetch, base: string, pdfPath: string, bytes: Buffer, sha: string): Promise<string> {
    const name = pdfPath.split('/').pop() ?? 'paper.pdf'
    const res = await this.req(fetchImpl, `${base}/v1/uploads`, '上传 PDF 失败', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: name,
        bytes: bytes.length,
        mime_type: 'application/pdf',
        purpose: 'parse',
        sha256sum: sha
      })
    })
    if (!res.ok) throw new ParseStepError(`上传 PDF 失败（HTTP ${res.status}）`)
    const up = (await res.json()) as UploadResponse
    if (up.status === 'completed' && up.file?.id) return up.file.id
    if (!up.upload_url) throw new ParseStepError('MinerU 未返回上传地址')
    const put = await this.req(fetchImpl, this.sameOrigin(base, up.upload_url), '传输 PDF 字节失败', {
      method: 'PUT',
      headers: up.upload_headers ?? {},
      body: new Uint8Array(bytes)
    }, FETCH_TIMEOUT.transfer)
    if (!put.ok) throw new ParseStepError(`传输 PDF 字节失败（HTTP ${put.status}）`)
    const done = await this.req(fetchImpl, `${base}/v1/uploads/${up.id}/complete`, '完成上传失败', { method: 'POST' })
    if (!done.ok) throw new ParseStepError(`完成上传失败（HTTP ${done.status}）`)
    const completed = (await done.json()) as UploadResponse
    if (!completed.file?.id) throw new ParseStepError('MinerU 未完成文件登记')
    return completed.file.id
  }

  /** upload_url 是同站绝对地址；剥到 path 拼回 base（stub 友好） */
  private sameOrigin(base: string, url: string): string {
    if (url.startsWith('/')) return base + url
    return url
  }

  private async createJob(fetchImpl: typeof fetch, base: string, fileId: string): Promise<string> {
    const res = await this.req(fetchImpl, `${base}/v1/parse/jobs`, '创建解析任务失败', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [{ source: { type: 'file_id', file_id: fileId } }],
        output_formats: ['markdown', 'zip']
      })
    })
    if (!res.ok) throw new ParseStepError(`创建解析任务失败（HTTP ${res.status}）`)
    const body = (await res.json()) as { job_id?: string }
    if (!body.job_id) throw new ParseStepError('MinerU 未返回 job_id')
    return body.job_id
  }

  private async pollJob(
    fetchImpl: typeof fetch,
    base: string,
    jobId: string,
    deadline: number,
    onTick: (completed: number, total: number) => void
  ): Promise<JobResponse> {
    let netFails = 0 // 瞬断（ECONNRESET 等）容忍：长解析期间服务端可能断 keep-alive，不立即判死
    let serverFails = 0 // 连续 5xx 容忍（偶发抖动不烧掉整篇解析）；4xx 仍立即失败
    for (;;) {
      let res: Response
      try {
        res = await fetchImpl(`${base}/v1/parse/jobs/${jobId}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT.poll) })
      } catch (e) {
        netFails++
        // uat13（D207-②）：底层原因脱敏保留（ECONNRESET 等），便于区分瞬断与持续断网
        if (netFails > 10) throw new ParseStepError(`查询解析进度失败（网络错误：${sanitizeFetchDetail(e)}）`)
        await this.sleep(Math.min(this.pollMs * netFails, 5000))
        continue
      }
      netFails = 0
      if (!res.ok) {
        if (res.status >= 500 && res.status < 600 && serverFails < POLL_5XX_LIMIT - 1) {
          serverFails++
          await this.sleep(Math.min(this.pollMs * serverFails, 5000))
          continue
        }
        throw new ParseStepError(`查询解析进度失败（HTTP ${res.status}）`)
      }
      serverFails = 0
      const job = (await res.json()) as JobResponse
      const total = job.progress?.total ?? job.files?.length ?? 1
      const completed = job.progress?.completed ?? 0
      onTick(completed, total)
      if (job.status === 'completed') return job
      if (job.status === 'failed' || job.status === 'canceled') {
        const fileErr = job.files?.find((f) => f.error)?.error
        throw new ParseStepError(
          job.status === 'canceled'
            ? 'MinerU 解析任务被取消'
            : `MinerU 解析失败：${fileErr ?? job.status}`
        )
      }
      if (this.now() > deadline) {
        // D73 总超时：明确报错，交由任务系统标记手动重试
        try {
          await fetchImpl(`${base}/v1/parse/jobs/${jobId}`, { method: 'DELETE', signal: AbortSignal.timeout(FETCH_TIMEOUT.json) })
        } catch {
          // 取消失败不掩盖超时错误
        }
        throw new ParseStepError('MinerU 解析超过预计总时长，已停止（可手动重试）')
      }
      await this.sleep(this.pollMs)
    }
  }

  /** 把 zip 里的解析产物解到缓存：images/** 按图号解到 <outDir>/images/，
   * 根目录 structured_content.json 一并存 <outDir>/（D27「按 bbox 跳到图」的
   * 图块数据源；实测 4.0.12 zip 恒含，缺了不阻断正文/图片，best-effort） */
  private extractZipArtifacts(zipBytes: Buffer, outDir: string): void {
    let entries
    try {
      entries = readZipBuffer(zipBytes)
    } catch {
      return // zip 拿不到不阻断正文（best-effort，图片下次重试可补）
    }
    for (const e of entries) {
      if (e.name === 'structured_content.json') {
        mkdirSync(outDir, { recursive: true })
        writeFileSync(join(outDir, 'structured_content.json'), e.data)
        continue
      }
      if (!e.name.startsWith('images/')) continue
      const rel = e.name.slice('images/'.length)
      if (!rel || !isSafeEntryName(rel)) continue
      const dest = join(outDir, 'images', rel)
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, e.data)
    }
  }

  private async fetchText(fetchImpl: typeof fetch, base: string, fileId: string): Promise<string> {
    const buf = await this.fetchBytes(fetchImpl, base, fileId)
    return Buffer.from(buf).toString('utf8')
  }

  private async fetchBytes(fetchImpl: typeof fetch, base: string, fileId: string): Promise<ArrayBuffer> {
    const res = await this.req(fetchImpl, `${base}/v1/files/${fileId}/content`, '获取解析结果失败', {}, FETCH_TIMEOUT.transfer)
    if (!res.ok) throw new ParseStepError(`获取解析结果失败（HTTP ${res.status}）`)
    return res.arrayBuffer()
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms).unref())
  }
}
