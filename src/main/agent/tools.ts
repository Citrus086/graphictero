import { existsSync, readFileSync } from 'node:fs'
import { tool } from 'ai'
import { z } from 'zod'
import type Database from 'better-sqlite3'
import { searchPapers } from '../db/fts'
import { createOpenAlexClient, type OpenAlexClient } from '../openalex/client'
import { readOpenAlexSettings } from '../openalex/env'
import { bumpOpenAlexDailyCount, searchPapersService } from '../openalex/search'
import { readApiKey } from '../llm/config'
import { recordWebCall } from '../llm/usage'
import { webFetchPage, webSearch as runWebSearch, type WebClientDeps } from '../web/client'
import { AuthLlmError, BadRequestLlmError, NetworkLlmError, RetryableLlmError } from '../llm/errors'
import { deleteRelation, upsertRelation, type RelationType } from '../db/relations'
import { computeAutoTypes } from '../relations/autoTypes'
import { graphMemberIds } from '../relations/membership'
import { listFigures } from '../reader/figures'
import { relationTypeLabel, relationTypeFromInput, RELATION_TYPE_LABELS } from '../../shared/relationTypes'
import { AGENT_SELECTABLE_RELATION_TYPES } from '../llm/prompts'
import { normalizeArxiv, proposeCandidate } from './candidates'
import { fullMarkdownToc, locateInFullText, readFullSection } from './paperFulltext'
import { searchFullText } from '../db/fulltextFts'
import { stripInlineImages } from '../text/stripInlineImages'
import { mineruMarkdownPath } from '../jobs/processPaper'
import { normalizeDoi } from '../zotero/ids'
import type { PaperHit } from '../../shared/ipc/agent'
import { snapshotRelation } from '../relations/snapshots'
import { buildGraphShortIdReplacer } from '../text/graphShortIds'
import { resolveFigureByNo } from '../../shared/ipc/pdf'
import { displayCandidateReason } from '../../shared/candidateReason'
import type { PaperCardPart } from '../../shared/parts'

/**
 * M5 lane/agent：Agent 工具集（设计文档 6.7；批 1 先实装本地 6 个读写工具）。
 *
 * - 只调用既有导出服务（db/fts、db/relations、relations/context、relations/autoTypes、
 *   reader/figures），不改那些文件；
 * - 读类工具每次读取落一行 session_traces（D8）并经 emitTrace 推给渲染层；
 * - 参数校验错误不抛给模型循环，作为工具结果里的 error 字段返回（D86）；
 * - 改图工具（addRelation / deleteRelation）直接生效、source='session'（D16），
 *   「引用 / 同一作者」自动类型仍由程序附加（D89：computeAutoTypes）；改动经
 *   onGraphChange 汇总成 data-graph-change part（改图小结，D30/6.5）；
 * - M6 第 0 批（2a/B1–B3，main）：新增 listRelations（B1）；类型入参中英都收、
 *   结果只出中文类型名（B7）；
 * - D143（M5 开放问题 2）：addRelation 命中既有边 = 拒绝（不写库、不存快照、不发
 *   小结；返回既有边 relationId/类型/方向/陈述/来源 + 中文说明，引导显式
 *   updateRelation/deleteRelation）；新增 updateRelation——唯一显式修改通道
 *   （同事务先写 relation_snapshots 快照、可撤销含原 source_type、改图小结标「修改」，
 *   引用推定方向不隐式翻转，仅显式 srcPaperId 改方向）；AGENT_TOOL_NAMES 13→14。
 * - 同一步多个工具调用并行由 AI SDK 默认并发执行（D66）。
 *
 * recallHistory（D28，批 2）与 proposeCandidate（批 3，写候选 + data-paper-card
 * part）已实装。searchPapers 走 OpenAlex；webSearch / webFetch 走 DeepSeek
 * Search/Fetch（D125，非空成功才记 category web）。searchImages 仍是后续版本
 * 占位（D128），不发网络请求。
 */

export interface ToolContext {
  db: Database.Database
  dataDir: string
  sessionId: number
  graphId: number
  /** M6 前置 2a（D129）：本回合 id——改动前快照绑 turn，跨回合守卫用 */
  turnId: string
  /** 本回合模型名（写关系 provenance 用） */
  model: string
  promptVersion: string
  /** D8：读类工具落 trace 并推事件（runtime 注入，含节流合批） */
  emitTrace: (t: { toolName: string; paperId?: number | null; summary: string; excerpt?: string }) => void
  /** 改图小结汇总（runtime 在回合末拼 data-graph-change part；updateRelation/deleteRelation 带 snapshotIds，D129/D143） */
  onGraphChange: (c: {
    changeType: 'addRelation' | 'updateRelation' | 'deleteRelation'
    relationIds: number[]
    paperIds: number[]
    summary: string
    snapshotIds?: number[]
  }) => void
  /** 候选卡片产出（runtime 在回合末拼 data-paper-card part，D32） */
  onPaperCard: (card: PaperCardPart) => void
  /**
   * 候选落库后广播 event:agent:candidates（合并批 e2e 发现：proposeCandidate 只写库
   * 不广播，画布虚线节点/图例要等重载才出现——mock 自己发事件所以 smoke 测不出；
   * 由 runtime 注入，IPC 层组装载荷，测试可不传）
   */
  emitCandidates?: () => void
  /** M6 lane/fetch 批 1：searchPapers 的 OpenAlex 客户端（测试注入假客户端；生产
   *  缺省按数据目录环境文件现建，baseUrl 走 GRAPHICTERO_OPENALEX_BASE_URL 缝） */
  openAlex?: OpenAlexClient
  /** webSearch / webFetch。测试注入，避免读 Key 或打到真实服务 */
  web?: WebClientDeps
}

const LLM_SELECTABLE_TYPES: readonly string[] = AGENT_SELECTABLE_RELATION_TYPES

function err(message: string): { error: string } {
  return { error: message }
}

