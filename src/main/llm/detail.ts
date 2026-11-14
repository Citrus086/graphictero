import type Database from 'better-sqlite3'
import { z } from 'zod'
import { DetailPartSchema, type DetailPart } from '../../shared/parts'
import type { DetailStaleReason, DetailView, PaperMetaView } from '../../shared/ipc/detail'
import { DEEPSEEK_FLASH_MAX_OUTPUT, streamChat, type LlmClientDeps } from './client'
import { DETAIL_PROMPT } from './prompts'
import { stripInlineImages } from '../text/stripInlineImages'
import { recordUsage } from './usage'

/**
 * 论文详情生成步骤（D18/D67/D85）：解析完成、名片就绪后自动生成。
 * 输出先按 UIMessage parts 存储（D20：text part；结构化 data part 与富文本
 * 渲染在 M4），跨图谱共享（D6）、每篇只生成一次（D67）、不会自动重新生成（D29）。
 */

export interface DetailResult {
  parts: DetailPart[]
  truncated: boolean
}

export interface DetailDeps {
  db: Database.Database
  paperId: number
  markdown: string
  pdfHash: string | null
  llm: () => LlmClientDeps
  now?: () => Date
  onDelta?: (text: string) => void
  /** D42：手动重新生成——跳过「已是最新」短路，覆盖旧详情（不保留旧版） */
  force?: boolean
  /** D142：该会话触发的详情记到会话后台；detail_regen / 与会话无关的留空 */
  sessionId?: number | null
}

export async function generateDetail(deps: DetailDeps): Promise<DetailResult> {
  const { db, paperId } = deps
  const markdown = stripInlineImages(deps.markdown)
  const now = (): Date => deps.now?.() ?? new Date()
  const paper = db.prepare('SELECT title, abstract FROM papers WHERE id = ?').get(paperId) as
    | { title: string; abstract: string | null }
    | undefined
  if (!paper) throw new Error(`论文 ${paperId} 不存在`)

  // 评审建 2（D67/D29）：pdf_hash + prompt_version 未变说明详情已是最新——
  // 跳过 LLM 调用、不覆盖已有内容（手动重试已成功任务等边界也不重复计费）
  const existing = db.prepare('SELECT parts, prompt_version, pdf_hash FROM paper_details WHERE paper_id = ?').get(paperId) as
    | { parts: string; prompt_version: string; pdf_hash: string | null }
    | undefined
  if (!deps.force && existing && existing.prompt_version === DETAIL_PROMPT.version && existing.pdf_hash === deps.pdfHash) {
    return { parts: JSON.parse(existing.parts) as DetailPart[], truncated: false }
  }

  const llm = deps.llm()
  const r = await streamChat(
    { ...llm, maxOutputTokens: DEEPSEEK_FLASH_MAX_OUTPUT }, // D100：不设低固定上限
    [
      { role: 'system', content: DETAIL_PROMPT.system },
      { role: 'user', content: `论文标题：${paper.title}\n\n全文（Markdown）：\n${markdown}` }
    ],
    deps.onDelta
  )
  recordUsage(db, {
    category: 'detail',
    paperId,
    sessionId: deps.sessionId ?? null,
    model: llm.model,
    usage: r.usage,
    at: now(),
    thinking: true
  })

  // D106：v2 输出为 parts JSON 数组——剥 ```json 围栏后解析，zod 校验（冻结契约）；
  // 不合法整段降级为单个 text part（保留原始输出），不重试、不二次计费。
  const parts: DetailPart[] = parseDetailParts(r.text) ?? [{ type: 'text', text: r.text }]
  const iso = now().toISOString()
  db.prepare(
    `INSERT INTO paper_details (paper_id, parts, model, prompt_version, pdf_hash, generated_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(paper_id) DO UPDATE SET
       parts = excluded.parts, model = excluded.model, prompt_version = excluded.prompt_version,
       pdf_hash = excluded.pdf_hash, generated_at = excluded.generated_at, updated_at = excluded.updated_at`
  ).run(paperId, JSON.stringify(parts), llm.model, DETAIL_PROMPT.version, deps.pdfHash, iso, iso, iso)
  return { parts, truncated: r.truncated }
}

// ── 详情读取（detail:get / detail:getMeta，M4 lane/detail 批 1）──────────

