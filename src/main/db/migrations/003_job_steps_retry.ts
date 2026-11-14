import type Database from 'better-sqlite3'
import type { Migration } from './index'

/**
 * 003 任务步骤记录与重试调度（D70/D85）。
 *
 * - job_steps：任务按步骤记录（D85：解析/名片/详情为一篇论文一个任务，按步骤
 *   重试、从失败步骤接着跑、各篇互不阻塞）。每个 (job, step) 一行：状态、尝试
 *   次数、错误、起止时间。已 succeeded 的步骤在重试时直接跳过；
 * - jobs.next_retry_at：可重试错误自动重试 3 次的下次可执行时间（指数退避；
 *   429 时取 Retry-After，D53/D70）。调度器只捞 next_retry_at 到期的任务。
 */
export const migration003: Migration = {
  version: 3,
  name: 'job_steps_retry',
  up(db: Database.Database): void {
    db.exec(`
-- ── 任务步骤（D85：按步骤记录 / 从失败步骤接着跑）────────────────────
CREATE TABLE job_steps (
  job_id      INTEGER NOT NULL REFERENCES jobs (id),
  step        TEXT NOT NULL,               -- parse | card | detail（process_paper）
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  started_at  TEXT,
  finished_at TEXT,
  PRIMARY KEY (job_id, step)
);

-- 自动重试的下次可执行时间（指数退避 / 429 Retry-After；空 = 立即可执行）
ALTER TABLE jobs ADD COLUMN next_retry_at TEXT;
`)
  }
}
