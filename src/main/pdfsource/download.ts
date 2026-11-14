import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { BadRequestLlmError, NetworkLlmError, RetryableLlmError } from '../llm/errors'

/**
 * lane/fetch：PDF 下载（m6_plan §3.1/风险 2；批 1 评审必须修 1）——
 * 流式读入 → 跨块校验 `%PDF-` 头（头字节计入文件与哈希）→ 50MB 上限 → 原子改名。
 * 钉扎路径在 `data` 回调里累计字节，超过上限立刻拆连接并以 PdfSourceError 拒绝；
 * 3xx 在响应头到达时结束这一跳并丢弃正文。请求声明 `Accept-Encoding: identity`；
 * 来源仍给 gzip / br / deflate 时先解压再校验，解压后的字节同样受上限约束。
 *
 * SSRF 防线（计划风险 2/3，逐跳复查）：
 * - 生产只放行 https；http 只在 URL 的 origin 与 `GRAPHICTERO_PDFSRC_BASE_URL`
 *   完全一致、且主机名恰好是 127.0.0.1 时放行（本地 fixture）。换端口、换主机
 *   的 http 一律拒绝，包括 302 到本机其它端口；
 * - `redirect: 'manual'` 逐跳复查、最多 5 跳；
 * - 拒绝环回 / 链路本地 / 私网 / 云元数据地址：IPv4 含十进制/八进制/十六进制与
 *   单数字写法（WHATWG URL 会先归一），IPv6 含 ::1 / ::ffff: 映射（后两组 16 位
 *   拆成四个八位组）/ 6to4（2002::/16）/ NAT64（64:ff9b::/96）/ fe80:: / fc00::；
 *   域名经 DNS 复查，解析到内网即拒。生产路径把连接钉在已复查的地址上
 *   （http(s).request 的 lookup）；注入的 fetchImpl 仍是先查后连，只给测试用。
 *
 * 错误口径：超时/5xx/429 → RetryableLlmError（runner 自动重试）；网络错 →
 * NetworkLlmError（离线 → waiting_network，D70）；不是 PDF / 超限 / 404 / 坏跳转 →
 * PdfSourceError（来源链记 error 后继续下一个来源；全部是内容错误时任务按
 * 无 PDF 成功收尾，必须修 2）。
 */

/** 单个 PDF 大小上限（m6_plan §3.1：50MB） */
export const PDF_MAX_BYTES = 50 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
/** 计划风险 2：最多 5 次跳转 */
const MAX_REDIRECTS = 5
/** %PDF- 头跨块校验需要的前导字节数 */
const PDF_HEAD_LEN = 5

/** 找到链接但拿不到合法 PDF（HTML 落地页/内容损坏/超大/404/跳转异常）——链内继续下一个来源 */
export class PdfSourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PdfSourceError'
  }
}

/** 测试可注入，避免单测去解析公网域名 */
export type DnsLookup = (hostname: string) => Promise<ReadonlyArray<{ address: string }>>

const defaultLookup: DnsLookup = (hostname) => lookup(hostname, { all: true })

/**
 * 测试缝 origin：只承认 http + 主机名恰好 127.0.0.1。
 * 环境变量指向其它主机时缝不生效（生产误设也不能把 http 放出来）。
 */
function testSeamOrigin(): string | null {
  const raw = process.env.GRAPHICTERO_PDFSRC_BASE_URL
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1') return null
    return u.origin
  } catch {
    return null
  }
}

function isExactTestSeam(u: URL): boolean {
  const origin = testSeamOrigin()
  return origin != null && u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.origin === origin
}

/** IPv4 归一化：支持十进制/八进制(0 开头)/十六进制(0x)每段与单数字整体写法 */
function parseIpv4(host: string): string | null {
  const part = (p: string): number | null => {
    if (/^0x[0-9a-f]{1,2}$/i.test(p)) return parseInt(p, 16)
    if (/^0[0-7]{1,3}$/.test(p) && p.length > 1) return parseInt(p, 8)
    if (/^\d{1,3}$/.test(p)) return parseInt(p, 10)
    return null
  }
  if (!host.includes('.')) {
    // 单数字整体写法（十/八/十六进制）：2130706433 / 017700000001 / 0x7f000001
    let n: number | null = null
    if (/^0x[0-9a-f]{1,8}$/i.test(host)) n = parseInt(host, 16)
    else if (/^0[0-7]{1,11}$/.test(host) && host.length > 1) n = parseInt(host, 8)
    else if (/^\d{1,10}$/.test(host)) n = parseInt(host, 10)
    if (n == null || n < 0 || n > 0xffffffff) return null
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
  }
  const m = host.match(/^([^.]+)\.([^.]+)\.([^.]+)\.([^.]+)$/)
  if (!m) return null
  const nums = m.slice(1).map(part)
  if (nums.some((n) => n == null || n > 255)) return null
  return nums.join('.')
}

