import type Database from 'better-sqlite3'
import type { ExportOptions } from '../../shared/ipc/export'
import { isRelationType, relationTypeLabel, type RelationType } from '../../shared/relationTypes'
import { paperDetailText } from '../relations/context'
import { buildGraphShortIdReplacer } from '../text/graphShortIds'

/**
 * Markdown 导出（D31/D60，原型 08；uat4：D150 短 id 替换 / 空类型=0 条 / 入边 / et al. / 本地日期）。
 *
 * 纯函数按「整理」后的画布顺序（y 再 x）输出。关系写出边 + 入边（入边标明「← 来自」），
 * 空数组 relationTypes = 0 条关系（uat4 建议修 1；不再表示「全部」）。参考文献「作者, 年份,
 * 标题」，超过 3 位作者列前 3 位接 et al.，有 DOI 才附 https://doi.org/…。导出于用本地时区。
 * 概览正文由调用方传入：预览本身不调用模型。
 */

export const OVERVIEW_PLACEHOLDER = '（研究线概览尚未生成。预览不调用模型。）'

export interface ExportPaper {
  id: number
  title: string
  authors: string
  year: number | null
  oneLiner: string | null
  doi: string | null
  x: number
  y: number
  detailText: string | null
}

export interface ExportEdge {
  srcId: number
  dstId: number
  /** 起点论文标题（uat4 建议修 5：入边行「← 来自 <srcTitle>」用） */
  srcTitle: string
  dstTitle: string
  types: RelationType[]
  statement: string
  /** uat6 D175(a)：AI 自动边且无引用依据（no_ref_basis=1 且 source_type='job'，与画布/面板同判定） */
  noRefBasis: boolean
}

export interface ExportGraph {
  name: string
  papers: ExportPaper[]
  edges: ExportEdge[]
}

interface MemberRow {
  id: number
  title: string
  first_author: string | null
  year: number | null
  one_liner: string | null
  doi: string | null
  x: number
  y: number
}

interface AuthorRow {
  given: string | null
  family: string | null
}

interface RelationRow {
  src_paper: number
  paper_low: number
  paper_high: number
  statement_text: string
  llm_types: string
  auto_types: string
  /** uat6 D175(a)：导出给无引用依据的 AI 自动边标「AI 推断 · 无引用依据」 */
  no_ref_basis: number
  source_type: string
}

function readTypeArray(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return []
    return value.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

function parseTypes(llm: string, auto: string): RelationType[] {
  const out: RelationType[] = []
  for (const raw of [...readTypeArray(llm), ...readTypeArray(auto)]) {
    if (isRelationType(raw) && !out.includes(raw)) out.push(raw)
  }
  return out
}

function authorLine(rows: AuthorRow[], firstAuthor: string | null): string {
  const names = rows
    .map((row) => [row.given, row.family].filter((part) => part && part.trim()).join(' '))
    .filter((name) => name.length > 0)
  if (names.length > 0) return names.join(', ')
  return firstAuthor?.trim() ?? ''
}

export function loadExportGraph(db: Database.Database, graphId: number): ExportGraph | null {
  const graph = db.prepare('SELECT name FROM graphs WHERE id = ?').get(graphId) as { name: string } | undefined
  if (!graph) return null
  const members = db
    .prepare(
      `SELECT p.id, p.title, p.first_author, p.year, p.one_liner, p.doi, m.x, m.y
       FROM graph_members m
       JOIN papers p ON p.id = m.paper_id
       WHERE m.graph_id = ? AND p.deleted_at IS NULL`
    )
    .all(graphId) as MemberRow[]
  const authorStmt = db.prepare(
    'SELECT given, family FROM paper_authors WHERE paper_id = ? ORDER BY position'
  )
  const papers: ExportPaper[] = members.map((row) => ({
    id: row.id,
    title: row.title,
    authors: authorLine(authorStmt.all(row.id) as AuthorRow[], row.first_author),
    year: row.year,
    oneLiner: row.one_liner,
    doi: row.doi,
    x: row.x,
    y: row.y,
    detailText: paperDetailText(db, row.id)
  }))
  const byId = new Map(papers.map((paper) => [paper.id, paper]))
  const relations = db
    .prepare(
      `SELECT src_paper, paper_low, paper_high, statement_text, llm_types, auto_types, no_ref_basis, source_type
       FROM relations
       WHERE graph_id = ? AND deleted_at IS NULL`
    )
    .all(graphId) as RelationRow[]
  // D150：旧陈述里的 P0x 内部短 id 换成《短标题》（只改导出文本，数据库不动）
  const replaceShortIds = buildGraphShortIdReplacer(db, graphId)
  const edges: ExportEdge[] = []
  for (const rel of relations) {
    const dstId = rel.src_paper === rel.paper_low ? rel.paper_high : rel.paper_low
    const dst = byId.get(dstId)
    const src = byId.get(rel.src_paper)
    if (!src || !dst) continue
    edges.push({
      srcId: rel.src_paper,
      dstId,
      srcTitle: src.title,
      dstTitle: dst.title,
      types: parseTypes(rel.llm_types, rel.auto_types),
      statement: replaceShortIds(rel.statement_text ?? ''),
      noRefBasis: rel.no_ref_basis === 1 && rel.source_type === 'job'
    })
  }
  return { name: graph.name, papers, edges }
}

function doiUrl(doi: string | null): string | null {
  const bare = doi?.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '') ?? ''
  if (!bare) return null
  return `https://doi.org/${bare}`
}

