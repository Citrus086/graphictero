import type { Migration } from './index'

/**
 * M4 车道迁移聚合（骨架）。
 *
 * 编号：lane/detail 用 **020–029**；lane/render 预留 **030–039**（预计用不到，若用也加在本数组，
 * 文件名 03N_xxx.ts）。新建 `02N_xxx.ts`（导出 `migration02N`，写法对齐 001–003）后在此加一行；
 * 不改 migrations/index.ts。现有 paper_details 与 papers.abstract_source 已够 M4 用，预计零新迁移。
 */
export const DETAIL_MIGRATIONS: Migration[] = []
