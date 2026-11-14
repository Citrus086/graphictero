import type { Migration } from './index'
import { migration040 } from './040_candidates_session'
import { migration041 } from './041_message_error'

/**
 * M5 lane/agent 车道迁移聚合（骨架）。
 *
 * 编号：lane/agent 用 **040–049**；备用 **050–059**（若 lane/chat 需要（预计零迁移）也加在
 * 本数组）。新建 `04N_xxx.ts`（导出 `migration04N`，写法对齐 001–003 / 010）后在此加一行；
 * 不改 migrations/index.ts。060+ 由维护者分配。
 *
 * 会话五表（sessions / session_messages / session_traces / session_observations /
 * session_archives）与 graph_candidates 已在 001/002 建好，M5 首次接线；预计需要的迁移
 * （车道内定，不预先建）：graph_candidates 补 session_id 等入口列、按需补消息工具调用
 * 原始记录表（若 parts JSON 不足以回放）。
 */
export const AGENT_MIGRATIONS: Migration[] = [migration040, migration041]
