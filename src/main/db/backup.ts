import type Database from 'better-sqlite3'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 数据库快照、升级前备份与清理（D59/D76）。
 *
 * - 用 VACUUM INTO 做一致性快照（WAL 模式下安全，相当于 SQLite online backup），
 *   产物是紧凑的单文件数据库，可直接打开验证；
 * - 每日快照：snapshot-YYYY-MM-DD.db，**当天已存在则跳过**（first-of-day 语义）——
 *   不用刚升级（甚至可能已坏）的库覆盖当天已有的好快照；
 * - 升级前备份：pre-upgrade-v{from}-to-v{to}-{date}.db，独立命名、不参与 snapshot
 *   的 7 天清理，单独保留最近 preUpgradeKeep 份（默认 3 份）。这份是「升级成功但
 *   结果不对」需要回滚数据时的唯一凭据（评审必须修 1）；
 * - 文件名里的日期按 UTC 滚动（与快照命名一致，内部语义自洽）。
 */

export const PRE_UPGRADE_PREFIX = 'pre-upgrade-'
export const PRE_UPGRADE_KEEP = 3

function dateStamp(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function snapshotPath(backupDir: string, now = new Date()): string {
  return join(backupDir, `snapshot-${dateStamp(now)}.db`)
}

/** pre-upgrade-v{from}-to-v{to}-{date}.db */
export function preUpgradePath(
  backupDir: string,
  fromVersion: number,
  toVersion: number,
  now = new Date()
): string {
  return join(backupDir, `${PRE_UPGRADE_PREFIX}v${fromVersion}-to-v${toVersion}-${dateStamp(now)}.db`)
}

/**
 * 打一份数据库快照，返回快照文件路径。
 * 当天已存在同名快照则直接返回已有路径（跳过，不覆盖）。
 */
export function createSnapshot(db: Database.Database, backupDir: string, now = new Date()): string {
  mkdirSync(backupDir, { recursive: true })
  const path = snapshotPath(backupDir, now)
  if (existsSync(path)) return path // 当天已有快照：保留早上那份（D59 评审修复）
  // VACUUM INTO 要求输出文件不存在
  db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`)
  return path
}

/**
 * 升级前备份（D59）：独立命名、独立保留，绝不与每日快照互相覆盖。
 * 返回备份文件路径。
 */
export function createPreUpgradeBackup(
  db: Database.Database,
  backupDir: string,
  fromVersion: number,
  toVersion: number,
  now = new Date()
): string {
  mkdirSync(backupDir, { recursive: true })
  const path = preUpgradePath(backupDir, fromVersion, toVersion, now)
  rmSync(path, { force: true })
  db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`)
  prunePreUpgradeBackups(backupDir, PRE_UPGRADE_KEEP)
  return path
}

const SNAPSHOT_NAME = /^snapshot-(\d{4}-\d{2}-\d{2})\.db$/

/**
 * 最近一份每日快照的 mtime（ISO）。只认 snapshot-YYYY-MM-DD.db，
 * 升级前备份不算。目录不存在或没有快照返回 null。
 */
export function latestSnapshotAt(backupDir: string): string | null {
  if (!existsSync(backupDir)) return null
  let best: { ms: number; iso: string } | null = null
  for (const name of readdirSync(backupDir)) {
    if (!SNAPSHOT_NAME.test(name)) continue
    const st = statSync(join(backupDir, name))
    if (!best || st.mtimeMs > best.ms) best = { ms: st.mtimeMs, iso: st.mtime.toISOString() }
  }
  return best?.iso ?? null
}

/** 清理超期快照（snapshot-*.db，保留最近 keepDays 天），返回被删除的文件路径列表。 */
export function pruneSnapshots(backupDir: string, keepDays = 7, now = new Date()): string[] {
  if (!existsSync(backupDir)) return []
  const cutoff = dateStamp(new Date(now.getTime() - keepDays * 24 * 60 * 60 * 1000))
  const removed: string[] = []
  for (const name of readdirSync(backupDir)) {
    const m = SNAPSHOT_NAME.exec(name)
    if (m && m[1] < cutoff) {
      rmSync(join(backupDir, name))
      removed.push(join(backupDir, name))
    }
  }
  return removed
}

/**
 * 升级前备份单独保留最近 keep 份，旧的删掉。
 * 按 mtime（最后写入时间）排新旧——文件名是版本号在前、日期在后，字典序在
 * 版本号过两位（v9 → v10 时 'v10' < 'v2'）或同日多版本时会把最新份当旧删掉
 * （评审复核建议修 5）。
 */
export function prunePreUpgradeBackups(backupDir: string, keep = PRE_UPGRADE_KEEP): string[] {
  if (!existsSync(backupDir)) return []
  const files = readdirSync(backupDir)
    .filter((n) => n.startsWith(PRE_UPGRADE_PREFIX) && n.endsWith('.db'))
    .sort((a, b) => statSync(join(backupDir, a)).mtimeMs - statSync(join(backupDir, b)).mtimeMs)
  const removed: string[] = []
  for (const name of files.slice(0, Math.max(0, files.length - keep))) {
    rmSync(join(backupDir, name))
    removed.push(join(backupDir, name))
  }
  return removed
}

/** 到下一个 UTC 日零点的毫秒数（每日快照按 UTC 日期命名，定时器对齐同一口径）。 */
export function msUntilNextUtcDay(now = new Date()): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  return next.getTime() - now.getTime()
}

/** 定时器用的统一入口：到点打当天快照（已存在则跳过）并清理，返回下一次延迟毫秒数。 */
export function runDailySnapshotTick(db: Database.Database, backupDir: string, now = new Date()): number {
  createSnapshot(db, backupDir, now)
  pruneSnapshots(backupDir, 7, now)
  return msUntilNextUtcDay(now)
}
