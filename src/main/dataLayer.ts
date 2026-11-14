import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { resolveDataDir } from './dataDir'
import { openDatabase } from './db/connection'
import { MIGRATIONS, runMigrations, type Migration } from './db/migrations'
import { createPreUpgradeBackup, createSnapshot, pruneSnapshots, snapshotPath } from './db/backup'

/**
 * 数据层初始化（M1）：解析数据目录 → 打开 SQLite → 升级（升级前自动备份，D59）
 * → 补当日快照（当天已存在则跳过）→ 清理超期快照。
 *
 * 本模块不依赖 electron（错误以异常抛出），index.ts 负责弹窗与退出；
 * initDataLayer 因此可以在 vitest 里做端到端集成测试（评审必须修 1）。
 */

export class DataDirBlockedError extends Error {
  constructor(public readonly reason: string) {
    super(`数据目录不合法：${reason}`)
    this.name = 'DataDirBlockedError'
  }
}

export interface InitDataLayerResult {
  db: Database.Database
  dataDir: string
  backupDir: string
  /** 本次升级前备份文件（无升级时为 null） */
  preUpgradeBackup: string | null
  /** 本次启动新打的每日快照路径；当天已存在而跳过为 null */
  snapshot: string | null
}

export function initDataLayer(rootPath: string, migrations: Migration[] = MIGRATIONS): InitDataLayerResult {
  const resolved = resolveDataDir(rootPath)
  if (!resolved.ok) throw new DataDirBlockedError(resolved.reason)
  mkdirSync(resolved.dir, { recursive: true })

  const db = openDatabase(join(resolved.dir, 'graphictero.db'))
  const backupDir = join(resolved.dir, 'backups')
  // 升级前自动备份（D59）：独立命名 pre-upgrade-v{from}-to-v{to}-{date}.db，
  // 不与每日快照互相覆盖，也不参与 snapshot 的 7 天清理（评审必须修 1）
  let preUpgradeBackup: string | null = null
  runMigrations(db, migrations, {
    beforeUpgrade: (pending) => {
      const from = db.pragma('user_version', { simple: true }) as number
      preUpgradeBackup = createPreUpgradeBackup(db, backupDir, from, pending[pending.length - 1].version)
    }
  })
  // 每日快照（D76）：当天已存在则跳过（first-of-day），不用刚升级的库覆盖早上的好快照
  const todayPath = snapshotPath(backupDir)
  const snapshot = existsSync(todayPath) ? null : createSnapshot(db, backupDir)
  pruneSnapshots(backupDir, 7)
  return { db, dataDir: resolved.dir, backupDir, preUpgradeBackup, snapshot }
}
