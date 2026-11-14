import type { Migration } from './index'

/**
 * 081（uat2-fix1，编号取 uat1b 授权号段 080–089 内 080 之后首个空号）：relations 增列
 * —— D149 edited_at（手动编辑 AI 边的时间标记）、D150 no_ref_basis（基于/改进无引用依据）。
 *
 * 这是 uat2b 迁移（原文件 011，version 11）的**修正版**：user_version 是单一高水位，
 * 已有库已跑到 80，version 11 永远不会执行，读关系时 SQL 直接失败（评审 review_uat2
 * 必须修 1）。改 81 后两种库态都要能过，因此 SQL 按列幂等：
 * ① 用户 / UAT 现有库 user_version=80 且**没有**这两列 → 补列；
 * ② uat2b 期间在本分支新建过的库**已有**这两列、但 user_version 被 80 盖过 → 跳过不报错。
 * table_info 缺哪列才 ALTER 哪列。
 */
export const migration081: Migration = {
  version: 81,
  name: 'relation_edited_and_ref_basis',
  up(db): void {
    const cols = new Set((db.pragma('table_info(relations)') as Array<{ name: string }>).map((c) => c.name))
    if (!cols.has('edited_at')) {
      db.exec('ALTER TABLE relations ADD COLUMN edited_at TEXT;')
    }
    if (!cols.has('no_ref_basis')) {
      db.exec('ALTER TABLE relations ADD COLUMN no_ref_basis INTEGER NOT NULL DEFAULT 0;')
    }
  }
}
