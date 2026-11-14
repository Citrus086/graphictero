import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TLSSocket } from 'node:tls'
import { gzipSync } from 'node:zlib'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BadRequestLlmError, NetworkLlmError, RetryableLlmError } from '../llm/errors'
import {
  installFetchGuard,
  minimalPdfBytes,
  startFixtureHttp,
  type FetchGuard,
  type FixtureHttp
} from '../testing/fixtureHttp'
import { downloadPdf, fetchPinned, isBlockedPdfHost, isUsablePdfLocation, PDF_MAX_BYTES, PdfSourceError, type DnsLookup } from './download'

/**
 * lane/fetch 批 1：PDF 下载测试——%PDF- 头校验、50MB 上限、超时/网络错误分类、
 * 原子改名（无 .tmp 残留）。全部打本地 fixture（出网守卫兜底）。
 * 批 1 返修必须修 1：SSRF 逐跳复查，http 只在测试缝精确 origin 上放行。
 */

let dir: string
let fixture: FixtureHttp
let guard: FetchGuard

beforeEach(async () => {
  guard = installFetchGuard()
  dir = mkdtempSync(join(tmpdir(), 'gt-dlpdf-'))
  fixture = await startFixtureHttp({
    pdfRoutes: { good: 'good', fake: 'html', huge: 'big', missing: '404', sleepy: 'slow' },
    slowDelayMs: 800,
    bigBytes: PDF_MAX_BYTES + 1024
  })
  process.env.GRAPHICTERO_PDFSRC_BASE_URL = fixture.baseUrl
})

afterEach(async () => {
  delete process.env.GRAPHICTERO_PDFSRC_BASE_URL
  rmSync(dir, { recursive: true, force: true })
  await fixture.close()
  for (const url of guard.urls) expect(new URL(url).hostname).toBe('127.0.0.1')
  guard.restore()
})

const noFetch = async (): Promise<Response> => {
  throw new Error('不应发起下载')
}

