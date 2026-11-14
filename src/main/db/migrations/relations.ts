import type { Migration } from './index'
import { migration010 } from './010_relations'
import { migration081 } from './081_relation_edited'
import { migration082 } from './082_fulltext_fts'
import { migration083 } from './083_candidate_flags'
import { migration084 } from './084_no_ref_basis_backfill'

/**
 * lane/relations 来源的迁移聚合。
 *
 * 历史号段：010（relation_gen_progress 等）。**注意：user_version 是单一高水位，
 * 不存在「车道号段」——后续迁移必须取全库当前最大版本之后的号**（评审 review_uat2
 * 必须修 1：uat2b 曾把 relations 加列迁移标成 011，已有库（≥80）永远不会执行）。
 * 081（relations 加列 edited_at / no_ref_basis）因此放在这里而不是新建文件堆。
 * 082（papers_text_fts 全文索引，uat3b 必须修 2）、083（graph_candidates 去重标记列，
 * D159/D161）、084（no_ref_basis 回填，uat4 建议修14b）按「全库最大版本之后顺排」
 * 惯例一并聚合在此。
 */
export const REL_MIGRATIONS: Migration[] = [migration010, migration081, migration082, migration083, migration084]
