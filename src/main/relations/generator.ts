import type Database from 'better-sqlite3'
import { DEEPSEEK_FLASH_MAX_OUTPUT, streamChat, type LlmClientDeps } from '../llm/client'
import { RetryableLlmError } from '../llm/errors'
import { recordUsage } from '../llm/usage'
import { upsertRelation, deleteRelation } from '../db/relations'
import { isRelationType, type RelationType } from '../../shared/relationTypes'
import { searchPapers } from '../db/fts'
import { buildShortIds, cardText, detailText, estimateTokens, loadGraphPapers, type GraphPaper } from './context'
import { computeAutoTypes } from './autoTypes'
import { markPaperProcessed, processedPaperIds } from './progress'
import { CANDIDATE_SELECT_PROMPT, NEW_PAPER_RELATION_PROMPT, RELATION_GEN_CONTINUE_SUFFIX, RELATION_GEN_PROMPT } from './prompts'
import { citePaper, replaceInternalRefTokens, resolveStoredIdToken } from '../text/internalRefs'

/**
 * 关系生成（D40/D47/D66/D86/D87）。
 *
 * - 首次建图：读本图全部参与论文的详情作为主要依据（D87）；估算上下文超过
 *   约 60 万 token 或超过约 120 篇时自动退化为「名片打底 + 逐篇走新增论文
 *   流程」（D86）；
 * - 新论文：三路信号（引用 / FTS5 关键词 / 名片全量）+ 文献耦合（D102）合并候选
 *   findRelatedPapers；深读候选改两阶段（D103）——LLM 先据信号挑 5–8 篇，再读
 *   候选详情写只涉及新论文的关系（D40）；
 * - 写关系：LLM 每次调用输出一批 JSON（≤ 50 条/批，D86 的每步约 50 条口径），
 *   finishReason=length 截断或没写完（done=false）就从「已写入的边 + 未处理的
 *   论文」接着跑（D86）；短 id 校验、自环拒绝、非法类型丢弃（校验错误作为
 *   结果计数返回，不中断）；写入幂等（upsertRelation 无序对合并，D89）；
 *   自动「引用 / 同一作者」附加在 LLM 建的边上（autoTypes.ts，D89/D93）。
 *
 * 输出预算：D92 thinking 开 + 流式；20 篇探针实测 8192 输出被 thinking 吃满
 * （finishReason=length，0 条关系），所以关系生成按 D100 显式给满 384k
 * （DEEPSEEK_FLASH_MAX_OUTPUT，可调）。
 */

export interface GenerateLimits {
  /** D86：约 60 万 token（估算值） */
  maxContextTokens?: number
  /** D86：约 120 篇 */
  maxPapers?: number
  maxOutputTokens?: number
  /** 截断续跑的迭代上限（保险丝，防死循环） */
  maxIterations?: number
}

export interface GenDeps {
  db: Database.Database
  llm: () => LlmClientDeps
  now?: () => Date
  limits?: GenerateLimits
  /** 每次 LLM 调用的正文增量回调（进度显示用） */
  onDelta?: (text: string) => void
}

export interface GenResult {
  strategy: 'details' | 'cards_then_per_paper'
  /** LLM 输出且校验通过、写入（或合并进已有边）的关系条数 */
  written: number
  /** 校验失败被丢弃的条数（短 id 越界/自环/非法类型/空陈述） */
  invalid: number
  /** 其中附加了自动类型（引用/同一作者）的条数 */
  autoAttached: number
  /** D104：因同对已有 session（手动/会话）边而跳过的条数（session 边绝不覆盖） */
  skippedSession?: number
  llmCalls: number
  truncated: boolean
}

const DEFAULT_MAX_CONTEXT_TOKENS = 600_000
const DEFAULT_MAX_PAPERS = 120
// D100：deepseek-flash 最大输出 384k；探针 8192 被 thinking 吃满的教训不设低上限
const DEFAULT_MAX_OUTPUT_TOKENS = DEEPSEEK_FLASH_MAX_OUTPUT
const DEFAULT_MAX_ITERATIONS = 10
/** 新论文的固定短 id：避开 P01…P99 编号空间（评审建议 7，≥99 篇图内 P99 撞车） */
export const NEW_PAPER_SHORT_ID = 'NEW'
/** D86：每一步最多约 50 条 addRelation */
export const RELATIONS_PER_CALL = 50
/** D103：精读候选 5–8 篇（两阶段，取代程序 top-8） */
export const MIN_DEEP_READ = 5
export const MAX_DEEP_READ = 8
/** D102：文献耦合信号阈值——共享参考文献 ≥ 1 篇即计（交集非空即耦合） */
export const COUPLING_MIN_SHARED = 1

