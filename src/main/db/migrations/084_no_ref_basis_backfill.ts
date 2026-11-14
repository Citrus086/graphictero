import type Database from 'better-sqlite3'
import type { Migration } from './index'
import { computeAutoTypes } from '../../relations/autoTypes'
import type { RelationType } from '../../../shared/relationTypes'

/**
 * 084（uat4 建议修14b；uat4-fix1 D173/M2 修订）：no_ref_basis 回填。
 *
 * UAT 旧数据里「基于/改进」关系的 no_ref_basis 全是列默认值 0，分不清「已核过、
 * 有引用依据」与「老数据、从没核过」。本迁移对所有仍存活且 llm_types 含 based_on
 * 的 **AI 自动边**（source_type='job'，D174；手工 / session 边不参与——它们不是
 * 「AI 推断」，不打无引用依据标记）用**本地引用数据**逐条核一遍（不调 LLM、不联网、
 * 只读本地表）：
 *
 * - 两端都**没有** paper_references 行（引用匹配从没对这两篇跑过，老库常态）→
 *   **保持 0 不动**（0 的语义在此阶段是「还没核过」，不能当成「已核过、无依据」
 *   标 1——否则引用匹配修好后也不会有任何机制把它改回来，D173）；
 * - 有引用数据且有直接引用证据 → no_ref_basis = 0（显式 0：「已核过、有依据」）；
 * - 有引用数据但没有任何引用证据 → no_ref_basis = 1（「AI 推断 · 无引用依据」）。
 *
 * 判定口径与关系生成 D150 完全同源：直接调用 relations/autoTypes.ts 的
 * computeAutoTypes（它读 paper_references 双向匹配 + 图谱成员口径）。
 *
 * **引用数据更新后的重算**：paper_references 每次写入（OpenAlex 重取 / deepseek
 * 兜底，见 openalex/references.ts 与 referencesExtract.ts 的写库路径）都会调用
 * autoTypes.recalcNoRefBasis 对相关「基于/改进」边按同一口径重算，**允许 1→0
 * 与 0→1**——不存在「只能靠重新生成关系才改得回」的路径。幂等：结果是
 * paper_references 的纯函数，重复执行一致。
 */
export const migration084: Migration = {
  version: 84,
  name: 'no_ref_basis_backfill',
  up(db: Database.Database): void {
    const rows = db
      .prepare(
        `SELECT id, graph_id, paper_low, paper_high, src_paper, llm_types
         FROM relations
         WHERE deleted_at IS NULL AND no_ref_basis = 0 AND source_type = 'job'`
      )
      .all() as Array<{ id: number; graph_id: number; paper_low: number; paper_high: number; src_paper: number; llm_types: string }>
    const upd = db.prepare('UPDATE relations SET no_ref_basis = ? WHERE id = ?')
    const hasRefs = db.prepare('SELECT 1 AS ok FROM paper_references WHERE paper_id = ? LIMIT 1')
    for (const r of rows) {
      let llmTypes: RelationType[] = []
      try {
        llmTypes = JSON.parse(r.llm_types) as RelationType[]
      } catch {
        continue // 坏 JSON 不动（不该发生）
      }
      if (!llmTypes.includes('based_on')) continue // 只核「基于/改进」边（D150 口径）
      // D173：引用证据尚未核过（两端都无 paper_references 行）→ 保持 0，不写 1
      const dst = r.paper_low === r.src_paper ? r.paper_high : r.paper_low
      if (!hasRefs.get(r.src_paper) && !hasRefs.get(dst)) continue
      // 与生成器同源：cites 证据（paper_references 双向匹配，图谱成员口径）
      const auto = computeAutoTypes(db, r.graph_id, r.src_paper, dst)
      upd.run(auto.autoTypes.includes('cites') ? 0 : 1, r.id)
    }
  }
}
