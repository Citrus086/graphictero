import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDatabase } from './db/connection'
import { MIGRATIONS, runMigrations } from './db/migrations'
import { indexFullTextFts, searchFullText } from './db/fulltextFts'
import { searchSidebar } from './librarySearch'

/**
 * uat8a D188：主进程侧栏查询入口。临时库，不碰真实数据目录。
 */

let dir: string
let db: Database.Database

function insertPaper(title: string, author: string | null, updatedAt: string): number {
  const r = db
    .prepare(
      `INSERT INTO papers (title, source, has_pdf, first_author, created_at, updated_at)
       VALUES (?, 'zotero', 0, ?, ?, ?)`
    )
    .run(title, author, updatedAt, updatedAt)
  return Number(r.lastInsertRowid)
}

function addMember(graphId: number, paperId: number, addedAt: string): void {
  db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)').run(
    graphId,
    paperId,
    addedAt
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-sidebar-search-'))
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('searchSidebar（D188）', () => {
  it('两段各自合并：标题原序在前，正文按 rank 在后，跨段不串，软删不出现', () => {
    const graphId = Number(
      db.prepare("INSERT INTO graphs (name, created_at, updated_at) VALUES ('g', 't0', 't0')").run().lastInsertRowid
    )
    // 成员加入顺序：后加入的 title 论文在前？ added_at 升序：mEarly 先，mLate 后。
    const mEarly = insertPaper('Member Early', 'Ann', '2024-01-02')
    const mLate = insertPaper('Member Late', 'Bob', '2024-01-03')
    const libNew = insertPaper('Library New', 'Cara', '2024-06-02')
    const libOld = insertPaper('Library Old', 'Dan', '2024-01-01')
    const gone = insertPaper('Deleted Body', null, '2024-06-03')
    addMember(graphId, mEarly, '2024-01-01T00:00:00Z')
    addMember(graphId, mLate, '2024-02-01T00:00:00Z')

    indexFullTextFts(db, mLate, '正文没有这个词 xylophonebody 。')
    indexFullTextFts(db, libOld, '只有正文提到 xylophonebody 一次。')
    indexFullTextFts(db, gone, 'xylophonebody 在已删论文里。')
    db.prepare("UPDATE papers SET deleted_at = '2024-07-01' WHERE id = ?").run(gone)

    const res = searchSidebar(db, graphId, 'xylophonebody')
    // 成员段：没有标题命中。mLate 正文命中。mEarly 无。
    expect(res.members).toEqual([{ paperId: mLate, via: 'body' }])
    // 论文库段：libOld 正文命中。libNew 无。顺序是正文 rank。gone 不在。
    expect(res.others).toEqual([{ paperId: libOld, via: 'body' }])
    expect(res.others.some((h) => h.paperId === gone)).toBe(false)
    expect(res.members.some((h) => h.paperId === libOld)).toBe(false)
  })

  it('标题命中优先且同一篇不带正文；成员序是 added_at，论文库序是 updated_at DESC', () => {
    const graphId = Number(
      db.prepare("INSERT INTO graphs (name, created_at, updated_at) VALUES ('g', 't0', 't0')").run().lastInsertRowid
    )
    const first = insertPaper('Alpha Note', 'Wei', '2024-01-01')
    const second = insertPaper('Beta Note', 'Li', '2024-08-01')
    const third = insertPaper('Plain', 'Na', '2024-03-01')
    addMember(graphId, second, '2024-03-01T00:00:00Z') // 后加入
    addMember(graphId, first, '2024-01-01T00:00:00Z') // 先加入
    indexFullTextFts(db, first, 'Alpha 的正文也有 Note 这个词。')
    indexFullTextFts(db, third, '正文单独出现 Note 一词。')

    const res = searchSidebar(db, graphId, 'Note')
    expect(res.members.map((h) => [h.paperId, h.via])).toEqual([
      [first, 'title'],
      [second, 'title']
    ])
    // 论文库：third 不在图中。updated_at：无标题命中的论文库项只有正文。
    // second/first 在图中，不进 others。third 正文命中 Note。
    expect(res.others).toEqual([{ paperId: third, via: 'body' }])
  })

  it('论文库标题命中保持 updated_at DESC，正文排在全部标题命中之后', () => {
    const graphId = Number(
      db.prepare("INSERT INTO graphs (name, created_at, updated_at) VALUES ('g', 't0', 't0')").run().lastInsertRowid
    )
    const older = insertPaper('Hit Older', null, '2024-01-01')
    const newer = insertPaper('Hit Newer', null, '2024-06-01')
    const bodyOnly = insertPaper('Other', null, '2024-09-01')
    indexFullTextFts(db, bodyOnly, '正文 tokenbodyonly 不在任何标题。')
    indexFullTextFts(db, newer, '标题论文的正文也写了 tokenbodyonly。')

    const res = searchSidebar(db, graphId, 'Hit')
    expect(res.others.map((h) => [h.paperId, h.via])).toEqual([
      [newer, 'title'],
      [older, 'title']
    ])
    const withBody = searchSidebar(db, graphId, 'tokenbodyonly')
    const bodyIds = withBody.others.map((h) => h.paperId).sort((x, y) => x - y)
    expect(bodyIds).toEqual([newer, bodyOnly].sort((x, y) => x - y))
    expect(withBody.others.every((h) => h.via === 'body')).toBe(true)
    // newer 标题不含该词、正文含：只出现一次，且是正文命中
    expect(withBody.others.filter((h) => h.paperId === newer)).toEqual([{ paperId: newer, via: 'body' }])
  })

  it('1 个字符（含中文单字）不查正文；2 个字符才查', () => {
    const graphId = Number(
      db.prepare("INSERT INTO graphs (name, created_at, updated_at) VALUES ('g', 't0', 't0')").run().lastInsertRowid
    )
    const pid = insertPaper('论文甲', null, '2024-01-01')
    indexFullTextFts(db, pid, '正文含有机器学习一词。')
    const searchBody = vi.fn(() => [{ paper_id: pid, rank: 0.1 }])

    const one = searchSidebar(db, graphId, '机', { searchBody })
    expect(searchBody).not.toHaveBeenCalled()
    expect(one.others.every((h) => h.via === 'title')).toBe(true)

    searchSidebar(db, graphId, '机器', { searchBody })
    expect(searchBody).toHaveBeenCalledTimes(1)

    // 真实索引：2 字中文能命中（前缀 / 分词），作为阈值依据
    const real = searchFullText(db, '机器')
    expect(real.map((r) => r.paper_id)).toContain(pid)
    const merged = searchSidebar(db, graphId, '机器')
    expect(merged.others).toEqual([{ paperId: pid, via: 'body' }])
  })

  it('空串不查正文，返回该段全部且不截断', () => {
    const graphId = Number(
      db.prepare("INSERT INTO graphs (name, created_at, updated_at) VALUES ('g', 't0', 't0')").run().lastInsertRowid
    )
    const ids = Array.from({ length: 3 }, (_, i) => insertPaper(`P${i}`, null, `2024-01-0${i + 1}`))
    addMember(graphId, ids[0]!, '2024-01-01')
    const searchBody = vi.fn(() => [])
    const res = searchSidebar(db, graphId, '   ', { searchBody, limit: 1 })
    expect(searchBody).not.toHaveBeenCalled()
    expect(res.members.map((h) => h.paperId)).toEqual([ids[0]])
    expect(res.others).toHaveLength(2)
  })

  it('特殊字符与注入的查询异常都不抛，降级为标题命中', () => {
    const graphId = Number(
      db.prepare("INSERT INTO graphs (name, created_at, updated_at) VALUES ('g', 't0', 't0')").run().lastInsertRowid
    )
    const pid = insertPaper('Safe Title', null, '2024-01-01')
    for (const q of ['"', '(', '*', 'OR', '图:', '!!!', 'a AND b OR (', "it's"]) {
      expect(() => searchSidebar(db, graphId, q)).not.toThrow()
      const res = searchSidebar(db, graphId, q)
      expect(Array.isArray(res.members)).toBe(true)
      expect(Array.isArray(res.others)).toBe(true)
    }
    const searchBody = vi.fn(() => {
      throw new Error('fts MATCH syntax')
    })
    const degraded = searchSidebar(db, graphId, 'Safe', { searchBody })
    expect(degraded.others).toEqual([{ paperId: pid, via: 'title' }])
  })

  it('limit：标题先占满，正文只填剩余', () => {
    const graphId = Number(
      db.prepare("INSERT INTO graphs (name, created_at, updated_at) VALUES ('g', 't0', 't0')").run().lastInsertRowid
    )
    const a = insertPaper('Hit A', null, '2024-03-01')
    const b = insertPaper('Hit B', null, '2024-02-01')
    const c = insertPaper('Body C', null, '2024-01-01')
    indexFullTextFts(db, c, '正文里的 Hit 不应该挤掉标题。')
    const res = searchSidebar(db, graphId, 'Hit', { limit: 2 })
    expect(res.others.map((h) => h.paperId)).toEqual([a, b])
    const room = searchSidebar(db, graphId, 'Hit', { limit: 3 })
    expect(room.others.map((h) => [h.paperId, h.via])).toEqual([
      [a, 'title'],
      [b, 'title'],
      [c, 'body']
    ])
  })

  it('图谱 ID 不合法抛错，不查库路径', () => {
    expect(() => searchSidebar(db, 0, 'ab')).toThrow('图谱 ID 不合法')
    expect(() => searchSidebar(db, 1.5, 'ab')).toThrow('图谱 ID 不合法')
  })
})
