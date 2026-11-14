import { createServer, type Server } from 'node:http'

/**
 * lane/fetch 批 1：本地假 HTTP 服务器（m6_plan §5.1/§6）——假 OpenAlex、假 Unpaywall、
 * 假 arXiv PDF、假出版方 PDF（有效 / HTML 冒充 / 超大 / 404 / 超时）。
 *
 * - 全部请求只监听 127.0.0.1 随机端口；测试/冒烟用 GRAPHICTERO_OPENALEX_BASE_URL /
 *   GRAPHICTERO_PDFSRC_BASE_URL 缝把客户端指过来（client.ts / pdfsource 已接）；
 * - 服务器记录收到的每个请求（method + url），测试据此断言「零真实网络」：
 *   除 127.0.0.1:<本端口> 外不得有任何请求；
 * - 「有效 PDF」用代码现场生成的最小 PDF 字节（%PDF- 头可校验，不入库任何真实论文）。
 */

export interface FixtureWork {
  /** 裸 W-ID（如 W2962883861） */
  wid: string
  doi?: string | null
  title: string
  year?: number | null
  authors?: string[]
  venue?: string | null
  abstract?: string | null
  citedBy?: number
  /** best_oa_location.pdf_url（开放获取 PDF 落地链接） */
  oaUrl?: string | null
  referencedWorks?: string[]
}

export interface FixtureUnpaywallEntry {
  /** 最佳 OA 的 PDF 直链；null/缺省 = 无 OA 版本 */
  pdfUrl?: string | null
  /** 落地页（无 pdfUrl 时退回它） */
  landing?: string | null
}

export type FixturePdfKind = 'good' | 'html' | 'big' | '404' | 'slow'

export interface FixtureHttpOptions {
  works?: FixtureWork[]
  /** 向前引用：被引 wid → 引用了它的 works（/works?filter=cites:W…） */
  cites?: Record<string, FixtureWork[]>
  /** 小写归一化 DOI → 条目；未登记的 DOI 返回 404 */
  unpaywall?: Record<string, FixtureUnpaywallEntry>
  /** /pdf/<name> 的行为；未登记的 name 返回 404 */
  pdfRoutes?: Record<string, FixturePdfKind>
  /** 'slow' 路由的延迟 ms（默认 1500；测试用小 timeoutMs 断言超时） */
  slowDelayMs?: number
  /** 'big' 路由的响应字节数（默认 64MB，超过 50MB 上限） */
  bigBytes?: number
  /** DeepSeek Search/Fetch 假路由。不设则这两条路径仍是 404，避免影响其它测试 */
  web?: { search?: FixtureWebKind; fetch?: FixtureWebKind }
}

export type FixtureWebKind = 'ok' | 'empty' | '429' | '402' | 'down'

export interface FixtureRequest {
  method: string
  url: string
}

export interface FixtureHttp {
  baseUrl: string
  port: number
  requests: FixtureRequest[]
  close: () => Promise<void>
}

/** 现场生成的最小 PDF 字节（%PDF- 头 + 最小对象图，供下载校验用） */
export function minimalPdfBytes(): Buffer {
  return Buffer.from(
    [
      '%PDF-1.4',
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj',
      'trailer<</Root 1 0 R>>',
      '%%EOF',
      ''
    ].join('\n'),
    'utf8'
  )
}

/** 摘要 → OpenAlex abstract_inverted_index（分词位置倒排） */
function invertedIndex(abstract: string): Record<string, number[]> {
  const idx: Record<string, number[]> = {}
  abstract.split(/\s+/).forEach((w, i) => {
    const key = w.toLowerCase()
    if (!key) return
    ;(idx[key] ??= []).push(i)
  })
  return idx
}

function workJson(w: FixtureWork): Record<string, unknown> {
  return {
    id: `https://openalex.org/${w.wid}`,
    doi: w.doi ? `https://doi.org/${w.doi}` : null,
    title: w.title,
    display_name: w.title,
    publication_year: w.year ?? null,
    authorships: (w.authors ?? []).map((a) => ({ author: { display_name: a } })),
    primary_location: { source: w.venue ? { display_name: w.venue } : null },
    cited_by_count: w.citedBy ?? 0,
    abstract_inverted_index: w.abstract ? invertedIndex(w.abstract) : null,
    best_oa_location: w.oaUrl ? { pdf_url: w.oaUrl, url: w.oaUrl } : null,
    referenced_works: (w.referencedWorks ?? []).map((r) => `https://openalex.org/${r}`)
  }
}

