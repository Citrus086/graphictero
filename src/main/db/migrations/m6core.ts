import type { Migration } from './index'
import { migration060 } from './060_relation_snapshots'
import { migration061 } from './061_candidate_columns'
import { migration062 } from './062_usage_category_web'

/**
 * M6 维护者前置迁移聚合（060 起）。
 *
 * 编号：**060–062 维护者前置**（060 relation_snapshots + 消息费用列；061 候选直达列；
 * 062 usage_records 放宽 'web'）；lane/fetch 用 063–069（./fetch.ts 的
 * FETCH_MIGRATIONS）；备用 070–079；080+ 需维护者分配。新建 `NNN_xxx.ts`
 * （导出 `migrationNNN`，写法对齐 040/041）后在此加一行；不改 migrations/index.ts
 * （060+ 的聚合行已由维护者加上）。
 */
export const M6CORE_MIGRATIONS: Migration[] = [migration060, migration061, migration062]
