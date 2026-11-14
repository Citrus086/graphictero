import type { Migration } from './index'
import { migration004 } from './004_annotations_quads_note'

/**
 * lane/pdf 车道迁移聚合（骨架）。
 *
 * PDF 车道专属的表 / 列变更：编号用 **004–009**，
 * 新建 `00N_xxx.ts`（导出 `migration00N`，写法对齐 001–003）后在 PDF_MIGRATIONS 里
 * 加一行；不改 migrations/index.ts。迁移不得依赖 REL 车道的表（两车道独立合并；
 * 确有跨车道依赖先找维护者）。
 */
export const PDF_MIGRATIONS: Migration[] = [migration004]
