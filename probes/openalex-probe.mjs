#!/usr/bin/env node
/**
 * M0 探针（D71/D72）：OpenAlex 引用覆盖率 + 按标题找回 DOI 的准确率。
 *
 * 用法：node probes/openalex-probe.mjs [--papers fixtures/papers.json] [--out results.json]
 *
 * 流程（对每篇）：
 *   1. 有 DOI → GET /works/doi:{doi} 拿 W-ID；
 *   2. 无 DOI → title.search 搜索，按 D71 阈值判定：
 *      规范化标题相似度 ≥ 0.95、第一作者姓一致（有作者信息时）、年份 ±1；
 *   3. 记录 matched / method(doi|title|none) / w_id / referenced_works 数量。
 * 最后算集合内部的直接引用对（W-ID 集合两两比较）。
 *
 * Key：.env 的 OPENALEX_API_KEY 有效就带上（api_key 参数）；无效/缺失则加 --no-key 不带来跑
 * （OpenAlex 无 key 也能用，只是池子小）。401 会被记录到结果里，不中断。
 *
 * 输出文件：带 key 与 --no-key 两次运行默认写到不同文件（避免互相覆盖丢失证据）：
 *   带 key   → probes/results/openalex-probe-keyed.json
 *   --no-key → probes/results/openalex-probe.json
 * 也可用 --out 显式指定。
 *
 * User-Agent 礼貌池：.env 里可设 OPENALEX_MAILTO=你的真实邮箱（OpenAlex 建议，进 polite
 * 池、显著减少限流）；未设时用占位邮箱（本机跑前请先设）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { loadEnv } from './lib/env.mjs'

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1] ?? true] : null)).filter(Boolean)
)
const papersPath = resolve(args.papers ?? 'probes/fixtures/papers.json')
const env = loadEnv()
// --no-key：即使 .env 里有 OPENALEX_API_KEY 也不带（key 无效 401 时用）
const apiKey = args['no-key'] ? null : env.OPENALEX_API_KEY || null
// keyed / no-key 默认输出到不同文件，避免两次运行互相覆盖（评审必须修 1）
const outPath = resolve(
  args.out ?? (apiKey ? 'probes/results/openalex-probe-keyed.json' : 'probes/results/openalex-probe.json')
)
const papers = JSON.parse(readFileSync(papersPath, 'utf-8'))

const MAILTO = env.OPENALEX_MAILTO || 'graphictero@example.com'
const BASE = 'https://api.openalex.org'

function normTitle(t) {
  return t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\u4e00-\u9fff]+/gi, ' ').trim()
}
/** 二元组 Dice 相似度，D71 的「规范化标题相似度 ≥ 0.95」 */
function titleSim(a, b) {
  const A = normTitle(a)
  const B = normTitle(b)
  if (!A || !B) return 0
  const big = (s) => new Set(s.split(' ').flatMap((w) => (w.length < 2 ? [w] : Array.from({ length: w.length - 1 }, (_, i) => w.slice(i, i + 2)))))
  const X = big(A)
  const Y = big(B)
  let inter = 0
  for (const g of X) if (Y.has(g)) inter++
  return (2 * inter) / (X.size + Y.size)
}

async function get(pathname, params = {}) {
  const url = new URL(BASE + pathname)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  if (apiKey) url.searchParams.set('api_key', apiKey)
  const res = await fetch(url, { headers: { 'User-Agent': `Graphictero-M0-probe (mailto:${MAILTO})` } })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

const results = []
for (const p of papers) {
  const r = { key: p.key, title: p.title, method: 'none', matched: false }
  try {
    let work = null
    if (p.doi) {
      const { status, body } = await get(`/works/doi:${p.doi}`)
      r.httpStatus = status
      if (status === 200) {
        work = body
        r.method = 'doi'
      } else if (status === 401) {
        r.error = '401 Unauthorized（OPENALEX_API_KEY 无效）'
        results.push(r)
        continue
      }
    }
    if (!work) {
      // 标题找回（D71）：标题相似度 ≥ 0.95、第一作者姓一致、年份 ±1
      const { status, body } = await get('/works', {
        search: p.title.replace(/[：:]/g, ' '),
        per_page: '5',
        select: 'id,doi,title,publication_year,authorships,referenced_works'
      })
      r.httpStatus = status
      if (status === 401) {
        r.error = '401 Unauthorized（OPENALEX_API_KEY 无效）'
        results.push(r)
        continue
      }
      if (status !== 200) {
        r.error = `HTTP ${status}`
        results.push(r)
        continue
      }
      let best = null
      for (const c of body.results ?? []) {
        const sim = titleSim(p.title, c.title ?? '')
        const surname = c.authorships?.[0]?.author?.display_name?.split(' ')?.pop() ?? null
        const surnameOk = p.firstAuthor ? surname?.toLowerCase() === p.firstAuthor.toLowerCase() : true
        const yearOk = p.year == null || c.publication_year == null || Math.abs(c.publication_year - p.year) <= 1
        if (sim >= 0.95 && surnameOk && yearOk) {
          best = { work: c, sim }
          break
        }
        if (!best || sim > best.sim) best = { work: c, sim }
      }
      r.bestCandidateSim = best?.sim ?? null
      if (best && best.sim >= 0.95) {
        const surname = best.work.authorships?.[0]?.author?.display_name?.split(' ')?.pop()
        const surnameOk = p.firstAuthor ? surname?.toLowerCase() === p.firstAuthor.toLowerCase() : true
        const yearOk = p.year == null || best.work.publication_year == null || Math.abs(best.work.publication_year - p.year) <= 1
        if (surnameOk && yearOk) {
          work = best.work
          r.method = 'title'
        }
      }
    }
    if (work) {
      r.matched = true
      r.wId = work.id
      r.doi = work.doi
      r.openalexYear = work.publication_year
      r.referencedWorks = (work.referenced_works ?? []).length
      r.refIds = work.referenced_works ?? []
    }
  } catch (e) {
    r.error = String(e)
  }
  results.push(r)
  await new Promise((s) => setTimeout(s, 200)) // 无 key 时限流，礼貌等待
}

// 集合内直接引用对（D40 信号 a）
const pairs = []
for (const a of results) {
  if (!a.matched || !a.refIds) continue
  const set = new Set(a.refIds)
  for (const b of results) {
    if (b.key !== a.key && b.matched && set.has(b.wId)) pairs.push({ from: a.key, to: b.key, kind: 'cites' })
  }
}

const summary = {
  total: results.length,
  matched: results.filter((r) => r.matched).length,
  byMethod: {
    doi: results.filter((r) => r.method === 'doi').length,
    title: results.filter((r) => r.method === 'title').length
  },
  citationPairs: pairs,
  usedApiKey: Boolean(apiKey)
}
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2))
console.log(JSON.stringify(summary, null, 2))
console.log(`详细结果: ${outPath}`)
