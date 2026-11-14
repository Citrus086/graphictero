import type { Migration } from './index'

/**
 * 041 lane/agent（M5）：session_messages 补 error 列——D53 ⑧-4 回合出错保留
 * 已生成内容，错误挂在这条 assistant 消息上（03f 重试入口按消息取）。
 */
export const migration041: Migration = {
  version: 41,
  name: 'session_message_error',
  up(db): void {
    db.exec(`
ALTER TABLE session_messages ADD COLUMN error TEXT;
`)
  }
}