// LLM 输出的类型是中文标签（探针同口径）；映射到结构化 key（D84）
const LLM_TYPE_TO_KEY: Record<string, RelationType> = {
  '基于/改进': 'based_on',
  '具体实现': 'implements',
  '对比': 'compares'
}
const ALLOWED_LLM_TYPES = new Set(Object.keys(LLM_TYPE_TO_KEY))

// ── LLM 输出解析（容错：截断 mid-JSON 时尽力捞出完整的数组元素）────────────────

export interface RelationDraft {
  src: string
  dst: string
  types: string[]
  statement: string
}

/** 完整 JSON 优先；失败则按大括号深度从 relations 数组里捞完整元素（截断续跑） */
export function parseRelationsJson(text: string): { relations: RelationDraft[]; done: boolean } {
  const obj = extractJsonObject(text)
  if (obj) {
    const relations = normalizeDrafts((obj as { relations?: unknown }).relations)
    if (relations.length > 0) return { relations, done: (obj as { done?: unknown }).done === true }
  }
  // 兜底：正则捞完整的单条对象（{"src":"P01",...}）
  const relations: RelationDraft[] = []
  const re = /\{[^{}]*"src"\s*:\s*"[^"]*"[^{}]*\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const one = extractJsonObject(m[0])
    if (one) relations.push(...normalizeDrafts([one]))
  }
  return { relations, done: false }
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>
        } catch {
          return null
        }
      }
    }
  }
  return null
}

function normalizeDrafts(raw: unknown): RelationDraft[] {
  if (!Array.isArray(raw)) return []
  const out: RelationDraft[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item == null) continue
    const o = item as Record<string, unknown>
    if (typeof o.src !== 'string' || typeof o.dst !== 'string' || typeof o.statement !== 'string') continue
    const types = Array.isArray(o.types) ? o.types.filter((t): t is string => typeof t === 'string') : []
    out.push({ src: o.src, dst: o.dst, types, statement: o.statement })
  }
  return out
}

// ── 写入（短 id 校验 / 自动类型附加 / 幂等 upsert）────────────────────────────

export interface WriteStats {
  written: number
  invalid: number
  autoAttached: number
  /** D104：因同对已有 session（手动/会话）边而跳过的 LLM 输出（session 边绝不覆盖） */
  skippedSession: number
}

/** 校验并写入一批草稿；invalid 计数校验错误（D86：作为结果返回，不中断）。
 * D104：同对已有 source_type='session' 的活边时跳过自动写入（保留 session 边原样，
 * 含 auto_types——自动类型只加在 LLM 建的边上，D89）；writtenIdPairs（可选）收集
 * 本次实际写入的无序对（paper_low\u0000paper_high），供 regenerate 删陈旧 job 边。 */
