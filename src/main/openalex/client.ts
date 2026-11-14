import { BadRequestLlmError, NetworkLlmError, RetryableLlmError } from '../llm/errors'
import { parseWorkFull, type OpenAlexWorkFull } from './oa'

/**
 * OpenAlex 薄客户端（D40/D49/D71）：W-ID + referenced_works，只做三件事——
 * 按 DOI 查单篇、按 W-ID 查单篇、按标题搜索（找回 DOI 用，三条阈值在 match.ts）。
 *
 * - 礼貌池：带 mailto（UA + 查询参数，OpenAlex 官方口径）；
 * - 限速与重试：请求间最小间隔；429 遵守 Retry-After、5xx/超时指数退避重试
 *   （默认 3 次），与 LLM 客户端同口径的错误分类（复用 RetryableLlmError /
 *   NetworkLlmError，关系引擎与 JobRunner 的分类逻辑一致）；
 * - fetchImpl 可注入：测试用假 fetch，不做真实批量请求。
 *
 * 已知实测（M0 探针 / PROGRESS）：对最新预印本 OpenAlex 常返回空 referenced_works，
 * 引用主路径之一是 D40 兜底——deepseek-flash 从 References 段抽取（references.ts）。
 */

export interface OpenAlexWork {
  /** 裸 W-ID（如 W2962883861），不含 https://openalex.org/ 前缀 */
  wid: string
  doi: string | null
  title: string | null
  publicationYear: number | null
  /** 第一作者姓（display_name 末词，小写）；D71 阈值②用 */
  firstAuthorSurname: string | null
  /** referenced_works 的裸 W-ID 列表 */
  referencedWorks: string[]
}

export interface OpenAlexClientDeps {
  /**
   * baseUrl 显式注入优先；缺省读 GRAPHICTERO_OPENALEX_BASE_URL 测试缝（m6_plan §3.4，
   * 只在测试/冒烟进程设置，指向本地 fixture HTTP 服务器），再缺省官方地址。
   */
  baseUrl?: string
  /** .env 的 OPENALEX_API_KEY；无 Key 走免费池（探针实测免费池可加 mailto 用） */
  apiKey?: string | null
  /** .env 的 OPENALEX_MAILTO */
  mailto?: string | null
  fetchImpl?: typeof fetch
  /** 请求间最小间隔 ms（默认 200，礼貌限速；测试可传 0） */
  minIntervalMs?: number
  /** 429/5xx/网络错误自动重试次数（默认 3，与 D53 一致） */
  maxRetries?: number
  /** 单次请求超时 ms（默认 30s） */
  timeoutMs?: number
  /** 惰性 sleep（测试可注入同步推进） */
  sleep?: (ms: number) => Promise<void>
  /** 每次成功的 HTTP（2xx）计一次。404 / 429 / 5xx / 断网不计（D126） */
  onBillable?: () => void
}

export interface OpenAlexClient {
  /** 按 DOI 查单篇；不存在返回 null */
  fetchWorkByDoi(doi: string): Promise<OpenAlexWork | null>
  /** 按裸 W-ID 查单篇；不存在返回 null */
  fetchWorkByWid(wid: string): Promise<OpenAlexWork | null>
  /** 按标题搜索（D49 找回 DOI 用），默认取前 5 条 */
  searchWorksByTitle(title: string, perPage?: number): Promise<OpenAlexWork[]>
  /** 批量按裸 W-ID 取 work 元数据（referenced_works 只有 W-ID，匹配 DOI/标题用；每 50 个一批） */
  fetchWorksByWids(wids: string[]): Promise<OpenAlexWork[]>
  /** lane/fetch 批 1：按关键词全文检索 works（searchPapers），返回富视图 */
  searchWorksFull(query: string, perPage?: number): Promise<OpenAlexWorkFull[]>
  /** lane/fetch 批 1：向前引用追踪——filter=cites:W…，返回引用该 work 的富视图 */
  fetchCitingWorksByWid(wid: string, perPage?: number): Promise<OpenAlexWorkFull[]>
  /** lane/fetch 批 1：按 DOI 查单篇富视图；不存在返回 null */
  fetchWorkFullByDoi(doi: string): Promise<OpenAlexWorkFull | null>
  /** lane/fetch 批 1：按裸 W-ID 查单篇富视图；不存在返回 null */
  fetchWorkFullByWid(wid: string): Promise<OpenAlexWorkFull | null>
}

