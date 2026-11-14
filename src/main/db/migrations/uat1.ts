import type { Migration } from './index'
import { migration080 } from './080_pdf_unresolved'
import { migration085 } from './085_candidate_verified'
import { migration086 } from './086_paper_references_rematch'
import { migration087 } from './087_pending_in_graph_dismissed'
import { migration088 } from './088_usage_reasoning_tokens'
import { migration089 } from './089_candidate_in_graph_reason_restore'
import { migration090 } from './090_jobs_superseded_at'

/**
 * lane/uat1(b) 迁移聚合。编号：uat1b 用 **080–089**（080 已用：papers.pdf_unresolved；
 * 081–084 聚合在 relations.ts 的 REL_MIGRATIONS；085（uat5）起收编进本文件；
 * 086（uat6）引用行重匹配；087（uat6b S2）遗留 pending+in_graph 候选改 dismissed；
 * 088（uat7 D180）usage_records.reasoning_tokens；089（uat6c M1）087 覆盖的候选
 * 理由恢复 / 置空，状态与理由分开存（in_graph 列）；090（uat6c S2）jobs 加
 * superseded_at 列 + 同组旧失败被成功取代的一次性清理）。
 * 新建 `NNN_xxx.ts`（导出 `migrationNNN`，写法对齐 060–063）后在此加一行。
 */
export const UAT1_MIGRATIONS: Migration[] = [migration080, migration085, migration086, migration087, migration088, migration089, migration090]