export function writeRelationDrafts(
  db: Database.Database,
  graphId: number,
  drafts: RelationDraft[],
  shortToId: Map<string, number>,
  provenance: { sourceJobId?: number | null; model?: string | null; promptVersion?: string | null },
  writtenIdPairs?: Set<string>
): WriteStats {
  const stats: WriteStats = { written: 0, invalid: 0, autoAttached: 0, skippedSession: 0 }
  for (const d of drafts) {
    const srcId = shortToId.get(d.src)
    const dstId = shortToId.get(d.dst)
    if (srcId == null || dstId == null || srcId === dstId) {
      stats.invalid++ // 短 id 不属于本图谱 / 自环（D86）
      continue
    }
    const typeKeys = [...new Set(d.types)]
    if (typeKeys.length === 0 || typeKeys.some((t) => !ALLOWED_LLM_TYPES.has(t))) {
      stats.invalid++ // 类型必填且只能是 LLM 三种（引用/同一作者程序附加，D89）
      continue
    }
    const statement = d.statement.trim()
    if (!statement) {
      stats.invalid++
      continue
    }
    // D104：同对已有 session（手动 / 会话）边 → 保留原边，LLM 输出只计 stats
    const low = Math.min(srcId, dstId)
    const high = Math.max(srcId, dstId)
    const existing = db
      .prepare('SELECT source_type FROM relations WHERE graph_id = ? AND paper_low = ? AND paper_high = ? AND deleted_at IS NULL')
      .get(graphId, low, high) as { source_type: string } | undefined
    if (existing?.source_type === 'session') {
      stats.skippedSession++
      continue
    }
    const llmTypes = typeKeys.map((t) => LLM_TYPE_TO_KEY[t]).filter(isRelationType)

    // 自动类型 + 引用推定方向（D89/D93）；只在 LLM 建的边上附加
    const auto = computeAutoTypes(db, graphId, srcId, dstId)
    // uat2b D150 后处理兜底①：陈述里禁止 P01/NEW/#25 内部编号——
    // 换成《短标题》（无标题则作者+年份）；查不到则剔除。替换后整句为空则丢弃（invalid）。
    // P/NEW 走本批 shortToId（含 NEW）；#N 走库内论文 id，再活关系，再任意未删论文。
    const paperCache = new Map<number, { title: string; firstAuthor: string | null; year: number | null } | null>()
    const cite = (pid: number): string | null => {
      if (!paperCache.has(pid)) {
        const row = db.prepare('SELECT title, first_author, year FROM papers WHERE id = ?').get(pid) as
          | { title: string; first_author: string | null; year: number | null }
          | undefined
        paperCache.set(pid, row ? { title: row.title, firstAuthor: row.first_author, year: row.year } : null)
      }
      const paper = paperCache.get(pid)
      return paper ? citePaper(paper) : null
    }
    const cleanedStatement = replaceInternalRefTokens(statement, (token) => {
      if (token.startsWith('#')) {
        const id = Number(token.slice(1))
        if (!Number.isInteger(id)) return null
        return resolveStoredIdToken(db, graphId, id, cite)
      }
      const pid = shortToId.get(token)
      return pid != null ? cite(pid) : null
    })
    if (!cleanedStatement) {
      stats.invalid++ // 替换后整句为空（如全是查不到的编号）——不写空陈述的边
      continue
    }
    // uat2b D150 后处理兜底②：「基于/改进」无引用依据（两篇之间无 cites）→ 保留类型、置标记
    const noRefBasis = llmTypes.includes('based_on') && !auto.autoTypes.includes('cites')
    const relationId = upsertRelation(db, {
      graphId,
      srcPaperId: auto.srcPaperId,
      dstPaperId: auto.dstPaperId,
      statement: cleanedStatement,
      llmTypes,
      ...(auto.autoTypes.length > 0 ? { autoTypes: auto.autoTypes } : {}), // 不传则保留库中原值
      sourceType: 'job',
      sourceJobId: provenance.sourceJobId ?? null,
      model: provenance.model ?? null,
      promptVersion: provenance.promptVersion ?? null,
      noRefBasis
    })
    void relationId
    writtenIdPairs?.add(`${low}\u0000${high}`)
    stats.written++
    if (auto.autoTypes.length > 0) stats.autoAttached++
  }
  return stats
}

// ── LLM 批循环（截断续跑）──────────────────────────────────────────────────────

interface BatchOutcome {
  stats: WriteStats
  done: boolean
  truncated: boolean
  /** 迭代保险丝耗尽（跑了 maxIterations 轮还没写完）：上游必须视为未完成 */
  fuseExhausted: boolean
}

