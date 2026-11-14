import type { Migration } from './index'

/**
 * 060（M6 前置 2a，维护者，D129/Q-M6-6 ①）：关系改动前快照 + 每回合费用列。
 *
 * - relation_snapshots：Agent 覆盖 / 删除关系前在同一事务存原样（before_json 为
 *   RelationRestoreInput 全量，含 autoTypes / sourceType / sourceJobId / model /
 *   promptVersion / 方向），⌘Z 按快照完整还原（含原 source_type），跨回合冲突
 *   仍按 D104 守卫拒绝。绑会话 + turn；会话物理删除（D122）时级联删快照。
 * - session_messages.cost_cny：每回合费用（D96-②，B6）——turn-end 时把本回合
 *   usage_records 合计写进该 assistant 消息，重开会话仍可见。
 */
export const migration060: Migration = {
  version: 60,
  name: 'relation_snapshots_and_message_cost',
  up(db): void {
    db.exec(`
CREATE TABLE relation_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  relation_id INTEGER NOT NULL REFERENCES relations(id),
  op TEXT NOT NULL CHECK (op IN ('update', 'delete')),
  before_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_relation_snapshots_relation ON relation_snapshots(relation_id, id);

ALTER TABLE session_messages ADD COLUMN cost_cny REAL;
`)
  }
}
