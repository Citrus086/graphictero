import type { Migration } from './index'
import { migration063 } from './063_pdf_attempts'
import { migration064 } from './064_usage_category_overview'

/**
 * lane/fetch（M6）车道迁移聚合（骨架）。
 *
 * 编号：lane/fetch 用 **063–069**；备用 **070–079**；**080+ 需维护者分配**。
 * 新建 `NNN_xxx.ts`（导出 `migrationNNN`，写法对齐 060–062）后在此加一行；
 * 不改 migrations/index.ts（聚合行已由维护者加上）。预计首批：
 * 063 pdf_attempts（PDF 来源尝试记录，m6_plan §5.1）。
 */
export const FETCH_MIGRATIONS: Migration[] = [migration063, migration064]
