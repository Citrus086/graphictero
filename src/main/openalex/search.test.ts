import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { installFetchGuard, startFixtureHttp, type FetchGuard, type FixtureHttp } from '../testing/fixtureHttp'
import { createOpenAlexClient } from './client'
import { bumpOpenAlexDailyCount, openAlexDailyCount, searchPapersService } from './search'
import { hitFromFull } from './citedBy'
import { arxivIdFromDoi, abstractFromInvertedIndex, parseWorkFull } from './oa'

/**
 * lane/fetch 批 1：searchPapers 服务层测试（m6_plan §5.1-2）。
 * 全部请求打本地 fixture（出网守卫兜底，零真实网络）；断言 per_page 上限、
 * D82 库内去重（inLibraryPaperId）、引用追踪（种子 + 向后 + 向前）、日计数。
 */

let dir: string
let db: Database.Database
let fixture: FixtureHttp
let guard: FetchGuard

beforeEach(async () => {
  guard = installFetchGuard()
  dir = mkdtempSync(join(tmpdir(), 'gt-oa-search-'))
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS)
  fixture = await startFixtureHttp({
    works: [
      {
        wid: 'W100',
        doi: '10.5/seed',
        title: 'Seed Paper on Probes',
        year: 2024,
        authors: ['Alice Smith', 'Bob Jones'],
        venue: 'Journal of Probes',
        abstract: 'we study probes and graphs',
        citedBy: 42,
        oaUrl: 'https://pub.example/seed.pdf',
        referencedWorks: ['W200', 'W201']
      },
      { wid: 'W200', doi: '10.48550/arxiv.2501.12345', title: 'Backward One', year: 2019, authors: ['Carol White'] },
      { wid: 'W201', doi: '10.5/back2', title: 'Backward Two', year: 2020 },
      { wid: 'W300', doi: '10.5/dupe', title: 'Library Dupe', year: 2021, authors: ['Dave Black'] },
      { wid: 'W301', doi: '10.5/top', title: 'Top Cited Probe Study', year: 2022, venue: 'Proc Probes', citedBy: 99 }
    ],
    cites: {
      W100: [{ wid: 'W301', doi: '10.5/top', title: 'Top Cited Probe Study', year: 2022, venue: 'Proc Probes', citedBy: 99 }]
    }
  })
  // 库内已有一篇（D82 去重命中用）
  const now = new Date().toISOString()
  db.prepare("INSERT INTO papers (title, source, doi, created_at, updated_at) VALUES ('已有论文', 'zotero', '10.5/dupe', ?, ?)").run(now, now)
})

afterEach(async () => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
  await fixture.close()
  for (const url of guard.urls) expect(new URL(url).hostname).toBe('127.0.0.1')
  guard.restore()
})

const client = () => createOpenAlexClient({ baseUrl: fixture.baseUrl, minIntervalMs: 0 })

describe('openalex/oa.ts 解析（lane/fetch 批 1）', () => {
  it('abstract_inverted_index 重建正文', () => {
    expect(abstractFromInvertedIndex({ we: [0], study: [1], probes: [2] })).toBe('we study probes')
    expect(abstractFromInvertedIndex(null)).toBeNull()
  })

  it('arxivIdFromDoi：10.48550/arXiv.xxxx 派生，去版本号', () => {
    expect(arxivIdFromDoi('10.48550/arxiv.2501.12345')).toBe('2501.12345')
    expect(arxivIdFromDoi('10.48550/arXiv.2501.12345v2')).toBe('2501.12345')
    expect(arxivIdFromDoi('10.1/other')).toBeNull()
  })

  it('parseWorkFull 字段口径（快照）', async () => {
    const w = await client().fetchWorkFullByWid('W100')
    expect(w).toMatchObject({
      wid: 'W100',
      doi: '10.5/seed',
      title: 'Seed Paper on Probes',
      year: 2024,
      authors: ['Alice Smith', 'Bob Jones'],
      venue: 'Journal of Probes',
      abstract: 'we study probes and graphs',
      citedBy: 42,
      oaUrl: 'https://pub.example/seed.pdf',
      referencedWorks: ['W200', 'W201']
    })
  })
})

