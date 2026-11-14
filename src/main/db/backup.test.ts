import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from './connection'
import { MIGRATIONS, runMigrations } from './migrations'
import {
  createPreUpgradeBackup,
  createSnapshot,
  latestSnapshotAt,
  msUntilNextUtcDay,
  preUpgradePath,
  prunePreUpgradeBackups,
  pruneSnapshots,
  snapshotPath
} from './backup'

describe('每日快照（D59/D76）', () => {
  let dir: string
  let dbPath: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gt-backup-'))
    dbPath = join(dir, 'graphictero.db')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function openWithData() {
    const db = openDatabase(dbPath)
    runMigrations(db, MIGRATIONS)
    const now = new Date().toISOString()
    db.prepare("INSERT INTO graphs (name, created_at, updated_at) VALUES ('快照测试', ?, ?)").run(now, now)
    return db
  }

  it('WAL 模式下 VACUUM INTO 得到可打开的完整快照', () => {
    const db = openWithData()
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    const path = createSnapshot(db, join(dir, 'backups'))
    expect(existsSync(path)).toBe(true)

    // 快照是独立的一致副本：只读打开、数据齐全、主库继续写不影响
    const snap = openDatabase(path)
    expect(snap.prepare('SELECT name FROM graphs').get()).toEqual({ name: '快照测试' })
    db.prepare("INSERT INTO graphs (name, created_at, updated_at) VALUES ('快照后的新数据', ?, ?)").run(
      new Date().toISOString(),
      new Date().toISOString()
    )
    expect(snap.prepare('SELECT COUNT(*) c FROM graphs').get()).toEqual({ c: 1 })
    snap.close()
    db.close()
  })

  it('同一天重复快照跳过不覆盖（first-of-day）：早上的好快照不被后续覆盖', () => {
    const db = openWithData()
    const backupDir = join(dir, 'backups')
    const morning = new Date('2026-10-25T08:00:00Z')
    const p1 = createSnapshot(db, backupDir, morning)
    // 快照后再写数据，同一天再打快照：返回原路径，内容仍是早上那份
    db.prepare("INSERT INTO graphs (name, created_at, updated_at) VALUES ('下午的新数据', ?, ?)").run(
      new Date().toISOString(),
      new Date().toISOString()
    )
    const p2 = createSnapshot(db, backupDir, new Date('2026-10-25T20:00:00Z'))
    expect(p2).toBe(p1)
    expect(readdirSync(backupDir).filter((f) => f.endsWith('.db'))).toHaveLength(1)
    const snap = openDatabase(p1)
    expect(snap.prepare('SELECT COUNT(*) c FROM graphs').get()).toEqual({ c: 1 })
    snap.close()
    db.close()
  })

  it('升级前备份：独立命名、与每日快照互不覆盖、不参与 snapshot 清理', () => {
    const db = openWithData()
    const backupDir = join(dir, 'backups')
    const now = new Date('2026-10-25T12:00:00Z')
    const snapshot = createSnapshot(db, backupDir, now)
    const pre = createPreUpgradeBackup(db, backupDir, 1, 2, now)
    expect(pre).toBe(preUpgradePath(backupDir, 1, 2, now))
    expect(pre).not.toBe(snapshot)
    // 两份都在；升级前备份不被快照清理删掉，反过来也不影响快照
    expect(existsSync(snapshot)).toBe(true)
    expect(existsSync(pre)).toBe(true)
    const removed = pruneSnapshots(backupDir, 7, new Date('2026-11-30T12:00:00Z'))
    expect(removed).toHaveLength(1)
    expect(existsSync(pre)).toBe(true)
    db.close()
  })

  it('升级前备份单独保留最近 N 份（按文件名排序删旧）', () => {
    const db = openWithData()
    const backupDir = join(dir, 'backups')
    for (const day of ['2026-10-01', '2026-10-10', '2026-10-20', '2026-10-25']) {
      createPreUpgradeBackup(db, backupDir, 1, 2, new Date(`${day}T12:00:00Z`))
    }
    const left = readdirSync(backupDir).filter((f) => f.startsWith('pre-upgrade-'))
    expect(left).toHaveLength(3)
    expect(left).not.toContain('pre-upgrade-v1-to-v2-2026-10-01.db')
    expect(left).toContain('pre-upgrade-v1-to-v2-2026-10-25.db')
    db.close()
  })

  it('升级前备份清理按 mtime 排新旧：v9→v10 字典序陷阱下最新份被保留（评审复核建议修 5）', () => {
    // 文件名版本号在日期前：'pre-upgrade-v10-...' < 'pre-upgrade-v9-...'（字典序），
    // 按文件名排序会把 v9→v10 的最新备份当旧删掉；按 mtime 则正确
    const backupDir = join(dir, 'backups')
    mkdirSync(backupDir, { recursive: true })
    const names = [
      'pre-upgrade-v1-to-v2-2026-09-01.db', // 最旧
      'pre-upgrade-v2-to-v3-2026-10-01.db',
      'pre-upgrade-v9-to-v10-2026-10-25.db' // 最新（字典序却排在 v1 与 v2 之间）
    ]
    names.forEach((n, i) => {
      writeFileSync(join(backupDir, n), 'x')
      const t = new Date('2026-10-25T12:00:00Z').getTime() - (names.length - i) * 24 * 60 * 60 * 1000
      utimesSync(join(backupDir, n), t / 1000, t / 1000)
    })
    const removed = prunePreUpgradeBackups(backupDir, 2)
    expect(removed).toEqual([join(backupDir, names[0])])
    const left = readdirSync(backupDir)
    expect(left).toContain('pre-upgrade-v9-to-v10-2026-10-25.db')
    expect(left).toContain('pre-upgrade-v2-to-v3-2026-10-01.db')
  })

  it('msUntilNextUtcDay：对齐下一个 UTC 日零点', () => {
    const now = new Date('2026-10-25T12:00:00Z')
    expect(msUntilNextUtcDay(now)).toBe(12 * 60 * 60 * 1000)
    // 跨月边界
    const endOfMonth = new Date('2026-10-31T23:00:00Z')
    expect(msUntilNextUtcDay(endOfMonth)).toBe(60 * 60 * 1000)
  })

  it('保留最近 7 天，超期删除（按文件名日期）', () => {
    const db = openWithData()
    const backupDir = join(dir, 'backups')
    // 造 10 天的快照
    for (let i = 0; i < 10; i++) {
      const d = new Date('2026-10-25T12:00:00Z')
      d.setUTCDate(d.getUTCDate() - i)
      createSnapshot(db, backupDir, d)
    }
    expect(readdirSync(backupDir).filter((f) => f.startsWith('snapshot-'))).toHaveLength(10)

    const removed = pruneSnapshots(backupDir, 7, new Date('2026-10-25T12:00:00Z'))
    const left = readdirSync(backupDir).filter((f) => f.startsWith('snapshot-'))
    expect(removed).toHaveLength(2) // 10-16、10-17 两份超期
    expect(left).toHaveLength(8) // 10-18 ~ 10-25（含第 7 天）
    // 保留的是最近 7 天（含第 7 天）
    expect(left).toContain('snapshot-2026-10-18.db')
    expect(left).not.toContain('snapshot-2026-10-17.db')
    db.close()
  })

  it('清理跳过非快照文件', () => {
    writeFileSync(join(dir, 'snapshot-not-a-date.db'), 'junk')
    writeFileSync(join(dir, 'notes.txt'), 'junk')
    expect(pruneSnapshots(dir, 7, new Date('2026-10-25T12:00:00Z'))).toEqual([])
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true)
    expect(snapshotPath(dir, new Date('2026-10-25T12:00:00Z'))).toBe(
      join(dir, 'snapshot-2026-10-25.db')
    )
  })

  it('最近自动备份取最新 snapshot 的 mtime，忽略其它文件', () => {
    const backupDir = join(dir, 'backups')
    expect(latestSnapshotAt(join(dir, 'missing'))).toBeNull()
    mkdirSync(backupDir)
    expect(latestSnapshotAt(backupDir)).toBeNull()
    const older = join(backupDir, 'snapshot-2026-10-01.db')
    const newer = join(backupDir, 'snapshot-2026-10-02.db')
    writeFileSync(older, 'a')
    writeFileSync(newer, 'b')
    writeFileSync(join(backupDir, 'pre-upgrade-v1.db'), 'c')
    const t1 = new Date('2026-10-01T00:00:00Z')
    const t2 = new Date('2026-10-02T03:04:05Z')
    utimesSync(older, t1, t1)
    utimesSync(newer, t2, t2)
    expect(latestSnapshotAt(backupDir)).toBe(t2.toISOString())
  })
})
