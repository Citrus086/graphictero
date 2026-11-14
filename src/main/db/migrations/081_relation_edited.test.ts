import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { MIGRATIONS, runMigrations } from './index'

/**
 * uat2-fix1 必须修 1：迁移 081（relations 加列 edited_at / no_ref_basis）的
 * 升级路径测试。user_version 是单一高水位——旧版误标 version 11，已有库（≥80）
 * 永远不会执行。两种真实库态都必须能升级到 81：
 * ① user_version=80 且没有这两列（用户 / UAT 现有库）；
 * ② 两列已在、user_version=80（uat2b 期间在本分支新建过的库，user_version 被 80 盖过）。
 */

let dir: string
let db: Database.Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-mig81-'))
  db = new Database(join(dir, 'graphictero.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function relationCols(): Set<string> {
  return new Set((db.pragma('table_info(relations)') as Array<{ name: string }>).map((c) => c.name))
}

/** 模拟「现有库」：只跑到 80（不含 081），user_version=80 */
function migrateUpTo80(): void {
  runMigrations(
    db,
    MIGRATIONS.filter((m) => m.version <= 80)
  )
}

describe('迁移 081（relations 加列 edited_at / no_ref_basis）', () => {
  it('① user_version=80 且无这两列的现有库 → 升级后两列在、版本到 90（082–090 随其后；uat6 086 引用重匹配、uat6b 087、uat7 088、uat6c 089/090）', () => {
    migrateUpTo80()
    expect(db.pragma('user_version', { simple: true })).toBe(80)
    expect(relationCols().has('edited_at')).toBe(false)
    expect(relationCols().has('no_ref_basis')).toBe(false)

    const applied = runMigrations(db, MIGRATIONS)
    expect(applied).toContain(81)
    expect(db.pragma('user_version', { simple: true })).toBe(90)
    expect(relationCols().has('edited_at')).toBe(true)
    expect(relationCols().has('no_ref_basis')).toBe(true)
    // 列可用：写读一轮
    const now = new Date().toISOString()
    db.prepare("INSERT INTO graphs (name, created_at, updated_at) VALUES ('t', ?, ?)").run(now, now)
    db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES ('a', 'zotero', 1, ?, ?)").run(now, now)
    db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES ('b', 'zotero', 1, ?, ?)").run(now, now)
    db.prepare(
      `INSERT INTO relations (graph_id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types,
         source_type, edited_at, no_ref_basis, created_at, updated_at)
       VALUES (1, 1, 2, 1, 's', '[]', '[]', 'job', ?, 1, ?, ?)`
    ).run(now, now, now)
    const row = db.prepare('SELECT edited_at, no_ref_basis FROM relations WHERE id = 1').get() as { edited_at: string; no_ref_basis: number }
    expect(row.edited_at).toBe(now)
    expect(row.no_ref_basis).toBe(1)
  })

  it('② 两列已在、user_version=80（uat2b 分支库）→ 再跑不报错、版本到 90、列不重复', () => {
    migrateUpTo80()
    // 模拟 uat2b 期间新建库：列已被（当时排序在 80 之前的 011 号）加过，但 user_version 停在 80
    db.exec(`
ALTER TABLE relations ADD COLUMN edited_at TEXT;
ALTER TABLE relations ADD COLUMN no_ref_basis INTEGER NOT NULL DEFAULT 0;
`)
    db.pragma('user_version = 80')

    const applied = runMigrations(db, MIGRATIONS) // 不得抛错（按列幂等）
    expect(applied).toContain(81)
    expect(db.pragma('user_version', { simple: true })).toBe(90)
    expect(relationCols().has('edited_at')).toBe(true)
    expect(relationCols().has('no_ref_basis')).toBe(true)
    // 再跑一次是空操作（版本已过）
    expect(runMigrations(db, MIGRATIONS)).toEqual([])
  })

  it('全新库全量迁移：两列在、最终版本 88', () => {
    runMigrations(db, MIGRATIONS)
    expect(db.pragma('user_version', { simple: true })).toBe(90)
    expect(relationCols().has('edited_at')).toBe(true)
    expect(relationCols().has('no_ref_basis')).toBe(true)
  })
})
