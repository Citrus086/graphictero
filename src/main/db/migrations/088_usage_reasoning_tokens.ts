import type { Migration } from './index'

/**
 * 088（uat7 D180）：usage_records 增加可空的推理 token 数。
 * 存量行保持 NULL（未知），不能与真实的 0 推理 token 混淆；推理 token 是输出 token
 * 的子集，只作统计，不参与 cost_cny 计价。
 */
export const migration088: Migration = {
  version: 88,
  name: 'usage_reasoning_tokens',
  up(db): void {
    db.exec('ALTER TABLE usage_records ADD COLUMN reasoning_tokens INTEGER')
  }
}
