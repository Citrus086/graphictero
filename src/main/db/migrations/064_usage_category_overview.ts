import type { Migration } from './index'

/**
 * 064（m6fix，D142）：usage_records.category 增加 'overview'（导出概览）。
 *
 * D132 当时把概览计入 'chat'，且明确不加 'export'。D142 改成单独类别，
 * 以便「用量与费用」和会话后台项能把它与对话分开。'export' 仍然拒绝。
 * 已含 'overview' 时直接返回（幂等）。写法对齐 062：重建表。
 */
export const migration064: Migration = {
  version: 64,
  name: 'usage_category_overview',
  up(db): void {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'usage_records'").get() as
      | { sql: string }
      | undefined
    if (row?.sql.includes("'overview'")) return
    db.exec(`
ALTER TABLE usage_records RENAME TO usage_records_old;

CREATE TABLE usage_records (
  id               INTEGER PRIMARY KEY,
  occurred_at      TEXT NOT NULL,
  category         TEXT NOT NULL CHECK (category IN ('chat', 'detail', 'relation', 'card', 'web', 'overview')),
  session_id       INTEGER,
  paper_id         INTEGER,
  model            TEXT,
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
  cache_miss_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  cost_cny         REAL NOT NULL DEFAULT 0,
  thinking         INTEGER NOT NULL DEFAULT 0
);

INSERT INTO usage_records
  (id, occurred_at, category, session_id, paper_id, model,
   input_tokens, cache_hit_tokens, cache_miss_tokens, output_tokens, cost_cny, thinking)
SELECT id, occurred_at, category, session_id, paper_id, model,
       input_tokens, cache_hit_tokens, cache_miss_tokens, output_tokens, cost_cny, thinking
FROM usage_records_old;

DROP TABLE usage_records_old;

CREATE INDEX idx_usage_time ON usage_records(occurred_at);
`)
  }
}
