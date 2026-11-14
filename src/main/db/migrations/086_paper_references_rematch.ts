import type Database from 'better-sqlite3'
import type { Migration } from './index'
import { rematchPaperReferences } from '../../relations/refRematch'

/**
 * 086（uat6 M2）：已有 paper_references 行的幂等重匹配 + D174 重算。
 *
 * 旧数据 matched_paper_id 全 NULL（只在 INSERT 时写一次，D165 匹配修复够不着
 * 已有行）——本迁移离线重匹配全部 NULL 行（复用 matchRefToLibrary / arxivIdOf /
 * computeAutoTypes / recalcNoRefBasis，不联网），随后只对受影响的 **AI 自动边**
 * （source_type='job'，D174）重算 auto_types（引用 cites）与 no_ref_basis；
 * 手工 / session 边不动；不改方向、不写 statement_text、不改 updated_at（084 口径）。
 * 只填 NULL → 非空，已非空的行不动；幂等（第二遍零写入，测试锁定表级快照一致）。
 */
export const migration086: Migration = {
  version: 86,
  name: 'paper_references_rematch',
  up(db: Database.Database): void {
    rematchPaperReferences(db)
  }
}
