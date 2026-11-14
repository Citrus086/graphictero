import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MigrationError, runMigrations, type Migration } from './migrations'
import { createSnapshot } from './backup'

const m1: Migration = {
  version: 1,
  name: 'create things',
  up(db) {
    db.exec('CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
  }
}

const m2Broken: Migration = {
  version: 2,
  name: 'broken: bad sql',
  up(db) {
    db.exec('CREATE TABL broken_syntax (id INTEGER)')
  }
}

const m2Ok: Migration = {
  version: 2,
  name: 'add index',
  up(db) {
    db.exec('CREATE INDEX idx_things_name ON things (name)')
  }
}

describe('runMigrations（D59）', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
  })
  afterEach(() => db.close())

  it('全新数据库按序应用脚本，user_version 推进', () => {
    const applied = runMigrations(db, [m1, m2Ok])
    expect(applied).toEqual([1, 2])
    expect(db.pragma('user_version', { simple: true })).toBe(2)
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'things'")
      .get()
    expect(table).toBeTruthy()
  })

  it('已是最新时重复运行是空操作', () => {
    runMigrations(db, [m1, m2Ok])
    const applied = runMigrations(db, [m1, m2Ok])
    expect(applied).toEqual([])
    expect(db.pragma('user_version', { simple: true })).toBe(2)
  })

  it('中间的脚本出错：整体回退，user_version 和已写入的数据都完好', () => {
    // 先只升级到 v1 并写入数据
    runMigrations(db, [m1])
    db.prepare("INSERT INTO things (name) VALUES ('珍贵的数据')").run()
    expect(db.pragma('user_version', { simple: true })).toBe(1)

    // 再补跑 v1（已有）+ v2（故意写错 SQL）：应抛 MigrationError
    expect(() => runMigrations(db, [m1, m2Broken])).toThrow(MigrationError)

    // 回退证据：版本仍停在 1，v1 的表和数据都在，v2 的痕迹不存在
    expect(db.pragma('user_version', { simple: true })).toBe(1)
    expect(db.prepare('SELECT name FROM things').get()).toEqual({ name: '珍贵的数据' })
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'broken_syntax'").get()
    ).toBeUndefined()
    // 索引也应随 v2 回退（v2 的 DDL 在事务内）
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_things_name'").get()).toBeUndefined()
  })

  it('有缺失脚本时先调用 beforeUpgrade 钩子（升级前自动备份的挂点）', () => {
    runMigrations(db, [m1])
    const beforeUpgrade = vi.fn()
    expect(() => runMigrations(db, [m1, m2Broken], { beforeUpgrade })).toThrow(MigrationError)
    expect(beforeUpgrade).toHaveBeenCalledTimes(1)
    expect(beforeUpgrade.mock.calls[0][0].map((m: Migration) => m.version)).toEqual([2])
  })

  it('升级前的备份里保存的是升级前（旧版本）的完整数据', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gt-migrate-'))
    try {
      runMigrations(db, [m1])
      db.prepare("INSERT INTO things (name) VALUES ('升级前的数据')").run()

      expect(() =>
        runMigrations(db, [m1, m2Broken], {
          beforeUpgrade: () => createSnapshot(db, dir)
        })
      ).toThrow(MigrationError)

      const backupPath = join(dir, `snapshot-${new Date().toISOString().slice(0, 10)}.db`)
      const backup = new Database(backupPath, { readonly: true, fileMustExist: true })
      expect(backup.prepare('SELECT name FROM things').get()).toEqual({ name: '升级前的数据' })
      expect(backup.pragma('user_version', { simple: true })).toBe(1)
      backup.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('迁移脚本版本号重复直接报错', () => {
    expect(() => runMigrations(db, [m1, { ...m1 }])).toThrow('版本号重复')
  })

  it('数据库版本高于本程序支持的最新版本：明确拒绝（旧 App 打开新库防护）', () => {
    db.pragma('user_version = 99')
    expect(() => runMigrations(db, [m1])).toThrow(/user_version=99/)
    expect(() => runMigrations(db, [m1])).toThrow(/v1/)
  })
})