/** 把 IPv6 里嵌的 IPv4（::ffff:127.0.0.1）拆成两个 16 位组 */
function expandIpv4Tail(seg: string): string[] | null {
  if (!seg.includes('.')) return [seg]
  const v4 = parseIpv4(seg)
  if (!v4) return null
  const [a, b, c, d] = v4.split('.').map(Number)
  return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)]
}

/** IPv6 展开为 8 组 16 位；坏形状返回 null */
function parseIpv6(host: string): bigint[] | null {
  let h = host.toLowerCase()
  const zone = h.indexOf('%')
  if (zone !== -1) h = h.slice(0, zone)
  if (!h.includes(':')) return null
  const halves = h.split('::')
  if (halves.length > 2) return null
  const expandSide = (s: string): string[] | null => {
    if (!s) return []
    const out: string[] = []
    for (const p of s.split(':')) {
      const exp = expandIpv4Tail(p)
      if (!exp) return null
      out.push(...exp)
    }
    return out
  }
  const left = expandSide(halves[0] ?? '')
  const right = halves.length === 2 ? expandSide(halves[1] ?? '') : []
  if (!left || !right) return null
  const missing = 8 - left.length - right.length
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null
  const parts = [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...right]
  if (parts.length !== 8) return null
  const out: bigint[] = []
  for (const p of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(p)) return null
    out.push(BigInt(parseInt(p, 16)))
  }
  return out
}

function embeddedV4(hi: bigint, lo: bigint): string {
  const h = Number(hi)
  const l = Number(lo)
  return [(h >> 8) & 255, h & 255, (l >> 8) & 255, l & 255].join('.')
}

/** 内网/环回/链路本地/云元数据判定（v4 点分十进制串 或 v6 展开组） */
function isInternalAddress(ip: string, v6: bigint[] | null): boolean {
  if (v6) {
    if (v6.every((g) => g === 0n)) return true // ::
    if (v6.slice(0, 7).every((g) => g === 0n) && v6[7] === 1n) return true // ::1
    if ((v6[0] & 0xffc0n) === 0xfe80n) return true // fe80::/10 链路本地
    if ((v6[0] & 0xfe00n) === 0xfc00n) return true // fc00::/7 私网 ULA
    // ::ffff:a.b.c.d：后两组 16 位拆成四个八位组（不能把两组直接用点拼起来）
    if (v6.slice(0, 5).every((g) => g === 0n) && v6[5] === 0xffffn) {
      return isInternalAddress(embeddedV4(v6[6], v6[7]), null)
    }
    // 6to4 2002::/16：第 2、3 组是内嵌 IPv4
    if (v6[0] === 0x2002n) return isInternalAddress(embeddedV4(v6[1], v6[2]), null)
    // NAT64 well-known prefix 64:ff9b::/96：末 32 位是内嵌 IPv4
    if (v6[0] === 0x64n && v6[1] === 0xff9bn && v6[2] === 0n && v6[3] === 0n && v6[4] === 0n && v6[5] === 0n) {
      return isInternalAddress(embeddedV4(v6[6], v6[7]), null)
    }
    return false
  }
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return false
  const [a, b, c, d] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  if (a === 0) return true // 0.0.0.0/8
  if (a === 10) return true
  if (a === 127) return true // 环回
  if (a === 169 && b === 254) return true // 链路本地 + 云元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 100 && b === 100 && c === 100 && d === 200) return true // 阿里云元数据
  if (a === 198 && (b === 18 || b === 19)) return true // 基准测试网段
  if (a === 192 && b === 0) return true // 192.0.0.0/16（含元数据 192.0.0.10）整段拒绝
  return false
}