describe('downloadPdf（lane/fetch 批 1）', () => {
  it('落盘失败时清掉临时文件', async () => {
    const dest = join(dir, 'ro-dest')
    mkdirSync(dest)
    chmodSync(dest, 0o555)
    const pdf = minimalPdfBytes()
    const fetchImpl: typeof fetch = async () => new Response(new Uint8Array(pdf), { status: 200 })
    try {
      await expect(downloadPdf(`${fixture.baseUrl}/pdf/good`, dest, { fetchImpl })).rejects.toThrow(/\.paper\.pdf\.tmp-/)
      expect(readdirSync(dest).some((name) => name.startsWith('.paper.pdf.tmp-'))).toBe(false)
      expect(readdirSync(dest)).not.toContain('paper.pdf')
    } finally {
      chmodSync(dest, 0o755)
    }
  })

  it('有效 PDF：落盘 papers/paper.pdf，字节与 sha256 含完整 %PDF- 头', async () => {
    const destDir = join(dir, 'papers', '1')
    const pdf = minimalPdfBytes()
    const res = await downloadPdf(`${fixture.baseUrl}/pdf/good`, destDir)
    expect(res.bytes).toBe(pdf.length)
    expect(res.sha256).toBe(createHash('sha256').update(pdf).digest('hex'))
    const onDisk = readFileSync(join(destDir, 'paper.pdf'))
    expect(onDisk.equals(pdf)).toBe(true)
    expect(onDisk.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it('%PDF- 头跨块时仍然完整落盘', async () => {
    const pdf = minimalPdfBytes()
    const fetchImpl: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(pdf.subarray(0, 2))
            controller.enqueue(pdf.subarray(2))
            controller.close()
          }
        }),
        { status: 200, headers: { 'content-type': 'application/pdf' } }
      )
    const dest = join(dir, 'split')
    const res = await downloadPdf(`${fixture.baseUrl}/pdf/good`, dest, { fetchImpl })
    const onDisk = readFileSync(join(dest, 'paper.pdf'))
    expect(onDisk.equals(pdf)).toBe(true)
    expect(res.bytes).toBe(pdf.length)
    expect(res.sha256).toBe(createHash('sha256').update(pdf).digest('hex'))
  })

  it('不足 5 字节记过短，空正文记为空', async () => {
    const short: typeof fetch = async () => new Response(Buffer.from('PDF'), { status: 200 })
    await expect(downloadPdf(`${fixture.baseUrl}/pdf/good`, join(dir, 'short'), { fetchImpl: short })).rejects.toThrow(
      '过短'
    )
    const empty: typeof fetch = async () => new Response(Buffer.alloc(0), { status: 200 })
    await expect(downloadPdf(`${fixture.baseUrl}/pdf/good`, join(dir, 'empty'), { fetchImpl: empty })).rejects.toThrow(
      '为空'
    )
  })

  it('HTML 冒充：PdfSourceError（链内继续下一来源的口径）', async () => {
    await expect(downloadPdf(`${fixture.baseUrl}/pdf/fake`, join(dir, 'a'))).rejects.toThrow(PdfSourceError)
    await expect(downloadPdf(`${fixture.baseUrl}/pdf/fake`, join(dir, 'a'))).rejects.toThrow('不是 PDF')
  })

  it('超过 50MB 上限：拒绝写入', async () => {
    await expect(downloadPdf(`${fixture.baseUrl}/pdf/huge`, join(dir, 'b'))).rejects.toThrow('上限')
  })

  it('HTTP 404：PdfSourceError；5xx 是可重试', async () => {
    await expect(downloadPdf(`${fixture.baseUrl}/pdf/missing`, join(dir, 'c'))).rejects.toThrow(PdfSourceError)
    const fetchImpl: typeof fetch = async () => new Response('nope', { status: 503 })
    await expect(downloadPdf(`${fixture.baseUrl}/pdf/good`, join(dir, 'c5'), { fetchImpl })).rejects.toThrow(
      RetryableLlmError
    )
  })

  it('超时：RetryableLlmError（runner 自动重试口径）', async () => {
    await expect(
      downloadPdf(`${fixture.baseUrl}/pdf/sleepy`, join(dir, 'd'), { timeoutMs: 150 })
    ).rejects.toThrow(RetryableLlmError)
  })

  it('非 https 直接拒绝（BadRequest，且不解析域名）', async () => {
    let lookups = 0
    const lookupImpl: DnsLookup = async () => {
      lookups += 1
      return [{ address: '93.184.216.34' }]
    }
    await expect(
      downloadPdf('http://example.com/x.pdf', join(dir, 'e'), { lookupImpl, fetchImpl: noFetch })
    ).rejects.toThrow(BadRequestLlmError)
    expect(lookups).toBe(0)
  })

  it('网络错误分类为 NetworkLlmError（离线时 runner 进 waiting_network）', async () => {
    // 指向未监听的本地端口：连接被拒（属网络层失败，不是 HTTP 状态）
    await fixture.close()
    await expect(downloadPdf(`${fixture.baseUrl}/pdf/good`, join(dir, 'f'))).rejects.toThrow(NetworkLlmError)
  })

  it('测试缝未设置时，http://127.0.0.1 也拒绝', async () => {
    delete process.env.GRAPHICTERO_PDFSRC_BASE_URL
    await expect(downloadPdf(`${fixture.baseUrl}/pdf/good`, join(dir, 'noseam'), { fetchImpl: noFetch })).rejects.toThrow(
      /内网|环回/
    )
  })

  it('302 到本机其它端口：拒绝且不再请求', async () => {
    const calls: string[] = []
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input))
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:23119/secret.pdf' } })
    }
    await expect(downloadPdf(`${fixture.baseUrl}/pdf/good`, join(dir, 'redir'), { fetchImpl })).rejects.toThrow(
      /内网|环回/
    )
    expect(calls).toEqual([`${fixture.baseUrl}/pdf/good`])
  })

  it('测试缝内的 302 仍可下载', async () => {
    const pdf = minimalPdfBytes()
    let n = 0
    const fetchImpl: typeof fetch = async () => {
      n += 1
      if (n === 1) {
        return new Response(null, { status: 302, headers: { location: `${fixture.baseUrl}/pdf/good` } })
      }
      return new Response(new Uint8Array(pdf), { status: 200 })
    }
    const res = await downloadPdf(`${fixture.baseUrl}/start`, join(dir, 'redir-ok'), { fetchImpl })
    expect(n).toBe(2)
    expect(res.bytes).toBe(pdf.length)
  })

  it('第 6 次跳转拒绝', async () => {
    let n = 0
    const fetchImpl: typeof fetch = async () => {
      n += 1
      return new Response(null, { status: 302, headers: { location: `${fixture.baseUrl}/hop${n}` } })
    }
    await expect(downloadPdf(`${fixture.baseUrl}/hop0`, join(dir, 'hops'), { fetchImpl })).rejects.toThrow(/跳转超过/)
    expect(n).toBe(6)
  })

  it('非常规环回/私网/元数据写法在发起请求前拒绝', async () => {
    const blocked = [
      'http://2130706433/x.pdf',
      'http://0x7f000001/x.pdf',
      'http://127.1/x.pdf',
      'http://0177.0.0.1/x.pdf',
      'http://0x7f.0.0.1/x.pdf',
      'https://[::1]/x.pdf',
      'https://[::ffff:127.0.0.1]/x.pdf',
      'https://[::ffff:7f00:1]/x.pdf',
      'http://[::ffff:10.0.0.1]/x.pdf',
      'https://[fe80::1]/x.pdf',
      'https://[fd00::1]/x.pdf',
      'https://10.1.2.3/x.pdf',
      'https://169.254.169.254/latest',
      'https://192.168.1.1/a.pdf',
      'https://192.0.0.10/a.pdf',
      'https://100.100.100.200/',
      'http://127.0.0.1:23119/a.pdf',
      'https://0.0.0.0/x.pdf',
      'https://metadata.google.internal/computeMetadata/v1/'
    ]
    for (const url of blocked) {
      await expect(downloadPdf(url, join(dir, 'blocked'), { fetchImpl: noFetch })).rejects.toThrow(BadRequestLlmError)
    }
  })

  it('域名解析到内网则拒绝，解析到公网才下载', async () => {
    const internal: DnsLookup = async () => [{ address: '10.0.0.8' }]
    await expect(
      downloadPdf('https://papers.example/a.pdf', join(dir, 'dns-in'), { lookupImpl: internal, fetchImpl: noFetch })
    ).rejects.toThrow(/内网|环回/)

    const mapped: DnsLookup = async () => [{ address: '::ffff:127.0.0.1' }]
    await expect(
      downloadPdf('https://papers.example/b.pdf', join(dir, 'dns-map'), { lookupImpl: mapped, fetchImpl: noFetch })
    ).rejects.toThrow(/内网|环回/)

    const pdf = minimalPdfBytes()
    let fetched = 0
    const pub: DnsLookup = async () => [{ address: '93.184.216.34' }]
    const fetchImpl: typeof fetch = async () => {
      fetched += 1
      return new Response(new Uint8Array(pdf), { status: 200 })
    }
    const res = await downloadPdf('https://papers.example/c.pdf', join(dir, 'dns-ok'), { lookupImpl: pub, fetchImpl })
    expect(fetched).toBe(1)
    expect(res.bytes).toBe(pdf.length)
  })

  it('isUsablePdfLocation：测试缝 http 可用，其它 http 与字面内网不可用', () => {
    expect(isUsablePdfLocation(`${fixture.baseUrl}/pdf/good`)).toBe(true)
    expect(isUsablePdfLocation('https://example.com/a.pdf')).toBe(true)
    expect(isUsablePdfLocation('http://example.com/a.pdf')).toBe(false)
    expect(isUsablePdfLocation('http://127.0.0.1:23119/a.pdf')).toBe(false)
    expect(isUsablePdfLocation('https://[::1]/a.pdf')).toBe(false)
    expect(isUsablePdfLocation('https://2130706433/a.pdf')).toBe(false)
    expect(isUsablePdfLocation('file:///tmp/a.pdf')).toBe(false)
    delete process.env.GRAPHICTERO_PDFSRC_BASE_URL
    expect(isUsablePdfLocation(`${fixture.baseUrl}/pdf/good`)).toBe(false)
  })

  it('6to4 / NAT64 内嵌内网地址拒绝，公网内嵌地址放行', async () => {
    const blocked = [
      'https://[2002:7f00:1::]/x.pdf',
      'https://[64:ff9b::7f00:1]/x.pdf',
      'https://[64:ff9b::a00:8]/x.pdf'
    ]
    for (const url of blocked) {
      await expect(downloadPdf(url, join(dir, 'embed'), { fetchImpl: noFetch })).rejects.toThrow(BadRequestLlmError)
    }
    expect(isBlockedPdfHost('2002:0808:0808::')).toBe(false)
    expect(isBlockedPdfHost('64:ff9b::808:808')).toBe(false)
  })

  it('fetchPinned 用已复查地址连到本地 fixture，不靠主机名解析', async () => {
    const port = new URL(fixture.baseUrl).port
    const res = await fetchPinned(`http://pinned.invalid:${port}/pdf/good`, 3000, '127.0.0.1')
    expect(res.status).toBe(200)
    const buf = Buffer.from(await res.arrayBuffer())
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })
})