async function runRelationBatches(
  deps: GenDeps,
  graphId: number,
  system: string,
  promptVersion: string,
  corpus: string,
  shortToId: Map<string, number>,
  sourceJobId: number | null,
  writtenPairs: Set<string>,
  writtenIdPairs?: Set<string>
): Promise<{ outcome: BatchOutcome; llmCalls: number }> {
  const db = deps.db
  const now = (): Date => deps.now?.() ?? new Date()
  const maxOutputTokens = deps.limits?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  const maxIterations = deps.limits?.maxIterations ?? DEFAULT_MAX_ITERATIONS
  const stats: WriteStats = { written: 0, invalid: 0, autoAttached: 0, skippedSession: 0 }
  let llmCalls = 0
  let truncated = false

  for (let iter = 0; iter < maxIterations; iter++) {
    const llm = deps.llm()
    const suffix =
      writtenPairs.size > 0
        ? `${RELATION_GEN_CONTINUE_SUFFIX}\n\n已写入（不要重复）：\n${[...writtenPairs].join('\n')}`
        : ''
    const r = await streamChat(
      { ...llm, maxOutputTokens },
      [
        { role: 'system', content: system },
        { role: 'user', content: `${corpus}${suffix}\n\n本条最多输出 ${RELATIONS_PER_CALL} 条。` }
      ],
      deps.onDelta
    )
    llmCalls++
    recordUsage(db, { category: 'relation', model: llm.model, usage: r.usage, at: now(), thinking: true })
    truncated = r.truncated

    const parsed = parseRelationsJson(r.text)
    const batch = writeRelationDrafts(db, graphId, parsed.relations.slice(0, RELATIONS_PER_CALL), shortToId, {
      sourceJobId,
      model: llm.model,
      promptVersion
    }, writtenIdPairs)
    stats.written += batch.written
    stats.invalid += batch.invalid
    stats.autoAttached += batch.autoAttached
    stats.skippedSession += batch.skippedSession
    for (const d of parsed.relations.slice(0, RELATIONS_PER_CALL)) {
      if (shortToId.has(d.src) && shortToId.has(d.dst) && d.src !== d.dst) {
        writtenPairs.add([d.src, d.dst].sort().join('\u0000'))
      }
    }

    // D86：写完（done 且未截断）或这轮没写出任何有效关系 → 收尾
    if ((parsed.done && !r.truncated) || batch.written === 0) {
      return { outcome: { stats, done: parsed.done, truncated, fuseExhausted: false }, llmCalls }
    }
  }
  return { outcome: { stats, done: false, truncated, fuseExhausted: true }, llmCalls }
}

/** 评审建议 6：保险丝耗尽 = 没跑完。抛可重试错误，让调度器重跑本步骤，
 * 绝不让上层把全部论文标成「已处理」（D86 的只补漏会无漏可补）。 */
function throwIfFuseExhausted(outcome: BatchOutcome): void {
  if (outcome.fuseExhausted) {
    throw new RetryableLlmError('关系生成迭代保险丝耗尽（输出未完成），请重试')
  }
}

// ── 首次建图（整图生成）───────────────────────────────────────────────────────

/**
 * D104（重新生成关系）：整图重建成功后，软删本图「本次没有再生成的旧 job 边」——
 * 只动 source_type='job' 且无序对不在本次写入集合里的活边；session（手动/会话）边
 * 绝不删除。只在 generateForGraph 正常返回后调用（保险丝耗尽抛错的路径不删）。
 * 返回删除条数。
 */
export function deleteStaleJobEdges(
  db: Database.Database,
  graphId: number,
  writtenIdPairs: Set<string>,
  now = new Date().toISOString()
): number {
  const rows = db
    .prepare(
      `SELECT id, paper_low, paper_high FROM relations
       WHERE graph_id = ? AND source_type = 'job' AND deleted_at IS NULL`
    )
    .all(graphId) as Array<{ id: number; paper_low: number; paper_high: number }>
  let deleted = 0
  for (const r of rows) {
    if (writtenIdPairs.has(`${r.paper_low}\u0000${r.paper_high}`)) continue
    deleteRelation(db, r.id, now)
    deleted++
  }
  return deleted
}

