import type Database from 'better-sqlite3'
import type { Migration } from './index'

/**
 * 002 设置落点、会话读取记录、D93 作者支撑表、PDF 来源代理列。
 *
 * - app_settings（kv）：设置类字段的落点——数据目录根位置（D83）、Unpaywall 邮箱
 *   （D64）、模型/服务商选择等；API Key 仍按 D34 存数据目录 .env，不进库；
 * - session_traces：Session 的「读取记录（trace）」（设计文档 Session 字段），
 *   Agent 每次工具读取留一行，可展开原文（D8）；
 * - paper_authors：作者全名拆解 + D93 规范化名，「同一作者」自动关系
 *   （规范化后精确比较，不做模糊匹配/缩写推断）直接查这张表，不用每次解析 csl_json；
 * - pdf_sources 补机构代理列（D64：登录状态、登录入口 URL）。
 */
export const migration002: Migration = {
  version: 2,
  name: 'settings_trace_authors',
  up(db: Database.Database): void {
    db.exec(`
-- ── 应用设置（kv；API Key 不进库，按 D34 存 .env）────────────────────
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

-- ── 会话读取记录（trace，设计文档 Session 字段；D8 灰色读取记录的数据源）──
CREATE TABLE session_traces (
  id         INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  tool_name  TEXT NOT NULL,             -- 读取工具名（建议值，如 read_paper_section）
  paper_id   INTEGER REFERENCES papers(id),
  summary    TEXT NOT NULL DEFAULT '',  -- 一行摘要（对话里灰色行显示的文本）
  excerpt    TEXT                         -- 展开的原文片段
);
CREATE INDEX idx_session_traces_session ON session_traces(session_id, id);

-- ── 论文作者表（D93「同一作者」自动关系的判等依据）─────────────────────
CREATE TABLE paper_authors (
  paper_id       INTEGER NOT NULL REFERENCES papers(id),
  position       INTEGER NOT NULL,      -- 作者顺序（0 起）
  family         TEXT,                  -- 姓
  given          TEXT,                  -- 名
  normalized     TEXT NOT NULL,         -- D93 规范化全名（小写/去重音/去标点/名姓顺序/合并空格）
  PRIMARY KEY (paper_id, position)
);
CREATE INDEX idx_paper_authors_normalized ON paper_authors(normalized);

-- ── PDF 来源：机构代理登录状态（D64）────────────────────────────────
ALTER TABLE pdf_sources ADD COLUMN proxy_login_url TEXT;   -- 代理登录入口
ALTER TABLE pdf_sources ADD COLUMN proxy_login_status TEXT
  CHECK (proxy_login_status IN ('logged_in', 'logged_out', 'expired'));
`)
  }
}
