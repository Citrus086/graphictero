import type { Migration } from './index'

/**
 * 063（lane/fetch 批 1，D130/D131）：PDF 来源尝试记录 pdf_attempts——
 * 03e「尝试过的来源 + 时间」（D65(6)）与「再试一次查找」（D133）的数据层。
 *
 * - 一次查找链里每个来源一行：arxiv / openalex / unpaywall / custom:<模板> / user_drop；
 * - result：not_found（来源没有给出链接）/ error（链接拿到但下载失败或内容不是 PDF）/ ok；
 * - at：ISO 时间串，页面按时间序展示（契约 PdfAttemptView，src/shared/ipc/cand.ts）。
 */
export const migration063: Migration = {
  version: 63,
  name: 'pdf_attempts',
  up(db): void {
    db.exec(`
CREATE TABLE pdf_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id INTEGER NOT NULL REFERENCES papers(id),
  source TEXT NOT NULL,
  url TEXT,
  result TEXT NOT NULL CHECK (result IN ('not_found', 'error', 'ok')),
  at TEXT NOT NULL
);
CREATE INDEX idx_pdf_attempts_paper ON pdf_attempts (paper_id, id);
`)
  }
}