/** 主机名本身就是内网/环回/云元数据（不含 DNS） */
export function isBlockedPdfHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === 'metadata.google.internal' ||
    host.endsWith('.metadata.google.internal')
  ) {
    return true
  }
  const v6 = parseIpv6(host)
  if (v6) return isInternalAddress('', v6)
  const v4 = parseIpv4(host)
  if (v4) return isInternalAddress(v4, null)
  // isIP 兜底：URL 已经归一成标准点分或十六进制组，上面的解析器没认出来时再看一次
  if (isIP(host) === 4) return isInternalAddress(host, null)
  return false
}

/**
 * 来源链用：这条 URL 能不能交给 downloadPdf。
 * https 且主机名不是字面内网 → true（下载时仍做 DNS 复查）；
 * http 仅测试缝的精确 origin。
 */
export function isUsablePdfLocation(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (isExactTestSeam(u)) return true
  if (u.protocol !== 'https:') return false
  return !isBlockedPdfHost(u.hostname)
}

/**
 * 下载前的 URL 放行检查（含 DNS 复查）；不放行抛 BadRequestLlmError（不重试）。
 * 域名返回已复查的第一个地址，供连接钉死；字面地址和测试缝返回 null。
 * `allowLoopbackPin` 只给本地钉扎测试：解析结果恰好是 127.0.0.1 时仍返回该地址。
 * 生产不传。其它内网地址、以及 127.0.0.1 以外的环回，照旧拒绝。
 */
async function assertUrlAllowed(url: string, lookupImpl: DnsLookup, allowLoopbackPin = false): Promise<string | null> {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new BadRequestLlmError('下载地址不是合法 URL', 400)
  }
  if (isExactTestSeam(u)) return null
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new BadRequestLlmError('PDF 下载只支持 http(s) 链接', 400)
  }
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (isBlockedPdfHost(host)) {
    throw new BadRequestLlmError('PDF 下载不允许内网/环回地址', 400)
  }
  // 公网 http 在 DNS 之前拒绝，避免测试或生产去解析外部域名
  if (u.protocol === 'http:') {
    throw new BadRequestLlmError('PDF 下载只支持 https 链接（http 仅测试环境可用）', 400)
  }
  if (parseIpv6(host) || parseIpv4(host) || isIP(host) !== 0) return null
  let resolved: ReadonlyArray<{ address: string }>
  try {
    resolved = await lookupImpl(host)
  } catch (e) {
    throw new NetworkLlmError(`PDF 下载域名解析失败：${e instanceof Error ? e.message : String(e)}`)
  }
  if (resolved.length === 0) {
    throw new NetworkLlmError('PDF 下载域名解析失败：没有地址')
  }
  for (const r of resolved) {
    if (isBlockedPdfHost(r.address) && !(allowLoopbackPin && r.address === '127.0.0.1')) {
      throw new BadRequestLlmError('PDF 下载域名解析到了内网/环回地址', 400)
    }
  }
  return resolved[0].address
}

export interface FetchPinnedOptions {
  maxBytes?: number
  /** 测试给本地自签证书用。生产不传，走系统 CA。 */
  ca?: Buffer
}

function copyHeaders(res: http.IncomingMessage): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(res.headers)) {
    if (typeof value === 'string') headers.set(key, value)
    else if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item)
    }
  }
  return headers
}

/** 只看第一段。identity / 缺省表示正文已经是原文。 */
function contentEncoding(headers: Headers): string | null {
  const raw = headers.get('content-encoding')
  if (!raw) return null
  const token = raw.split(',')[0]?.trim().toLowerCase() ?? ''
  if (!token || token === 'identity') return null
  return token
}

function limitMessage(maxBytes: number): string {
  return `PDF 超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`
}

/** Response 的 BodyInit 不接受 Node Buffer。拷一份普通 Uint8Array。 */
function responseBytes(buf: Buffer): BodyInit {
  return new Uint8Array(buf)
}

/** 解压时按输出字节封顶，避免小 gzip 膨胀过上限后才被看见。 */
function inflateLimited(raw: Buffer, maxBytes: number, encoding: string): Promise<Buffer> {
  const make =
    encoding === 'gzip' || encoding === 'x-gzip'
      ? createGunzip
      : encoding === 'br'
        ? createBrotliDecompress
        : encoding === 'deflate'
          ? createInflate
          : null
  if (!make) return Promise.reject(new PdfSourceError('下载内容使用了不支持的压缩'))
  return new Promise((resolve, reject) => {
    const stream = make()
    const chunks: Buffer[] = []
    let n = 0
    let settled = false
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      stream.destroy()
      reject(err)
    }
    stream.on('data', (c: Buffer) => {
      if (settled) return
      n += c.length
      if (n > maxBytes) {
        fail(new PdfSourceError(limitMessage(maxBytes)))
        return
      }
      chunks.push(c)
    })
    stream.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    stream.on('error', () => fail(new PdfSourceError('压缩的下载内容无法解压')))
    stream.end(raw)
  })
}

