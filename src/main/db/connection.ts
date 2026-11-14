import Database from 'better-sqlite3'

/**
 * 打开应用数据库：WAL 模式（D76 的快照依赖它做在线备份）、开外键、busy timeout。
 */
export function openDatabase(file: string): Database.Database {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  return db
}