const DEFAULT_BASE_URL = 'https://api.openalex.org'
const DEFAULT_MIN_INTERVAL_MS = 200
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_TIMEOUT_MS = 30_000

/** 从 OpenAlex 的 id URL（https://openalex.org/W2962883861）取裸 W-ID */
export function widOf(idUrl: string | null | undefined): string | null {
  if (!idUrl) return null
  const m = idUrl.match(/\/(W\d+)\s*$/i)
  return m ? m[1].toUpperCase() : null
}

/** OpenAlex work JSON → 薄 Work 视图（probe 已核对的字段口径） */
export function parseWork(raw: Record<string, unknown>): OpenAlexWork {
  const authorships = (raw.authorships as Array<Record<string, unknown>> | undefined) ?? []
  const first = authorships[0]?.author as Record<string, unknown> | undefined
  const displayName = typeof first?.display_name === 'string' ? first.display_name : null
  return {
    wid: widOf(raw.id as string | null) ?? '',
    doi: typeof raw.doi === 'string' ? raw.doi.replace(/^https?:\/\/doi\.org\//i, '') : null,
    title: (raw.title as string | null) ?? (raw.display_name as string | null) ?? null,
    publicationYear: (raw.publication_year as number | null) ?? null,
    firstAuthorSurname: displayName ? (displayName.split(' ').pop() ?? '').toLowerCase() || null : null,
    referencedWorks: ((raw.referenced_works as string[] | undefined) ?? [])
      .map((u) => widOf(u))
      .filter((w): w is string => w != null)
  }
}

function parseRetryAfterMs(v: string | null): number | undefined {
  if (!v) return undefined
  const sec = Number(v)
  if (Number.isFinite(sec) && sec >= 0) return sec * 1000
  const t = Date.parse(v)
  if (!Number.isNaN(t)) return Math.max(0, t - Date.now())
  return undefined
}

export function createOpenAlexClient(deps: OpenAlexClientDeps): OpenAlexClient {
  // 测试缝：GRAPHICTERO_OPENALEX_BASE_URL（默认官方地址；web/pdfsrc 两个缝归 lane/fetch 实现端读取）
  const baseUrl = deps.baseUrl ?? process.env.GRAPHICTERO_OPENALEX_BASE_URL ?? DEFAULT_BASE_URL
  const fetchImpl = deps.fetchImpl ?? fetch
  const minIntervalMs = deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
  const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let lastRequestAt = 0

  async function requestJson(path: string, params: Record<string, string>): Promise<unknown | null> {
    const url = new URL(`${baseUrl}${path}`)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    if (deps.mailto) url.searchParams.set('mailto', deps.mailto)
    if (deps.apiKey) url.searchParams.set('api_key', deps.apiKey)

    for (let attempt = 0; ; attempt++) {
      // 礼貌限速：与上次请求间隔至少 minIntervalMs
      const wait = minIntervalMs - (Date.now() - lastRequestAt)
      if (wait > 0) await sleep(wait)
      lastRequestAt = Date.now()

      let res: Response
      try {
        const mailto = deps.mailto?.trim()
        res = await fetchImpl(url.toString(), {
          headers: {
            // 没有联系邮箱时不塞占位地址（建议修 11）
            'User-Agent': mailto ? `Graphictero (mailto:${mailto})` : 'Graphictero'
          },
          signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
        })
      } catch (e) {
        if (attempt < maxRetries) {
          await sleep(2 ** attempt * 200)
          continue
        }
        if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
          throw new RetryableLlmError('OpenAlex 请求超时')
        }
        throw new NetworkLlmError(`OpenAlex 网络错误：${e instanceof Error ? e.message : String(e)}`)
      }

      if (res.status === 404) return null // 单篇不存在：合法结果，不是错误，不计次
      if (res.status === 429) {
        const body = await res.text().catch(() => '')
        if (/credit|quota|daily/i.test(body)) {
          throw new BadRequestLlmError('OpenAlex 当日免费额度已用完，今天不再自动重试', 429)
        }
        const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'))
        if (attempt < maxRetries) {
          await sleep(Math.max(retryAfterMs ?? 0, 2 ** attempt * 200))
          continue
        }
        throw new RetryableLlmError('OpenAlex 请求被限流（429）', 429, retryAfterMs)
      }
      if (res.status >= 500) {
        if (attempt < maxRetries) {
          await sleep(2 ** attempt * 200)
          continue
        }
        throw new RetryableLlmError(`OpenAlex 服务端错误（${res.status}）`, res.status)
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        // 评审建议 9：400/403 等重试无用，抛 BadRequestLlmError（不重试，
        // 与 runner/关系引擎对 400 的 failed_action 口径一致）；401 也按
        // BadRequest 处理（OpenAlex 的 401 是 Key 无效，重试无意义）。
        // 引用拿不到时走 D40 兜底，单篇引不到不阻塞关系生成
        throw new BadRequestLlmError(`OpenAlex 错误（${res.status}）：${body.slice(0, 200)}`, res.status)
      }
      deps.onBillable?.()
      return (await res.json()) as unknown
    }
  }

  return {
    async fetchWorkByDoi(doi: string): Promise<OpenAlexWork | null> {
      const raw = (await requestJson(`/works/doi:${encodeURIComponent(doi)}`, {})) as Record<string, unknown> | null
      return raw ? parseWork(raw) : null
    },
    async fetchWorkByWid(wid: string): Promise<OpenAlexWork | null> {
      const raw = (await requestJson(`/works/${encodeURIComponent(wid)}`, {})) as Record<string, unknown> | null
      return raw ? parseWork(raw) : null
    },
    async searchWorksByTitle(title: string, perPage = 5): Promise<OpenAlexWork[]> {
      const raw = (await requestJson('/works', {
        search: title.replace(/[：:]/g, ' ').replace(/\s+/g, ' ').trim(),
        per_page: String(Math.min(Math.max(perPage, 1), 25))
      })) as Record<string, unknown> | null
      const results = (raw?.results as Array<Record<string, unknown>> | undefined) ?? []
      return results.map(parseWork)
    },
    async fetchWorksByWids(wids: string[]): Promise<OpenAlexWork[]> {
      const uniq = [...new Set(wids.map((w) => w.toUpperCase()))].filter(Boolean)
      const out: OpenAlexWork[] = []
      for (let i = 0; i < uniq.length; i += 50) {
        const chunk = uniq.slice(i, i + 50)
        const raw = (await requestJson('/works', {
          // uat6b M2：openalex.id: 过滤器已被 OpenAlex 拒绝（400，uat5 复测证实）——
          // 批量取 work 改用裸 W id 管道分隔：filter=openalex:W1|W2…（官方支持，每批 ≤50）
          filter: `openalex:${chunk.join('|')}`,
          per_page: '50'
        })) as Record<string, unknown> | null
        const results = (raw?.results as Array<Record<string, unknown>> | undefined) ?? []
        out.push(...results.map(parseWork))
      }
      return out
    },
    async searchWorksFull(query: string, perPage = 10): Promise<OpenAlexWorkFull[]> {
      const raw = (await requestJson('/works', {
        search: query.replace(/[：:]/g, ' ').replace(/\s+/g, ' ').trim(),
        per_page: String(Math.min(Math.max(perPage, 1), 25))
      })) as Record<string, unknown> | null
      const results = (raw?.results as Array<Record<string, unknown>> | undefined) ?? []
      return results.map(parseWorkFull)
    },
    async fetchWorkFullByDoi(doi: string): Promise<OpenAlexWorkFull | null> {
      const raw = (await requestJson(`/works/doi:${encodeURIComponent(doi)}`, {})) as Record<string, unknown> | null
      return raw ? parseWorkFull(raw) : null
    },
    async fetchWorkFullByWid(wid: string): Promise<OpenAlexWorkFull | null> {
      const raw = (await requestJson(`/works/${encodeURIComponent(wid)}`, {})) as Record<string, unknown> | null
      return raw ? parseWorkFull(raw) : null
    },
    async fetchCitingWorksByWid(wid: string, perPage = 25): Promise<OpenAlexWorkFull[]> {
      const raw = (await requestJson('/works', {
        // OpenAlex 向前引用：filter=cites:<openalex id url>
        filter: `cites:https://openalex.org/${encodeURIComponent(wid.toUpperCase())}`,
        per_page: String(Math.min(Math.max(perPage, 1), 25))
      })) as Record<string, unknown> | null
      const results = (raw?.results as Array<Record<string, unknown>> | undefined) ?? []
      return results.map(parseWorkFull)
    }
  }
}
