import type { Migration } from './index'

/**
 * 085（uat5 D168/D169）：graph_candidates——
 * - verified：OpenAlex 回填核对标记。1=已核实（本地库命中 / OpenAlex 核对通过 /
 *   未做联网核对）；0=核对失败（uat5 必须修 2：DOI 解析到错误记录、标题不相似、
 *   或 D168 只给标题时找不到可核实记录），卡片低调显示「未核实」/
 *   「未找到可核实的记录」。按列幂等（081 先例）。
 * - status CHECK 放宽加 'dismissed'（D169：已在本图谱中的候选自动收起，
 *   reason=in_graph）。SQLite 不能改 CHECK，整表重建（rename→create→copy→drop），
 *   数据原样拷回、索引重建。runMigrations 已包在外层事务里，这里不再 BEGIN。
 *   无外键指向本表（001 全文无 REFERENCES graph_candidates），重建安全。
 */
export const migration085: Migration = {
  version: 85,
  name: 'candidate_verified_and_dismissed',
  up(db): void {
    const cols = new Set((db.pragma('table_info(graph_candidates)') as Array<{ name: string }>).map((c) => c.name))
    if (!cols.has('verified')) {
      db.exec('ALTER TABLE graph_candidates ADD COLUMN verified INTEGER NOT NULL DEFAULT 1;')
    }
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'graph_candidates'").get() as
      | { sql: string | null }
      | undefined)?.sql
    if (sql && !sql.includes("'dismissed'")) {
      db.exec(`
ALTER TABLE graph_candidates RENAME TO graph_candidates_old;
CREATE TABLE graph_candidates (
  id                 INTEGER PRIMARY KEY,
  graph_id           INTEGER NOT NULL REFERENCES graphs (id),
  title              TEXT NOT NULL DEFAULT '',
  authors_json       TEXT NOT NULL DEFAULT '[]',
  year               INTEGER,
  doi                TEXT,
  arxiv_id           TEXT,
  existing_paper_id  INTEGER REFERENCES papers (id),
  reason             TEXT,
  x                  REAL NOT NULL DEFAULT 0,
  y                  REAL NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'confirmed', 'ignored', 'dismissed')),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  session_id         INTEGER REFERENCES sessions(id),
  paper_id           INTEGER REFERENCES papers(id),
  venue              TEXT,
  openalex_wid       TEXT,
  abstract           TEXT,
  oa_url             TEXT,
  title_dup          INTEGER NOT NULL DEFAULT 0,
  in_graph           INTEGER NOT NULL DEFAULT 0,
  verified           INTEGER NOT NULL DEFAULT 1
);
INSERT INTO graph_candidates SELECT * FROM graph_candidates_old;
DROP TABLE graph_candidates_old;
CREATE INDEX idx_candidates_graph ON graph_candidates (graph_id, status);
`)
    }
  }
}
