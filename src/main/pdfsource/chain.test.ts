import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { installFetchGuard, startFixtureHttp, type FetchGuard, type FixtureHttp } from '../testing/fixtureHttp'
import { createOpenAlexClient } from '../openalex/client'
import { customTemplateUrl } from './customTemplate'
import { arxivPdfUrl, normalizeArxivId } from './arxiv'
import { expandSources, locatePdfUrls } from './chain'
import { openAlexOaUrl } from './oa'
import { unpaywallOaUrl } from './unpaywall'
import { getPdfSources, setPdfSources } from './settings'
import { listPdfAttempts } from './attempts'

/**
 * lane/fetch 批 1：PDF 查找链测试（m6_plan §5.1-4/§6）。
 * 断言：来源顺序、开关、尝试记录（not_found/error/ok）、自定义模板 SSRF 拦截、
 * 设置读写；全部请求打本地 fixture（出网守卫兜底）。
 */

let dir: string
let db: Database.Database
let fixture: FixtureHttp
let guard: FetchGuard
let paperId: number

beforeEach(async () => {
  guard = installFetchGuard()
  dir = mkdtempSync(join(tmpdir(), 'gt-pdfsrc-'))
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS)
  const now = new Date().toISOString()
  const r = db.prepare("INSERT INTO papers (title, source, created_at, updated_at) VALUES ('P', 'zotero', ?, ?)").run(now, now)
  paperId = Number(r.lastInsertRowid)
  fixture = await startFixtureHttp({
    works: [
      { wid: 'W1', doi: '10.7/hasoa', title: 'Has OA', oaUrl: '{{BASE}}/pdf/good' },
      { wid: 'W2', doi: '10.7/nooa', title: 'No OA', oaUrl: null }
    ]
  })
  process.env.GRAPHICTERO_PDFSRC_BASE_URL = fixture.baseUrl
})

afterEach(async () => {
  delete process.env.GRAPHICTERO_PDFSRC_BASE_URL
  db.close()
  rmSync(dir, { recursive: true, force: true })
  await fixture.close()
  for (const url of guard.urls) expect(new URL(url).hostname).toBe('127.0.0.1')
  guard.restore()
})

const client = () => createOpenAlexClient({ baseUrl: fixture.baseUrl, minIntervalMs: 0 })

describe('pdfsource 基础（lane/fetch 批 1）', () => {
  it('arxiv：归一化 ID 与 URL 构造（pdfsrc 缝）', () => {
    expect(normalizeArxivId('2501.12345v2')).toBe('2501.12345')
    expect(normalizeArxivId('https://arxiv.org/abs/2501.12345')).toBe('2501.12345')
    expect(arxivPdfUrl('2501.12345v2')).toBe(`${fixture.baseUrl}/pdf/2501.12345.pdf`)
    expect(arxivPdfUrl('not-an-arxiv-id')).toBeNull()
  })

  it('customTemplateUrl：{doi} 编码 + https 强制 + 内网拦截', () => {
    expect(customTemplateUrl('https://pub.example/{doi}.pdf', '10.1/A B')).toBe('https://pub.example/10.1%2Fa%20b.pdf')
    expect(customTemplateUrl('https://pub.example/{doi}', null)).toBeNull()
    expect(() => customTemplateUrl('http://pub.example/{doi}', '10.1/a')).toThrow('https')
    expect(() => customTemplateUrl('https://127.0.0.1:8080/{doi}', '10.1/a')).toThrow('内网')
    expect(() => customTemplateUrl('https://192.168.1.1/{doi}', '10.1/a')).toThrow('内网')
    expect(() => customTemplateUrl('https://localhost/{doi}', '10.1/a')).toThrow('内网')
    expect(() => customTemplateUrl('https://[::1]/{doi}', '10.1/a')).toThrow('内网')
    expect(() => customTemplateUrl('https://2130706433/{doi}', '10.1/a')).toThrow('内网')
  })

  it('设置读写：默认只开开放获取（D54/D131），保存后回读一致', () => {
    const dflt = getPdfSources(db, dir)
    expect(dflt.sources).toEqual([{ kind: 'open_access', enabled: true }])
    const input = {
      sources: [
        { kind: 'custom' as const, enabled: true, template: 'https://pub.example/{doi}.pdf' },
        { kind: 'open_access' as const, enabled: false }
      ],
      unpaywallEmail: 'p@example.com'
    }
    setPdfSources(db, input)
    expect(getPdfSources(db, dir)).toEqual(input)
  })
})

