import type { Migration } from './index'

/**
 * 080（lane/uat1b，uat1b 第 2 部分）：papers.pdf_unresolved——
 * 「Zotero 条目有 PDF 附件但导入时没取到文件」的事实标记。
 *
 * 详情页来源行按真实状态显示（「条目有 PDF 附件，但没找到文件」vs「条目没有
 * PDF 附件」）；重新导入/拖入/查找补齐 PDF 后清零。有 PDF 的论文恒为 0。
 * （080 起编号原标注「需维护者分配」——uat1b 任务书授权按仓库迁移号规则加列，
 * 取首个未用号 080。）
 */
export const migration080: Migration = {
  version: 80,
  name: 'pdf_unresolved',
  up(db): void {
    db.exec(`
ALTER TABLE papers ADD COLUMN pdf_unresolved INTEGER NOT NULL DEFAULT 0;
`)
  }
}
