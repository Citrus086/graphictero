import type Database from 'better-sqlite3'
import { stripInlineImages } from '../text/stripInlineImages'

/**
 * 关系生成的图谱上下文加载：参与论文（D62/D67：有 PDF、未删除、已有详情）、
 * 短 id（P01…，D86）、名片/详情文本。首次建图以详情为主要依据（D87）；
 * 规模超限时退化为名片打底（D86，见 generator.ts）。
 */

export interface GraphPaper {
  id: number
  title: string
  firstAuthor: string | null
  year: number | null
  abstract: string | null
  oneLiner: string | null
  /** paper_details 的 text parts 拼接（没有详情为 null → 不参与生成） */
  detailText: string | null
}

export interface GraphContext {
  graphId: number
  papers: GraphPaper[]
  /** 短 id → 论文 id（P01 起，按论文 id 排序，稳定前缀利于缓存，D86） */
  shortToId: Map<string, number>
  idToShort: Map<number, string>
}

export function paperDetailText(db: Database.Database, paperId: number): string | null {
  const row = db.prepare('SELECT parts FROM paper_details WHERE paper_id = ?').get(paperId) as
    | { parts: string }
    | undefined
  if (!row) return null
  try {
    const parts = JSON.parse(row.parts) as Array<{ type: string; text?: string }>
    const text = parts.filter((p) => p.type === 'text' && typeof p.text === 'string').map((p) => p.text!).join('\n\n')
    // 详情入库前已去掉内嵌图；这里再滤一次，避免旧详情里的 data URI 进关系语料或 readPaper
    return stripInlineImages(text).trim() || null
  } catch {
    return null
  }
}

/** 参与关系生成的论文：图谱成员 ∩ 有 PDF ∩ 未删除 ∩ 有详情（D62/D67/D85） */
export function loadGraphPapers(db: Database.Database, graphId: number): GraphPaper[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.title, p.first_author, p.year, p.abstract, p.one_liner
       FROM graph_members m JOIN papers p ON p.id = m.paper_id
       WHERE m.graph_id = ? AND p.deleted_at IS NULL AND p.has_pdf = 1
       ORDER BY p.id`
    )
    .all(graphId) as Array<{
    id: number
    title: string
    first_author: string | null
    year: number | null
    abstract: string | null
    one_liner: string | null
  }>
  const out: GraphPaper[] = []
  for (const r of rows) {
    out.push({
      id: r.id,
      title: r.title,
      firstAuthor: r.first_author,
      year: r.year,
      abstract: r.abstract,
      oneLiner: r.one_liner,
      detailText: paperDetailText(db, r.id)
    })
  }
  return out
}

export function buildShortIds(papers: Array<{ id: number }>): {
  shortToId: Map<string, number>
  idToShort: Map<number, string>
} {
  const shortToId = new Map<string, number>()
  const idToShort = new Map<number, string>()
  papers.forEach((p, i) => {
    const short = `P${String(i + 1).padStart(2, '0')}`
    shortToId.set(short, p.id)
    idToShort.set(p.id, short)
  })
  return { shortToId, idToShort }
}

/** 名片文本（D39：标题 + 摘要 + 一句话摘要，摘要不截断 D52） */
export function cardText(p: GraphPaper): string {
  return [`《${p.title}》`, p.abstract ?? '', p.oneLiner ? `一句话：${p.oneLiner}` : '']
    .filter(Boolean)
    .join('\n')
}

/** 详情文本（D87：首次建图主要依据） */
export function detailText(p: GraphPaper): string {
  return `《${p.title}》\n${p.detailText ?? ''}`
}

/**
 * 粗略 token 估算（D86 规模上限判定用）：CJK 每字 ≈1，拉丁每 4 字符 ≈1。
 * 只是数量级判断，不追求精确。
 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[㐀-鿿豈-﫿]/g) ?? []).length
  const latin = text.length - cjk
  return Math.ceil(cjk + latin / 4)
}