/** uat4 建议修 3：作者 ≤3 位照列；>3 位列前 3 位后接 ", et al."。 */
export function formatReferenceAuthors(authors: string): string {
  const list = authors
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
  if (list.length === 0) return '佚名'
  if (list.length <= 3) return list.join(', ')
  return `${list.slice(0, 3).join(', ')}, et al.`
}

function referenceLine(paper: ExportPaper): string {
  const authors = formatReferenceAuthors(paper.authors)
  const core = paper.year != null ? `${authors}, ${paper.year}, ${paper.title}` : `${authors}, ${paper.title}`
  const url = doiUrl(paper.doi)
  return url ? `- ${core} ${url}` : `- ${core}`
}

function paperBlock(paper: ExportPaper, edges: ExportEdge[], details: boolean): string {
  // uat6 S3：标题行作者与参考文献**同一个 et al. 函数**（>3 位 → 前 3 位 + et al.；
  // 无作者行不写作者段，与旧行为一致）
  const authors = paper.authors.trim() ? formatReferenceAuthors(paper.authors) : ''
  const meta = [authors, paper.year != null ? String(paper.year) : ''].filter((part) => part !== '')
  const lines = [meta.length > 0 ? `## ${paper.title}（${meta.join(', ')}）` : `## ${paper.title}`]
  if (paper.oneLiner?.trim()) lines.push('', paper.oneLiner.trim())
  // uat6 D175(a)：无引用依据的 AI 自动边在导出里标明（预览与保存同一 render()）
  const marker = (edge: ExportEdge): string => (edge.noRefBasis ? '（AI 推断 · 无引用依据）' : '')
  const mine = edges
    .filter((edge) => edge.srcId === paper.id)
    .sort((a, b) => a.dstTitle.localeCompare(b.dstTitle, 'zh') || a.dstId - b.dstId)
  if (mine.length > 0) {
    if (lines.length === 1) lines.push('')
    for (const edge of mine) {
      const label = relationTypeLabel(edge.types) || '未定类型'
      const statement = edge.statement.trim()
      lines.push(statement ? `- ${label} → ${edge.dstTitle}：${statement}${marker(edge)}` : `- ${label} → ${edge.dstTitle}${marker(edge)}`)
    }
  }
  // uat4 建议修 5：终点论文下也列入边（标明方向）；排序同出边口径（按对端标题再 id）
  const incoming = edges
    .filter((edge) => edge.dstId === paper.id)
    .sort((a, b) => a.srcTitle.localeCompare(b.srcTitle, 'zh') || a.srcId - b.srcId)
  if (incoming.length > 0) {
    if (lines.length === 1) lines.push('')
    for (const edge of incoming) {
      const label = relationTypeLabel(edge.types) || '未定类型'
      const statement = edge.statement.trim()
      lines.push(statement ? `- ${label} ← 来自 ${edge.srcTitle}：${statement}${marker(edge)}` : `- ${label} ← 来自 ${edge.srcTitle}${marker(edge)}`)
    }
  }
  if (details && paper.detailText?.trim()) {
    lines.push('', paper.detailText.trim().split('\n').map((line) => `> ${line}`).join('\n'))
  }
  return lines.join('\n')
}

export function buildMarkdown(
  graph: ExportGraph,
  options: Pick<ExportOptions, 'overview' | 'details' | 'relationTypes' | 'references'>,
  extras: { exportedAt: Date; overviewText: string | null }
): string {
  const papers = [...graph.papers].sort((a, b) => a.y - b.y || a.x - b.x || a.id - b.id)
  // uat4 建议修 1：空 relationTypes = 0 条关系（不再当「全部」；「全部」由 UI 默认全选表达）
  const allowed = new Set(options.relationTypes)
  const visible = graph.edges.filter((edge) => edge.types.some((type) => allowed.has(type)))
  const date = localDateString(extras.exportedAt)
  const blocks = [`# ${graph.name}\n\n导出于 ${date} · ${papers.length} 篇论文 · ${visible.length} 条关系`]
  if (options.overview) {
    blocks.push(`## 概览\n\n${extras.overviewText?.trim() || OVERVIEW_PLACEHOLDER}`)
  }
  for (const paper of papers) blocks.push(paperBlock(paper, visible, options.details))
  if (options.references) {
    blocks.push(`## 参考文献\n\n${papers.map((paper) => referenceLine(paper)).join('\n')}`)
  }
  return `${blocks.join('\n\n')}\n`
}

/**
 * uat4 建议修 6：导出于用本地时区日期。tzOffsetMinutes 可注入便于测试
 * （Node 运行时切换 process.env.TZ 不可靠，不依赖它）。默认取运行环境本地偏移。
 */
export function localDateString(d: Date, tzOffsetMinutes?: number): string {
  const offset = tzOffsetMinutes ?? -d.getTimezoneOffset()
  return new Date(d.getTime() + offset * 60_000).toISOString().slice(0, 10)
}

/** 保存对话框的默认文件名。只给文件名，不带数据目录。 */
export function markdownFileName(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim() || 'graph'
  return `${safe}.md`
}
