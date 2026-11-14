import type Database from 'better-sqlite3'

/**
 * 论文是否属于某图谱：graph_members 成员且未删除。
 * restoreRelation（⌘Z 恢复，评审建议修 5）与引擎共用同一口径；
 * 不限 has_pdf——手工边可以连无 PDF 的论文，PDF 门槛是引擎生成/引用步骤
 * 自己的参与条件（D62），不属于「属于本图」的语义。
 */
export function paperInGraph(db: Database.Database, graphId: number, paperId: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM graph_members m JOIN papers p ON p.id = m.paper_id
         WHERE m.graph_id = ? AND p.id = ? AND p.deleted_at IS NULL`
      )
      .get(graphId, paperId) != null
  )
}

/**
 * uat6b S3：本图成员（未软删）论文 id 集合——与画布同口径。Agent 侧读关系的出口
 * （listRelations / 起始上下文的关系摘要）只返回两端都是成员的边；指向非成员论文的
 * 遗留边画布已隐藏，工具侧不再漏出（不删库里的行）。
 */
export function graphMemberIds(db: Database.Database, graphId: number): Set<number> {
  const rows = db
    .prepare(
      `SELECT p.id FROM graph_members m JOIN papers p ON p.id = m.paper_id
       WHERE m.graph_id = ? AND p.deleted_at IS NULL ORDER BY p.id`
    )
    .all(graphId) as Array<{ id: number }>
  return new Set(rows.map((r) => r.id))
}

/**
 * uat6c S1：「两端都是本图成员（未软删）的活关系」的 SQL 条件片段（别名 r =
 * relations）——与画布（目标节点不存在即不画）、uat6b S3 的 Agent listRelations、
 * 导出（loadExportGraph 按成员 byId 过滤）同一口径。图谱列表 / 头部计数
 * （appService listGraphs / getGraphDetail）与关系读取（appService listRelations）
 * 共用本片段，三处同源；指向非成员论文的遗留边不计数、不出列表（不删库里的行）。
 */
export const MEMBER_RELATION_SQL = `r.deleted_at IS NULL
  AND EXISTS (
    SELECT 1 FROM graph_members ml JOIN papers pl ON pl.id = ml.paper_id
    WHERE ml.graph_id = r.graph_id AND ml.paper_id = r.paper_low AND pl.deleted_at IS NULL
  )
  AND EXISTS (
    SELECT 1 FROM graph_members mh JOIN papers ph ON ph.id = mh.paper_id
    WHERE mh.graph_id = r.graph_id AND mh.paper_id = r.paper_high AND ph.deleted_at IS NULL
  )`
