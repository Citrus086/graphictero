import type { Migration } from './index'

/**
 * 040 lane/agent（M5）：graph_candidates 补 session_id——候选由哪个会话提出
 * （event:agent:candidates 的 sessionId 载荷、批 3 proposeCandidate 链路用）。
 * 列可空：历史候选与程序补排的候选没有来源会话。
 */
export const migration040: Migration = {
  version: 40,
  name: 'candidates_session_id',
  up(db): void {
    db.exec(`
ALTER TABLE graph_candidates ADD COLUMN session_id INTEGER REFERENCES sessions(id);
`)
  }
}
