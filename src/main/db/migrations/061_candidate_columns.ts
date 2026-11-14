import type { Migration } from './index'

/**
 * 061（M6 前置 2b，维护者）：graph_candidates 直达列——确认入库后的论文、
 * 检索时拿到的元数据（免得确认时再查一次 OpenAlex）。
 *
 * - paper_id：库外候选确认入库后回填（D124：候选存 App 自有库）；
 * - venue / openalex_wid / abstract / oa_url：searchPapers（lane/fetch）检索时写入；
 *   oa_url 是 best_oa_location，PDF 查找链直接用（m6_plan §3.1）。
 * 全部可空：M5 既有候选行与「已在库中」候选没有这些值。
 */
export const migration061: Migration = {
  version: 61,
  name: 'candidate_direct_columns',
  up(db): void {
    db.exec(`
ALTER TABLE graph_candidates ADD COLUMN paper_id INTEGER REFERENCES papers(id);
ALTER TABLE graph_candidates ADD COLUMN venue TEXT;
ALTER TABLE graph_candidates ADD COLUMN openalex_wid TEXT;
ALTER TABLE graph_candidates ADD COLUMN abstract TEXT;
ALTER TABLE graph_candidates ADD COLUMN oa_url TEXT;
`)
  }
}
