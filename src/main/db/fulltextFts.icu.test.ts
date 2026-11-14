import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from './connection'
import { MIGRATIONS, runMigrations } from './migrations'

/**
 * uat6b 必须修 M1：脏索引检查不依赖分词器 ICU 版本——用 mock segmentText 模拟
 * 两种 ICU 对 `data:image/png;base64,…` 的分词行为：
 * - ICU 78（Node 26）：单个 token `data:image`（冒号不断开）；
 * - ICU 74（Electron 35.7.5）：`data` `image` `png` `base64` 多个 token（uat5 复测
 *   证实的生产形态）。
 * 两种形态下：旧索引（未剥离 data URI 直接分词）都必须被 backfill 识别并重建；
 * 重建（stripInlineImages → 占位 [图：alt]）后第二次 backfill 返回 0（幂等）。
 */

const mode = vi.hoisted(() => ({ icu: 78 as 74 | 78 }))

// mock segmentText：ICU 78 保留冒号（data:image 单 token）；ICU 74 按字母数字切（多 token）
vi.mock('./segment', () => ({
  segmentText: (text: string): string => {
    const re = mode.icu === 74 ? /[a-z0-9]+|[一-鿿]+/g : /[a-z0-9:]+|[一-鿿]+/g
    return text.toLowerCase().match(re)?.join(' ') ?? ''
  }
}))

import { segmentText } from './segment'
import { backfillFullTextFts, looksLikeLegacyBase64Index } from './fulltextFts'

let dir: string
let db: Database.Database
let dataDir: string

const FULL_MD =
  '# 1 概述\n如图所示。\n\n![架构图](data:image/png;base64,QUJDREVGRw==)\n\n## 2 方法\n<img src="data:image/jpeg;base64,QUJDREVGRw==" alt="流程图">\n正文提到 CRISPR 技术。\n'

beforeEach(() => {
  mode.icu = 78
  dir = mkdtempSync(join(tmpdir(), 'gt-fulltext-icu-'))
  dataDir = join(dir, 'data')
  mkdirSync(join(dataDir, 'papers'), { recursive: true })
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function insertPaper(): number {
  const now = new Date().toISOString()
  return Number(
    db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES ('论文', 'zotero', 1, ?, ?)").run(now, now).lastInsertRowid
  )
}

function writeFullMd(paperId: number): void {
  mkdirSync(join(dataDir, 'papers', String(paperId), 'mineru'), { recursive: true })
  writeFileSync(join(dataDir, 'papers', String(paperId), 'mineru', 'full.md'), FULL_MD, 'utf8')
}

describe('uat6b M1：脏索引检查对 ICU 74 / ICU 78 两种分词形态都成立', () => {
  it('mock 分词器确实产出两种形态（ICU 78 = data:image 单 token）', () => {
    mode.icu = 78
    const seg = segmentText('图 x data:image/png;base64,QUJD 正文')
    expect(seg).toContain('data:image')
    mode.icu = 74
    const seg74 = segmentText('图 x data:image/png;base64,QUJD 正文')
    expect(seg74).not.toContain('data:image')
    expect(seg74).toContain('data image png base64')
  })

  it('ICU 78 形态：旧索引（未剥离直接分词）命中脏检查 → 重建 → 幂等', () => {
    mode.icu = 78
    const pid = insertPaper()
    writeFullMd(pid)
    // 模拟旧索引：data URI 未剥离就分词（uat5 之前的写入口径）
    db.prepare('INSERT OR REPLACE INTO papers_text_fts (rowid, seg) VALUES (?, ?)').run(pid, segmentText(FULL_MD))
    const dirty = (db.prepare('SELECT seg FROM papers_text_fts WHERE rowid = ?').get(pid) as { seg: string }).seg
    expect(dirty).toContain('data:image')
    expect(looksLikeLegacyBase64Index(dirty)).toBe(true)
    expect(backfillFullTextFts(db, dataDir)).toBe(1)
    const rebuilt = (db.prepare('SELECT seg FROM papers_text_fts WHERE rowid = ?').get(pid) as { seg: string }).seg
    expect(rebuilt).not.toContain('base64')
    expect(rebuilt).not.toContain('qujd')
    expect(looksLikeLegacyBase64Index(rebuilt)).toBe(false)
    expect(backfillFullTextFts(db, dataDir)).toBe(0) // 幂等
  })

  it('ICU 74 形态（Electron 生产形态）：旧索引命中脏检查 → 重建 → 幂等', () => {
    mode.icu = 74
    const pid = insertPaper()
    writeFullMd(pid)
    db.prepare('INSERT OR REPLACE INTO papers_text_fts (rowid, seg) VALUES (?, ?)').run(pid, segmentText(FULL_MD))
    const dirty = (db.prepare('SELECT seg FROM papers_text_fts WHERE rowid = ?').get(pid) as { seg: string }).seg
    expect(dirty).toContain('data image png base64') // Electron ICU 74 的真实分词形态
    expect(dirty).not.toContain('data:image')
    expect(looksLikeLegacyBase64Index(dirty)).toBe(true)
    expect(backfillFullTextFts(db, dataDir)).toBe(1) // uat5-fix1 的 SQL 检查在这条形态下不命中，uat6b 修复后命中
    const rebuilt = (db.prepare('SELECT seg FROM papers_text_fts WHERE rowid = ?').get(pid) as { seg: string }).seg
    expect(rebuilt).not.toContain('qujdrevgrw')
    expect(looksLikeLegacyBase64Index(rebuilt)).toBe(false)
    expect(backfillFullTextFts(db, dataDir)).toBe(0) // 幂等：第二次启动不再重建
  })

  it('两种形态下自然正文（data image 短语、无 base64）都不误触发', () => {
    for (const icu of [74, 78] as const) {
      mode.icu = icu
      const pid = insertPaper()
      const md = '# 方法\n正文讨论 data image pipeline 与 CRISPR。\n'
      mkdirSync(join(dataDir, 'papers', String(pid), 'mineru'), { recursive: true })
      writeFileSync(join(dataDir, 'papers', String(pid), 'mineru', 'full.md'), md, 'utf8')
      db.prepare('INSERT OR REPLACE INTO papers_text_fts (rowid, seg) VALUES (?, ?)').run(pid, segmentText(md))
      expect(backfillFullTextFts(db, dataDir)).toBe(0)
      db.prepare('DELETE FROM papers_text_fts WHERE rowid = ?').run(pid)
      db.prepare('DELETE FROM papers WHERE id = ?').run(pid)
    }
  })
})