function normDoi(doi: string): string {
  return decodeURIComponent(doi)
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .trim()
    .toLowerCase()
}

const json = (res: import('node:http').ServerResponse, status: number, body: unknown): void => {
  const buf = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(buf)
}

/**
 * 出网守卫（m6_plan §6「除 127.0.0.1 外的任何请求直接让测试失败」）：包住全局
 * fetch，记录每个请求 URL；凡不是 127.0.0.1 的直接抛错。测试 beforeEach 安装、
 * afterEach 断言 urls 全为本地并 restore。
 */
export interface FetchGuard {
  urls: string[]
  restore: () => void
}

export function installFetchGuard(): FetchGuard {
  const orig = globalThis.fetch
  const urls: string[] = []
  const wrapped: typeof fetch = ((input: unknown, init?: unknown) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const url = new URL(raw)
    urls.push(url.href)
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      return Promise.reject(new Error(`出网守卫拦截：${url.href}`))
    }
    return orig(input as never, init as never)
  }) as typeof fetch
  globalThis.fetch = wrapped
  return { urls, restore: () => (globalThis.fetch = orig) }
}

export async function startFixtureHttp(opts: FixtureHttpOptions = {}): Promise<FixtureHttp> {
  const works = opts.works ?? []
  const byWid = new Map(works.map((w) => [w.wid.toUpperCase(), w]))
  const byDoi = new Map(works.filter((w) => w.doi).map((w) => [normDoi(w.doi as string), w]))
  const requests: FixtureRequest[] = []

  // 自指占位：works/unpaywall 里的 '{{BASE}}' 在响应时替换为真实地址
  // （fixture 启动前拿不到端口；oaUrl 指向本服务器自己的 /pdf/… 路由）
  let baseHref = ''
  const withBase = (v: unknown): unknown =>
    baseHref ? (JSON.parse(JSON.stringify(v).split('{{BASE}}').join(baseHref)) as unknown) : v

  const server: Server = createServer((req, res) => {
    requests.push({ method: req.method ?? 'GET', url: req.url ?? '' })
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = u.pathname

    // ── 假 OpenAlex ────────────────────────────────────────────────────
    if (path === '/works') {
      const respond = (status: number, body: unknown): void => json(res, status, withBase(body))
      const search = u.searchParams.get('search')
      const filter = u.searchParams.get('filter')
      const perPage = Math.max(1, Number(u.searchParams.get('per_page') ?? '25') || 25)
      if (search != null) {
        const term = search.toLowerCase()
        const hits = works
          .filter(
            (w) =>
              w.title.toLowerCase().includes(term) ||
              (w.venue ?? '').toLowerCase().includes(term) ||
              (w.authors ?? []).some((a) => a.toLowerCase().includes(term))
          )
          .slice(0, perPage)
        return respond(200, { results: hits.map(workJson) })
      }
      if (filter != null) {
        // OpenAlex filter 值可以是裸 W-ID 或完整 id URL（管道分隔多个值）
        const cites = filter.match(/cites:(?:https:\/\/openalex\.org\/)?([Ww]\d+)(?:\||$)/)
        if (cites) {
          const cited = byWid.get(cites[1].toUpperCase())
          const citing = (opts.cites ?? {})[cites[1].toUpperCase()] ?? []
          if (!cited && citing.length === 0) return respond(200, { results: [] })
          return respond(200, { results: citing.slice(0, perPage).map(workJson) })
        }
        // uat6b M2：与真实 OpenAlex 一致——旧 openalex.id: 过滤器已 400（回归防线）；
        // 新口径 filter=openalex:W1|W2…（裸 W id 管道分隔）
        if (/openalex\.id:/.test(filter)) {
          return respond(400, { error: 'openalex.id is not a valid field' })
        }
        const widFilter = filter.match(/^openalex:([Ww]\d+(?:\|[Ww]\d+)*)$/)
        if (widFilter) {
          const hits = widFilter[1]
            .split('|')
            .map((w) => byWid.get(w.toUpperCase()))
            .filter((w): w is FixtureWork => w != null)
          return respond(200, { results: hits.map(workJson) })
        }
        return respond(200, { results: [] })
      }
      return respond(200, { results: [] })
    }
    const doiMatch = path.match(/^\/works\/doi:(.+)$/)
    if (doiMatch) {
      const w = byDoi.get(normDoi(doiMatch[1]))
      if (!w) return json(res, 404, { error: 'not found' })
      return json(res, 200, withBase(workJson(w)))
    }
    const widMatch = path.match(/^\/works\/([Ww]\d+)$/)
    if (widMatch) {
      const w = byWid.get(widMatch[1].toUpperCase())
      if (!w) return json(res, 404, { error: 'not found' })
      return json(res, 200, withBase(workJson(w)))
    }

    // ── 假 Unpaywall ───────────────────────────────────────────────────
    const unpaywallMatch = path.match(/^\/(?:api\/)?v2\/(.+)$/)
    if (unpaywallMatch) {
      const entry = (opts.unpaywall ?? {})[normDoi(unpaywallMatch[1])]
      if (!entry) return json(res, 404, { error: 'not found' })
      const best = entry.pdfUrl ?? entry.landing ?? null
      return json(res, 200, withBase({
        doi: normDoi(unpaywallMatch[1]),
        is_oa: best != null,
        best_oa_location: best ? { url_for_pdf: entry.pdfUrl ?? null, url: entry.landing ?? entry.pdfUrl ?? null } : null
      }))
    }

    // ── 假 arXiv / 出版方 PDF ──────────────────────────────────────────
    const pdfMatch = path.match(/^\/pdf\/(.+)$/)
    if (pdfMatch) {
      // arXiv 风格 /pdf/<id>.pdf：注册键用裸名（'2501.12345'）
      const name = decodeURIComponent(pdfMatch[1]).replace(/\.pdf$/i, '')
      const kind = (opts.pdfRoutes ?? {})[name]
      if (!kind) {
        res.writeHead(404)
        return res.end('not found')
      }
      if (kind === '404') {
        res.writeHead(404)
        return res.end('not found')
      }
      if (kind === 'slow') {
        const delay = opts.slowDelayMs ?? 1500
        setTimeout(() => {
          if (res.destroyed) return
          res.writeHead(200, { 'content-type': 'application/pdf' })
          res.end(minimalPdfBytes())
        }, delay)
        return
      }
      if (kind === 'html') {
        res.writeHead(200, { 'content-type': 'text/html' })
        return res.end('<html><body>landing page, not a pdf</body></html>')
      }
      if (kind === 'big') {
        const total = opts.bigBytes ?? 64 * 1024 * 1024
        // 以真实 %PDF- 头开头的大文件（下载端先验头再验上限，两个坏情况都要可测）
        const head = minimalPdfBytes()
        const payload = total > head.length ? Buffer.concat([head, Buffer.alloc(total - head.length, 0)]) : head.subarray(0, total)
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(payload.length) })
        const chunkSize = 1024 * 1024
        let sent = 0
        const write = (): void => {
          while (sent < payload.length) {
            const n = Math.min(chunkSize, payload.length - sent)
            const part = payload.subarray(sent, sent + n)
            sent += n
            if (!res.write(part)) {
              res.once('drain', write)
              return
            }
          }
          res.end()
        }
        write()
        return
      }
      // good
      res.writeHead(200, { 'content-type': 'application/pdf' })
      return res.end(minimalPdfBytes())
    }

    if (opts.web && (path === '/v1/tools/search' || path === '/v1/tools/fetch')) {
      const kind = (path.endsWith('/search') ? opts.web.search : opts.web.fetch) ?? 'empty'
      if (kind === 'down') {
        res.destroy()
        return
      }
      if (kind === '429' || kind === '402') {
        res.writeHead(Number(kind))
        return res.end('{}')
      }
      if (path.endsWith('/search')) {
        const results = kind === 'ok' ? [{ title: 'Fixture Page', url: 'https://example.com/a', snippet: 'a snippet' }] : []
        return json(res, 200, { results })
      }
      const content = kind === 'ok' ? '# Fixture\n\nbody' : ''
      return json(res, 200, { title: kind === 'ok' ? 'Fixture Page' : '', url: 'https://example.com/a', content })
    }

    res.writeHead(404)
    res.end('not found')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address == null || typeof address === 'string') throw new Error('fixture 服务器启动失败')
  const port = address.port
  baseHref = `http://127.0.0.1:${port}`
  let closed = false
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () => {
      if (closed) return Promise.resolve() // 幂等：测试里可能主动关过一次
      closed = true
      return new Promise<void>((resolve) => {
        server.close(() => resolve())
        // 兜底：有慢连接挂着时 close 会等；冒烟/测试进程随即退出
        setTimeout(() => resolve(), 2000).unref()
      })
    }
  }
}
