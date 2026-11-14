import type Database from 'better-sqlite3'
import { buildShortIds } from '../relations/context'
import { citePaper, replaceInternalRefTokens } from './internalRefs'

/**
 * D150：导出/显示层共用的图谱级 P0x → 简称 替换。
 *
 * 口径与关系生成一致（context.ts buildShortIds）：图内论文按 id 升序，P01 起。
 * 旧关系陈述里残留的内部短 id（P01…P99）在导出时换成《短标题》或「作者, 年份」；
 * 数据库不改，只替换导出文本。映射对不上 / 越界的编号直接剔除（token 被
 * replaceInternalRefTokens 剔除），保证导出不出现 `\bP\d{2}\b`。NEW / #N 记号
 * 也一律剔除（导出口径不解析这两种内部记号）。
 */

interface MemberRow {
  id: number
  title: string
  first_author: string | null
  year: number | null
}

/** 建一个把文本里的 P0x 换成引用的 replacer。图谱成员（未删）按 id 升序编 P01…。 */
export function buildGraphShortIdReplacer(db: Database.Database, graphId: number): (text: string) => string {
  const rows = db
    .prepare(
      `SELECT p.id, p.title, p.first_author, p.year
       FROM graph_members m
       JOIN papers p ON p.id = m.paper_id
       WHERE m.graph_id = ? AND p.deleted_at IS NULL
       ORDER BY p.id`
    )
    .all(graphId) as MemberRow[]
  const { shortToId } = buildShortIds(rows)
  const infoById = new Map(rows.map((r) => [r.id, { title: r.title, firstAuthor: r.first_author, year: r.year }]))
  return (text: string) =>
    replaceInternalRefTokens(text, (token) => {
      // 只认 P\d{2}（P01…P99）；越界编号与 NEW / #N 一律返回 null → 剔除
      if (!/^P\d{2}$/.test(token)) return null
      const paperId = shortToId.get(token)
      if (paperId == null) return null
      const info = infoById.get(paperId)
      return info ? citePaper(info) : null
    })
}