/**
 * 生产主机名路径：不注入 fetchImpl。http 主机名在 assertUrlAllowed 就被拒绝，
 * 所以这里用本地自签 https，lookup 固定回 127.0.0.1。
 */
describe('fetchPinned 经 downloadPdf（不注入 fetchImpl）', () => {
  let cert: Buffer
  let key: Buffer
  let certDir: string
  let server: https.Server
  let port = 0
  const snis: string[] = []
  const hosts: string[] = []
  const encodings: string[] = []
  const paths: string[] = []
  const timers = new Set<ReturnType<typeof setInterval>>()
  const flow = { redirBytes: 0, redirClosedEarly: false, hugeBytes: 0 }
  const pdf = minimalPdfBytes()

  function resetPins(): void {
    snis.length = 0
    hosts.length = 0
    encodings.length = 0
    paths.length = 0
    for (const timer of timers) clearInterval(timer)
    timers.clear()
    flow.redirBytes = 0
    flow.redirClosedEarly = false
    flow.hugeBytes = 0
  }

  beforeAll(async () => {
    certDir = mkdtempSync(join(tmpdir(), 'gt-pin-cert-'))
    const cnf = join(certDir, 'openssl.cnf')
    writeFileSync(
      cnf,
      [
        '[req]',
        'distinguished_name=req_dn',
        'x509_extensions=v3',
        'prompt=no',
        '[req_dn]',
        'CN=pinned.invalid',
        '[v3]',
        'subjectAltName=DNS:pinned.invalid,DNS:second.invalid',
        'basicConstraints=CA:FALSE',
        ''
      ].join('\n')
    )
    const keyPath = join(certDir, 'key.pem')
    const certPath = join(certDir, 'cert.pem')
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath, '-days', '1', '-nodes', '-config', cnf],
      { stdio: 'ignore' }
    )
    key = readFileSync(keyPath)
    cert = readFileSync(certPath)
    const gz = gzipSync(pdf)
    server = https.createServer({ key, cert }, (req, res) => {
      req.on('error', () => undefined)
      res.on('error', () => undefined)
      hosts.push(String(req.headers.host ?? ''))
      encodings.push(String(req.headers['accept-encoding'] ?? ''))
      const path = req.url ?? '/'
      paths.push(path)
      if (path === '/redir') {
        res.writeHead(302, { Location: `https://second.invalid:${port}/pdf` })
        const chunk = Buffer.alloc(64 * 1024, 0x41)
        const timer = setInterval(() => {
          if (res.destroyed || res.writableEnded) {
            clearInterval(timer)
            timers.delete(timer)
            return
          }
          flow.redirBytes += chunk.length
          if (flow.redirBytes > 8 * 1024 * 1024) {
            clearInterval(timer)
            timers.delete(timer)
            res.end()
            return
          }
          res.write(chunk)
        }, 20)
        timers.add(timer)
        res.on('close', () => {
          clearInterval(timer)
          timers.delete(timer)
          if (flow.redirBytes < 1024 * 1024) flow.redirClosedEarly = true
        })
        return
      }
      if (path === '/huge') {
        res.writeHead(200, { 'content-type': 'application/pdf' })
        let started = false
        const first = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(16 * 1024 - 5, 0x41)])
        const chunk = Buffer.alloc(16 * 1024, 0x41)
        const timer = setInterval(() => {
          if (res.destroyed || res.writableEnded) {
            clearInterval(timer)
            timers.delete(timer)
            return
          }
          const buf = started ? chunk : first
          started = true
          flow.hugeBytes += buf.length
          if (flow.hugeBytes > 8 * 1024 * 1024) {
            clearInterval(timer)
            timers.delete(timer)
            res.end()
            return
          }
          res.write(buf)
        }, 5)
        timers.add(timer)
        res.on('close', () => {
          clearInterval(timer)
          timers.delete(timer)
        })
        return
      }
      if (path === '/gz') {
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-encoding': 'gzip' })
        res.end(gz)
        return
      }
      res.writeHead(200, { 'content-type': 'application/pdf' })
      res.end(pdf)
    })
    server.on('secureConnection', (sock) => {
      const name = (sock as TLSSocket).servername
      snis.push(typeof name === 'string' ? name : '')
    })
    server.on('tlsClientError', () => undefined)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port
        resolve()
      })
    })
  })

  afterAll(async () => {
    resetPins()
    await new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
    rmSync(certDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    resetPins()
  })

  function lookupImpl(): DnsLookup {
    return async () => [{ address: '127.0.0.1' }]
  }

  it('未开测试缝时，解析到 127.0.0.1 仍拒绝且不连接', async () => {
    await expect(
      downloadPdf(`https://pinned.invalid:${port}/pdf`, join(dir, 'pin-block'), {
        lookupImpl: lookupImpl(),
        tlsCa: cert,
        timeoutMs: 1000
      })
    ).rejects.toBeInstanceOf(BadRequestLlmError)
    expect(hosts).toEqual([])
    expect(snis).toEqual([])
    expect(readdirSync(join(dir, 'pin-block')).some((name) => name === 'paper.pdf' || name.startsWith('.paper.pdf.tmp-'))).toBe(false)
  })

  it('正文超过上限拒绝为 PdfSourceError，临时 PDF 不落盘', async () => {
    const dest = join(dir, 'pin-huge')
    const looked: string[] = []
    let caught: unknown
    try {
      await downloadPdf(`https://pinned.invalid:${port}/huge`, dest, {
        lookupImpl: async (hostname) => {
          looked.push(hostname)
          return [{ address: '127.0.0.1' }]
        },
        maxBytes: 32 * 1024,
        timeoutMs: 4000,
        tlsCa: cert,
        allowLoopbackPin: true
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(PdfSourceError)
    expect(caught).not.toBeInstanceOf(NetworkLlmError)
    expect((caught as Error).message).toMatch(/上限/)
    expect(looked).toEqual(['pinned.invalid'])
    expect(snis).toContain('pinned.invalid')
    expect(hosts).toContain(`pinned.invalid:${port}`)
    expect(encodings.every((v) => v === 'identity')).toBe(true)
    expect(flow.hugeBytes).toBeGreaterThan(32 * 1024)
    expect(flow.hugeBytes).toBeLessThan(1024 * 1024)
    expect(readdirSync(dest).some((name) => name === 'paper.pdf' || name.startsWith('.paper.pdf.tmp-'))).toBe(false)
    expect(guard.urls.some((url) => url.includes('pinned.invalid'))).toBe(false)
  })

  it('钉扎后 302 再钉下一跳，大正文不缓冲仍能跟上', async () => {
    const dest = join(dir, 'pin-redir')
    const looked: string[] = []
    const started = Date.now()
    const res = await downloadPdf(`https://pinned.invalid:${port}/redir`, dest, {
      lookupImpl: async (hostname) => {
        looked.push(hostname)
        return [{ address: '127.0.0.1' }]
      },
      maxBytes: 32 * 1024,
      timeoutMs: 4000,
      tlsCa: cert,
      allowLoopbackPin: true
    })
    expect(Date.now() - started).toBeLessThan(1500)
    expect(flow.redirClosedEarly).toBe(true)
    expect(flow.redirBytes).toBeLessThan(1024 * 1024)
    expect(looked).toEqual(['pinned.invalid', 'second.invalid'])
    expect(snis.indexOf('pinned.invalid')).toBeGreaterThanOrEqual(0)
    expect(snis.indexOf('pinned.invalid')).toBeLessThan(snis.indexOf('second.invalid'))
    expect(hosts).toContain(`pinned.invalid:${port}`)
    expect(hosts).toContain(`second.invalid:${port}`)
    expect(paths).toEqual(['/redir', '/pdf'])
    expect(encodings.every((v) => v === 'identity')).toBe(true)
    expect(res.bytes).toBe(pdf.length)
    expect(readFileSync(join(dest, 'paper.pdf')).equals(pdf)).toBe(true)
  })

  it('压缩响应先解压再校验 %PDF-，请求声明 identity', async () => {
    const dest = join(dir, 'pin-gz')
    const res = await downloadPdf(`https://pinned.invalid:${port}/gz`, dest, {
      lookupImpl: lookupImpl(),
      tlsCa: cert,
      allowLoopbackPin: true
    })
    expect(encodings).toEqual(['identity'])
    expect(snis).toContain('pinned.invalid')
    expect(hosts).toContain(`pinned.invalid:${port}`)
    expect(res.bytes).toBe(pdf.length)
    expect(res.sha256).toBe(createHash('sha256').update(pdf).digest('hex'))
    expect(readFileSync(join(dest, 'paper.pdf')).equals(pdf)).toBe(true)
  })
})