export async function generateForGraph(
  deps: GenDeps,
  graphId: number,
  sourceJobId: number | null = null,
  opts: { force?: boolean; replaceStaleJobEdges?: boolean } = {}
): Promise<GenResult> {
  const db = deps.db
  const maxContextTokens = deps.limits?.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS
  const maxPapers = deps.limits?.maxPapers ?? DEFAULT_MAX_PAPERS

  const all = loadGraphPapers(db, graphId)
  const processed = processedPaperIds(db, graphId)
  // D62/D67/D85：有 PDF、未删除、有详情的论文才参与；默认跳过已处理的（D86）
  let participants = all.filter((p) => p.detailText != null)
  if (!opts.force) participants = participants.filter((p) => !processed.has(p.id))
  if (participants.length === 0) {
    return { strategy: 'details', written: 0, invalid: 0, autoAttached: 0, llmCalls: 0, truncated: false }
  }

  const corpusTokens = participants.reduce((sum, p) => sum + estimateTokens(p.detailText!), 0)
  const overLimit = corpusTokens > maxContextTokens || participants.length > maxPapers
  // D104：regenerate 收集本次实际写入的无序对，成功后删未重写旧 job 边
  const writtenIdPairs = new Set<string>()

  if (!overLimit) {
    // D87：全部详情为主要依据
    const { shortToId, idToShort } = buildShortIds(participants)
    const corpus = buildCorpus(participants, idToShort, 'detail')
    const { outcome, llmCalls } = await runRelationBatches(
      deps,
      graphId,
      RELATION_GEN_PROMPT.system,
      RELATION_GEN_PROMPT.version,
      corpus,
      shortToId,
      sourceJobId,
      new Set(),
      writtenIdPairs
    )
    throwIfFuseExhausted(outcome) // 没跑完不标记已处理，重试整步（也不删旧边）
    if (opts.replaceStaleJobEdges) deleteStaleJobEdges(db, graphId, writtenIdPairs)
    const now = deps.now?.() ?? new Date()
    for (const p of participants) markPaperProcessed(db, graphId, p.id, now.toISOString())
    return { strategy: 'details', llmCalls, truncated: outcome.truncated, ...outcome.stats }
  }

  // D86 超限：名片打底（一次 LLM 全量名片），再逐篇走新增论文流程
  const { shortToId, idToShort } = buildShortIds(participants)
  const cardCorpus = buildCorpus(participants, idToShort, 'card')
  const cardsRound = await runRelationBatches(
    deps,
    graphId,
    RELATION_GEN_PROMPT.system,
    RELATION_GEN_PROMPT.version,
    cardCorpus,
    shortToId,
    sourceJobId,
    new Set(),
    writtenIdPairs
  )
  const total: GenResult = {
    strategy: 'cards_then_per_paper',
    written: cardsRound.outcome.stats.written,
    invalid: cardsRound.outcome.stats.invalid,
    autoAttached: cardsRound.outcome.stats.autoAttached,
    llmCalls: cardsRound.llmCalls,
    truncated: cardsRound.outcome.truncated
  }
  throwIfFuseExhausted(cardsRound.outcome) // 名片层没跑完不逐篇、不标记已处理
  for (const p of participants) {
    const one = await generateForPaper(deps, graphId, p.id, sourceJobId, writtenIdPairs)
    total.written += one.written
    total.invalid += one.invalid
    total.autoAttached += one.autoAttached
    total.llmCalls += one.llmCalls
    total.truncated = total.truncated || one.truncated
  }
  if (opts.replaceStaleJobEdges) deleteStaleJobEdges(db, graphId, writtenIdPairs)
  return total
}

function buildCorpus(participants: GraphPaper[], idToShort: Map<number, string>, level: 'detail' | 'card'): string {
  return participants
    .map((p) => {
      const short = idToShort.get(p.id)!
      const body = level === 'detail' ? detailText(p) : cardText(p)
      return `===== ${short}《${p.title}》 =====\n${body}`
    })
    .join('\n\n')
}

// ── 三路信号候选（D40；findRelatedPapers 为 RAG 预留接口，D41）────────────────

export type RelatedSignalKey = 'cites' | 'coupling' | 'keywords' | 'cards'

export interface RelatedCandidate {
  paperId: number
  title: string
  signals: RelatedSignalKey[]
  /** D102：文献耦合的共享参考文献数（< COUPLING_MIN_SHARED 时为 0） */
  couplingCount: number
}

