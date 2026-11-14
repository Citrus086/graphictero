import type Database from 'better-sqlite3'
import { relationTypeLabel, type RelationType } from '../../shared/relationTypes'
import { graphMemberIds } from '../relations/membership'

/**
 * M5 lane/agent：按会话入口构造起始上下文指针（设计文档 6.2/6.3）。
 *
 * - graph 入口：全图指针 + 名片层——成员论文短 id（P01…，D86 口径）+ 标题/年份/
 *   第一作者/一句话摘要，让模型先知道图上有哪些论文再决定读哪篇；M6 第 0 批 B1：
 *   指针附「已有关系 N 条」+ 前 30 条一行摘要（超出提示用 listRelations 查），
 *   改关系前先查，新增/修改/删除都心里有数（D143）；
 * - paper 入口：该篇论文的名片（标题/作者/年份/摘要/一句话）；
 * - relation 入口：这条边的两端论文名片 + 边陈述与类型。
 * 指针文本拼进 Agent instructions（runtime.ts），不进用户消息。
 */

export interface EntryPointer {
  entryType: 'graph' | 'paper' | 'relation'
  graphId: number
  entryId: number | null
  text: string
}

interface CardRow {
  id: number
  title: string
  first_author: string | null
  year: number | null
  abstract: string | null
  one_liner: string | null
}

function cardLine(short: string, r: CardRow): string {
  const head = [`《${r.title}》`, r.year != null ? String(r.year) : null, r.first_author].filter(Boolean).join(' · ')
  return `- ${short} ${head}${r.one_liner ? `\n  一句话：${r.one_liner}` : ''}`
}

function paperCard(db: Database.Database, paperId: number): CardRow | null {
  return (
    (db
      .prepare('SELECT id, title, first_author, year, abstract, one_liner FROM papers WHERE id = ? AND deleted_at IS NULL')
      .get(paperId) as CardRow | undefined) ?? null
  )
}

function pointerForPaper(db: Database.Database, graphId: number, paperId: number): string {
  const p = paperCard(db, paperId)
  if (!p) return `入口论文 ${paperId} 不存在或已删除。`
  const inGraph = db
    .prepare('SELECT 1 FROM graph_members WHERE graph_id = ? AND paper_id = ?')
    .get(graphId, paperId)
  return [
    `当前入口是一篇论文（${inGraph ? '已在当前图谱中' : '不在当前图谱中'}）：`,
    cardLine(`P${paperId}`, p),
    p.abstract ? `摘要：${p.abstract}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

function pointerForRelation(db: Database.Database, graphId: number, relationId: number): string {
  const rel = db
    .prepare(
      `SELECT id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types
       FROM relations WHERE id = ? AND graph_id = ? AND deleted_at IS NULL`
    )
    .get(relationId, graphId) as
    | { id: number; paper_low: number; paper_high: number; src_paper: number; statement_text: string; llm_types: string; auto_types: string }
    | undefined
  if (!rel) return `入口关系 ${relationId} 不存在或已删除。`
  const low = paperCard(db, rel.paper_low)
  const high = paperCard(db, rel.paper_high)
  const srcIsLow = rel.src_paper === rel.paper_low
  const types = [...(JSON.parse(rel.llm_types) as string[]), ...(JSON.parse(rel.auto_types) as string[])]
  return [
    '当前入口是一条关系：',
    `- 被引/被针对方（src）：${srcIsLow ? cardLine(`P${rel.paper_low}`, low!) : cardLine(`P${rel.paper_high}`, high!)}`,
    `- 引用/针对方（dst）：${srcIsLow ? cardLine(`P${rel.paper_high}`, high!) : cardLine(`P${rel.paper_low}`, low!)}`,
    `- 陈述：${rel.statement_text}`,
    `- 类型：${types.join(' / ')}`
  ].join('\n')
}

/** B1：图谱入口指针附边摘要上限（超出提示用 listRelations 查）。 */
const POINTER_RELATION_LIMIT = 30

function pointerForGraph(db: Database.Database, graphId: number): string {
  const g = db.prepare('SELECT name FROM graphs WHERE id = ?').get(graphId) as { name: string } | undefined
  const rows = db
    .prepare(
      `SELECT p.id, p.title, p.first_author, p.year, p.abstract, p.one_liner
       FROM graph_members m JOIN papers p ON p.id = m.paper_id
       WHERE m.graph_id = ? AND p.deleted_at IS NULL
       ORDER BY p.id`
    )
    .all(graphId) as CardRow[]
  if (rows.length === 0) return `当前图谱「${g?.name ?? graphId}」还没有论文。`
  const short = new Map(rows.map((r, i) => [r.id, `P${String(i + 1).padStart(2, '0')}`]))
  const lines = rows.map((r, i) => cardLine(`P${String(i + 1).padStart(2, '0')}（id ${r.id}）`, r))
  // B1：已有关系摘要（含方向 + 中文类型 + 陈述前 120 字），超出上限提示用 listRelations。
  // uat6b S3：与画布 / listRelations 同口径——只列两端都是本图成员（未软删）的边，
  // 指向非成员论文的遗留边不进出模型上下文（计数同口径）。
  const memberIds = graphMemberIds(db, graphId)
  const rels = (
    db
      .prepare(
        `SELECT id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types
       FROM relations WHERE graph_id = ? AND deleted_at IS NULL ORDER BY id`
      )
      .all(graphId) as Array<{
      id: number
      paper_low: number
      paper_high: number
      src_paper: number
      statement_text: string
      llm_types: string
      auto_types: string
    }>
  ).filter((r) => memberIds.has(r.paper_low) && memberIds.has(r.paper_high))
  let relLines: string[] = []
  if (rels.length > 0) {
    relLines = [`已有关系 ${rels.length} 条（改关系前用 listRelations 核对；摘要：）`]
    for (const r of rels.slice(0, POINTER_RELATION_LIMIT)) {
      const dst = r.src_paper === r.paper_low ? r.paper_high : r.paper_low
      const types = relationTypeLabel([...(JSON.parse(r.llm_types) as RelationType[]), ...(JSON.parse(r.auto_types) as RelationType[])])
      relLines.push(
        `- #${r.id} ${short.get(r.src_paper) ?? `P${r.src_paper}`}→${short.get(dst) ?? `P${dst}`}（${types}）：${r.statement_text.slice(0, 120)}`
      )
    }
    if (rels.length > POINTER_RELATION_LIMIT) {
      relLines.push(`…共 ${rels.length} 条，仅列前 ${POINTER_RELATION_LIMIT} 条，其余用 listRelations 工具查询。`)
    }
  }
  return [`当前图谱「${g?.name ?? graphId}」，共 ${rows.length} 篇论文：`, ...lines, ...relLines].join('\n')
}

export function buildEntryPointer(
  db: Database.Database,
  entry: { entryType: 'graph' | 'paper' | 'relation'; graphId: number; entryId: number | null }
): EntryPointer {
  let text: string
  if (entry.entryType === 'paper' && entry.entryId != null) {
    text = pointerForPaper(db, entry.graphId, entry.entryId)
  } else if (entry.entryType === 'relation' && entry.entryId != null) {
    text = pointerForRelation(db, entry.graphId, entry.entryId)
  } else {
    text = pointerForGraph(db, entry.graphId)
  }
  return { entryType: entry.entryType, graphId: entry.graphId, entryId: entry.entryId, text }
}
