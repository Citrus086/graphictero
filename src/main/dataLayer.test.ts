import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDataLayer } from './dataLayer'
import { openDatabase } from './db/connection'
import { migration001 } from './db/migrations/001_init'
import type { Migration } from './db/migrations'

/**
 * initDataLayer 链路集成测试（评审必须修 1）：
 * 已有 v1 数据 → 提供 v2 迁移再走一遍启动流程 →
 * 升级前备份文件仍存在且内容是旧版本数据、未被当日快照覆盖。
 */
describe('initDataLayer 启动链路（D59 升级前备份不被每日快照覆盖）', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gt-datalayer-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  // 测试专用 v2 迁移：加一张新表（模拟未来批次改表结构）
  const migration002Fake: Migration = {
    version: 2,
    name: 'fake_v2',
    up(db) {
      db.exec('CREATE TABLE fake_v2_table (id INTEGER PRIMARY KEY)')
    }
  }

  const insertGraph = (dbPath: string, name: string): void => {
    const db = openDatabase(dbPath)
    const now = new Date().toISOString()
    db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run(name, now, now)
    db.close()
  }

  it('首次启动：建库到 v1 + 打当日快照；二次启动（有 v2 迁移）：升级前备份保留旧数据且不被快照覆盖', () => {
    // 第一轮：全新库（v0 → v1 也算一次升级，会留一份空的升级前备份，无害）
    const first = initDataLayer(root, [migration001])
    expect(first.preUpgradeBackup).toContain('pre-upgrade-v0-to-v1-')
    expect(first.snapshot).not.toBeNull()
    insertGraph(join(first.dataDir, 'graphictero.db'), '升级前的数据')
    first.db.close()

    // 第二轮：App 升级了（多了 v2 迁移），当天快照已存在（first-of-day 应跳过）
    const second = initDataLayer(root, [migration001, migration002Fake])
    expect(second.preUpgradeBackup).not.toBeNull()
    expect(second.snapshot).toBeNull() // 当天已有快照，跳过
    expect(second.db.prepare('SELECT COUNT(*) c FROM fake_v2_table').get()).toEqual({ c: 0 }) // v2 已应用

    // 升级前备份存在，且内容是旧版本数据（有旧数据、没有 v2 表）
    const pre = second.preUpgradeBackup!
    expect(existsSync(pre)).toBe(true)
    expect(pre).toContain('pre-upgrade-v1-to-v2-')
    const preDb = openDatabase(pre)
    expect(preDb.prepare('SELECT name FROM graphs').get()).toEqual({ name: '升级前的数据' })
    expect(
      preDb.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name = 'fake_v2_table'").get()
    ).toEqual({ c: 0 })
    expect(preDb.pragma('user_version', { simple: true })).toBe(1)
    preDb.close()

    // 当日快照仍是第一轮那份（不被升级后数据覆盖），升级前的数据在快照里没有
    const backupDir = second.backupDir
    const snapshots = readdirSync(backupDir).filter((f) => f.startsWith('snapshot-'))
    expect(snapshots).toHaveLength(1)
    const snapDb = openDatabase(join(backupDir, snapshots[0]))
    expect(snapDb.prepare('SELECT COUNT(*) c FROM graphs').get()).toEqual({ c: 0 })
    snapDb.close()
    second.db.close()
  })

  it('根位置在同步盘里：整链路不建目录，抛 DataDirBlockedError', () => {
    // initDataLayer 用真实 home 做拦截判断（同生产），指向本机 iCloud Drive 路径
    expect(() => initDataLayer(join(homedir(), 'Library', 'Mobile Documents', 'gt-test-docs'))).toThrow(
      '数据目录不合法'
    )
  })
})
