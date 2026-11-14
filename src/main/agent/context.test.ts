import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { buildEntryPointer } from './context'

/**
 * M6 第 0 批 B1：graph 入口指针附「已有关系 N 条」+ 边一行摘要（上限 30 条，
 * 超出提示用 listRelations 查）；中文类型名；无边图谱不带关系段。
 */

let dir: string
let db: Database.Database
let graphId: number

const now = (): string => new Date().toISOString()

function insertPaper(title: string): number {
  return Number(
    db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES (?, 'zotero', 1, ?, ?)").run(title, now(), now()).lastInsertRowid
  )
}

function addEdge(src: number, dst: number, statement: string, idHint: number): void {
  db.prepare(
    `INSERT INTO relations (graph_id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types,
       source_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '["compares"]', '[]', 'job', ?, ?)`
  ).run(graphId, Math.min(src, dst), Math.max(src, dst), src, `${statement} ${idHint}`, now(), now())
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-ctx-'))
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS)
  graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('指针图', now(), now()).lastInsertRowid)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('buildEntryPointer（B1：graph 入口附边摘要）', () => {
  it('无边图谱：指针只含论文名片，不出现关系段', () => {
    const p = insertPaper('独苗')
    db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)').run(graphId, p, now())
    const ptr = buildEntryPointer(db, { entryType: 'graph', graphId, entryId: null })
    expect(ptr.text).toContain('共 1 篇论文')
    expect(ptr.text).not.toContain('已有关系')
  })

  it('有边：含「已有关系 N 条」+ 方向 + 中文类型 + 陈述摘要', () => {
    const a = insertPaper('甲')
    const b = insertPaper('乙')
    const ins = db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)')
    ins.run(graphId, a, now())
    ins.run(graphId, b, now())
    addEdge(a, b, '甲针对乙的对比研究陈述', 1)
    const ptr = buildEntryPointer(db, { entryType: 'graph', graphId, entryId: null })
    expect(ptr.text).toContain('已有关系 1 条')
    expect(ptr.text).toContain('#1')
    expect(ptr.text).toContain('P01→P02')
    expect(ptr.text).toContain('对比')
    expect(ptr.text).toContain('甲针对乙的对比研究陈述')
    expect(ptr.text).not.toContain('compares') // B7：中文类型名
  })

  it('超过 30 条：只列前 30 并提示用 listRelations 查', () => {
    const ids: number[] = []
    for (let i = 0; i < 10; i++) ids.push(insertPaper(`论文${i}`))
    const ins = db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)')
    for (const id of ids) ins.run(graphId, id, now())
    // 35 条互不重复的无序对（唯一约束 (graph_id, paper_low, paper_high)）
    let n = 0
    outer: for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        addEdge(ids[a], ids[b], `关系${n}`, n)
        if (++n >= 35) break outer
      }
    }
    const ptr = buildEntryPointer(db, { entryType: 'graph', graphId, entryId: null })
    expect(ptr.text).toContain('已有关系 35 条')
    expect(ptr.text).toContain('仅列前 30 条')
    expect(ptr.text).toContain('listRelations')
    // 摘要行数 = 30（每条一行 `- #id P..→P..（类型）：陈述`）
    expect(ptr.text.match(/^- #\d+ P\d+/gm)).toHaveLength(30)
  })

  it('uat6b S3：指向非成员论文的遗留边不进起始上下文（与 listRelations/画布同口径）', () => {
    const a = insertPaper('甲')
    const b = insertPaper('乙')
    const outsider = insertPaper('非成员')
    const ins = db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)')
    ins.run(graphId, a, now())
    ins.run(graphId, b, now())
    addEdge(a, b, '成员间正常边', 1)
    addEdge(a, outsider, '指向非成员的遗留边', 2)
    const ptr = buildEntryPointer(db, { entryType: 'graph', graphId, entryId: null })
    expect(ptr.text).toContain('已有关系 1 条')
    expect(ptr.text).toContain('成员间正常边')
    expect(ptr.text).not.toContain('指向非成员的遗留边')
  })
})
