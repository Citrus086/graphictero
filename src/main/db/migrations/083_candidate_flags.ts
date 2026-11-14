import type { Migration } from './index'

/**
 * 083（uat3b D159/D161）：graph_candidates 增列——
 * - title_dup：只有规范化标题命中库中论文（DOI/arXiv/wid 都没中）时的「可能是另一
 *   版本」提示标记（D159 不自动拦截，卡片上提示）；
 * - in_graph：候选去重命中（DOI/arXiv/wid，**不含仅标题命中**，与 D159 一致）的论文
 *   **已在当前图谱**时不建画布候选节点，卡片显示「已在本图谱中」（D161）。
 * 按列幂等（081 先例）：table_info 缺哪列才 ALTER 哪列。
 */
export const migration083: Migration = {
  version: 83,
  name: 'candidate_dedupe_flags',
  up(db): void {
    const cols = new Set((db.pragma('table_info(graph_candidates)') as Array<{ name: string }>).map((c) => c.name))
    if (!cols.has('title_dup')) {
      db.exec('ALTER TABLE graph_candidates ADD COLUMN title_dup INTEGER NOT NULL DEFAULT 0;')
    }
    if (!cols.has('in_graph')) {
      db.exec('ALTER TABLE graph_candidates ADD COLUMN in_graph INTEGER NOT NULL DEFAULT 0;')
    }
  }
}