describe('searchPapersService（lane/fetch 批 1）', () => {
  it('关键词检索：返回 PaperHit（作者/oaUrl/期刊齐全）', async () => {
    const hits = await searchPapersService(db, client(), 'probe', 10)
    expect(hits.length).toBeGreaterThanOrEqual(2)
    const seed = hits.find((h) => h.doi === '10.5/seed')
    expect(seed?.inLibraryPaperId).toBeUndefined()
    expect(seed?.authors).toEqual(['Alice Smith', 'Bob Jones'])
    expect(seed?.oaUrl).toBe('https://pub.example/seed.pdf')
    expect(seed?.venue).toBe('Journal of Probes')
  })

  it('D82 库内去重：命中论文标 inLibraryPaperId', async () => {
    const hits = await searchPapersService(db, client(), 'dupe', 10)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ title: 'Library Dupe', year: 2021 })
    expect(hits[0].inLibraryPaperId).toBeGreaterThan(0)
  })

  it('limit 上限 25（per_page 透传）', async () => {
    const hits = await searchPapersService(db, client(), 'probe', 50)
    expect(hits.length).toBeLessThanOrEqual(25)
    expect(fixture.requests.find((r) => r.url.includes('search='))?.url).toContain('per_page=25')
  })

  it('W-ID 引用追踪：种子 + 向后 referenced_works + 向前 cited_by', async () => {
    const hits = await searchPapersService(db, client(), 'W100', 10)
    expect(hits[0]).toMatchObject({ title: 'Seed Paper on Probes', doi: '10.5/seed' })
    const titles = hits.map((h) => h.title)
    expect(titles).toContain('Backward One') // 向后（M3 批量 W-ID 口径）
    expect(titles).toContain('Top Cited Probe Study') // 向前（filter=cites）
  })

  it('DOI 引用追踪同样可用', async () => {
    const hits = await searchPapersService(db, client(), '10.5/seed', 10)
    expect(hits[0]?.doi).toBe('10.5/seed')
  })

  it('W-ID 尾斜杠、OpenAlex URL、doi.org 与 doi: 前缀都识别', async () => {
    for (const q of ['W100/', 'https://openalex.org/W100/', 'https://doi.org/10.5/seed', 'doi:10.5/seed']) {
      const hits = await searchPapersService(db, client(), q, 5)
      expect(hits[0]?.title).toBe('Seed Paper on Probes')
    }
  })

  it('向后引用只有 arXiv 号的库内论文标 inLibraryPaperId', async () => {
    const now = new Date().toISOString()
    const pid = Number(
      db.prepare("INSERT INTO papers (title, source, arxiv_id, created_at, updated_at) VALUES ('预印本', 'zotero', '2501.12345', ?, ?)").run(now, now).lastInsertRowid
    )
    const hits = await searchPapersService(db, client(), 'W100', 10)
    const back = hits.find((h) => h.title === 'Backward One')
    expect(back?.inLibraryPaperId).toBe(pid)
  })

  it('每次成功 HTTP 计一次，404 不计', async () => {
    let n = 0
    const c = createOpenAlexClient({
      baseUrl: fixture.baseUrl,
      minIntervalMs: 0,
      onBillable: () => {
        n += 1
        bumpOpenAlexDailyCount(db)
      }
    })
    await searchPapersService(db, c, 'probe', 10)
    expect(n).toBe(1)
    expect(openAlexDailyCount(db)).toBe(1)
    await searchPapersService(db, c, 'W999999', 10)
    expect(n).toBe(1)
    await searchPapersService(db, c, 'W100', 10)
    expect(n).toBe(4)
  })

  it('不存在的 W-ID：空结果不抛错', async () => {
    expect(await searchPapersService(db, client(), 'W999999', 10)).toEqual([])
  })

  it('OpenAlex 检索日计数（同日累计、跨日清零）', () => {
    const d = new Date('2026-10-26T08:00:00Z')
    bumpOpenAlexDailyCount(db, d)
    bumpOpenAlexDailyCount(db, d)
    expect(openAlexDailyCount(db, d)).toBe(2)
    expect(openAlexDailyCount(db, new Date('2026-10-27T08:00:00Z'))).toBe(0)
  })

  it('hitFromFull：缺失字段不吐 undefined 键', () => {
    const hit = hitFromFull(db, parseWorkFull({ id: 'https://openalex.org/W500', title: 'Bare' }))
    expect(hit).toEqual({ title: 'Bare', authors: [], year: null })
  })
})
