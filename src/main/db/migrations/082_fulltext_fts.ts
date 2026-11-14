import type { Migration } from './index'

/**
 * 082（uat3b 必须修 2）：papers_text_fts —— MinerU 原文（papers/<id>/mineru/full.md）
 * 的全文 FTS5 索引（searchLibrary 原文检索用，D77 不新增工具）。
 *
 * 一行一篇论文（rowid=paperId，seg 列为 Intl.Segmenter 预分词后的原文），与
 * papers_fts（元数据）并列；索引进退在 db/fulltextFts.ts，解析成功后写、启动时
 * backfill 补历史库。user_version 单一高水位：编号取全库当前最大（081）之后的 082。
 */
export const migration082: Migration = {
  version: 82,
  name: 'papers_fulltext_fts',
  up(db): void {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS papers_text_fts USING fts5 (seg, tokenize='porter unicode61')`)
  }
}
