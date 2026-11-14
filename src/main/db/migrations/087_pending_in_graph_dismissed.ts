import type Database from 'better-sqlite3'
import type { Migration } from './index'

/**
 * 087（uat6b S2）：遗留 pending + in_graph 候选改 dismissed（D169 收口）——
 *
 * uat5 的 085 只放宽了 status CHECK 加 'dismissed'，没有动存量数据；旧库里遗留的
 * `status='pending'` 且「已在本图谱中」的候选（如测试者 复测：SeekBench 候选 7，
 * pending、in_graph=1）此后每次重复提议都命中它去重，既不显示「已在本图谱中」徽标
 * 口径，也不符合 D169「落库即 dismissed」。
 *
 * 本迁移按 **D169 in_graph 判定**（与 proposeCandidate 落库口径一致）：候选已解析到
 * 的论文（existing_paper_id）是该图谱成员、未软删 → status='dismissed'、
 * reason='in_graph'（原因按 D169 口径写明，updated_at 随之刷新），其它字段不动；
 * 非 in_graph 的 pending、已 confirmed / dismissed / ignored 的行一律不动。幂等：
 * 第二遍无匹配行，零写入。
 */
export const migration087: Migration = {
  version: 87,
  name: 'pending_in_graph_candidates_dismissed',
  up(db: Database.Database): void {
    db.prepare(
      `UPDATE graph_candidates
       SET status = 'dismissed',
           reason = 'in_graph',
           updated_at = ?
       WHERE status = 'pending'
         AND existing_paper_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM graph_members m
           JOIN papers p ON p.id = m.paper_id
           WHERE m.graph_id = graph_candidates.graph_id
             AND m.paper_id = graph_candidates.existing_paper_id
             AND p.deleted_at IS NULL
         )`
    ).run(new Date().toISOString())
  }
}
