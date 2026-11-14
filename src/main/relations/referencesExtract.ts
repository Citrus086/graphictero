import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { DEEPSEEK_FLASH_MAX_OUTPUT, streamChat, type LlmClientDeps } from '../llm/client'
import { recordUsage } from '../llm/usage'
import { titleSim } from '../openalex/match'
import { normDoi } from '../openalex/references'
import { stripInlineImages } from '../text/stripInlineImages'
import { REFERENCES_EXTRACT_PROMPT } from './prompts'
import { recalcNoRefBasis } from './autoTypes'

/**
 * D40 兜底：OpenAlex 补不全（本篇查不到 / referenced_works 为空，最新预印本
 * 常态，M0 实测）时，用 deepseek-flash 从 MinerU 解析出的 References 段抽取
 * 引用条目，写 paper_references（source='deepseek'），与库内论文按 DOI /
 * 标题三条阈值（D71 同口径）匹配填 matched_paper_id。
 *
 * lane/pdf 未合并期间，Markdown 读 <数据目录>/papers/<id>/mineru/full.md——
 * 测试直接写 fixture Markdown 到该路径，不依赖真 MinerU（任务书口径）。
 */

const MAX_REFS_CHARS = 30_000

/** 从 full Markdown 截出 References 段（标题行 References/参考文献 到下一个标题/文末）
 * uat4 D165：容忍真实 MinerU 输出里常见的编号/冒号尾——`## 7 参考文献`、
 * `**References:**` 也能切到（此前只认整词完全相等，段切分一环落空全链落空） */
