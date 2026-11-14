import type Database from 'better-sqlite3'
import type { Migration } from './index'

/**
 * 001 初始建表（D23/D61/D70/D75/D84/D89）。
 *
 * 取舍说明（设计文档没写死、按最贴近文档的做法，详见 PROGRESS）：
 * - 时间统一存 ISO 字符串（new Date().toISOString()）。
 * - 关系方向：paper_low/paper_high 固定无序对（low < high，CHECK 保证），
 *   src_paper 指出方向的那一端；A → B 表示「B 基于/针对 A」（D75）。
 * - 关系类型固定集合（D84）：基于/改进、具体实现、对比、引用、同一作者。
 *   llm_types（LLM 判断）与 auto_types（程序自动附加，D89）分开存 JSON 数组。
 * - papers 的 DOI / arXiv ID / Zotero key 唯一性用部分索引（软删除行不参与，
 *   删除后允许重新入库，D75）。
 */
export const migration001: Migration = {
  version: 1,
  name: 'init',
  up(db: Database.Database): void {
    db.exec(`
-- ── 论文库（D61 CSL-JSON + 常用字段索引列）────────────────────────────
CREATE TABLE papers (
  id                   INTEGER PRIMARY KEY,
  csl_json             TEXT NOT NULL DEFAULT '{}',   -- D61：CSL-JSON 完整元数据
  title                TEXT NOT NULL DEFAULT '',
  first_author         TEXT,                          -- 第一作者姓（去重用，D71）
  year                 INTEGER,
  doi                  TEXT,                          -- 归一化（小写、去空白）
  arxiv_id             TEXT,                          -- 去重用（D55/D82）
  openalex_wid         TEXT,                          -- 引用比较用 W-ID（D71）
  zotero_library_id    INTEGER,                       -- D75：重新导入恢复内部 ID
  zotero_item_key      TEXT,
  source               TEXT NOT NULL DEFAULT 'zotero' -- zotero | agent
                       CHECK (source IN ('zotero', 'agent')),
  has_pdf              INTEGER NOT NULL DEFAULT 0,    -- D62 PDF 状态
  pdf_source           TEXT CHECK (pdf_source IN
                       ('zotero', 'open_access', 'institution_proxy', 'custom', 'user_drop')), -- D54
  abstract             TEXT,
  abstract_source      TEXT CHECK (abstract_source IN ('original', 'ai', 'openalex')), -- D46/D54
  one_liner            TEXT,                          -- D45 一句话摘要
  pdf_hash             TEXT,                          -- D29 详情「可能已过期」判断
  deleted_at           TEXT,                          -- D75 软删除（记删除时间，可恢复）
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_papers_doi ON papers (doi)
  WHERE doi IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX idx_papers_arxiv ON papers (arxiv_id)
  WHERE arxiv_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX idx_papers_zotero ON papers (zotero_library_id, zotero_item_key)
  WHERE zotero_item_key IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_papers_year ON papers (year);

-- 关键词（D74：归一化后存，用于 FTS5 检索）
CREATE TABLE paper_keywords (
  paper_id INTEGER NOT NULL REFERENCES papers (id),
  keyword  TEXT NOT NULL,
  PRIMARY KEY (paper_id, keyword)
);

-- ── 图谱与成员（D75：从图谱移除只删 graph_members 和相关关系）─────────
CREATE TABLE graphs (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE graph_members (
  graph_id INTEGER NOT NULL REFERENCES graphs (id),
  paper_id INTEGER NOT NULL REFERENCES papers (id),
  x        REAL NOT NULL DEFAULT 0,   -- 画布坐标
  y        REAL NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL,
  PRIMARY KEY (graph_id, paper_id)
);

-- 候选节点（Agent 发现的未确认论文，D26/D55）
CREATE TABLE graph_candidates (
  id                 INTEGER PRIMARY KEY,
  graph_id           INTEGER NOT NULL REFERENCES graphs (id),
  title              TEXT NOT NULL DEFAULT '',
  authors_json       TEXT NOT NULL DEFAULT '[]',
  year               INTEGER,
  doi                TEXT,
  arxiv_id           TEXT,
  existing_paper_id  INTEGER REFERENCES papers (id), -- D55：去重命中「已在库中」
  reason             TEXT,                          -- 推荐理由
  x                  REAL NOT NULL DEFAULT 0,
  y                  REAL NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'confirmed', 'ignored')),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_candidates_graph ON graph_candidates (graph_id, status);

-- ── 关系（D75/D83/D84/D89）───────────────────────────────────────────
CREATE TABLE relations (
  id                INTEGER PRIMARY KEY,
  graph_id          INTEGER NOT NULL REFERENCES graphs (id),
  paper_low         INTEGER NOT NULL REFERENCES papers (id),
  paper_high        INTEGER NOT NULL REFERENCES papers (id),
  src_paper         INTEGER NOT NULL,                 -- 方向：等于 paper_low 或 paper_high
  statement_text    TEXT NOT NULL DEFAULT '',    -- D83 自然语言陈述（不限一句；避开常用词 statement 命名）
  llm_types         TEXT NOT NULL DEFAULT '[]',       -- D84 LLM 判断的类型（JSON 数组）
  auto_types        TEXT NOT NULL DEFAULT '[]',       -- D89 程序自动附加：引用 / 同一作者
  source_type       TEXT NOT NULL                     -- D75 provenance: job | session
                    CHECK (source_type IN ('job', 'session')),
  source_job_id     INTEGER REFERENCES jobs (id),
  source_session_id INTEGER,
  model             TEXT,                             -- 生成所用模型
  prompt_version    TEXT,
  deleted_at        TEXT,                             -- 软删除
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CHECK (paper_low < paper_high),
  CHECK (src_paper IN (paper_low, paper_high))
);
-- D89：同一图谱同一无序论文对只有一条边（软删除的行不参与唯一性）
CREATE UNIQUE INDEX idx_relations_pair ON relations (graph_id, paper_low, paper_high)
  WHERE deleted_at IS NULL;

-- ── 统一任务表（D70，七种状态）───────────────────────────────────────
CREATE TABLE jobs (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,   -- parse_detail | relation_gen | reference_fetch |
                               -- detail_regen | candidate_pdf（kind 名称为建议值，D70）
  graph_id    INTEGER REFERENCES graphs (id),
  paper_id    INTEGER REFERENCES papers (id),
  status      TEXT NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued', 'running', 'waiting_network', 'waiting_key',
                                'failed_retryable', 'failed_action', 'succeeded')),
  current_step TEXT,           -- 当前步骤：解析 / 解析后处理 / 生成详情…
  failed_step  TEXT,           -- 失败在哪一步
  error        TEXT,
  retry_count  INTEGER NOT NULL DEFAULT 0,
  progress     REAL,           -- 0..1
  payload      TEXT NOT NULL DEFAULT '{}',  -- JSON：已处理论文、MinerU 任务 id、总超时…（D73/D85/D86）
  started_at   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_jobs_status ON jobs (status, kind);

-- ── 引用记录（D40/D71：只用 OpenAlex，比较 W-ID 集合）────────────────
CREATE TABLE paper_references (
  id               INTEGER PRIMARY KEY,
  paper_id         INTEGER NOT NULL REFERENCES papers (id),
  openalex_wid     TEXT,
  doi              TEXT,
  title            TEXT,
  year             INTEGER,
  matched_paper_id INTEGER REFERENCES papers (id),   -- 未匹配为空
  source           TEXT NOT NULL DEFAULT 'openalex'  -- openalex | deepseek（兜底）
                   CHECK (source IN ('openalex', 'deepseek')),
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_references_paper ON paper_references (paper_id);

-- ── 论文详情缓存（D18/D20/D29，跨图谱共享，D6）────────────────────────
CREATE TABLE paper_details (
  paper_id       INTEGER PRIMARY KEY REFERENCES papers (id),
  parts          TEXT NOT NULL,        -- UIMessage parts JSON（D20）
  model          TEXT,
  prompt_version TEXT,                 -- D29：prompt 版本变化提示「可能已过期」
  pdf_hash       TEXT,                 -- D29：PDF 换版（文件哈希变化）提示
  generated_at   TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- ── 会话（D7 属于图谱；D28 观察日志 + 已压缩原文可回查）───────────────
CREATE TABLE sessions (
  id         INTEGER PRIMARY KEY,
  graph_id   INTEGER NOT NULL REFERENCES graphs (id),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('graph', 'paper', 'relation')),
  entry_id   INTEGER,
  name       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_graph ON sessions (graph_id);

CREATE TABLE session_messages (
  id         INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions (id),
  seq        INTEGER NOT NULL,          -- 会话内序号，保序
  role       TEXT NOT NULL,             -- user | assistant | system
  parts      TEXT NOT NULL,             -- UIMessage parts JSON
  created_at TEXT NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE TABLE session_observations (   -- D28 观察日志：带日期、重要程度的要点
  id         INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions (id),
  content    TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 0,
  logged_at  TEXT NOT NULL
);

CREATE TABLE session_archives (       -- D28：被压缩的旧原文不丢弃，可回查
  id         INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions (id),
  seq_from   INTEGER NOT NULL,
  seq_to     INTEGER NOT NULL,
  parts      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- ── 标注（D27，PDF 阅读器高亮与笔记）─────────────────────────────────
CREATE TABLE annotations (
  id         INTEGER PRIMARY KEY,
  paper_id   INTEGER NOT NULL REFERENCES papers (id),
  page       INTEGER NOT NULL,
  bbox       TEXT,                      -- JSON：[x, y, w, h]（PDF 页面坐标，PDF 点，左上原点）
  type       TEXT NOT NULL CHECK (type IN ('highlight', 'note')),
  text       TEXT NOT NULL DEFAULT '',
  color      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_annotations_paper ON annotations (paper_id);

-- ── 用量记录（D58/D79，本地换算人民币费用）───────────────────────────
CREATE TABLE usage_records (
  id               INTEGER PRIMARY KEY,
  occurred_at      TEXT NOT NULL,       -- 按请求发生时间区分高峰 / 空闲价（D79）
  category         TEXT NOT NULL CHECK (category IN ('chat', 'detail', 'relation', 'card')),
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
CREATE INDEX idx_usage_time ON usage_records (occurred_at);

-- ── PDF 来源列表（D54，可配置有序列表）───────────────────────────────
CREATE TABLE pdf_sources (
  id           INTEGER PRIMARY KEY,
  position     INTEGER NOT NULL,        -- 有序
  name         TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('open_access', 'institution_proxy', 'url_template')),
  url_template TEXT,                    -- 含 {doi} 的 URL 模板
  enabled      INTEGER NOT NULL DEFAULT 1
);

-- ── 全文检索（D74：porter unicode61 + Intl.Segmenter 预分词）──────────
CREATE VIRTUAL TABLE papers_fts USING fts5 (
  title_seg,
  abstract_seg,
  keywords_seg,
  tokenize = 'porter unicode61'
);
`)
  }
}