/**
 * D210：宽松修复 LLM 输出的 parts JSON。模型有时在 text 值内部写未转义的 ASCII 双引号
 * （如 比较的是"某一时刻…"）或裸换行/制表符，导致 JSON.parse 直接失败、整段降级为单 text。
 * 按字符扫描（无依赖）：字符串值内部的 `"`，若其后（跳过空白）是 `,` `}` `]` `:` 或输入结束，
 * 视为该字符串的收尾引号；否则视为内容引号，转义为 `\"`。字符串内的裸 \n / \t 一并转义，
 * 已有转义序列原样透传。修复结果仍须经 zod 校验（见 parseDetailParts）。
 */
export function repairDetailJson(text: string): string {
  let out = ''
  let inString = false
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (!inString) {
      out += c
      if (c === '"') inString = true
      i += 1
      continue
    }
    if (c === '\\') {
      out += c + (text[i + 1] ?? '')
      i += 2
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < n && /\s/.test(text[j])) j += 1
      const next = text[j]
      if (next === undefined || next === ',' || next === '}' || next === ']' || next === ':') {
        out += '"'
        inString = false
      } else {
        out += '\\"'
      }
      i += 1
      continue
    }
    if (c === '\n') {
      out += '\\n'
      i += 1
      continue
    }
    if (c === '\t') {
      out += '\\t'
      i += 1
      continue
    }
    out += c
    i += 1
  }
  return out
}

/** 解析并校验 parts JSON 数组（内部共用）：非数组 / 空数组 / zod 不过都返回 null */
function parsePartsArrayJson(raw: string): DetailPart[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  const check = z.array(DetailPartSchema).safeParse(parsed)
  return check.success ? check.data : null
}

/**
 * D106 生成侧解析：剥 ```json 围栏 → JSON.parse → zod（冻结 parts 契约）校验。
 * 任一步失败返回 null（调用方降级为单个 text part）；空数组视为不合法。
 * D210：JSON.parse 失败时先经 repairDetailJson 宽松修复再重试一次（修复后仍过 zod 才算成功）。
 */
export function parseDetailParts(text: string): DetailPart[] | null {
  let t = text.trim()
  const fence = t.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/)
  if (fence) t = fence[1].trim()
  const ok = parsePartsArrayJson(t)
  if (ok) return ok
  return parsePartsArrayJson(repairDetailJson(t))
}

/**
 * D106 读取口径：库里 parts 不是合法 parts 数组时（如早期存的一整段 Markdown 字符串），
 * 降级包成单个 text part 返回，不丢内容、不报错。
 * D210 读取侧自愈：当结果是「只有一个 text part、且其 text 去围栏后以 `[` 开头」时——
 * 正是当年生成侧解析失败降级入库的样子——对该 text 再跑 parseDetailParts（含宽松修复），
 * 成功则返回修复后的 parts（getDetailView 顺手幂等回写库，详见其注释）。
 */
export function coerceDetailParts(raw: string): DetailPart[] {
  return coerceDetailPartsInner(raw).parts
}

/** 内部口径：附 healed 标记（getDetailView 幂等回写用） */
function coerceDetailPartsInner(raw: string): { parts: DetailPart[]; healed: boolean } {
  const ok = parsePartsArrayJson(raw)
  const base: DetailPart[] = ok ?? [{ type: 'text', text: raw }]
  // D210 读取侧自愈：结果只有单个 text part 且其 text 去围栏后以 `[` 开头——
  // 正是当年生成侧解析失败降级入库的样子——再跑生成侧解析（含宽松修复）。
  // 注意：库内合法 parts 数组里包着坏 JSON 字符串（降级入库的实际形态）也要走到这里。
  if (base.length === 1 && base[0].type === 'text') {
    const healed = healFromSingleText(base[0].text)
    if (healed) return { parts: healed, healed: true }
  }
  return { parts: base, healed: false }
}

/** D210：单个 text part 的读取侧自愈——去围栏后以 `[` 开头的，再按生成侧口径解析（含修复） */
function healFromSingleText(text: string): DetailPart[] | null {
  let t = text.trim()
  const fence = t.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/)
  if (fence) t = fence[1].trim()
  if (!t.startsWith('[')) return null
  return parseDetailParts(t)
}

/**
 * detail:get 服务层：读缓存详情 + 计算过期原因（D29）。
 * staleReason：prompt 版本变化 → 'prompt'；PDF 哈希变化 → 'pdf'；换模型不提示（D29）。
 * 无详情返回 null。
 */