export function findRelatedPapers(
  db: Database.Database,
  graphId: number,
  paperId: number,
  limit = 20
): RelatedCandidate[] {
  const members = new Map(
    (
      db
        .prepare(
          `SELECT p.id, p.title FROM graph_members m JOIN papers p ON p.id = m.paper_id
           WHERE m.graph_id = ? AND p.deleted_at IS NULL AND p.has_pdf = 1 AND p.id != ?`
        )
        .all(graphId, paperId) as Array<{ id: number; title: string }>
    ).map((r) => [r.id, r.title])
  )
  const signals = new Map<number, Set<RelatedSignalKey>>()
  const add = (pid: number, s: RelatedSignalKey): void => {
    if (!members.has(pid)) return
    if (!signals.has(pid)) signals.set(pid, new Set())
    signals.get(pid)!.add(s)
  }

  // (a) 引用：双向——别人引了它（matched_paper_id = paperId）+ 它引了别人
  const citing = db
    .prepare(
      `SELECT DISTINCT paper_id FROM paper_references
       WHERE matched_paper_id = ? AND paper_id IN (SELECT paper_id FROM graph_members WHERE graph_id = ?)`
    )
    .all(paperId, graphId) as Array<{ paper_id: number }>
  for (const r of citing) add(r.paper_id, 'cites')
  const cited = db
    .prepare(
      `SELECT matched_paper_id AS pid FROM paper_references
       WHERE paper_id = ? AND matched_paper_id IN (SELECT paper_id FROM graph_members WHERE graph_id = ?)`
    )
    .all(paperId, graphId) as Array<{ pid: number }>
  for (const r of cited) add(r.pid, 'cites')

  // D102 文献耦合：本篇与候选各自 matched_paper_id 集合的交集大小。
  // 口径：只算成功匹配到库内论文的参考文献（matched_paper_id 非空；openalex 与
  // deepseek 两个 source 都计入）；交集 ≥ COUPLING_MIN_SHARED（1）即计耦合信号——
  // 它是 D40(a) 引用关系一路的信号，不是独立关系类型（MVP 关系类型仍只有
  // LLM 三种 + 程序自动 引用/同一作者，D84/D89）。归一化取 Salton cosine
  // shared/√(|A|·|B|)，只用于同档信号内的排序（|A| 本篇、|B| 候选的匹配引用数），
  // 不进候选视图；无参考文献的论文交集为空、不报错。
  const couplingRows = db
    .prepare(
      `SELECT r2.paper_id AS pid,
              COUNT(DISTINCT r2.matched_paper_id) AS shared,
              (SELECT COUNT(DISTINCT matched_paper_id) FROM paper_references WHERE paper_id = r2.paper_id) AS other
       FROM paper_references r2
       JOIN paper_references r1
         ON r1.paper_id = ? AND r1.matched_paper_id = r2.matched_paper_id
       WHERE r2.paper_id IN (SELECT paper_id FROM graph_members WHERE graph_id = ? AND paper_id != ?)
       GROUP BY r2.paper_id
       HAVING COUNT(DISTINCT r2.matched_paper_id) >= ?`
    )
    .all(paperId, graphId, paperId, COUPLING_MIN_SHARED) as Array<{ pid: number; shared: number; other: number }>
  const ownCount =
    (
      db.prepare('SELECT COUNT(DISTINCT matched_paper_id) AS n FROM paper_references WHERE paper_id = ?').get(paperId) as {
        n: number
      }
    ).n ?? 0
  // Salton cosine：shared / √(|A|·|B|)，同档排序用
  const couplingScore = new Map<number, number>(
    couplingRows.map((r) => [r.pid, ownCount > 0 && r.other > 0 ? r.shared / Math.sqrt(ownCount * r.other) : 0])
  )
  const couplingCount = new Map<number, number>(couplingRows.map((r) => [r.pid, r.shared]))
  for (const r of couplingRows) add(r.pid, 'coupling')

  // (b) 关键词：本篇关键词逐个 FTS5 检索，命中图谱内论文
  const keywords = db.prepare('SELECT keyword FROM paper_keywords WHERE paper_id = ?').all(paperId) as Array<{
    keyword: string
  }>
  for (const { keyword } of keywords) {
    for (const hit of searchPapers(db, keyword, 20)) add(hit.paper_id, 'keywords')
  }

  // (c) 名片全量：图谱内其他有 PDF 的论文都作为候选（D40(c)/D47）
  for (const pid of members.keys()) add(pid, 'cards')

  // 排序：取最强信号档位（评审建议修（rel3）4：原加权和让 cites-only 与
  // coupling+keywords 同分，Salton 可能把「耦合+关键词」排到「仅直接引用」前）：
  // 直接引用 > 文献耦合 > 关键词 > 名片全量（D40 信号强度档位）；同档按耦合
  // Salton cosine 降序，再按 id 升序
  const rank = (s: Set<RelatedSignalKey>): number =>
    Math.min(s.has('cites') ? 0 : 9, s.has('coupling') ? 1 : 9, s.has('keywords') ? 2 : 9, 3)
  return [...signals.entries()]
    .map(([pid, s]) => ({ paperId: pid, title: members.get(pid)!, signals: [...s], couplingCount: couplingCount.get(pid) ?? 0 }))
    .sort((a, b) => {
      const diff = rank(new Set(a.signals)) - rank(new Set(b.signals))
      if (diff !== 0) return diff
      const cs = (couplingScore.get(b.paperId) ?? 0) - (couplingScore.get(a.paperId) ?? 0)
      if (cs !== 0) return cs
      return a.paperId - b.paperId
    })
    .slice(0, limit)
}

