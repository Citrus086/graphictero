import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { MineruParser } from './mineruParser'
import { isSafeEntryName, readZipBuffer } from './unzip'
import { writeZip } from '../db/zip'
import { ParseStepError } from '../llm/errors'
import type { ParseProgressView } from '../../shared/ipc/pdf'

/**
 * MineruParser 单测：本地 HTTP stub 模拟 MinerU api-server
 * （docs/mineru-server-api.md 实测口径），不真起 MinerU。
 * 覆盖：成功链路（上传→job→轮询→正文+图片）、秒传、失败、总超时、服务不可用、
 * zip 图片解包与 zip-slip 防护。
 */

interface StubState {
  uploadsCompletedImmediately: boolean
  jobBehavior: 'normal' | 'fail' | 'stuck' | 'query500' | 'query404'
  /** query500 模式返回 500 的轮询次数（其余轮询走 normal；默认无限 = 持续 500） */
  query500Times: number
  putBodies: Buffer[]
  deleteCalled: number
  pollCount: number
}

let server: Server
let base: string
let stub: StubState
let dir: string

function json(res: import('node:http').ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gt-parser-'))
  stub = { uploadsCompletedImmediately: false, jobBehavior: 'normal', query500Times: Number.MAX_SAFE_INTEGER, putBodies: [], deleteCalled: 0, pollCount: 0 }
  server = createServer((req, res) => {
    const url = req.url ?? ''
    const method = req.method ?? ''
    if (method === 'POST' && url === '/v1/uploads') {
      if (stub.uploadsCompletedImmediately) {
        return json(res, { id: 'up0', status: 'completed', file: { id: 'file-src-instant' } })
      }
      return json(res, {
        id: 'up1',
        status: 'pending',
        upload_url: '/v1/uploads/up1/content',
        upload_headers: { 'Content-Type': 'application/pdf' },
        file: null
      })
    }
    if (method === 'PUT' && url === '/v1/uploads/up1/content') {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        stub.putBodies.push(Buffer.concat(chunks))
        res.writeHead(200)
        res.end()
      })
      return
    }
    if (method === 'POST' && url === '/v1/uploads/up1/complete') {
      return json(res, { status: 'completed', file: { id: 'file-src' } })
    }
    if (method === 'POST' && url === '/v1/parse/jobs') {
      return json(res, { job_id: 'job1' })
    }
    if (method === 'GET' && url === '/v1/parse/jobs/job1') {
      stub.pollCount++
      if (stub.jobBehavior === 'query404') return json(res, { error: 'nope' }, 404)
      if (stub.jobBehavior === 'query500' && stub.pollCount <= stub.query500Times) return json(res, { error: 'boom' }, 500)
      if (stub.jobBehavior === 'stuck') return json(res, { status: 'running', progress: { completed: 0, failed: 0, total: 1 }, files: [] })
      if (stub.jobBehavior === 'fail') {
        return json(res, {
          status: 'failed',
          progress: { completed: 0, failed: 1, total: 1 },
          files: [{ status: 'failed', error: 'OCR 引擎崩溃' }]
        })
      }
      if (stub.pollCount < 2) {
        return json(res, { status: 'running', progress: { completed: 0, failed: 0, total: 1 }, files: [{ status: 'running' }] })
      }
      return json(res, {
        status: 'completed',
        progress: { completed: 1, failed: 0, total: 1 },
        files: [{
          status: 'completed',
          output_files: { markdown: { file_id: 'file-md' }, zip: { file_id: 'file-zip' } }
        }]
      })
    }
    if (method === 'DELETE' && url === '/v1/parse/jobs/job1') {
      stub.deleteCalled++
      return json(res, { status: 'canceled' })
    }
    if (method === 'GET' && url === '/v1/files/file-md/content') {
      res.writeHead(200, { 'Content-Type': 'text/markdown' })
      res.end('# 标题\n\n正文 ![](images/fig1.jpg)\n')
      return
    }
    if (method === 'GET' && url === '/v1/files/file-zip/content') {
      const zipPath = join(dir, 'out.zip')
      writeZip(
        [
          { name: 'paper.md', data: Buffer.from('# 标题') },
          { name: 'structured_content.json', data: Buffer.from('{"pages":[{"page_idx":0,"blocks":[]}]}') },
          { name: 'images/fig1.jpg', data: Buffer.from('FAKEJPEG') },
          { name: 'images/sub/fig2.png', data: Buffer.from('FAKEPNG') }
        ],
        zipPath
      )
      res.writeHead(200, { 'Content-Type': 'application/zip' })
      res.end(readFileSync(zipPath))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

function makePdf(): string {
  const p = join(dir, 'paper.pdf')
  writeFileSync(p, Buffer.from('%PDF-fake-bytes'))
  return p
}

function makeParser(extra: Partial<ConstructorParameters<typeof MineruParser>[0]> = {}): MineruParser {
  return new MineruParser({
    sidecar: {
      isReady: () => true,
      baseUrl: () => base,
      pageProgress: () => ({ pagesDone: 3, pagesTotal: 10 })
    },
    pollMs: 5,
    ...extra
  })
}

describe('MineruParser 成功链路', () => {
  it('上传→建 job→轮询→正文写回，图片按图号解到 outDir/images/', async () => {
    const parser = makeParser()
    const pdf = makePdf()
    const outDir = join(dir, 'mineru')
    const progress: ParseProgressView[] = []
    const result = await parser.parse(pdf, outDir, (p) => progress.push(p))

    expect(result.markdown).toContain('# 标题')
    expect(result.outDir).toBe(outDir)
    // PDF 字节确实 PUT 上去
    expect(stub.putBodies.length).toBe(1)
    expect(stub.putBodies[0].equals(readFileSync(pdf))).toBe(true)
    // 图片解包（含子目录），zip 里的 md 不重复落盘（正文以 full.md 口径由步骤层写）
    expect(readFileSync(join(outDir, 'images', 'fig1.jpg'), 'utf8')).toBe('FAKEJPEG')
    expect(readFileSync(join(outDir, 'images', 'sub', 'fig2.png'), 'utf8')).toBe('FAKEPNG'
    )
    expect(existsSync(join(outDir, 'paper.md'))).toBe(false)
    // structured_content.json 一并缓存（D27「按 bbox 跳到图」的图块数据源）
    expect(readFileSync(join(outDir, 'structured_content.json'), 'utf8')).toContain('"page_idx":0')
    // 进度：stage 覆盖 upload → parse（起始 + 每轮轮询）→ download
    expect(progress.map((p) => p.stage)).toEqual(['upload', 'parse', 'parse', 'parse', 'download'])
    expect(progress[0]).toMatchObject({ pagesDone: 3, pagesTotal: 10, completedFiles: 0, totalFiles: 1 })
    expect(progress[1].completedFiles).toBe(0)
    expect(progress[3].completedFiles).toBe(1) // 轮询拿到文件级进度
  })

  it('同 sha 秒传：uploads 直接 completed 时跳过 PUT', async () => {
    stub.uploadsCompletedImmediately = true
    const parser = makeParser()
    const outDir = join(dir, 'mineru')
    const result = await parser.parse(makePdf(), outDir)
    expect(result.markdown).toContain('# 标题')
    expect(stub.putBodies.length).toBe(0)
  })
})

describe('MineruParser 失败路径（一律 ParseStepError，D85 手动重试）', () => {
  it('服务不可用 → ParseStepError', async () => {
    const parser = new MineruParser({
      sidecar: { isReady: () => false, baseUrl: () => null, pageProgress: () => ({ pagesDone: null, pagesTotal: null }) }
    })
    await expect(parser.parse(makePdf(), join(dir, 'm'))).rejects.toThrow(ParseStepError)
    await expect(parser.parse(makePdf(), join(dir, 'm'))).rejects.toThrow('MinerU 服务不可用')
  })

  it('服务端 job failed → 带服务端错误原因', async () => {
    stub.jobBehavior = 'fail'
    const parser = makeParser()
    await expect(parser.parse(makePdf(), join(dir, 'm'))).rejects.toThrow('OCR 引擎崩溃')
  })

  it('解析总超时（D73）：stuck job 到点报错并尝试取消', async () => {
    stub.jobBehavior = 'stuck'
    const t0 = Date.now()
    const parser = makeParser({ now: () => Date.now() - t0, totalTimeoutMs: 80, pollMs: 10 })
    await expect(parser.parse(makePdf(), join(dir, 'm'))).rejects.toThrow('超过预计总时长')
    expect(stub.deleteCalled).toBe(1)
  })

  it('解析中途服务崩溃（查询 500）→ ParseStepError', async () => {
    stub.jobBehavior = 'query500'
    const parser = makeParser()
    await expect(parser.parse(makePdf(), join(dir, 'm'))).rejects.toThrow('查询解析进度失败')
  })

  it('轮询 5xx 容忍：连续 2 次 500 后恢复 → 照常完成（不烧掉整篇解析）', async () => {
    stub.jobBehavior = 'query500'
    stub.query500Times = 2 // 前两次轮询 500，之后恢复 normal
    const parser = makeParser()
    const result = await parser.parse(makePdf(), join(dir, 'm'))
    expect(result.markdown).toContain('# 标题')
    expect(stub.pollCount).toBeGreaterThanOrEqual(3)
  })

  it('轮询 4xx 仍立即失败（不进入 5xx 容忍）', async () => {
    stub.jobBehavior = 'query404'
    const parser = makeParser()
    await expect(parser.parse(makePdf(), join(dir, 'm'))).rejects.toThrow('HTTP 404')
    expect(stub.pollCount).toBe(1)
  })

  it('轮询瞬断（ECONNRESET 类）容忍重试，恢复后照常完成', async () => {
    const realFetch = globalThis.fetch
    let throws = 2 // 前两次轮询抛连接错误
    const flaky: typeof fetch = (async (url, init) => {
      if (String(url).includes('/v1/parse/jobs/') && throws > 0) {
        throws--
        throw new Error('read ECONNRESET')
      }
      return realFetch(url, init)
    }) as typeof fetch
    const parser = makeParser({ fetchImpl: flaky })
    const result = await parser.parse(makePdf(), join(dir, 'm'))
    expect(result.markdown).toContain('# 标题')
  })

  it('轮询持续断网超过容忍次数 → ParseStepError', async () => {
    const dead: typeof fetch = (async (url, init) => {
      if (String(url).includes('/v1/parse/jobs/')) throw new Error('read ECONNRESET')
      return globalThis.fetch(url, init)
    }) as typeof fetch
    const t0 = Date.now()
    const parser = makeParser({ fetchImpl: dead, now: () => Date.now() - t0, totalTimeoutMs: 60_000, pollMs: 5 })
    await expect(parser.parse(makePdf(), join(dir, 'm'))).rejects.toThrow('网络错误')
  })
})

describe('unzip 工具（zip-slip 防护 / CRC / 解压上限）', () => {
  it('isSafeEntryName 拒绝绝对路径与 ..', () => {
    expect(isSafeEntryName('fig1.jpg')).toBe(true)
    expect(isSafeEntryName('sub/fig2.png')).toBe(true)
    expect(isSafeEntryName('../evil.jpg')).toBe(false)
    expect(isSafeEntryName('sub/../../evil.jpg')).toBe(false)
    expect(isSafeEntryName('/abs/evil.jpg')).toBe(false)
    expect(isSafeEntryName('')).toBe(false)
  })

  it('readZipBuffer 读出条目并校验 CRC；坏 zip 抛错', () => {
    const zipPath = join(dir, 't.zip')
    writeZip([{ name: 'a.txt', data: Buffer.from('hello') }], zipPath)
    const entries = readZipBuffer(readFileSync(zipPath))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ name: 'a.txt' })
    expect(entries[0].data.toString()).toBe('hello')
    expect(() => readZipBuffer(Buffer.from('not a zip'))).toThrow('EOCD')
  })

  /** 伪造 zip：local header 指向空数据（crc=0 可通过校验），中央目录谎报未压缩大小 */
  function forgeZip(entries: { name: string; uncompressedSize: number }[]): Buffer {
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 8) // method: store
    const cds = entries.map((e) => {
      const nameBuf = Buffer.from(e.name, 'utf8')
      const cd = Buffer.alloc(46 + nameBuf.length)
      cd.writeUInt32LE(0x02014b50, 0)
      cd.writeUInt16LE(20, 4)
      cd.writeUInt16LE(0, 8) // method: store
      cd.writeUInt32LE(0, 16) // crc（空数据 = 0）
      cd.writeUInt32LE(0, 20) // 压缩尺寸 0
      cd.writeUInt32LE(e.uncompressedSize, 24) // 未压缩尺寸（谎报）
      cd.writeUInt16LE(nameBuf.length, 28)
      cd.writeUInt32LE(0, 42) // localOffset
      nameBuf.copy(cd, 46)
      return cd
    })
    const cdBuf = Buffer.concat(cds)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(entries.length, 8)
    eocd.writeUInt16LE(entries.length, 10)
    eocd.writeUInt32LE(cdBuf.length, 12)
    eocd.writeUInt32LE(local.length, 16)
    return Buffer.concat([local, cdBuf, eocd])
  }

  it('单条目未压缩大小超上限（>200MB）→ 抛错，不读数据（zip bomb 防护）', () => {
    const zip = forgeZip([{ name: 'bomb.bin', uncompressedSize: 300 * 1024 * 1024 }])
    expect(() => readZipBuffer(zip)).toThrow('单条目')
  })

  it('全包未压缩总量超上限（>1GB）→ 抛错（单条目均合规）', () => {
    const zip = forgeZip(
      Array.from({ length: 8 }, (_, i) => ({ name: `f${i}.bin`, uncompressedSize: 150 * 1024 * 1024 }))
    )
    expect(() => readZipBuffer(zip)).toThrow('总量')
  })

  it('合规的伪造 zip 照常解析（空数据 + crc 0）', () => {
    const entries = readZipBuffer(forgeZip([{ name: 'a.txt', uncompressedSize: 0 }]))
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe('a.txt')
    expect(entries[0].data.length).toBe(0)
  })
})