export function extractReferencesSection(markdown: string): string | null {
  const lines = markdown.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim().replace(/^#{1,6}\s*/, '').replace(/[*_]/g, '').trim()
    if (/^\d*[\s.、:：]?\s*(references|bibliography|参考文献|参\s*考\s*文\s*献)\s*:?\s*$/i.test(t)) {
      start = i + 1
      break
    }
  }
  if (start === -1) return null
  const body: string[] = []
  for (let i = start; i < lines.length; i++) {
    if (/^\s*#{1,6}\s+\S/.test(lines[i])) break // 下一个小标题（如附录）结束
    body.push(lines[i])
  }
  const text = body.join('\n').trim()
  return text || null
}

interface ExtractedRef {
  title?: string
  year?: number
  doi?: string
}

/**
 * uat4 D165：arXiv 裸 id 归一——从各种常见写法里抽出 `1706.03762`：
 * `arXiv:1706.03762v3` / `https://arxiv.org/abs/1706.03762v3` / arXiv-DOI
 * `10.48550/arXiv.1706.03762`；版本号 vN 剥掉（引用方常引 v2、库里登记 v1），
 * 旧式 `cs/9901001` 也收。归不出返回 null。
 */
export function arxivIdOf(raw: string | null | undefined): string | null {
  if (!raw) return null
  let s = raw.trim()
  if (!s) return null
  s = s.replace(/^https?:\/\/(www\.)?arxiv\.org\/(abs|pdf)\//i, '')
  s = s.replace(/^arxiv\s*:\s*/i, '')
  s = s.replace(/^10\.48550\/arxiv\./i, '')
  const m = s.match(/^(\d{4}\.\d{4,5}|[a-z-]+\/[a-z]{0,2}\d+)(?:v\d+)?$/i)
  return m ? m[1].toLowerCase() : null
}

/**
 * 容错解析 JSON 数组（generator.ts parseRelationsJson 同口径）：
 * 完整数组优先；截断（mid-JSON）时按大括号深度捞出完整的元素对象，
 * 并上报 truncated——上层据此知道没抽完（评审必须修 3）。
 */
export function parseRefsJson(text: string): { refs: ExtractedRef[]; truncated: boolean } {
  const m = text.match(/\[[\s\S]*\]/)
  if (m) {
    try {
      const arr = JSON.parse(m[0]) as unknown
      if (Array.isArray(arr)) {
        return { refs: arr.filter((x): x is ExtractedRef => typeof x === 'object' && x != null), truncated: false }
      }
    } catch {
      // 落到截断兜底
    }
  }
  // 截断兜底：捞包含 "title" 的完整单条对象（{...} 无嵌套）
  const refs: ExtractedRef[] = []
  const re = /\{[^{}]*"title"\s*:\s*"[^"]*"[^{}]*\}/g
  let mo: RegExpExecArray | null
  while ((mo = re.exec(text)) !== null) {
    try {
      const one = JSON.parse(mo[0]) as ExtractedRef
      refs.push(one)
    } catch {
      // 跳过坏对象
    }
  }
  return { refs, truncated: true }
}

export interface RefsExtractDeps {
  db: Database.Database
  dataDir: string
  paperId: number
  llm: () => LlmClientDeps
  now?: () => Date
}

export interface RefsExtractResult {
  /** References 段是否存在 / 抽取到几条 / 匹配到库内几条 */
  sectionFound: boolean
  wroteCount: number
  matchedCount: number
  /** LLM 输出被截断（只捞回部分条目）——上层可提示「没抽完」（评审必须修 3） */
  truncated: boolean
}

export async function extractReferencesWithLlm(deps: RefsExtractDeps): Promise<RefsExtractResult> {
  const { db, dataDir, paperId } = deps
  const now = (): Date => deps.now?.() ?? new Date()
  const mdPath = join(dataDir, 'papers', String(paperId), 'mineru', 'full.md')
  if (!existsSync(mdPath)) return { sectionFound: false, wroteCount: 0, matchedCount: 0, truncated: false }
  const section = stripInlineImages(extractReferencesSection(readFileSync(mdPath, 'utf8')) ?? '')
  if (!section) return { sectionFound: false, wroteCount: 0, matchedCount: 0, truncated: false }

  const llm = deps.llm()
  const r = await streamChat(
    { ...llm, maxOutputTokens: DEEPSEEK_FLASH_MAX_OUTPUT }, // D100：兜底路径同样给满 384k
    [
      { role: 'system', content: REFERENCES_EXTRACT_PROMPT.system },
      {
        role: 'user',
        content: `论文参考文献段落（截断至 ${MAX_REFS_CHARS} 字符）：\n${section.slice(0, MAX_REFS_CHARS)}`
      }
    ]
  )
  recordUsage(db, { category: 'relation', paperId, model: llm.model, usage: r.usage, at: now(), thinking: true })
  const parsed = parseRefsJson(r.text)
  const refs = parsed.refs.filter((x) => typeof x.title === 'string' && x.title.trim())

  // 与库内论文按 DOI 精确 / arXiv id 精确 / 标题三条阈值匹配（D49：可按标题匹配；参考方无姓信息，
  // 阈值②自动放行——同 openalex/match.ts 对无姓候选的口径）
  const lib = db
    .prepare('SELECT id, title, first_author, year, doi, arxiv_id FROM papers WHERE deleted_at IS NULL')
    .all() as Array<{ id: number; title: string; first_author: string | null; year: number | null; doi: string | null; arxiv_id: string | null }>
  // 评审建议 11：DOI 匹配走 normDoi（剥 https://doi.org/ 前缀 + 小写），
  // 与 openalex/references.ts 同口径
  const byDoi = new Map(lib.filter((p) => p.doi).map((p) => [normDoi(p.doi!), p.id]))
  // uat4 D165：arXiv 第二径——库内论文的 arxiv_id 列与 arXiv-DOI 统一归一成裸 id 建索引，
  // 兜住「引用写 arXiv:xxxxv2、库里登记 10.48550/arxiv.xxxx」这种 DOI 字符串不相等的互引
  const byArxiv = new Map<string, number>()
  for (const p of lib) {
    const a = arxivIdOf(p.arxiv_id) ?? arxivIdOf(p.doi)
    if (a && !byArxiv.has(a)) byArxiv.set(a, p.id)
  }
  const iso = now().toISOString()
  let matched = 0
  const tx = db.transaction(() => {
    // 幂等：清掉本篇旧的 deepseek 行再写
    db.prepare("DELETE FROM paper_references WHERE paper_id = ? AND source = 'deepseek'").run(paperId)
    const ins = db.prepare(
      `INSERT INTO paper_references (paper_id, openalex_wid, doi, title, year, matched_paper_id, source, created_at)
       VALUES (?, NULL, ?, ?, ?, ?, 'deepseek', ?)`
    )
    for (const ref of refs) {
      const doi = typeof ref.doi === 'string' && ref.doi.trim() ? ref.doi.trim() : null
      const year = typeof ref.year === 'number' && Number.isFinite(ref.year) ? Math.trunc(ref.year) : null
      let matchedId: number | null = null
      const arxiv = arxivIdOf(doi)
      if (doi && byDoi.has(normDoi(doi))) {
        matchedId = byDoi.get(normDoi(doi))!
      } else if (arxiv && byArxiv.has(arxiv)) {
        // uat4 D165：arXiv id 归一命中（剥版本号）
        matchedId = byArxiv.get(arxiv)!
      } else {
        // 标题三条阈值（阈值① bigram Dice ≥0.95；参考方无姓信息阈值②放行；③年份 ±1）
        let best: { id: number; sim: number } | null = null
        for (const p of lib) {
          const sim = titleSim(ref.title!, p.title)
          if (sim < 0.95) continue
          const yearOk = year == null || p.year == null || Math.abs(p.year - year) <= 1
          if (!yearOk) continue
          if (!best || sim > best.sim) best = { id: p.id, sim }
        }
        matchedId = best?.id ?? null
      }
      if (matchedId != null) matched++
      ins.run(paperId, doi, ref.title!.trim(), year, matchedId, iso)
    }
  })
  tx()
  // uat4-fix1 D173（M2）：引用数据写入后重算相关「基于/改进」边的 no_ref_basis（允许 1→0）
  recalcNoRefBasis(db, paperId)
  return { sectionFound: true, wroteCount: refs.length, matchedCount: matched, truncated: parsed.truncated }
}