/** 第一阶段输出解析：{"candidates":["P01",…]}，容错同 parseRelationsJson（捞完整 JSON 对象） */
export function parseCandidateIdsJson(text: string): string[] {
  const obj = extractJsonObject(text)
  const raw = obj ? (obj as { candidates?: unknown }).candidates : null
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === 'string')
}

// ── 新论文：与已有节点的关系（D40 信号候选 → D103 两阶段挑 5–8 篇深读 → 写关系）────

/**
 * D103 第一阶段：LLM 根据信号（标题/摘要/引用/文献耦合/关键词）从候选中挑 5–8 篇
 * 精读。口径：
 * - 有资格深读的候选 = 候选本身有详情（没详情深读无意义；名片层仍全量给 LLM）；
 * - 候选数 ≤ MAX_DEEP_READ（小图）：全选深读，跳过第一阶段（0 次 LLM 调用）；
 * - 容错：越界短 id 丢弃、重复去重、> 8 截到 8、< 5 按 LLM 选的收（宁缺毋滥）；
 *   一个有效 id 都没有（空输出/截断/全是越界 id）→ 降级为信号排序 top 8（原程序
 *   口径，不报错、不烧重试）；
 * - LLM 错误不改分类：Retryable / BadRequest 等直接上抛，由引擎按现有口径处理；
 * - 调用按 D92 开 thinking + 流式、按 D100 给满输出、按 D96 实时记账一次。
 */
async function selectDeepReadCandidates(
  deps: GenDeps,
  newPaper: GraphPaper,
  candidates: RelatedCandidate[],
  byId: Map<number, GraphPaper>,
  shortOf: (pid: number) => string,
  shortToId: Map<string, number>
): Promise<{ deepIds: Set<number>; llmCalls: number }> {
  const eligible = candidates.filter((c) => byId.get(c.paperId)?.detailText != null)
  if (eligible.length <= MAX_DEEP_READ) {
    return { deepIds: new Set(eligible.map((c) => c.paperId)), llmCalls: 0 }
  }

  const llm = deps.llm()
  const maxOutputTokens = deps.limits?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  const lines = eligible.map((c) => {
    const p = byId.get(c.paperId)!
    const sig = c.signals
      .map((s) => (s === 'coupling' ? `文献耦合(共享 ${c.couplingCount} 篇参考文献)` : s))
      .join('/')
    return `- ${shortOf(c.paperId)}《${c.title}》 信号：${sig}\n  ${cardText(p).replace(/\n/g, ' ')}`
  })
  const user = [
    `新加入的论文 NEW：《${newPaper.title}》`,
    cardText(newPaper),
    `候选列表（共 ${eligible.length} 篇有资格深读的候选）：`,
    ...lines
  ].join('\n')
  const r = await streamChat(
    { ...llm, maxOutputTokens },
    [
      { role: 'system', content: CANDIDATE_SELECT_PROMPT.system },
      { role: 'user', content: user }
    ],
    deps.onDelta
  )
  recordUsage(deps.db, { category: 'relation', model: llm.model, usage: r.usage, at: deps.now?.() ?? new Date(), thinking: true })

  const eligibleShorts = new Set(eligible.map((c) => shortOf(c.paperId)))
  const picked: number[] = []
  for (const short of parseCandidateIdsJson(r.text)) {
    const pid = shortToId.get(short)
    if (pid == null || !eligibleShorts.has(short) || picked.includes(pid)) continue // 越界 / 重复丢弃
    picked.push(pid)
    if (picked.length >= MAX_DEEP_READ) break // 超出截到 8
  }
  if (picked.length === 0) {
    // 降级：信号排序前 8（eligible 已按信号强度排序）
    return { deepIds: new Set(eligible.slice(0, MAX_DEEP_READ).map((c) => c.paperId)), llmCalls: 1 }
  }
  return { deepIds: new Set(picked), llmCalls: 1 }
}

