import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from './db/connection'
import { MIGRATIONS, runMigrations } from './db/migrations'
import { migrateDataDir } from './migrateDataDir'
import { DataDirBlockedError } from './dataLayer'

/**
 * 数据目录迁移（D83）：先快照再迁移；新位置仍走 iCloud/Dropbox 拦截；
 * 契约（评审必须修 2）：快照 → 复制 → quick_check 校验 → 写设置 → 删旧，
 * 复制/校验/写设置任一步失败旧数据都完好。
 */

let home: string
let currentRoot: string
let dataDir: string
let db: Database.Database

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gt-home-'))
  currentRoot = mkdtempSync(join(tmpdir(), 'gt-current-'))
  dataDir = join(currentRoot, 'Graphictero')
  mkdirSync(dataDir, { recursive: true })
  db = openDatabase(join(dataDir, 'graphictero.db'))
  runMigrations(db, MIGRATIONS)
})

afterEach(() => {
  if (db?.open) db.close()
  rmSync(home, { recursive: true, force: true })
  rmSync(currentRoot, { recursive: true, force: true })
})

function fileExists(path: string): boolean {
  return existsSync(path)
}

/** 塞点数据 + 文件，供「旧数据完好」类断言用 */
function seedData(): void {
  const now = new Date().toISOString()
  db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('迁移测试', now, now)
  writeFileSync(join(dataDir, '.env'), 'DEEPSEEK_API_KEY=key-migrates-with-data\n') // .env 随数据迁移（非备份）
  mkdirSync(join(dataDir, 'papers', '1'), { recursive: true })
  writeFileSync(join(dataDir, 'papers', '1', 'paper.pdf'), Buffer.from('%PDF-1.4 fake'))
}

describe('数据目录迁移（D83）', () => {
  it('先快照再迁移：数据完整搬到新位置，写设置在删旧之前，旧目录删除', () => {
    seedData()
    const persist = vi.fn((root: string) => {
      expect(root).toBe(join(home, 'new-root'))
      // 评审必须修 2：persistNewRoot 被调用时旧目录必须还在（写设置在删旧之前）
      expect(existsSync(dataDir)).toBe(true)
    })

    const result = migrateDataDir(db, dataDir, join(home, 'new-root'), { home, persistNewRoot: persist })

    expect(result.dataDir).toBe(join(home, 'new-root', 'Graphictero'))
    expect(result.root).toBe(join(home, 'new-root'))
    expect(persist).toHaveBeenCalledTimes(1)
    // 快照在迁移前打在当前目录的 backups/ 里，并随复制带到新位置
    expect(existsSync(result.snapshot)).toBe(false) // 旧位置已删
    const snapshotName = result.snapshot.slice(result.snapshot.lastIndexOf('/') + 1)
    expect(existsSync(join(result.dataDir, 'backups', snapshotName))).toBe(true)

    // 数据完整：新位置直接打开验证（quick_check 过的副本）
    const moved = openDatabase(join(result.dataDir, 'graphictero.db'))
    expect(moved.prepare('SELECT name FROM graphs').get()).toEqual({ name: '迁移测试' })
    moved.close()
    expect(fileExists(join(result.dataDir, 'papers', '1', 'paper.pdf'))).toBe(true)
    expect(fileExists(join(result.dataDir, '.env'))).toBe(true)
    // 旧目录已删
    expect(existsSync(dataDir)).toBe(false)
    db = undefined as unknown as Database.Database // 已关，afterEach 不再关
  })

  it('复制中途失败（目标父目录只读）：旧数据完好，可原地重开库继续用', () => {
    seedData()
    const roDir = join(home, 'read-only-parent')
    mkdirSync(roDir)
    chmodSync(roDir, 0o555) // cpSync 建目标目录即失败：制造「复制中途失败」

    try {
      expect(() =>
        migrateDataDir(db, dataDir, join(roDir, 'new-root'), {
          home,
          persistNewRoot: () => {
            throw new Error('persistNewRoot 不应在复制失败后被调用')
          }
        })
      ).toThrow()
    } finally {
      chmodSync(roDir, 0o755) // 恢复权限，afterEach 才能清理
    }

    // 旧数据完好（必 2 测试锁定：中途失败旧数据绝对安全）
    expect(existsSync(dataDir)).toBe(true)
    const reopened = openDatabase(join(dataDir, 'graphictero.db'))
    expect(reopened.prepare('SELECT name FROM graphs').get()).toEqual({ name: '迁移测试' })
    reopened.close()
    expect(fileExists(join(dataDir, 'papers', '1', 'paper.pdf'))).toBe(true)
    db = undefined as unknown as Database.Database // 已关，用重开的代替
  })

  it('写设置失败：不删旧目录、清理新副本，下次启动仍落在旧根', () => {
    seedData()
    const persist = vi.fn(() => {
      throw new Error('模拟写 data-root.json 失败（磁盘满/权限）')
    })

    expect(() =>
      migrateDataDir(db, dataDir, join(home, 'new-root'), { home, persistNewRoot: persist })
    ).toThrow('模拟写 data-root.json 失败')
    expect(persist).toHaveBeenCalledTimes(1)

    // 必 2：写设置失败绝不删旧；新副本被清理，不留半成品
    expect(existsSync(dataDir)).toBe(true)
    expect(existsSync(join(home, 'new-root', 'Graphictero'))).toBe(false)
    const reopened = openDatabase(join(dataDir, 'graphictero.db'))
    expect(reopened.prepare('SELECT name FROM graphs').get()).toEqual({ name: '迁移测试' })
    reopened.close()
    db = undefined as unknown as Database.Database
  })

  it('新位置在 iCloud/Dropbox 里被拦下，数据原地不动', () => {
    // 构造假 home：iCloud Drive 目录
    const icloud = join(home, 'Library', 'Mobile Documents')
    mkdirSync(icloud, { recursive: true })
    const before = readdirSync(dataDir)
    expect(() => migrateDataDir(db, dataDir, icloud, { home })).toThrow(DataDirBlockedError)
    expect(readdirSync(dataDir)).toEqual(before)
    expect(db.open).toBe(true)
  })

  it('拒绝嵌套与覆盖：新位置在当前目录里 / 目标非空', () => {
    expect(() => migrateDataDir(db, dataDir, currentRoot, { home })).toThrow(/相同/)
    expect(() => migrateDataDir(db, dataDir, join(dataDir, 'inner'), { home })).toThrow(/里面/)
    const occupied = join(home, 'occupied')
    mkdirSync(join(occupied, 'Graphictero'), { recursive: true })
    writeFileSync(join(occupied, 'Graphictero', 'x'), 'x')
    expect(() => migrateDataDir(db, dataDir, occupied, { home })).toThrow(/空目录/)
    expect(db.open).toBe(true) // 全部被拒时库还开着
  })

  it('拒绝嵌套：新根是指向数据目录内部的符号链接也绕不过（评审建议修 6）', () => {
    mkdirSync(join(dataDir, 'sub'), { recursive: true })
    const linkRoot = join(home, 'link-into-data')
    symlinkSync(join(dataDir, 'sub'), linkRoot)
    // 词法上 link-into-data 不在 dataDir 里；realpath 解引用后必须被拒
    expect(() => migrateDataDir(db, dataDir, linkRoot, { home })).toThrow(/里面/)
    expect(db.open).toBe(true)
  })
})
