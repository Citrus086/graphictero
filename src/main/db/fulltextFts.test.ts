import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from './connection'
import { MIGRATIONS, runMigrations } from './migrations'
import { backfillFullTextFts, indexFullTextFts, reindexFullTextFtsIfPresent, searchFullText } from './fulltextFts'
import { segmentText } from './segment'

/** uat5 必须修 1（D141）：全文索引同样去 data URI；老脏索引启动重建（幂等）。 */

let dir: string
let db: Database.Database
let dataDir: string

const FULL_MD =
  '# 1 概述\n如图所示。\n\n![架构图](data:image/png;base64,QUJDREVGRw==)\n\n## 2 方法\n<img src="data:image/jpeg;base64,QUJDREVGRw==" alt="流程图">\n正文提到 CRISPR 技术。\n'

function insertPaper(title: string): number {
  const now = new Date().toISOString()
  return Number(
    db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES (?, 'zotero', 1, ?, ?)").run(title, now, now).lastInsertRowid
  )
}

function writeFullMd(paperId: number, content: string): void {
  mkdirSync(join(dataDir, 'papers', String(paperId), 'mineru'), { recursive: true })
  writeFileSync(join(dataDir, 'papers', String(paperId), 'mineru', 'full.md'), content, 'utf8')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-fulltext-'))
  dataDir = join(dir, 'data')
  mkdirSync(join(dataDir, 'papers'), { recursive: true })
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('全文索引去 data URI（uat5 必须修 1，D141）', () => {
  it('indexFullTextFts：seg 不含 data URI，占位 [图：alt] 进索引且可检索', () => {
    const pid = insertPaper('论文甲')
    indexFullTextFts(db, pid, FULL_MD)
    const row = db.prepare('SELECT seg FROM papers_text_fts WHERE rowid = ?').get(pid) as { seg: string }
    expect(row.seg).not.toContain('data image')
    expect(row.seg).not.toContain('qujdrevgrw')
    expect(row.seg).toContain('crispr')
    // 占位里的 alt 词进索引（中文按词切分）
    expect(row.seg).toContain('架构')
    expect(searchFullText(db, 'CRISPR')).toHaveLength(1)
  })

  it('reindexFullTextFtsIfPresent：有 full.md 重建、无 full.md 不动、幂等', () => {
    const pid = insertPaper('论文乙')
    expect(reindexFullTextFtsIfPresent(db, dataDir, pid)).toBe(false)
    writeFullMd(pid, FULL_MD)
    expect(reindexFullTextFtsIfPresent(db, dataDir, pid)).toBe(true)
    const seg1 = (db.prepare('SELECT seg FROM papers_text_fts WHERE rowid = ?').get(pid) as { seg: string }).seg
    expect(reindexFullTextFtsIfPresent(db, dataDir, pid)).toBe(true) // 幂等可重复执行
    const seg2 = (db.prepare('SELECT seg FROM papers_text_fts WHERE rowid = ?').get(pid) as { seg: string }).seg
    expect(seg2).toBe(seg1)
    expect(seg2).not.toContain('data image')
  })

  it('backfillFullTextFts：缺索引补建 + 含 data:image 真实 token 的脏索引重建（幂等，uat5-fix1 M1）', () => {
    const pid = insertPaper('论文丙')
    writeFullMd(pid, FULL_MD)
    // 第一次：补缺失索引
    expect(backfillFullTextFts(db, dataDir)).toBe(1)
    const seg = (db.prepare('SELECT seg FROM papers_text_fts WHERE rowid = ?').get(pid) as { seg: string }).seg
    expect(seg).not.toContain('data:image')
    // 模拟老库脏索引：用 segmentText(未剥离 markdown) 的真实输出写入（含 data:image token）
    db.prepare('INSERT OR REPLACE INTO papers_text_fts (rowid, seg) VALUES (?, ?)').run(pid, segmentText(FULL_MD))
    expect((db.prepare('SELECT seg FROM papers_text_fts WHERE rowid = ?').get(pid) as { seg: string }).seg).toContain('data:image')
    expect(backfillFullTextFts(db, dataDir)).toBe(1) // 脏行被重建
    const rebuilt = (db.prepare('SELECT seg FROM papers_text_fts WHERE rowid = ?').get(pid) as { seg: string }).seg
    expect(rebuilt).not.toContain('data:image')
    expect(rebuilt).not.toContain('qujd')
    expect(backfillFullTextFts(db, dataDir)).toBe(0) // 幂等：第二次不再重建
  })

  it('uat6b M1：ICU 74 形态（data image <mime> base64 相邻 token）的脏索引也被重建（幂等）', () => {
    const pid = insertPaper('论文庚')
    writeFullMd(pid, FULL_MD)
    // 直接写入 ICU 74（Electron 35.7.5 / ICU 74.2）分词形态的脏行——不依赖当前 Node 的 Segmenter
    db.prepare('INSERT OR REPLACE INTO papers_text_fts (rowid, seg) VALUES (?, ?)').run(
      pid,
      '概述 如 图 所 示 架构图 data image png base64 qujdrevgrw 方法 流程图 data image jpeg base64 qujdrevgrw crispr'
    )
    expect(backfillFullTextFts(db, dataDir)).toBe(1) // 脏行（ICU 74 形态）被重建
    const rebuilt = (db.prepare('SELECT seg FROM papers_text_fts WHERE rowid = ?').get(pid) as { seg: string }).seg
    expect(rebuilt).not.toContain('base64')
    expect(rebuilt).not.toContain('qujd')
    expect(backfillFullTextFts(db, dataDir)).toBe(0) // 幂等：第二次不再重建
  })

  it('uat6b M1：正文自然出现的 "data image" 短语（无 base64）两种形态都不误触发', () => {
    const pid = insertPaper('论文辛')
    const md = '# 方法\n正文讨论 data image pipeline，也提到 base64 编码的历史，与 CRISPR 无关。\n'
    writeFullMd(pid, md)
    // 自然短语 + 远处出现 base64 词：不是相邻「单 token + base64」序列，不算脏
    db.prepare('INSERT OR REPLACE INTO papers_text_fts (rowid, seg) VALUES (?, ?)').run(
      pid,
      '方法 正文讨论 data image pipeline 也 提到 base64 编码 的 历史 与 crispr 无关'
    )
    expect(backfillFullTextFts(db, dataDir)).toBe(0)
    // 但「data image <单token> base64」相邻序列（ICU 74 脏形态）仍要命中：
    db.prepare('INSERT OR REPLACE INTO papers_text_fts (rowid, seg) VALUES (?, ?)').run(pid, '正文 data image png base64 qujdrevgrw 结尾')
    expect(backfillFullTextFts(db, dataDir)).toBe(1)
    expect(backfillFullTextFts(db, dataDir)).toBe(0)
  })

  it('uat5-fix1 M1：正文自然出现的英文 "data image" 不触发重建（词边界匹配）', () => {
    const pid = insertPaper('论文戊')
    const md = '# 方法\n正文讨论 data image pipeline 与 CRISPR。\n'
    writeFullMd(pid, md)
    indexFullTextFts(db, pid, md) // 剥离后正文本就含 "data image" 两个独立词
    expect((db.prepare('SELECT seg FROM papers_text_fts WHERE rowid = ?').get(pid) as { seg: string }).seg).toContain('data image')
    expect(backfillFullTextFts(db, dataDir)).toBe(0) // 不是脏索引，不得每次启动重建
    // 反之真含 data:image token 才重建
    db.prepare('INSERT OR REPLACE INTO papers_text_fts (rowid, seg) VALUES (?, ?)').run(pid, segmentText(md + '\n\n![x](data:image/png;base64,QUJD)\n'))
    expect(backfillFullTextFts(db, dataDir)).toBe(1)
  })

  it('软删论文不补索引', () => {
    const pid = insertPaper('论文丁')
    writeFullMd(pid, FULL_MD)
    db.prepare('UPDATE papers SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), pid)
    expect(backfillFullTextFts(db, dataDir)).toBe(0)
  })
})