export async function generateForPaper(
  deps: GenDeps,
  graphId: number,
  paperId: number,
  sourceJobId: number | null = null,
  writtenIdPairs?: Set<string>
): Promise<GenResult> {
  const db = deps.db
  const newPaper = loadGraphPapers(db, graphId).find((p) => p.id === paperId)
  if (!newPaper || newPaper.detailText == null) {
    throw new Error(`论文 ${paperId} 不在图谱中、没有 PDF 或还没有详情，不参与关系生成（D62/D67）`)
  }

  // 参与者：图谱内其他有详情的论文（用于名片层）；新论文固定短 id NEW
  // （评审建议 7：P99 在 ≥99 篇图内与真实论文编号撞车）
  const others = loadGraphPapers(db, graphId).filter((p) => p.id !== paperId && p.detailText != null)
  const { idToShort } = buildShortIds(others)
  const shortToId = new Map<string, number>([...idToShort.entries()].map(([id, s]) => [s, id]))
  shortToId.set(NEW_PAPER_SHORT_ID, paperId)
  const shortOf = (pid: number): string => (pid === paperId ? NEW_PAPER_SHORT_ID : idToShort.get(pid) ?? `?${pid}`)

  // 候选：三路信号 + 文献耦合（D40/D102）；D103 两阶段——LLM 挑 5–8 篇深读（取代程序 top-8）
  const candidates = findRelatedPapers(db, graphId, paperId, 20)
  const byId = new Map(loadGraphPapers(db, graphId).map((p) => [p.id, p]))
  const { deepIds, llmCalls: selectCalls } = await selectDeepReadCandidates(
    deps,
    newPaper,
    candidates,
    byId,
    shortOf,
    shortToId
  )

  const corpusParts: string[] = [
    `===== ${NEW_PAPER_SHORT_ID}《${newPaper.title}》（新加入的论文，全文详情如下） =====\n${detailText(newPaper)}`
  ]
  for (const c of candidates) {
    const p = byId.get(c.paperId)
    if (!p) continue
    const tag = deepIds.has(c.paperId)
      ? `候选（信号：${c.signals.join('/')}，已附详情）`
      : `候选（信号：${c.signals.join('/')}，仅名片）`
    corpusParts.push(
      `===== ${shortOf(c.paperId)}《${c.title}》 ${tag} =====\n${deepIds.has(c.paperId) ? detailText(p) : cardText(p)}`
    )
  }
  const corpus = corpusParts.join('\n\n')

  const writtenPairs = new Set<string>()
  const { outcome, llmCalls } = await runRelationBatches(
    deps,
    graphId,
    NEW_PAPER_RELATION_PROMPT.system,
    NEW_PAPER_RELATION_PROMPT.version,
    corpus,
    shortToId,
    sourceJobId,
    writtenPairs,
    writtenIdPairs
  )
  throwIfFuseExhausted(outcome) // 没跑完不标记已处理，重试整步
  const now = deps.now?.() ?? new Date()
  markPaperProcessed(db, graphId, paperId, now.toISOString())
  return { strategy: 'details', llmCalls: selectCalls + llmCalls, truncated: outcome.truncated, ...outcome.stats }
}