export function getDetailView(db: Database.Database, paperId: number): DetailView | null {
  const paper = db.prepare('SELECT pdf_hash FROM papers WHERE id = ? AND deleted_at IS NULL').get(paperId) as
    | { pdf_hash: string | null }
    | undefined
  if (!paper) return null
  const row = db
    .prepare('SELECT parts, model, prompt_version, pdf_hash, generated_at FROM paper_details WHERE paper_id = ?')
    .get(paperId) as
    | { parts: string; model: string | null; prompt_version: string | null; pdf_hash: string | null; generated_at: string }
    | undefined
  if (!row) return null
  const coerced = coerceDetailPartsInner(row.parts)
  // D210 自愈回写（幂等）：本次经宽松修复成功才写回——已降级的存量详情免重新付费生成；
  // 写回后 raw 即合法 parts JSON，再次读取 healed=false，不会再写。
  if (coerced.healed) {
    db.prepare('UPDATE paper_details SET parts = ?, updated_at = ? WHERE paper_id = ?').run(
      JSON.stringify(coerced.parts),
      new Date().toISOString(),
      paperId
    )
  }
  let staleReason: DetailStaleReason = null
  if (row.prompt_version !== DETAIL_PROMPT.version) staleReason = 'prompt'
  else if (row.pdf_hash !== paper.pdf_hash) staleReason = 'pdf'
  return {
    paperId,
    parts: coerced.parts,
    model: row.model ?? '—',
    generatedAt: row.generated_at,
    promptVersion: row.prompt_version ?? '—',
    staleReason
  }
}

const ABSTRACT_SOURCES = new Set(['original', 'ai', 'openalex'])
const PDF_SOURCES = new Set(['zotero', 'open_access', 'institution_proxy', 'custom', 'user_drop'])

/** detail:getMeta 服务层：csl_json + paper_authors → 详情页头部元数据（论文不存在/已删返回 null） */
export function getPaperMetaView(db: Database.Database, paperId: number): PaperMetaView | null {
  const row = db
    .prepare(
      `SELECT title, csl_json, first_author, year, doi, zotero_item_key, source, has_pdf,
              pdf_source, pdf_unresolved, abstract, abstract_source, one_liner
       FROM papers WHERE id = ? AND deleted_at IS NULL`
    )
    .get(paperId) as
    | {
        title: string
        csl_json: string
        first_author: string | null
        year: number | null
        doi: string | null
        zotero_item_key: string | null
        source: string
        has_pdf: number
        pdf_source: string | null
        pdf_unresolved: number
        abstract: string | null
        abstract_source: string | null
        one_liner: string | null
      }
    | undefined
  if (!row) return null

  let csl: Record<string, unknown> = {}
  try {
    const p = JSON.parse(row.csl_json) as unknown
    if (p && typeof p === 'object' && !Array.isArray(p)) csl = p as Record<string, unknown>
  } catch {
    /* csl_json 损坏按空处理 */
  }
  const authors = (
    db.prepare('SELECT family, given FROM paper_authors WHERE paper_id = ? ORDER BY position').all(paperId) as Array<{
      family: string | null
      given: string | null
    }>
  )
    .map((a) => [a.given, a.family].filter(Boolean).join(' ').trim())
    .filter((s) => s.length > 0)
  if (authors.length === 0) {
    const cslAuthors = Array.isArray(csl.author) ? (csl.author as Array<Record<string, unknown>>) : []
    for (const a of cslAuthors) {
      const name = [a?.given, a?.family].filter((x): x is string => typeof x === 'string' && x.length > 0).join(' ')
      if (name) authors.push(name)
    }
  }
  if (authors.length === 0 && row.first_author) authors.push(row.first_author)

  const container = csl['container-title']
  const venue = Array.isArray(container)
    ? (container.filter((x): x is string => typeof x === 'string' && x.length > 0)[0] ?? null)
    : typeof container === 'string' && container.length > 0
      ? container
      : null

  return {
    paperId,
    title: row.title,
    authors,
    year: row.year,
    venue,
    doi: row.doi,
    zoteroItemKey: row.zotero_item_key,
    source: row.source === 'agent' ? 'agent' : 'zotero',
    hasPdf: row.has_pdf === 1,
    pdfSource: PDF_SOURCES.has(row.pdf_source ?? '') ? (row.pdf_source as PaperMetaView['pdfSource']) : null,
    pdfUnresolved: row.pdf_unresolved === 1,
    abstract: row.abstract,
    abstractSource: row.abstract_source && ABSTRACT_SOURCES.has(row.abstract_source) ? (row.abstract_source as PaperMetaView['abstractSource']) : null,
    oneLiner: row.one_liner
  }
}
