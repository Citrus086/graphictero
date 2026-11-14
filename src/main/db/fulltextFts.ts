import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { segmentText } from './segment'
import { buildFtsMatch } from './fts'
import { stripInlineImages } from '../text/stripInlineImages'

/**
 * uat3b 必须修 2：MinerU 原文全文索引（papers_text_fts，迁移 082）。
 *
 * - 一行一篇论文（rowid=paperId），seg 列为 segmentText 预分词后的 full.md 原文；
 * - 解析成功即重建该篇索引（process_paper 步骤 1 写 full.md 后）；
 * - 启动 backfill（main/index.ts）给历史库补齐：有 full.md 而索引缺失的论文重建；
 * - 查询复用 fts.ts 的 buildFtsMatch 分词口径（与元数据检索同一套）。
 */

/** full.md 路径约定与 processPaper.mineruMarkdownPath 同源（避免循环依赖本地展开） */
function fullMarkdownPath(dataDir: string, paperId: number): string {
  return join(dataDir, 'papers', String(paperId), 'mineru', 'full.md')
}

/**
 * uat5 必须修 1（D141）：full.md 约九成体积是内嵌 base64 图片，索引前同样
 * 过 stripInlineImages（与送进 LLM 的文本同口径），占位 [图：alt]。磁盘 full.md 不动。
 */
export function indexFullTextFts(db: Database.Database, paperId: number, markdown: string): void {
  db.prepare('INSERT OR REPLACE INTO papers_text_fts (rowid, seg) VALUES (?, ?)').run(paperId, segmentText(stripInlineImages(markdown)))
}

/**
 * 若磁盘上有 full.md 就重建该篇全文索引（恢复软删论文 / 脏索引重建共用）。
 * 返回是否真的重建了（无 full.md 返回 false，幂等）。
 */
export function reindexFullTextFtsIfPresent(db: Database.Database, dataDir: string, paperId: number): boolean {
  const p = fullMarkdownPath(dataDir, paperId)
  if (!existsSync(p)) return false
  try {
    indexFullTextFts(db, paperId, readFileSync(p, 'utf8'))
    return true
  } catch {
    return false
  }
}

export function removeFullTextFts(db: Database.Database, paperId: number): void {
  db.prepare('DELETE FROM papers_text_fts WHERE rowid = ?').run(paperId)
}

/** 全文检索：bm25 排序，返回命中的论文 id 列表（rank 越小越相关）。 */
export function searchFullText(
  db: Database.Database,
  query: string,
  limit = 10
): Array<{ paper_id: number; rank: number }> {
  const match = buildFtsMatch(query)
  if (!match) return []
  return db
    .prepare('SELECT rowid AS paper_id, bm25(papers_text_fts) AS rank FROM papers_text_fts WHERE papers_text_fts MATCH ? ORDER BY rank LIMIT ?')
    .all(match, limit) as Array<{ paper_id: number; rank: number }>
}

/**
 * uat6b 必须修 M1：脏索引判定（含 base64 内嵌图片分词残留），**不依赖分词器
 * ICU 版本**——`Intl.Segmenter` 对 `data:image/png;base64,…` 的切分随 ICU 版本不同：
 * - Node 26 / ICU 78：单个 token `data:image`（冒号不断开）→ ` data:image ` 词边界命中；
 * - Electron 35 / ICU 74：`data` `image` `png` `base64` 四个相邻 token（uat5 复测证据：
 *   旧索引行含 `data image jpeg base64 …` 词序列）→ 匹配「`data image` + 单 token
 *   + `base64`」相邻序列。
 * 两种形态都识别；重建走 stripInlineImages → 占位 `[图：alt]` 不含 base64 词，
 * 第二次启动不再命中（幂等）。正文里自然出现的英文 "data image" 短语后面不紧跟
 * 「单 token + base64」，不会误触发。
 */
export function looksLikeLegacyBase64Index(seg: string | null | undefined): boolean {
  if (!seg) return false
  const s = ` ${seg} `
  if (s.includes(' data:image ')) return true // ICU 78 形态：单 token
  // ICU 74 形态：` data image <mime> base64 ` 相邻 token 序列（mime 为无空格单 token）
  const needle = ' data image '
  let from = 0
  for (;;) {
    const i = s.indexOf(needle, from)
    if (i < 0) return false
    if (/^\S+ base64 /.test(s.slice(i + needle.length))) return true
    from = i + 1
  }
}

/**
 * 启动 backfill：库里有 full.md 但全文索引缺失（老库刚升级 / 索引被清）的论文重建索引。
 * 返回补建的论文数（日志用）。FTS5 表对任何库都可查询（老库经 082 迁移建表）。
 */
export function backfillFullTextFts(db: Database.Database, dataDir: string): number {
  // uat6b M1：脏检查在 JS 里按内容判定（looksLikeLegacyBase64Index），seg 为 NULL =
  // 索引缺失，同样补建；不依赖分词器版本，Electron（ICU 74）/ Node（ICU 78）都命中。
  const rows = db
    .prepare(
      `SELECT p.id, f.seg AS seg FROM papers p
       LEFT JOIN papers_text_fts f ON f.rowid = p.id
       WHERE p.deleted_at IS NULL`
    )
    .all() as Array<{ id: number; seg: string | null }>
  let n = 0
  for (const { id, seg } of rows) {
    if (seg != null && !looksLikeLegacyBase64Index(seg)) continue // 有索引且干净：跳过
    if (reindexFullTextFtsIfPresent(db, dataDir, id)) n += 1 // 缺索引补建 / 脏索引重建
  }
  return n
}
