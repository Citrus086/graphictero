import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { minimalPdfBytes } from '../testing/fixtureHttp'
import { attachUserPdf } from './userDrop'
import type Database from 'better-sqlite3'

/**
 * 拖入 PDF：普通文件、拒绝符号链接、只读一遍（哈希与落盘字节一致）。
 */

let dir: string
let db: Database.Database
let paperId: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-drop-'))
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS)
  const now = new Date().toISOString()
  paperId = Number(
    db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES ('P', 'zotero', 0, ?, ?)").run(now, now).lastInsertRowid
  )
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('attachUserPdf', () => {
  it('普通文件复制进论文目录，字节与哈希一致', () => {
    const src = join(dir, 'in.pdf')
    const pdf = minimalPdfBytes()
    writeFileSync(src, pdf)
    attachUserPdf(db, dir, paperId, src)
    const onDisk = readFileSync(join(dir, 'papers', String(paperId), 'paper.pdf'))
    expect(onDisk.equals(pdf)).toBe(true)
    const row = db.prepare('SELECT has_pdf, pdf_source, pdf_hash, pdf_unresolved FROM papers WHERE id = ?').get(paperId) as {
      has_pdf: number
      pdf_source: string
      pdf_hash: string
      pdf_unresolved: number
    }
    expect(row.has_pdf).toBe(1)
    expect(row.pdf_source).toBe('user_drop')
    expect(row.pdf_hash).toMatch(/^[0-9a-f]{64}$/)
    // uat1-fix1 建议修 1：拖入补齐 PDF 后清「条目有附件没找到文件」标记
    expect(row.pdf_unresolved).toBe(0)
  })

  it('源是符号链接或目录时拒绝', () => {
    const real = join(dir, 'real.pdf')
    writeFileSync(real, minimalPdfBytes())
    const link = join(dir, 'link.pdf')
    symlinkSync(real, link)
    expect(() => attachUserPdf(db, dir, paperId, link)).toThrow(/符号链接/)

    const asDir = join(dir, 'dir.pdf')
    mkdirSync(asDir)
    expect(() => attachUserPdf(db, dir, paperId, asDir)).toThrow(/不是普通文件/)
  })

  it('目标已是符号链接时不跟随，外部文件保持原样', () => {
    const src = join(dir, 'in.pdf')
    writeFileSync(src, minimalPdfBytes())
    const outside = join(dir, 'outside.pdf')
    writeFileSync(outside, Buffer.from('keep-me'))
    const folder = join(dir, 'papers', String(paperId))
    mkdirSync(folder, { recursive: true })
    symlinkSync(outside, join(folder, 'paper.pdf'))
    expect(() => attachUserPdf(db, dir, paperId, src)).toThrow(/符号链接/)
    expect(readFileSync(outside).toString('utf8')).toBe('keep-me')
    expect(readdirSync(folder).some((name) => name.includes('.tmp'))).toBe(false)
    expect(readdirSync(folder)).toContain('paper.pdf')
  })

  it('覆盖已有 PDF 后不留临时文件；坏文件头不改原文件', () => {
    const folder = join(dir, 'papers', String(paperId))
    mkdirSync(folder, { recursive: true })
    const dest = join(folder, 'paper.pdf')
    const original = minimalPdfBytes()
    writeFileSync(dest, original)
    const next = Buffer.concat([minimalPdfBytes(), Buffer.from('next')])
    const src = join(dir, 'next.pdf')
    writeFileSync(src, next)
    attachUserPdf(db, dir, paperId, src)
    expect(readFileSync(dest).equals(next)).toBe(true)
    expect(readdirSync(folder).some((name) => name.includes('.tmp'))).toBe(false)

    const bad = join(dir, 'bad.pdf')
    writeFileSync(bad, Buffer.from('%PDF-nope-wait'.slice(0, 4) + 'not-a-pdf'))
    expect(() => attachUserPdf(db, dir, paperId, bad)).toThrow(/PDF/)
    expect(readFileSync(dest).equals(next)).toBe(true)
    expect(readdirSync(folder).some((name) => name.includes('.tmp'))).toBe(false)
  })
})
