import type { Migration } from './index'

/**
 * 062（M6 前置 2d，维护者）：usage_records.category CHECK 放宽——加 'web'
 * （DeepSeek Search / Fetch 按次计价，D125；记账实现归 lane/fetch）。
 *
 * SQLite 改 CHECK 只能重建表：事务内改名 → 建新表（宽 CHECK）→ 复制数据 →
 * 删旧表 → 改名，行数与费用合计不变（回归测试在 database.test.ts）。索引随
 * 建表语句重建（idx_usage_time）。
 *
 * 口径：'export' 不加——导出概览的 LLM 调用按 D132 计入 'chat'（对话用量）。
 */
export const migration062: Migration = {
  version: 62,
  name: 'usage_category_web',
  up(db): void {
    db.exec(`
ALTER TABLE usage_records RENAME TO usage_records_old;

CREATE TABLE usage_records (
  id               INTEGER PRIMARY KEY,
  occurred_at      TEXT NOT NULL,
  category         TEXT NOT NULL CHECK (category IN ('chat', 'detail', 'relation', 'card', 'web')),
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
