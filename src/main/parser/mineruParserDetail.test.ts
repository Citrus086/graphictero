import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MineruParser, sanitizeFetchDetail } from './mineruParser'
import { SidecarLogFile } from '../sidecar/sidecarLogFile'

/**
 * uat13（D207-②）：MinerU 失败可诊断——
 * ① sanitizeFetchDetail：保留脱敏后的底层原因（cause.code / message），
 *    去掉 URL / 查询串 / key 形态内容，限长；
 * ② parser 步骤错误：含请求路径（method + pathname）+ 底层原因，不再只剩「fetch failed」；
 * ③ SidecarLogFile：sidecar 输出落盘（时间戳行、行缓冲、大小超限滚动截断）。
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-uat13-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function fetchFailedWith(code: string, causeMessage: string): Error {
  const cause = Object.assign(new Error(causeMessage), { code })
  return new TypeError('fetch failed', { cause })
}

describe('sanitizeFetchDetail（脱敏 + 保留底层原因）', () => {
  it('fetch failed + cause.code：保留 code（如 ECONNREFUSED）', () => {
    const detail = sanitizeFetchDetail(fetchFailedWith('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:5312'))
    expect(detail).toContain('ECONNREFUSED')
    expect(detail).toContain('fetch failed')
  })

  it('undici 风格（UND_ERR_*）保留', () => {
    const detail = sanitizeFetchDetail(fetchFailedWith('UND_ERR_SOCKET', 'other side closed'))
    expect(detail).toContain('UND_ERR_SOCKET')
  })

  it('超时/中断归一为「请求超时或被中断」', () => {
    expect(sanitizeFetchDetail(new Error('The operation timed out'))).toBe('请求超时或被中断')
    expect(sanitizeFetchDetail(new DOMException('The operation was aborted', 'AbortError'))).toBe('请求超时或被中断')
  })

  it('AggregateError 取第一个子错误的 code', () => {
    const inner = Object.assign(new Error('connect ETIMEDOUT 10.0.0.1:443'), { code: 'ETIMEDOUT' })
    const agg = new AggregateError([inner], 'fetch failed')
    expect(sanitizeFetchDetail(agg)).toContain('ETIMEDOUT')
  })

  it('脱敏：URL / 查询串 / key= 形态内容一律不含', () => {
    const cause = new Error(
      'request to https://api.example.com/v1/uploads?api_key=sk-supersecretabcdef123456 failed'
    )
    const detail = sanitizeFetchDetail(new TypeError('fetch failed', { cause }))
    expect(detail).not.toContain('https://')
    expect(detail).not.toContain('sk-supersecret')
    expect(detail).not.toContain('api_key=')
  })

  it('异常长消息截断到上限内', () => {
    const cause = new Error('x'.repeat(2000))
    const detail = sanitizeFetchDetail(new TypeError('fetch failed', { cause }))
    expect(detail.length).toBeLessThanOrEqual(161) // 160 + 省略号
  })

  it('非 Error 输入不抛（回退 String）', () => {
    expect(() => sanitizeFetchDetail('plain string')).not.toThrow()
    expect(() => sanitizeFetchDetail(null)).not.toThrow()
  })
})

describe('MineruParser 步骤错误含请求路径 + 底层原因', () => {
  function makeParser(fetchImpl: typeof fetch): MineruParser {
    return new MineruParser({
      sidecar: {
        isReady: () => true,
        baseUrl: () => 'http://127.0.0.1:5312',
        pageProgress: () => ({ pagesDone: null, pagesTotal: null })
      },
      fetchImpl
    })
  }

  function makePdf(): string {
    const p = join(dir, 'paper.pdf')
    writeFileSync(p, Buffer.from('%PDF-fake'))
    return p
  }

  it('上传登记 POST /v1/uploads 抛 fetch failed → ParseStepError 含路径与 ECONNREFUSED', async () => {
    const dead: typeof fetch = (async () => {
      throw fetchFailedWith('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:5312')
    }) as typeof fetch
    const parser = makeParser(dead)
    await expect(parser.parse(makePdf(), join(dir, 'out'))).rejects.toThrow('上传 PDF 失败')
    await expect(parser.parse(makePdf(), join(dir, 'out'))).rejects.toThrow('POST /v1/uploads')
    await expect(parser.parse(makePdf(), join(dir, 'out'))).rejects.toThrow('ECONNREFUSED')
  })

  it('错误信息不含 URL 查询串与 key 形态内容', async () => {
    const leak: typeof fetch = (async () => {
      const cause = new Error('connect ECONNRESET https://evil.example.com/x?token=abc123secret')
      throw new TypeError('fetch failed', { cause })
    }) as typeof fetch
    const parser = makeParser(leak)
    await expect(parser.parse(makePdf(), join(dir, 'out'))).rejects.toThrowError(/上传 PDF 失败/)
    await parser.parse(makePdf(), join(dir, 'out')).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e)
      expect(msg).not.toContain('https://')
      expect(msg).not.toContain('abc123secret')
    })
  })
})

describe('SidecarLogFile（uat13 D207-②：sidecar 输出落盘滚动日志）', () => {
  it('按行写入并加时间戳前缀；flush 收尾残行', () => {
    const file = join(dir, 'logs', 'mineru-sidecar.log')
    const log = new SidecarLogFile(file)
    log.appendChunk('Hybrid processing window 1/1: pages 1-2/2\npartial') // 残行不立即写
    log.appendChunk(' line done\n\n') // 空行跳过
    log.flush()
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('Hybrid processing window 1/1: pages 1-2/2')
    expect(text).toContain('partial line done')
    expect(text.match(/^\[\d{4}-\d{2}-\d{2}T/m)).toBeTruthy()
    expect(text.includes('\n\n')).toBe(false) // 空行没落盘
  })

  it('超过上限时滚动截断（保留末尾）', () => {
    const file = join(dir, 'mineru-sidecar.log')
    const log = new SidecarLogFile(file, 1024) // 小上限便于测试
    for (let i = 0; i < 100; i++) log.appendChunk(`line-${String(i).padStart(3, '0')} ${'x'.repeat(40)}\n`)
    log.flush()
    const size = readFileSync(file, 'utf8').length
    expect(size).toBeLessThanOrEqual(1024)
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('line-099') // 末尾保留
  })

  it('目录不存在时自动创建；写盘失败不抛', () => {
    const log = new SidecarLogFile(join(dir, 'a', 'b', 'c.log'))
    expect(() => log.appendChunk('hello\n')).not.toThrow()
    expect(readFileSync(join(dir, 'a', 'b', 'c.log'), 'utf8')).toContain('hello')
  })
})
