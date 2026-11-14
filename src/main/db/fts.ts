import type Database from 'better-sqlite3'
import { segmentText } from './segment'

/**
 * FTS5 索引与查询（D33/D74）。
 *
 * - 写入：标题 / 摘要 / 关键词先过 Intl.Segmenter 预分词再存；
 * - 查询：用户查询串同样先分词再 MATCH（M0 实测必须这么做）；
 * - 带连字符的名称（如 deep-seek-r1）分词后按短语查询，避免被拆成 AND。
 */

export function indexPaperFts(
  db: Database.Database,
  paperId: number,
  fields: { title: string; abstract: string | null; keywords: string[] }
): void {
  db.prepare(
    `INSERT OR REPLACE INTO papers_fts (rowid, title_seg, abstract_seg, keywords_seg)
     VALUES (?, ?, ?, ?)`
  ).run(
    paperId,
    segmentText(fields.title),
    fields.abstract ? segmentText(fields.abstract) : '',
    fields.keywords.map((k) => segmentText(k)).join(' ')
  )
}

export function removePaperFts(db: Database.Database, paperId: number): void {
  db.prepare('DELETE FROM papers_fts WHERE rowid = ?').run(paperId)
}

/**
 * M6 第 0 批 B4（D121 实测 bug 4）：查询串转 FTS5 MATCH 表达式。
 * 每个词转义（双引号包裹）后加前缀 `*`，词之间 **OR**——多词自然语言查询不再被
 * 隐式 AND 卡成 0 命中（如 “HALT illusory completion” 至少命中一端）。每个词同时给
 * 词干精确形（`"w"`，porter 词干器处理 retrieve→retriev 形态归并，保留既有回归）
 * 与前缀形（`"w"*`，部分词 / 复合词前缀命中）。
 * 例：'强化学习' -> '"强化"* OR "强化" OR "学习"* OR "学习"'；'deep-seek' -> '"deep"* OR "deep" OR "seek"* OR "seek"'。
 * 词数上限 8，常用停用词（英文小品词 / 中文助词）剔除；空查询返回空串。
 */
const FTS_STOPWORDS = new Set([
  'the', 'of', 'and', 'a', 'an', 'in', 'on', 'for', 'to', 'with', 'by', 'is', 'are', 'was', 'were',
  '的', '和', '与', '及', '或', '在', '是', '了', '对', '为', '基于'
])
const FTS_MAX_TERMS = 8

/** FTS5 短语转义：双引号内的 `"` 翻倍（查不到词的脏字符安全降级为空词）。 */
function escapeFtsTerm(term: string): string {
  return term.replace(/"/g, '""')
}

export function buildFtsMatch(query: string): string {
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
  const terms: string[] = []
  let wordCount = 0
  for (const raw of query.split(/\s+/)) {
    if (!raw || wordCount >= FTS_MAX_TERMS) continue
    // 带连字符的名称拆成词参与 OR（前缀匹配仍命中 deep-seek-r1，D74 回归见 database.test）
    const pieces = raw.includes('-') ? raw.split('-').filter(Boolean) : [raw]
    for (const piece of pieces) {
      const words = [...segmenter.segment(piece)]
        .filter((s) => s.isWordLike)
        .map((s) => s.segment.toLowerCase().trim())
        .filter((w) => w.length > 0 && !FTS_STOPWORDS.has(w))
      for (const w of words) {
        if (wordCount >= FTS_MAX_TERMS) break
        wordCount++
        const esc = escapeFtsTerm(w)
        terms.push(`"${esc}"*`, `"${esc}"`)
      }
      if (wordCount >= FTS_MAX_TERMS) break
    }
  }
  return terms.join(' OR ')
}

/** 查询词列表（命中数统计用，与 buildFtsMatch 同一分词口径，去掉 `*`/引号）。 */
function ftsTerms(query: string): string[] {
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
  const terms: string[] = []
  for (const raw of query.split(/\s+/)) {
    if (!raw || terms.length >= FTS_MAX_TERMS) continue
    const pieces = raw.includes('-') ? raw.split('-').filter(Boolean) : [raw]
    for (const piece of pieces) {
      for (const s of segmenter.segment(piece)) {
        if (!s.isWordLike) continue
        const w = s.segment.toLowerCase().trim()
        if (w.length > 0 && !FTS_STOPWORDS.has(w) && !terms.includes(w)) terms.push(w)
        if (terms.length >= FTS_MAX_TERMS) return terms
      }
    }
  }
  return terms
}

/**
 * 论文库内检索（B4）：FTS5 bm25 排序（标题列权重高于摘要/关键词），命中词数多的
 * 排前面（多词查询「全部命中的优先」）。返回命中词数 hits 供调用方展示/再排序。
 */
export function searchPapers(
  db: Database.Database,
  query: string,
  limit = 20
): Array<{ paper_id: number; rank: number; hits: number }> {
  const match = buildFtsMatch(query)
  if (!match) return []
  const terms = ftsTerms(query)
  // bm25 加权排序（标题列 10 / 摘要 1 / 关键词 3）先取一屏；命中词数在 JS 侧统计
  //（FTS5 的 MATCH 不能用在 SELECT 表达式里，逐词取 rowid 集合后计数，每词一条查询）
  const fetchLimit = Math.min(Math.max(limit * 4, limit), 200)
  const rows = db
    .prepare(
      `SELECT rowid AS paper_id, bm25(papers_fts, 10.0, 1.0, 3.0) AS rank
       FROM papers_fts WHERE papers_fts MATCH ?
       ORDER BY rank LIMIT ?`
    )
    .all(match, fetchLimit) as Array<{ paper_id: number; rank: number }>
  if (terms.length === 0) return rows.map((r) => ({ ...r, hits: 0 }))
  const hitStmt = db.prepare('SELECT rowid FROM papers_fts WHERE papers_fts MATCH ?')
  const termSets = terms.map((t) => {
    const esc = escapeFtsTerm(t)
    return new Set((hitStmt.all(`"${esc}"* OR "${esc}"`) as Array<{ rowid: number }>).map((r) => r.rowid))
  })
  const withHits = rows.map((r) => ({ ...r, hits: termSets.filter((s) => s.has(r.paper_id)).length }))
  // 全部命中的排前面；同命中数按 bm25 rank
  withHits.sort((a, b) => b.hits - a.hits || a.rank - b.rank)
  return withHits.slice(0, limit)
}