describe('locatePdfUrls（lane/fetch 批 1）', () => {
  it('open_access 找到第一条链接即停，不再问后面的来源', async () => {
    const urls = await locatePdfUrls({
      db,
      paperId,
      doi: '10.7/hasoa',
      arxivId: null,
      openalexWid: null,
      settings: { sources: [{ kind: 'open_access', enabled: true }], unpaywallEmail: 'p@example.com' },
      openAlex: client()
    })
    // 无 arXiv ID：arxiv 记 not_found；openalex 命中后不再问 unpaywall（即使配了邮箱）
    expect(urls).toEqual([{ source: 'openalex', url: `${fixture.baseUrl}/pdf/good` }])
    expect(listPdfAttempts(db, paperId).map((a) => [a.source, a.result])).toEqual([['arxiv', 'not_found']])
    expect(fixture.requests.some((r) => r.url.includes('/v2/'))).toBe(false)
  })

  it('坏模板记 error 后继续，不丢掉后面找到的链接', async () => {
    const urls = await locatePdfUrls({
      db,
      paperId,
      doi: '10.7/hasoa',
      arxivId: null,
      openalexWid: null,
      settings: {
        sources: [
          { kind: 'custom', enabled: true, template: 'https://127.0.0.1/{doi}' },
          { kind: 'open_access', enabled: true }
        ]
      },
      openAlex: client()
    })
    expect(urls).toEqual([{ source: 'openalex', url: `${fixture.baseUrl}/pdf/good` }])
    expect(listPdfAttempts(db, paperId).map((a) => [a.source, a.result])).toEqual([
      ['custom:127.0.0.1', 'error'],
      ['arxiv', 'not_found']
    ])
  })

  it('D140：邮箱留空回退注入的 mailto，两者都没有才跳过 Unpaywall', async () => {
    setPdfSources(db, { sources: [{ kind: 'open_access', enabled: true }] })
    expect(getPdfSources(db, dir, { mailto: 'from-env@example.com' }).unpaywallEmail).toBe('from-env@example.com')
    setPdfSources(db, { sources: [{ kind: 'open_access', enabled: true }], unpaywallEmail: 'explicit@example.com' })
    expect(getPdfSources(db, dir, { mailto: 'from-env@example.com' }).unpaywallEmail).toBe('explicit@example.com')
    setPdfSources(db, { sources: [{ kind: 'open_access', enabled: true }], unpaywallEmail: '   ' })
    const none = getPdfSources(db, dir, { mailto: null })
    expect(none.unpaywallEmail).toBeUndefined()
    await locatePdfUrls({
      db,
      paperId,
      doi: '10.7/nooa',
      arxivId: null,
      openalexWid: null,
      settings: none,
      openAlex: client()
    })
    expect(listPdfAttempts(db, paperId).map((a) => [a.source, a.result])).toEqual([
      ['arxiv', 'not_found'],
      ['openalex', 'not_found'],
      ['unpaywall', 'not_found']
    ])
    expect(fixture.requests.some((r) => r.url.includes('/v2/'))).toBe(false)
  })

  it('D140：注入的回退邮箱真的请求了 Unpaywall /v2/', async () => {
    setPdfSources(db, { sources: [{ kind: 'open_access', enabled: true }] })
    const settings = getPdfSources(db, dir, { mailto: 'fallback@example.com' })
    expect(settings.unpaywallEmail).toBe('fallback@example.com')
    await locatePdfUrls({
      db,
      paperId,
      doi: '10.7/nooa',
      arxivId: null,
      openalexWid: null,
      settings,
      openAlex: client()
    })
    const hit = fixture.requests.find((r) => r.url.includes('/v2/'))
    expect(hit?.url).toContain('/v2/')
    expect(decodeURIComponent(hit?.url ?? '')).toContain('fallback@example.com')
  })

  it('非测试缝的 http OA 链接跳过，https 落地页仍可用', async () => {
    const fake = {
      async fetchWorkFullByDoi() {
        return {
          wid: 'W9',
          doi: '10.7/nooa',
          title: 't',
          year: null,
          authors: [],
          venue: null,
          abstract: null,
          citedBy: null,
          oaUrl: 'http://publisher.example/a.pdf',
          arxivId: null,
          referencedWorks: []
        }
      }
    }
    expect(await openAlexOaUrl(fake as never, { doi: '10.7/nooa', cachedOaUrl: 'http://publisher.example/cached.pdf' })).toBeNull()
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          best_oa_location: { url_for_pdf: 'http://publisher.example/a.pdf', url: 'https://publisher.example/a.pdf' }
        }),
        { status: 200 }
      )
    expect(await unpaywallOaUrl('10.1/a', 'a@b.c', { fetchImpl })).toBe('https://publisher.example/a.pdf')
    const bothHttp: typeof fetch = async () =>
      new Response(JSON.stringify({ best_oa_location: { url_for_pdf: 'http://publisher.example/a.pdf', url: 'http://publisher.example/land' } }), {
        status: 200
      })
    expect(await unpaywallOaUrl('10.1/a', 'a@b.c', { fetchImpl: bothHttp })).toBeNull()
  })

  it('全来源未命中（干净 not_found）→ 返回空数组 = 无 PDF 路径', async () => {
    const urls = await locatePdfUrls({
      db,
      paperId,
      doi: '10.7/nooa',
      arxivId: null,
      openalexWid: null,
      settings: { sources: [{ kind: 'open_access', enabled: true }] },
      openAlex: client()
    })
    expect(urls).toEqual([])
    expect(listPdfAttempts(db, paperId).every((a) => a.result === 'not_found')).toBe(true)
  })

  it('缓存的 oa_url 直接命中（不再查 OpenAlex）', async () => {
    const urls = await locatePdfUrls({
      db,
      paperId,
      doi: '10.7/nooa',
      arxivId: null,
      openalexWid: null,
      cachedOaUrl: `${fixture.baseUrl}/pdf/good`,
      settings: { sources: [{ kind: 'open_access', enabled: true }] },
      openAlex: client()
    })
    expect(urls).toEqual([{ source: 'openalex', url: `${fixture.baseUrl}/pdf/good` }])
    expect(fixture.requests.every((r) => !r.url.startsWith('/works'))).toBe(true)
  })

  it('自定义来源参与排序；open_access 关掉后只剩自定义', async () => {
    const settings = {
      sources: [
        { kind: 'custom' as const, enabled: true, template: 'https://pub.example/{doi}.pdf' },
        { kind: 'open_access' as const, enabled: false }
      ]
    }
    expect(expandSources(settings).map((s) => s.source)).toEqual(['custom:pub.example'])
    const urls = await locatePdfUrls({
      db,
      paperId,
      doi: '10.7/nooa',
      arxivId: null,
      openalexWid: null,
      settings,
      openAlex: client()
    })
    expect(urls).toEqual([{ source: 'custom:pub.example', url: 'https://pub.example/10.7%2Fnooa.pdf' }])
  })
})