/**
 * 把这一跳钉在已复查的地址上。SNI 与 Host 用 URL 主机名，TCP 连 `address`。
 * 注入 fetchImpl 的测试路径不走这里。
 */
export async function fetchPinned(
  urlStr: string,
  timeoutMs: number,
  address: string,
  opts: FetchPinnedOptions = {}
): Promise<Response> {
  const maxBytes = opts.maxBytes ?? PDF_MAX_BYTES
  const u = new URL(urlStr)
  const lib = u.protocol === 'https:' ? https : http
  const family = isIP(address) === 6 ? 6 : 4
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80
  return await new Promise((resolve, reject) => {
    let settled = false
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      reject(err)
    }
    const ok = (response: Response): void => {
      if (settled) return
      settled = true
      resolve(response)
    }
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers: { host: u.host, 'accept-encoding': 'identity' },
        ...(u.protocol === 'https:' ? { servername: u.hostname, ...(opts.ca ? { ca: opts.ca } : {}) } : {}),
        lookup: ((hostname: string, options: unknown, callback?: unknown) => {
          const cb = (typeof options === 'function' ? options : callback) as (
            err: NodeJS.ErrnoException | null,
            address: string | Array<{ address: string; family: number }>,
            family?: number
          ) => void
          const all =
            typeof options === 'object' &&
            options != null &&
            'all' in options &&
            Boolean((options as { all?: boolean }).all)
          if (all) cb(null, [{ address, family }])
          else cb(null, address, family)
          void hostname
        }) as never
      },
      (res) => {
        const status = res.statusCode ?? 0
        const headers = copyHeaders(res)
        // 先标 settled 再 destroy，避免 socket error 把 PdfSourceError 盖成网络错误
        const abort = (): void => {
          res.destroy()
          req.destroy()
        }
        res.on('error', (e) => {
          if (settled) return
          settled = true
          req.destroy()
          reject(e instanceof Error ? e : new Error(String(e)))
        })
        if (status >= 300 && status < 400) {
          settled = true
          abort()
          resolve(new Response(null, { status, headers }))
          return
        }
        const chunks: Buffer[] = []
        let received = 0
        res.on('data', (c: Buffer | string) => {
          if (settled) return
          const buf = Buffer.isBuffer(c) ? c : Buffer.from(c)
          received += buf.length
          if (received > maxBytes) {
            settled = true
            abort()
            reject(new PdfSourceError(limitMessage(maxBytes)))
            return
          }
          chunks.push(buf)
        })
        res.on('end', () => {
          if (settled) return
          const raw = Buffer.concat(chunks)
          const encoding = contentEncoding(headers)
          if (!encoding) {
            ok(new Response(responseBytes(raw), { status, headers }))
            return
          }
          void inflateLimited(raw, maxBytes, encoding)
            .then((body) => {
              headers.delete('content-encoding')
              headers.delete('content-length')
              ok(new Response(responseBytes(body), { status, headers }))
            })
            .catch((e: unknown) => {
              fail(e instanceof PdfSourceError ? e : new PdfSourceError('压缩的下载内容无法解压'))
            })
        })
      }
    )
    req.setTimeout(timeoutMs, () => {
      if (settled) return
      settled = true
      req.destroy()
      const e = new Error('PDF 下载超时')
      e.name = 'TimeoutError'
      reject(e)
    })
    req.on('error', (e) => {
      if (settled) return
      settled = true
      reject(e instanceof Error ? e : new Error(String(e)))
    })
    req.end()
  })
}

export interface DownloadPdfResult {
  bytes: number
  sha256: string
}