/** 截断时不切在拉丁词中间；中文（无空白）仍按字数切，并补省略号。 */
export function clipWords(s: string, max: number): string {
  const t = s.trim()
  if (t.length <= max) return t
  let cut = t.slice(0, max)
  const next = t[max] ?? ''
  const last = cut[cut.length - 1] ?? ''
  if (/[A-Za-z0-9]/.test(last) && /[A-Za-z0-9]/.test(next)) {
    const m = /[A-Za-z0-9][A-Za-z0-9'’._-]*$/.exec(cut)
    if (m && m.index > 0) cut = cut.slice(0, m.index)
  }
  return `${cut.trimEnd()}…`
}

/** B1/B2：图内论文短 id（P01…，按成员入序），工具结果与指针同一口径。 */
function shortPaperIds(db: Database.Database, graphId: number): Map<number, string> {
  const rows = db
    .prepare(
      `SELECT p.id FROM graph_members m JOIN papers p ON p.id = m.paper_id
       WHERE m.graph_id = ? AND p.deleted_at IS NULL ORDER BY p.id`
    )
    .all(graphId) as Array<{ id: number }>
  return new Map(rows.map((r, i) => [r.id, `P${String(i + 1).padStart(2, '0')}`]))
}

interface LiveRelationRow {
  id: number
  paper_low: number
  paper_high: number
  src_paper: number
  statement_text: string
  llm_types: string
  auto_types: string
  source_type: string
}

function findLiveRelation(db: Database.Database, graphId: number, a: number, b: number): LiveRelationRow | undefined {
  return db
    .prepare(
      `SELECT id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types, source_type
       FROM relations WHERE graph_id = ? AND paper_low = ? AND paper_high = ? AND deleted_at IS NULL`
    )
    .get(graphId, Math.min(a, b), Math.max(a, b)) as LiveRelationRow | undefined
}

const RELATION_SOURCE_LABELS: Record<string, string> = { job: '自动生成', session: '会话或手动' }

function paperExistsInGraph(db: Database.Database, graphId: number, paperId: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM graph_members m JOIN papers p ON p.id = m.paper_id
         WHERE m.graph_id = ? AND m.paper_id = ? AND p.deleted_at IS NULL`
      )
      .get(graphId, paperId) != null
  )
}

/** readPaper 单次返回的字符上限（评审建议修 7：长节按 offset 分段读取，不一次全量回模型）。 */
export const READ_PAPER_MAX_CHARS = 20_000

/**
 * 读 MinerU 原文 full.md；缺失返回 null（调用方给结构化说明，不回退详情解读，D68）。
 * uat5 必须修 1（D141）：full.md 约九成是内嵌 base64 图片，送给模型前过
 * stripInlineImages（占位 [图：alt]）——磁盘 full.md 保持原样（阅读器要用 data URI）。
 */
function readFullMarkdown(dataDir: string, paperId: number): string | null {
  const p = mineruMarkdownPath(dataDir, paperId)
  if (!existsSync(p)) return null
  try {
    return stripInlineImages(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/** 归档 parts JSON（UIMessage parts）提取纯文本，供 recallHistory 摘要展示。 */
export function extractArchiveText(partsJson: string): string {
  try {
    const parts = JSON.parse(partsJson) as Array<{ type?: string; text?: string }>
    return parts.filter((p) => p.type === 'text' && typeof p.text === 'string').map((p) => p.text!).join('\n')
  } catch {
    return ''
  }
}

const paperCard = z.object({
  paperId: z.number().int().positive(),
  title: z.string(),
  year: z.number().int().nullable(),
  firstAuthor: z.string().nullable(),
  oneLiner: z.string().nullable()
})

export function createAgentTools(ctx: ToolContext) {
  const getPapers = tool({
    description: '列出当前图谱中的全部论文（id、标题、年份、第一作者、一句话摘要）。先用它了解图上有哪些论文，再决定读哪篇。',
    inputSchema: z.object({}),
    execute: async () => {
      const rows = ctx.db
        .prepare(
          `SELECT p.id AS paperId, p.title, p.year, p.first_author AS firstAuthor, p.one_liner AS oneLiner
           FROM graph_members m JOIN papers p ON p.id = m.paper_id
           WHERE m.graph_id = ? AND p.deleted_at IS NULL
           ORDER BY p.id`
        )
        .all(ctx.graphId) as Array<z.infer<typeof paperCard>>
      ctx.emitTrace({ toolName: 'getPapers', summary: `查看图谱论文列表（${rows.length} 篇）` })
      return { papers: rows }
    }
  })

  const readPaper = tool({
    description:
      '读取一篇论文的 MinerU 解析原文（full.md，含公式/表格/图号的原始 Markdown）：标题、年份、摘要 + 原文。' +
      '不传 section 返回原文目录（章节树 + 图号/表号列表，编号按原文）；传 section（章节名或目录序号）返回该节原文，' +
      '长节用 offset 分段续读（返回 hasMore/nextOffset）。出处按原文章节号/表号/图号引用（「§4.2」「表 3」「图 2」），不要重新编号。' +
      '用 getPapers / searchLibrary 拿到 paperId 后再读；searchLibrary 的原文命中会给出章节定位。',
    inputSchema: z.object({
      paperId: z.number().int().positive(),
      /** 章节名（模糊匹配）或目录序号（1 起）；不传 = 只返回目录 */
      section: z.string().min(1).max(200).optional(),
      /** 节内字符偏移：长节续读传上次返回的 nextOffset；首次读不用传 */
      offset: z.number().int().min(0).optional()
    }),
    execute: async ({ paperId, section, offset }) => {
      const p = ctx.db
        .prepare(
          `SELECT id, title, year, abstract, one_liner AS oneLiner, has_pdf AS hasPdf
           FROM papers WHERE id = ? AND deleted_at IS NULL`
        )
        .get(paperId) as
        | { id: number; title: string; year: number | null; abstract: string | null; oneLiner: string | null; hasPdf: number }
        | undefined
      if (!p) return err(`论文 ${paperId} 不存在或已删除`)
      const base = { paperId: p.id, title: p.title, year: p.year, abstract: p.abstract, oneLiner: p.oneLiner, hasPdf: p.hasPdf === 1 }
      // D68：readPaper 读原文（full.md），不回退成详情解读
      const full = readFullMarkdown(ctx.dataDir, paperId)
      if (full == null) {
        ctx.emitTrace({
          toolName: 'readPaper',
          paperId,
          summary: `读《${p.title}》原文：未解析（无 full.md）`,
          excerpt: (p.abstract ?? p.oneLiner ?? '').slice(0, 300)
        })
        return {
          ...base,
          fullText: null,
          note: '原文不可用：这篇论文还没有解析出全文（未解析 / 解析失败 / 解析中）。可以先读上面的摘要与一句话摘要；等解析完成后再按 section 读原文。'
        }
      }
      const toc = fullMarkdownToc(full)
      // 不传章节：返回目录（章节树 + 图号/表号，出处按原文编号）
      if (section == null) {
        ctx.emitTrace({ toolName: 'readPaper', paperId, summary: `查看《${p.title}》原文目录（${toc.sections.length} 节）` })
        return {
          ...base,
          fullText: true,
          toc: {
            sections: toc.sections,
            figures: toc.figures,
            tables: toc.tables
          },
          totalChars: toc.totalChars,
          note: `原文共 ${toc.totalChars} 字。传 section（序号或标题）按节读原文；长节分段续读（offset）。出处按原文章节号/表号/图号引用。`
        }
      }
      const seg = readFullSection(full, section, offset ?? 0, READ_PAPER_MAX_CHARS)
      if (!seg) {
        return err(`《${p.title}》原文没有章节「${section}」（共 ${toc.sections.length} 节，先不传 section 看目录）`)
      }
      ctx.emitTrace({
        toolName: 'readPaper',
        paperId,
        summary: `读《${p.title}》原文 §${seg.title}${seg.hasMore ? `（第 ${seg.offset}–${seg.endOffset} 字，还有下一段）` : ''}`,
        excerpt: seg.text.slice(0, 300)
      })
      return {
        ...base,
        fullText: true,
        section: { index: seg.index, title: seg.title },
        location: `§${seg.title}`, // 原文章节号，回复里可直接引用
        text: seg.text,
        range: [seg.offset, seg.endOffset],
        hasMore: seg.hasMore,
        nextOffset: seg.nextOffset,
        note: seg.hasMore ? `本节还有下文：再调 readPaper（section=${seg.index}、offset=${seg.nextOffset}）继续读` : undefined
      }
    }
  })

  const recallHistory = tool({
    description:
      '回查本会话早期被压缩归档的对话原文（session_archives）与观察日志要点（D28）。' +
      '长会话里早期内容已不在模型上下文中，需要旧细节时用这个工具。可传 query 关键词过滤。',
    inputSchema: z.object({ query: z.string().max(200).optional() }),
    execute: async ({ query }) => {
      const q = query?.trim().toLowerCase()
      const archives = (
        ctx.db.prepare('SELECT id, seq_from, seq_to, parts, created_at FROM session_archives WHERE session_id = ? ORDER BY id DESC LIMIT 20').all(ctx.sessionId) as Array<{ id: number; seq_from: number; seq_to: number; parts: string; created_at: string }>
      )
        .filter((a) => !q || a.parts.toLowerCase().includes(q))
        .slice(0, 10)
        .map((a) => ({
          archiveId: a.id,
          seqFrom: a.seq_from,
          seqTo: a.seq_to,
          createdAt: a.created_at,
          excerpt: extractArchiveText(a.parts).slice(0, 800)
        }))
      const observations = (
        ctx.db.prepare('SELECT content, importance, logged_at FROM session_observations WHERE session_id = ? ORDER BY id DESC LIMIT 20').all(ctx.sessionId) as Array<{ content: string; importance: number; logged_at: string }>
      )
        .filter((o) => !q || o.content.toLowerCase().includes(q))
        .slice(0, 10)
        .map((o) => ({ content: o.content, importance: o.importance, loggedAt: o.logged_at }))
      ctx.emitTrace({ toolName: 'recallHistory', summary: `回查历史（归档 ${archives.length} 段、要点 ${observations.length} 条）${q ? `「${query}」` : ''}` })
      return { archives, observations }
    }
  })

  const searchLibrary = tool({
    description:
      '在论文库里检索（不限当前图谱）：标题/摘要/关键词元数据 + **MinerU 原文全文**（两篇论文的正文细节都能命中）。' +
      '查原文细节先用它定位（原文命中带章节号 + 上下文片段），再用 readPaper 读该节；找库里的相关论文也用它。' +
      '可传 paperId 只看某一篇，或 graphOnly 只搜当前图谱成员。',
    inputSchema: z.object({
      query: z.string().min(1).max(500),
      limit: z.number().int().min(1).max(50).default(10),
      /** 只看某一篇论文的原文/元数据（可选） */
      paperId: z.number().int().positive().optional(),
      /** 只搜当前图谱成员的论文（可选） */
      graphOnly: z.boolean().optional()
    }),
    execute: async ({ query, limit, paperId, graphOnly }) => {
      // 元数据检索（papers_fts：标题/摘要/关键词）
      let metaHits = searchPapers(ctx.db, query, limit * 2)
      // 原文全文检索（papers_text_fts：full.md 正文）
      let fullHits = searchFullText(ctx.db, query, limit * 2)
      if (paperId != null) {
        metaHits = metaHits.filter((h) => h.paper_id === paperId)
        fullHits = fullHits.filter((h) => h.paper_id === paperId)
      }
      if (graphOnly === true) {
        const memberIds = new Set(
          (ctx.db.prepare('SELECT paper_id AS id FROM graph_members WHERE graph_id = ?').all(ctx.graphId) as Array<{ id: number }>).map((r) => r.id)
        )
        metaHits = metaHits.filter((h) => memberIds.has(h.paper_id))
        fullHits = fullHits.filter((h) => memberIds.has(h.paper_id))
      }
      const paperStmt = ctx.db.prepare(
        'SELECT id, title, year, first_author AS firstAuthor FROM papers WHERE id = ? AND deleted_at IS NULL'
      )
      const papers = metaHits
        .map((h) => paperStmt.get(h.paper_id) as { id: number; title: string; year: number | null; firstAuthor: string | null } | undefined)
        .filter((p): p is NonNullable<typeof p> => p != null)
        .slice(0, limit)
        .map((p) => ({ paperId: p.id, title: p.title, year: p.year, firstAuthor: p.firstAuthor }))
      // 原文命中：补章节号 + 上下文片段（位置出处，可直接接 readPaper 定位）
      const fullTextHits: Array<{ paperId: number; title: string; year: number | null; firstAuthor: string | null; section: string | null; snippet: string }> = []
      for (const h of fullHits) {
        if (fullTextHits.length >= Math.min(limit, 5)) break
        const p = paperStmt.get(h.paper_id) as { id: number; title: string; year: number | null; firstAuthor: string | null } | undefined
        if (!p) continue
        const full = readFullMarkdown(ctx.dataDir, h.paper_id)
        if (full == null) continue
        const loc = locateInFullText(full, query)
        fullTextHits.push({ paperId: p.id, title: p.title, year: p.year, firstAuthor: p.firstAuthor, section: loc?.section ?? null, snippet: loc?.snippet ?? '' })
      }
      ctx.emitTrace({
        toolName: 'searchLibrary',
        summary: `检索「${query}」：元数据 ${papers.length} 篇、原文命中 ${fullTextHits.length} 篇`
      })
      return { papers, fullTextHits }
    }
  })

  const getFigure = tool({
    description: '按图号读取一篇论文的插图信息（页码从 1 起，存储的 page_idx 为 0 基；图注）。返回该图的图注与所在页。',
    inputSchema: z.object({
      paperId: z.number().int().positive(),
      figureNo: z.number().int().min(1)
    }),
    execute: async ({ paperId, figureNo }) => {
      const p = ctx.db.prepare('SELECT title FROM papers WHERE id = ? AND deleted_at IS NULL').get(paperId) as
        | { title: string }
        | undefined
      if (!p) return err(`论文 ${paperId} 不存在或已删除`)
      const figures = listFigures(ctx.dataDir, paperId)
      const fig = resolveFigureByNo(figures, figureNo)
      if (!fig) return err(`《${p.title}》没有找到图 ${figureNo}（图注里编号为 ${figureNo} 的图）`)
      ctx.emitTrace({
        toolName: 'getFigure',
        paperId,
        summary: `查看《${p.title}》图 ${figureNo}`,
        excerpt: fig.caption ?? undefined
      })
      return { figureNo, page: fig.page + 1, caption: fig.caption }
    }
  })

  const addRelation = tool({
    description:
      '在当前图谱新增一条关系（立即生效）。srcPaperId → dstPaperId 表示「dst 基于/针对 src」；' +
      `types 用中文类型名（${LLM_SELECTABLE_TYPES.map((t) => RELATION_TYPE_LABELS[t as keyof typeof RELATION_TYPE_LABELS]).join(' / ')}）` +
      `或英文 id（${LLM_SELECTABLE_TYPES.join(' / ')}），cites / same_author 由程序自动附加，不要选。` +
      '同一对论文已有关系时**不会写入**（一对论文只保留一条关系，D89）：工具结果会返回既有边的 ' +
      'relationId、类型、方向与陈述；要修改已有边请用 updateRelation，要删除请用 deleteRelation。' +
      'statement 用一句具体的中文说明这条关系。',
    inputSchema: z.object({
      srcPaperId: z.number().int().positive(),
      dstPaperId: z.number().int().positive(),
      statement: z.string().min(1).max(1000),
      /** B7：中文名与英文 id 都收（在 execute 内统一转 id，校验失败返回中文错误，D86） */
      types: z.array(z.string().min(1).max(50)).min(1).max(3)
    }),
    execute: async ({ srcPaperId, dstPaperId, statement, types }) => {
      if (srcPaperId === dstPaperId) return err('关系不能是自环：两端不能是同一篇论文（D86）')
      if (!paperExistsInGraph(ctx.db, ctx.graphId, srcPaperId)) return err(`论文 ${srcPaperId} 不在当前图谱中`)
      if (!paperExistsInGraph(ctx.db, ctx.graphId, dstPaperId)) return err(`论文 ${dstPaperId} 不在当前图谱中`)
      // B7：类型中英都收，统一转 id；自动附加类型不可手选（D89）
      const llmTypes: RelationType[] = []
      for (const t of types) {
        const id = relationTypeFromInput(t)
        if (!id) {
          return err(
            `未知的关系类型：${t}（可选：${LLM_SELECTABLE_TYPES.map((x) => `${RELATION_TYPE_LABELS[x as keyof typeof RELATION_TYPE_LABELS]}(${x})`).join(' / ')}）`
          )
        }
        if (!LLM_SELECTABLE_TYPES.includes(id)) {
          return err(`「${RELATION_TYPE_LABELS[id]}」由程序自动附加，不能手动选择（D89）`)
        }
        llmTypes.push(id)
      }
      // D89：引用/同一作者自动类型与引用推定方向由程序附加
      const auto = computeAutoTypes(ctx.db, ctx.graphId, srcPaperId, dstPaperId)
      const short = shortPaperIds(ctx.db, ctx.graphId)
      const pairLow = Math.min(auto.srcPaperId, auto.dstPaperId)
      const pairHigh = Math.max(auto.srcPaperId, auto.dstPaperId)
      const existing = findLiveRelation(ctx.db, ctx.graphId, pairLow, pairHigh)
      const stmt = statement.trim()
      const autoZh = relationTypeLabel(auto.autoTypes)

      if (existing) {
        // D143（M5 开放问题 2）：命中既有边 = 拒绝——不覆盖、不翻转方向；不写库、
        // 不存快照、不发小结。返回既有边信息 + 中文说明，引导显式 updateRelation。
        // 模型反向传参（B→A）经 computeAutoTypes 归一到同一对，同样在这里拒绝。
        const dstOf = existing.src_paper === existing.paper_low ? existing.paper_high : existing.paper_low
        const srcS = short.get(existing.src_paper) ?? `P${existing.src_paper}`
        const dstS = short.get(dstOf) ?? `P${dstOf}`
        const direction = `${srcS}→${dstS}`
        const typesZh = relationTypeLabel([
          ...(JSON.parse(existing.llm_types) as RelationType[]),
          ...(JSON.parse(existing.auto_types) as RelationType[])
        ])
        const statementShort = existing.statement_text.slice(0, 300)
        const source = RELATION_SOURCE_LABELS[existing.source_type] ?? existing.source_type
        ctx.emitTrace({ toolName: 'addRelation', summary: `新增关系被拒：${srcS}–${dstS} 已有关系 #${existing.id}（${typesZh}）` })
        return {
          rejected: true,
          reason: 'pair_has_relation',
          existing: { relationId: existing.id, direction, types: typesZh, statement: statementShort, source },
          message:
            `论文 ${srcS} 与 ${dstS} 之间已有关系 #${existing.id}（${direction}，${typesZh}，来源：${source}）：` +
            `「${statementShort}」。一对论文只保留一条关系（D89），addRelation 不会覆盖或翻转它，本次未写入。` +
            // D156：被拒后不自动 updateRelation——除非用户明确要求改这条边，否则先问用户
            `如果用户明确要求修改这条边，请调用 updateRelation（relationId=${existing.id}）；` +
            `否则不要直接修改——在回复里向用户说明这条既有边的类型、方向、陈述与来源，并询问用户是否要修改；` +
            `若要删除，请调用 deleteRelation。`
        }
      }

      const relationId = upsertRelation(ctx.db, {
        graphId: ctx.graphId,
        srcPaperId: auto.srcPaperId,
        dstPaperId: auto.dstPaperId,
        statement: stmt,
        llmTypes,
        ...(auto.autoTypes.length > 0 ? { autoTypes: auto.autoTypes } : {}),
        sourceType: 'session',
        sourceSessionId: ctx.sessionId,
        model: ctx.model,
        promptVersion: ctx.promptVersion
      })
      const autoNote = auto.autoTypes.length > 0 ? `；自动附加类型：${autoZh}` : ''
      ctx.onGraphChange({
        changeType: 'addRelation',
        relationIds: [relationId],
        paperIds: [auto.srcPaperId, auto.dstPaperId],
        summary: `新增关系 #${relationId}：${short.get(auto.srcPaperId) ?? auto.srcPaperId} → ${short.get(auto.dstPaperId) ?? auto.dstPaperId}（${relationTypeLabel(llmTypes)}${autoNote}）：${clipWords(stmt, 120)}`
      })
      return { relationId, autoTypes: autoZh }
    }
  })

  const updateRelation = tool({
    description:
      '修改当前图谱里已有的一条关系（立即生效，改动前自动存快照、可撤销）。' +
      '可改 statement（陈述）、types（类型，中文名或英文 id，同 addRelation 校验）与方向' +
      '（传 srcPaperId = 新的起点论文 id，必须是该边两端之一；不传保持原方向）。' +
      '注意：listRelations 返回的 statement 是展示版（内部编号已换成短标题、截断至 120 字），' +
      '把它原样传进来会被拒绝——改陈述时基于方向与类型自己组织语言，内部编号写法与库内原文一致。' +
      'relationId 用 listRelations 查询，或从 addRelation 拒绝结果里的 existing.relationId 取得。' +
      '同一对论文只保留一条关系（D89）：新建用 addRelation，已有边要改必须用这个工具显式修改。',
    inputSchema: z.object({
      relationId: z.number().int().positive(),
      /** 新陈述；不传保持原陈述 */
      statement: z.string().min(1).max(1000).optional(),
      /** 新类型（中文名或英文 id 都收，校验口径同 addRelation）；不传保持原类型 */
      types: z.array(z.string().min(1).max(50)).min(1).max(3).optional(),
      /** 要改方向时给新的起点论文 id（必须是该边两端之一）；不传保持原方向 */
      srcPaperId: z.number().int().positive().optional()
    }),
    execute: async ({ relationId, statement, types, srcPaperId }) => {
      if (statement == null && types == null && srcPaperId == null) {
        return err('至少提供一项修改：statement（新陈述）、types（新类型）或 srcPaperId（改方向）')
      }
      const rel = ctx.db
        .prepare(
          `SELECT id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types, source_type
           FROM relations WHERE id = ? AND graph_id = ? AND deleted_at IS NULL`
        )
        .get(relationId, ctx.graphId) as LiveRelationRow | undefined
      if (!rel) return err(`关系 ${relationId} 不存在或已删除（须在当前图谱中）`)
      // 类型入参中英都收，校验口径与 addRelation 一致（B7/D86）；不传保持原类型
      let llmTypes: RelationType[]
      if (types != null) {
        llmTypes = []
        for (const t of types) {
          const id = relationTypeFromInput(t)
          if (!id) {
            return err(
              `未知的关系类型：${t}（可选：${LLM_SELECTABLE_TYPES.map((x) => `${RELATION_TYPE_LABELS[x as keyof typeof RELATION_TYPE_LABELS]}(${x})`).join(' / ')}）`
            )
          }
          if (!LLM_SELECTABLE_TYPES.includes(id)) {
            return err(`「${RELATION_TYPE_LABELS[id]}」由程序自动附加，不能手动选择（D89）`)
          }
          llmTypes.push(id)
        }
      } else {
        llmTypes = JSON.parse(rel.llm_types) as RelationType[]
      }
      const short = shortPaperIds(ctx.db, ctx.graphId)
      const lowS = short.get(rel.paper_low) ?? `P${rel.paper_low}`
      const highS = short.get(rel.paper_high) ?? `P${rel.paper_high}`
      // 方向：只有显式给 srcPaperId 且与原方向不同才翻转（D143 显式修改）；
      // 引用数据推定方向（D89）只用于新建边，不在修改时隐式翻转
      if (srcPaperId != null && srcPaperId !== rel.paper_low && srcPaperId !== rel.paper_high) {
        return err(`srcPaperId 必须是关系 #${relationId} 的两端之一（${lowS} 或 ${highS}）`)
      }
      const oldDst = rel.src_paper === rel.paper_low ? rel.paper_high : rel.paper_low
      const newSrc = srcPaperId ?? rel.src_paper
      const newDst = newSrc === rel.paper_low ? rel.paper_high : rel.paper_low
      const flipped = newSrc !== rel.src_paper
      // uat4-fix2 S5：展示版（listRelations 的返回值：P0x→《短标题》+ 120 字截断）绝不作为
      // 原文写库——与展示版逐字相同、或原文是 P0x 而传入串含《短标题》替换痕迹的，拒绝覆盖、
      // 保留原文，并引导 agent 用原文/P0x 写法。
      if (statement != null) {
        const trimmed = statement.trim()
        const displayVersion = clipWords(buildGraphShortIdReplacer(ctx.db, ctx.graphId)(rel.statement_text), 120)
        const displayTrace = /\bP\d{2}\b/.test(rel.statement_text) && trimmed.includes('《') && !rel.statement_text.includes('《')
        if (trimmed === displayVersion || displayTrace) {
          return err(
            '传入的 statement 是这条关系的展示版（内部编号已替换为《短标题》/可能截断至 120 字），不能作为原文写入——' +
              '本次未做任何修改，库内原文保持不变。要改陈述请基于方向与类型自己组织语言；指代论文用库内原文的编号写法' +
              `（如 ${lowS} / ${highS}）或作者+年份。`
          )
        }
      }
      const stmt = statement != null ? statement.trim() : rel.statement_text
      // D89：引用/同一作者自动类型按程序重新附加（auto_types 只读）
      const auto = computeAutoTypes(ctx.db, ctx.graphId, newSrc, newDst)

      // D129：同事务先写改动前快照，撤销可完整还原（含原 source_type / 方向）
      let snapshotId = 0
      const tx = ctx.db.transaction(() => {
        snapshotId = snapshotRelation(ctx.db, { sessionId: ctx.sessionId, turnId: ctx.turnId, relationId: rel.id, op: 'update' })
        upsertRelation(ctx.db, {
          graphId: ctx.graphId,
          srcPaperId: newSrc,
          dstPaperId: newDst,
          statement: stmt,
          llmTypes,
          autoTypes: auto.autoTypes,
          sourceType: 'session',
          sourceSessionId: ctx.sessionId,
          model: ctx.model,
          promptVersion: ctx.promptVersion
        })
      })
      tx()

      const before: { types: string; statement: string; source: string; direction: string } = {
        types: relationTypeLabel([
          ...(JSON.parse(rel.llm_types) as RelationType[]),
          ...(JSON.parse(rel.auto_types) as RelationType[])
        ]),
        statement: clipWords(rel.statement_text, 120),
        source: RELATION_SOURCE_LABELS[rel.source_type] ?? rel.source_type,
        direction: `${short.get(rel.src_paper) ?? `P${rel.src_paper}`}→${short.get(oldDst) ?? `P${oldDst}`}`
      }
      const autoZh = relationTypeLabel(auto.autoTypes)
      const afterTypesZh = relationTypeLabel([...llmTypes, ...auto.autoTypes])
      const after = {
        types: afterTypesZh,
        statement: clipWords(stmt, 120),
        direction: `${short.get(newSrc) ?? `P${newSrc}`}→${short.get(newDst) ?? `P${newDst}`}`
      }
      const autoNote = auto.autoTypes.length > 0 ? `；自动附加类型：${autoZh}` : ''
      ctx.onGraphChange({
        changeType: 'updateRelation',
        relationIds: [rel.id],
        paperIds: [rel.paper_low, rel.paper_high],
        snapshotIds: [snapshotId],
        summary:
          `修改关系 #${rel.id}（原：${before.types} · ${before.statement} · ${before.source} · 方向 ${before.direction}）→ ` +
          `${after.direction}（${afterTypesZh}${autoNote}）：${clipWords(stmt, 120)}`
      })
      ctx.emitTrace({ toolName: 'updateRelation', summary: `修改关系 #${rel.id}（原 ${before.types}）` })
      return { relationId: rel.id, updated: true, before, after, ...(flipped ? { directionChanged: before.direction } : {}), autoTypes: autoZh }
    }
  })

  const listRelations = tool({
    description:
      '列出当前图谱中已有的关系（B1）：每行含 relationId、方向（P01→P02）、中文类型名、陈述前 120 字、来源。' +
      '注意：statement 是展示版（内部编号已换成短标题、且截断至 120 字），仅供参考阅读，' +
      '不要把它原样作为 updateRelation 的陈述写入——改陈述时基于类型与方向自己组织语言，' +
      '或用户明确给出原文。' +
      '改关系前必须先查——addRelation 遇到已有边不会写入（结果返回既有边），修改用 updateRelation、删除用 deleteRelation，relationId 从这里拿。',
    inputSchema: z.object({
      /** 只看与某篇论文相关的边（可选） */
      paperId: z.number().int().positive().optional(),
      paperIds: z.array(z.number().int().positive()).max(20).optional(),
      limit: z.number().int().min(1).max(100).default(50)
    }),
    execute: async ({ paperId, paperIds, limit }) => {
      const filter = [...(paperIds ?? []), ...(paperId != null ? [paperId] : [])]
      const short = shortPaperIds(ctx.db, ctx.graphId)
      let rows = ctx.db
        .prepare(
          `SELECT id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types, source_type
           FROM relations WHERE graph_id = ? AND deleted_at IS NULL ORDER BY id`
        )
        .all(ctx.graphId) as LiveRelationRow[]
      // uat6b S3：只返回两端都是本图成员（未软删）的关系，与画布同口径——指向
      // 非成员论文的遗留边画布已隐藏，工具侧不再漏出（total 同口径；不删库里的行）
      const memberIds = graphMemberIds(ctx.db, ctx.graphId)
      rows = rows.filter((r) => memberIds.has(r.paper_low) && memberIds.has(r.paper_high))
      if (filter.length > 0) {
        const set = new Set(filter)
        rows = rows.filter((r) => set.has(r.paper_low) || set.has(r.paper_high))
      }
      const total = rows.length
      rows = rows.slice(0, limit)
      // uat4 建议修14a：旧陈述里残留的内部编号（P01…）在工具结果显示层换成
      // 《短标题》/「作者, 年份」（口径同 D150 导出口径；数据库不改）。构造轻量（一条
      // SQL + Map），每次调用现建。
      const replaceShortIds = buildGraphShortIdReplacer(ctx.db, ctx.graphId)
      const relations = rows.map((r) => {
        const dst = r.src_paper === r.paper_low ? r.paper_high : r.paper_low
        const typesZh = relationTypeLabel([...(JSON.parse(r.llm_types) as RelationType[]), ...(JSON.parse(r.auto_types) as RelationType[])])
        return {
          relationId: r.id,
          src: short.get(r.src_paper) ?? `P${r.src_paper}`,
          dst: short.get(dst) ?? `P${dst}`,
          direction: `${short.get(r.src_paper) ?? `P${r.src_paper}`}→${short.get(dst) ?? `P${dst}`}`,
          types: typesZh,
          statement: clipWords(replaceShortIds(r.statement_text), 120),
          source: RELATION_SOURCE_LABELS[r.source_type] ?? r.source_type
        }
      })
      ctx.emitTrace({ toolName: 'listRelations', summary: `查看图谱关系列表（${relations.length}/${total} 条）` })
      return {
        relations,
        total,
        ...(total > relations.length ? { note: `共 ${total} 条，仅返回前 ${relations.length} 条；可按 paperId 过滤或调大 limit` } : {})
      }
    }
  })

  const proposeCandidateTool = tool({
    description:
      '向用户提议一篇可能值得加入图谱的论文。不在本图谱时立即出现虚线候选节点；已在本图谱时只出卡片、不建节点。' +
      '提供标题、作者、年份与 DOI 或 arXiv 号（用于去重，D82；两者都没有时可只给标题，程序用 OpenAlex 按标题检索核对，D168）；' +
      'reason 只写一句中文推荐理由（作者、年份、期刊由程序回填），以该论文短标题开头、独立成句，' +
      '不要用「同上」等指代其他候选或条目，不要在理由里重复论文全名。',
    inputSchema: z.object({
      title: z.string().min(1).max(500),
      authors: z.array(z.string().max(200)).max(50).default([]),
      year: z.number().int().min(1400).max(2200).optional(),
      doi: z.string().max(500).optional(),
      arxivId: z.string().max(100).optional(),
      reason: z.string().min(1).max(1000),
      abstract: z.string().max(20000).optional(),
      venue: z.string().max(500).optional(),
      oaUrl: z.string().max(2000).optional(),
      openalexWid: z.string().max(40).optional()
    }),
    execute: async ({ title, authors, year, doi, arxivId, reason, abstract, venue, oaUrl, openalexWid }) => {
      // D168：允许只给标题（没有 DOI / arXiv 时用 OpenAlex 按标题检索核对）
      if (!doi?.trim() && !arxivId?.trim() && !title.trim()) return err('需要提供论文标题（DOI / arXiv 可选，D168）')
      const hit = rememberedHit(doi, arxivId)
      const view = await proposeCandidate(
        ctx.db,
        {
          graphId: ctx.graphId,
          sessionId: ctx.sessionId,
          title,
          authors,
          year: year ?? null,
          doi: doi ?? null,
          arxivId: arxivId ?? null,
          reason,
          abstract: abstract?.trim() || hit?.abstract || null,
          venue: venue?.trim() || hit?.venue || null,
          oaUrl: oaUrl?.trim() || hit?.oaUrl || null,
          openalexWid: openalexWid?.trim() || null
        },
        { openAlex: ctx.openAlex ?? null }
      )
      // 落库即广播：画布虚线节点与图例实时出现（合并批 e2e 发现的缺口，见 ToolContext 注释）
      ctx.emitCandidates?.()
      // D161/D182/D169：去重命中已有行时不再静默——按命中行的状态给卡片：
      // - pending（D182）：出「已在待确认候选中」卡片（定位 / 确认加入），不新建重复候选行；
      // - dismissed 且 in_graph（D169）：仍按「已在本图谱中」徽标口径展示（无确认按钮）。
      if (view.duplicateOfId != null) {
        if (view.status === 'pending' || view.status === 'dismissed') {
          ctx.onPaperCard({
            type: 'data-paper-card',
            id: `c${view.duplicateOfId}`,
            status: 'done',
            title: view.title,
            authors: view.authors.slice(0, 50),
            year: view.year ?? undefined,
            venue: view.venue,
            doi: view.doi ?? undefined,
            arxivId: view.arxivId ?? undefined,
            oaUrl: view.oaUrl,
            // uat6c M1：状态码（如 087 遗留的 'in_graph'）不当理由正文出卡
            reason: displayCandidateReason(view.reason) ?? '',
            cardStatus: 'candidate',
            existingPaperId: view.existingPaperId ?? undefined,
            ...(view.titleDup ? { titleDup: true } : {}),
            ...(view.unverified ? { unverified: true } : {}),
            ...(view.status === 'pending'
              ? { pendingDup: true, ...(view.inGraph ? { inGraph: true } : {}) }
              : // D169：命中 dismissed 按「已在本图谱中」口径出卡——即便 in_graph 列为 0
                // （087 把「先候选、后入图」的旧行改 dismissed 但不写列，评审建议修 1）
                { inGraph: true })
          })
        }
      } else {
        ctx.onPaperCard({
          type: 'data-paper-card',
          id: `c${view.id}`,
          status: 'done',
          title: view.title,
          authors: view.authors.slice(0, 50),
          year: view.year ?? undefined,
          venue: view.venue,
          doi: view.doi ?? undefined,
          arxivId: view.arxivId ?? undefined,
          oaUrl: view.oaUrl,
          // uat6c M1：状态码（如 087 遗留的 'in_graph'）不当理由正文出卡
          reason: displayCandidateReason(view.reason) ?? '',
          cardStatus: 'candidate',
          existingPaperId: view.existingPaperId ?? undefined,
          ...(view.titleDup ? { titleDup: true } : {}),
          ...(view.inGraph ? { inGraph: true } : {}),
          ...(view.unverified ? { unverified: true } : {})
        })
      }
      ctx.emitTrace({ toolName: 'proposeCandidate', summary: `提议候选《${view.title}》${view.existingPaperId != null ? '（已在论文库中）' : ''}` })
      const note =
        view.duplicateOfId != null
          ? view.status === 'pending'
            ? `已是待确认候选 #${view.duplicateOfId}，未新建重复候选`
            : '该论文已在本图谱中（候选已自动收起），未新建'
          : view.inGraph
            ? '该论文已在本图谱中，未新建画布候选节点'
            : view.existingPaperId != null
              ? '该论文已在论文库中，用户确认后将直接加入图谱'
              : view.unverified
                ? '未能核实这篇候选的外部记录（卡片已低调标注），请用户自行判断是否加入'
                : '候选已创建。用户确认后会写入论文库并查找 PDF'
      return {
        candidateId: view.id,
        status: view.status,
        existingPaperId: view.existingPaperId,
        ...(view.duplicateOfId != null ? { duplicateOfId: view.duplicateOfId } : {}),
        note
      }
    }
  })

  /** 本回合 searchPapers 命中，供 proposeCandidate 补摘要（模型不必回传长摘要，D134 bug5） */
  const hitsByKey = new Map<string, PaperHit>()
  const rememberHits = (hits: PaperHit[]): void => {
    for (const hit of hits) {
      if (hit.doi) hitsByKey.set(`doi:${normalizeDoi(hit.doi)}`, hit)
      if (hit.arxivId) hitsByKey.set(`arxiv:${normalizeArxiv(hit.arxivId)}`, hit)
    }
  }
  const rememberedHit = (doi?: string | null, arxivId?: string | null): PaperHit | undefined => {
    if (doi) {
      const hit = hitsByKey.get(`doi:${normalizeDoi(doi)}`)
      if (hit) return hit
    }
    if (arxivId) return hitsByKey.get(`arxiv:${normalizeArxiv(arxivId)}`)
    return undefined
  }
  const clip = (s: string, n = 80): string => {
    const t = s.trim()
    return t.length <= n ? t : `${t.slice(0, n)}…`
  }

  const webDeps = (): WebClientDeps | { error: string } => {
    if (ctx.web) {
      if (!ctx.web.apiKey.trim()) return { error: '缺少 API Key' }
      return ctx.web
    }
    const key = readApiKey(ctx.dataDir, 'deepseek')
    if (!key) return { error: '缺少 API Key' }
    return { apiKey: key }
  }

  const webFailure = (e: unknown): { error: string } => {
    const msg = e instanceof Error ? e.message : String(e)
    if (e instanceof AuthLlmError) {
      return err(e.status === 402 ? `网页工具失败（余额不足）：${msg}` : `网页工具失败（API Key 无效）：${msg}`)
    }
    if (e instanceof NetworkLlmError) return err(`网页工具失败（网络异常，可稍后重试）：${msg}`)
    if (e instanceof RetryableLlmError) return err(`网页工具失败（限流或超时，可稍后重试）：${msg}`)
    return err(`网页工具失败：${msg}`)
  }

  const webSearch = tool({
    description: '用 DeepSeek 联网搜索。成功且非空记一笔网页费用；失败或没有结果不收费。只在本地（searchLibrary / readPaper）确实没有时兜底，不得把本地与网页信息下成「矛盾」结论。',
    inputSchema: z.object({ query: z.string().max(500).optional() }),
    execute: async ({ query }) => {
      if (!query?.trim()) return err('缺少 query：请给出搜索关键词')
      const q = query.trim()
      const deps = webDeps()
      if ('error' in deps) {
        ctx.emitTrace({ toolName: 'webSearch', summary: `联网搜索「${clip(q)}」失败：${deps.error}` })
        return err(deps.error)
      }
      try {
        const found = await runWebSearch(deps, q)
        if (found.billable) recordWebCall(ctx.db, { sessionId: ctx.sessionId })
        const titles = found.results.map((r) => r.title).filter(Boolean).slice(0, 3).join('、')
        ctx.emitTrace({
          toolName: 'webSearch',
          summary: `联网搜索「${clip(q)}」：${found.results.length} 条${titles ? `（${clip(titles)}）` : ''}`
        })
        return { results: found.results }
      } catch (e) {
        const failure = webFailure(e)
        ctx.emitTrace({ toolName: 'webSearch', summary: `联网搜索「${clip(q)}」失败：${clip(failure.error, 160)}` })
        return failure
      }
    }
  })

  const searchImages = tool({
    description: '联网检索图片（后续版本，D128；当前返回占位结果，不发起网络请求）。',
    inputSchema: z.object({
      query: z.string().max(500).optional()
    }),
    execute: async ({ query }) => {
      if (!query?.trim()) return err('缺少 query：请给出搜索关键词')
      return {
        available: false,
        m6: true,
        message: 'searchImages 将在后续版本提供（D128），本次未发起网络请求'
      }
    }
  })

  const webFetch = tool({
    description: '抓取一个 https 网页并返回 Markdown。标题或正文去空白后非空记一笔网页费用；两者都空白不收费。只在本地确实没有时兜底，不得把本地与网页信息下成「矛盾」结论。',
    inputSchema: z.object({ url: z.string().max(2000).optional() }),
    execute: async ({ url }) => {
      const u = url?.trim() ?? ''
      if (!u) return err('缺少 url：请给出要抓取的网页链接')
      if (!/^https:\/\//i.test(u)) return err('url 必须是 https 链接（http / 其他协议不支持）')
      const deps = webDeps()
      if ('error' in deps) {
        ctx.emitTrace({ toolName: 'webFetch', summary: `抓取网页 ${clip(u, 160)} 失败：${deps.error}` })
        return err(deps.error)
      }
      try {
        const fetched = await webFetchPage(deps, u)
        if (fetched.billable) recordWebCall(ctx.db, { sessionId: ctx.sessionId })
        const title = fetched.page.title?.trim()
        ctx.emitTrace({
          toolName: 'webFetch',
          summary: `抓取网页 ${clip(u, 160)}：${title ? clip(title) : fetched.billable ? '有正文' : '空结果'}`
        })
        return { result: fetched.page }
      } catch (e) {
        const failure = webFailure(e)
        ctx.emitTrace({ toolName: 'webFetch', summary: `抓取网页 ${clip(u, 160)} 失败：${clip(failure.error, 160)}` })
        return failure
      }
    }
  })

  // M6 lane/fetch 批 1：searchPapers 真实现——OpenAlex 检索 + 引用追踪（D117/D82/D126）
  const searchPapersTool = tool({
    description:
      '在 OpenAlex 外部学术库检索论文。query 为关键词时按相关度检索；为 DOI（10.xxxx/…）或 OpenAlex W-ID（W…）时做引用追踪（返回种子论文 + 它引用的和引用它的论文）。结果带 inLibraryPaperId 的已在论文库中；看中相关论文就用 proposeCandidate 提议候选。' +
      '只在本地（searchLibrary / readPaper）确实没有时兜底，不得把本地与网页信息下成「矛盾」结论。',
    inputSchema: z.object({
      query: z.string().max(500).optional(),
      limit: z.number().int().min(1).max(25).default(10)
    }),
    execute: async ({ query, limit }) => {
      if (!query?.trim()) return err('缺少 query：请给出搜索关键词')
      try {
        const client =
          ctx.openAlex ??
          ((): OpenAlexClient => {
            const s = readOpenAlexSettings(ctx.dataDir)
            return createOpenAlexClient({
              apiKey: s.apiKey,
              mailto: s.mailto,
              onBillable: () => bumpOpenAlexDailyCount(ctx.db)
            })
          })()
        const q = query.trim()
        const hits = await searchPapersService(ctx.db, client, q, limit ?? 10)
        rememberHits(hits)
        const titles = hits.map((h) => h.title).filter(Boolean).slice(0, 3).join('、')
        ctx.emitTrace({
          toolName: 'searchPapers',
          summary: `检索论文「${clip(q)}」：${hits.length} 篇${titles ? `（${clip(titles)}）` : ''}`
        })
        if (hits.length === 0) return { results: [], note: '未检索到相关论文（或该论文不在 OpenAlex 中）' }
        return {
          results: hits,
          note: `检索到 ${hits.length} 篇（最多 25）；带 inLibraryPaperId 的已在你的论文库中，其余可经 proposeCandidate 提议后由用户确认入库。`
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // D86 口径：错误作为工具结果返回，不抛给模型循环；断网/限流如实说明
        const failure = (text: string): { error: string } => {
          ctx.emitTrace({ toolName: 'searchPapers', summary: `检索论文「${clip(query?.trim() || '')}」失败：${clip(text, 160)}` })
          return err(text)
        }
        if (e instanceof AuthLlmError) return failure(`联网检索失败（OpenAlex Key 无效）：${msg}`)
        if (e instanceof NetworkLlmError) return failure(`联网检索失败（网络异常，可稍后重试）：${msg}`)
        if (e instanceof RetryableLlmError) return failure(`联网检索失败（限流或超时，可稍后重试）：${msg}`)
        if (e instanceof BadRequestLlmError) return failure(`联网检索失败：${msg}`)
        return failure(`联网检索失败：${msg}`)
      }
    }
  })

  const deleteRelationTool = tool({
    description: '删除当前图谱里的一条关系（软删除，立即生效，可撤销）。relationId 用 listRelations 查询获得。',
    inputSchema: z.object({ relationId: z.number().int().positive() }),
    execute: async ({ relationId }) => {
      const rel = ctx.db
        .prepare('SELECT id, paper_low, paper_high FROM relations WHERE id = ? AND graph_id = ? AND deleted_at IS NULL')
        .get(relationId, ctx.graphId) as { id: number; paper_low: number; paper_high: number } | undefined
      if (!rel) return err(`关系 ${relationId} 不存在或已删除`)
      // M6 前置 2a（D129）：同事务先写改动前快照，删除可经快照完整还原
      let snapshotId = 0
      const tx = ctx.db.transaction(() => {
        snapshotId = snapshotRelation(ctx.db, { sessionId: ctx.sessionId, turnId: ctx.turnId, relationId, op: 'delete' })
        deleteRelation(ctx.db, relationId)
      })
      tx()
      const short = shortPaperIds(ctx.db, ctx.graphId)
      ctx.onGraphChange({
        changeType: 'deleteRelation',
        relationIds: [relationId],
        paperIds: [rel.paper_low, rel.paper_high],
        snapshotIds: [snapshotId],
        summary: `删除关系 #${relationId}（${short.get(rel.paper_low) ?? rel.paper_low} ↔ ${short.get(rel.paper_high) ?? rel.paper_high}）`
      })
      return { deleted: true, relationId }
    }
  })

  return {
    getPapers,
    readPaper,
    searchLibrary,
    getFigure,
    addRelation,
    updateRelation,
    listRelations,
    deleteRelation: deleteRelationTool,
    recallHistory,
    proposeCandidate: proposeCandidateTool,
    webSearch,
    webFetch,
    searchPapers: searchPapersTool,
    searchImages
  }
}

export type AgentTools = ReturnType<typeof createAgentTools>
