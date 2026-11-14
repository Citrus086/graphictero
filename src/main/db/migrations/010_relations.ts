import type { Migration } from './index'

/**
 * 010 lane/relations 车道：关系生成的进度记录 + DOI 匹配方式（D71）。
 *
 * - relation_gen_progress：关系生成任务按论文记「已处理」（D86）——首建整图生成
 *   与逐篇新增共用；截断 / 失败后续跑时跳过已处理的论文，只补漏掉的；
 * - papers.doi_match_method：D71「记录用的是哪种匹配方式」——original（Zotero /
 *   导入原有）/ openalex_title（按标题找回，三条阈值）；按标题找回的 DOI 不参与
 *   自动去重（D71）；
 * - paper_references 表在 001 已建（含 source openalex|deepseek 的 D40 兜底列），
 *   本迁移不动它。
 */
export const migration010: Migration = {
  version: 10,
  name: 'relations_progress_doi_method',
  up(db): void {
    db.exec(`
-- ── 关系生成进度：按论文记「已处理」（D86）───────────────────────────
CREATE TABLE relation_gen_progress (
  graph_id INTEGER NOT NULL REFERENCES graphs(id),
  paper_id INTEGER NOT NULL REFERENCES papers(id),
  done_at  TEXT NOT NULL,
  PRIMARY KEY (graph_id, paper_id)
);

-- ── papers 补 DOI 匹配方式（D71：记录 original / openalex_title）─────
ALTER TABLE papers ADD COLUMN doi_match_method TEXT
  CHECK (doi_match_method IN ('original', 'openalex_title'));
`)
  }
}