export async function downloadPdf(
  url: string,
  destDir: string,
  opts: {
    timeoutMs?: number
    maxBytes?: number
    fetchImpl?: typeof fetch
    lookupImpl?: DnsLookup
    /** 只给本地自签钉扎测试。生产不传。 */
    tlsCa?: Buffer
    /**
     * 只给本地钉扎测试：允许这一跳的解析结果恰好是 127.0.0.1，并仍钉在该地址上。
     * 生产不传。10/8、其它环回、IPv6 映射环回都不放行。
     */
    allowLoopbackPin?: boolean
  } = {}
): Promise<DownloadPdfResult> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const lookupImpl = opts.lookupImpl ?? defaultLookup
  const maxBytes = opts.maxBytes ?? PDF_MAX_BYTES
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const destPath = join(destDir, 'paper.pdf')
  mkdirSync(destDir, { recursive: true })
  const tmpPath = join(destDir, `.paper.pdf.tmp-${process.pid}`)

  // 逐跳跟随重定向（redirect:'manual'），每跳都过 assertUrlAllowed
  let current = url
  let res!: Response
  for (let hop = 0; ; hop++) {
    const pinned = await assertUrlAllowed(current, lookupImpl, opts.allowLoopbackPin === true)
    try {
      // 域名且没有注入 fetch：钉在已复查的地址上。字面 IP、测试缝、注入 fetchImpl 仍走 fetch
      // （后者只给测试用，复查和连接不是同一次，进度文档记残留）。
      res =
        pinned != null && opts.fetchImpl == null
          ? await fetchPinned(current, timeoutMs, pinned, { maxBytes, ca: opts.tlsCa })
          : await fetchImpl(current, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      // 超限是内容错误：来源链继续下一个，不进重试 / waiting_network
      if (e instanceof PdfSourceError) throw e
      if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        throw new RetryableLlmError('PDF 下载超时')
      }
      throw new NetworkLlmError(`PDF 下载网络错误：${e instanceof Error ? e.message : String(e)}`)
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined)
      if (hop >= MAX_REDIRECTS) throw new PdfSourceError(`跳转超过 ${MAX_REDIRECTS} 次`)
      const loc = res.headers.get('location')
      if (!loc) throw new PdfSourceError('响应跳转缺少 Location 头')
      current = new URL(loc, current).href
      continue
    }
    break
  }
  if (res.status === 408 || res.status === 429 || res.status >= 500) {
    await res.body?.cancel().catch(() => undefined)
    throw new RetryableLlmError(`PDF 下载暂时失败（HTTP ${res.status}）`)
  }
  if (!res.ok || !res.body) {
    throw new PdfSourceError(`下载失败（HTTP ${res.status}）`)
  }

  const hash = createHash('sha256')
  const reader = res.body.getReader()
  const chunks: Buffer[] = []
  let bytes = 0
  let head = Buffer.alloc(0) // 跨块拼前导字节，凑满 %PDF- 再判（建议修 6）
  let headChecked = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const buf = Buffer.from(value)
      if (!headChecked) {
        head = Buffer.concat([head, buf])
        if (head.length < PDF_HEAD_LEN) continue
        headChecked = true
        if (head.subarray(0, PDF_HEAD_LEN).toString('latin1') !== '%PDF-') {
          throw new PdfSourceError('下载到的内容不是 PDF（可能是网页落地页）')
        }
        // 头字节也要进文件和哈希，否则落盘的 PDF 被砍掉 %PDF-
        bytes += head.length
        if (bytes > maxBytes) throw new PdfSourceError(`PDF 超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`)
        hash.update(head)
        chunks.push(head)
        head = Buffer.alloc(0)
        continue
      }
      bytes += buf.length
      if (bytes > maxBytes) throw new PdfSourceError(`PDF 超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`)
      hash.update(buf)
      chunks.push(buf)
    }
  } catch (e) {
    await reader.cancel().catch(() => undefined)
    rmSync(tmpPath, { force: true })
    if (e instanceof PdfSourceError) throw e
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new RetryableLlmError('PDF 下载超时')
    }
    throw new NetworkLlmError(`PDF 下载中断：${e instanceof Error ? e.message : String(e)}`)
  }
  if (!headChecked) {
    rmSync(tmpPath, { force: true })
    throw new PdfSourceError(head.length === 0 ? '下载内容为空' : '下载内容过短，不是完整 PDF')
  }
  // 内存拼装后一次性落盘再原子改名（单文件 ≤50MB，可控；避免引入流依赖差异）
  // 写盘或改名失败时清掉临时文件，避免 .paper.pdf.tmp-* 留在论文目录里
  try {
    writeFileSync(tmpPath, Buffer.concat(chunks))
    renameSync(tmpPath, destPath) // 原子改名：papers/<id>/paper.pdf 不出现半文件
  } catch (e) {
    rmSync(tmpPath, { force: true })
    throw e
  }
  return { bytes, sha256: hash.digest('hex') }
}
