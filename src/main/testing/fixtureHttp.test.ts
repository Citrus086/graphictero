import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installFetchGuard, minimalPdfBytes, startFixtureHttp, type FetchGuard, type FixtureHttp } from './fixtureHttp'

/**
 * lane/fetch 批 1：fixtureHttp 自测——假 OpenAlex（search / doi / wid / cites / 批量）、
 * 假 Unpaywall、假 PDF 路由（good/html/big/404/slow）、请求记录与出网守卫。
 */

let fixture: FixtureHttp
let guard: FetchGuard

beforeEach(async () => {
  guard = installFetchGuard()
})

afterEach(async () => {
  await fixture?.close()
  fixture = undefined as never
  // 出网守卫：批内任何请求都必须打在 127.0.0.1（fixture 端口）
  for (const url of guard.urls) expect(new URL(url).hostname).toBe('127.0.0.1')
  guard.restore()
})

describe('fixtureHttp（lane/fetch 批 1）', () => {
  it('最小 PDF 字节带 %PDF- 头（代码现场生成，非真实论文）', () => {
    expect(minimalPdfBytes().subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it('假 OpenAlex：search / doi / wid / cites / 批量 id 过滤 + 请求记录', async () => {
    fixture = await startFixtureHttp({
      works: [
        { wid: 'W1', doi: '10.1/a', title: 'Graph Reasoning Survey', year: 2024, authors: ['Alice Smith'], venue: 'JGA', abstract: 'a survey of graphs', citedBy: 7, oaUrl: null, referencedWorks: ['W2'] },
        { wid: 'W2', doi: '10.1/b', title: 'Deep Probe', year: 2023, authors: ['Bob Jones'] }
      ],
      cites: { W2: [{ wid: 'W3', doi: '10.1/c', title: 'Citing Deep Probe', year: 2025 }] }
    })
    const base = fixture.baseUrl
    const j = (r: Response): Promise<unknown> => r.json()

    const search = (await (await fetch(`${base}/works?search=graph&per_page=5`)).json()) as { results: Array<{ id: string; title: string }> }
    expect(search.results.map((r) => r.title)).toEqual(['Graph Reasoning Survey'])

    const byDoi = (await (await fetch(`${base}/works/doi:10.1%2Fa`)).json()) as { id: string }
    expect(byDoi.id).toBe('https://openalex.org/W1')
    expect((await fetch(`${base}/works/doi:10.9%2Fnone`)).status).toBe(404)

    const byWid = (await (await fetch(`${base}/works/W2`)).json()) as { title: string }
    expect(byWid.title).toBe('Deep Probe')

    const cites = (await (await fetch(`${base}/works?filter=cites:https://openalex.org/W2`)).json()) as { results: Array<{ title: string }> }
    expect(cites.results.map((r) => r.title)).toEqual(['Citing Deep Probe'])

    const batch = (await (await fetch(`${base}/works?filter=openalex:W1|W2`)).json()) as { results: Array<{ title: string }> }
    expect(batch.results).toHaveLength(2)

    // uat6b M2：旧 openalex.id: 过滤器与真实 OpenAlex 一致返回 400（回归防线）
    const legacy = await fetch(`${base}/works?filter=openalex.id:https://openalex.org/W1`)
    expect(legacy.status).toBe(400)

    const parsed = fixture.requests.map((r) => new URL(r.url, base))
    expect(parsed.every((u) => u.port === String(fixture.port))).toBe(true)
    void j
  })

  it('假 Unpaywall 与 PDF 路由（good/html/big/404/slow）', async () => {
    fixture = await startFixtureHttp({
      unpaywall: { '10.1/a': { pdfUrl: null, landing: null } },
      pdfRoutes: { good: 'good', fake: 'html', huge: 'big', missing: '404', sleepy: 'slow' },
      slowDelayMs: 50,
      bigBytes: 1024
    })
    const base = fixture.baseUrl

    const up = (await (await fetch(`${base}/api/v2/10.1%2Fa?email=a%40b.c`)).json()) as { is_oa: boolean }
    expect(up.is_oa).toBe(false)
    expect((await fetch(`${base}/api/v2/10.9%2Fnone?email=a%40b.c`)).status).toBe(404)

    const good = await fetch(`${base}/pdf/good`)
    expect(good.status).toBe(200)
    expect((await good.arrayBuffer()).byteLength).toBe(minimalPdfBytes().length)

    const html = await fetch(`${base}/pdf/fake`)
    expect(html.headers.get('content-type')).toContain('text/html')

    const big = await fetch(`${base}/pdf/huge`)
    expect(Number(big.headers.get('content-length'))).toBe(1024)
    await big.arrayBuffer()

    expect((await fetch(`${base}/pdf/missing`)).status).toBe(404)

    const slowStart = Date.now()
    await (await fetch(`${base}/pdf/sleepy`)).arrayBuffer()
    expect(Date.now() - slowStart).toBeGreaterThanOrEqual(40)
  })
})
