import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { MIGRATIONS, runMigrations } from './index'
import { migration086 } from './086_paper_references_rematch'
import { rematchPaperReferences } from '../../relations/refRematch'

/**
 * uat6 M2：迁移 086（已有 paper_references 行幂等重匹配 + D174 重算）测试。
 *
 * 模拟测试者 UAT 现场：paper_references.matched_paper_id 全 NULL（只在 INSERT 时写
 * 一次，D165 匹配修复够不着旧行）。论文 7、8 引用 SeaKR（9），三种入口各一行：
 * DOI（带 https 前缀/大小写差异）、arXiv（带版本号的 arXiv-DOI）、标题（0.95+ 阈值）。
 * 断言：重匹配填上 9 → 受影响论文的 AI 自动边补上 cites、no_ref_basis 1→0；
 * 手工/session 边不动；两端无引用行的边保持 0；已非空的 matched_paper_id 不清空；
 * 软删目标不匹配；幂等（第二遍表级快照一致）；全程离线（本文件不触网、无 fetch）。
 */

let dir: string
let db: Database.Database
let graphId: number
let p7: number
let p8: number
let p9: number

function insPaper(title: string, extra: { doi?: string | null; arxivId?: string | null; wid?: string | null; author?: string | null } = {}): number {
  const now = new Date().toISOString()
  return Number(
    db
      .prepare(
        'INSERT INTO papers (title, source, has_pdf, first_author, year, doi, arxiv_id, openalex_wid, created_at, updated_at) VALUES (?, ?, 1, ?, 2024, ?, ?, ?, ?, ?)'
      )
      .run(title, 'zotero', extra.author ?? null, extra.doi ?? null, extra.arxivId ?? null, extra.wid ?? null, now, now).lastInsertRowid
  )
}

function insRelation(
  src: number,
  dst: number,
  llmTypes: string,
  extra: Partial<{ noRefBasis: number; sourceType: 'job' | 'session'; autoTypes: string }> = {}
): number {
  const now = new Date().toISOString()
  return Number(
    db
      .prepare(
        `INSERT INTO relations (graph_id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types,
           source_type, no_ref_basis, created_at, updated_at)
         VALUES (?, ?, ?, ?, '陈述原文', ?, ?, ?, ?, ?, ?)`
      )
      .run(graphId, Math.min(src, dst), Math.max(src, dst), src, llmTypes, extra.autoTypes ?? '[]', extra.sourceType ?? 'job', extra.noRefBasis ?? 0, now, now)
      .lastInsertRowid
  )
}

function member(pid: number): void {
  db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)').run(graphId, pid, new Date().toISOString())
}

function insRef(paperId: number, cols: { wid?: string | null; doi?: string | null; title?: string | null; year?: number | null; matched?: number | null }): void {
  db.prepare(
    `INSERT INTO paper_references (paper_id, openalex_wid, doi, title, year, matched_paper_id, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'openalex', ?)`
  ).run(paperId, cols.wid ?? null, cols.doi ?? null, cols.title ?? null, cols.year ?? null, cols.matched ?? null, new Date().toISOString())
}

const refRows = (): Array<Record<string, unknown>> =>
  db.prepare('SELECT paper_id, openalex_wid, doi, title, year, matched_paper_id FROM paper_references ORDER BY id').all() as Array<Record<string, unknown>>
const relRows = (): Array<Record<string, unknown>> =>
  db.prepare('SELECT id, auto_types, no_ref_basis, src_paper, statement_text, updated_at FROM relations ORDER BY id').all() as Array<Record<string, unknown>>
const autoTypesOf = (id: number): string[] => JSON.parse((db.prepare('SELECT auto_types AS v FROM relations WHERE id = ?').get(id) as { v: string }).v) as string[]
const noRefBasisOf = (id: number): number => (db.prepare('SELECT no_ref_basis AS v FROM relations WHERE id = ?').get(id) as { v: number }).v

function migrateUpTo85(): void {
  runMigrations(
    db,
    MIGRATIONS.filter((m) => m.version <= 85)
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-mig86-'))
  db = new Database(join(dir, 'graphictero.db'))
  migrateUpTo85()
  const now = new Date().toISOString()
  graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('重匹配图', now, now).lastInsertRowid)
  // 论文 7、8 引用 SeaKR（论文 9）；三个入口各一
  p7 = insPaper('Seven: When Absence Is Evidence', { author: 'Min' })
  p8 = insPaper('Eight: Illusory Completion in Search', { author: 'Ko' })
  p9 = insPaper('SeaKR: Self-aware Knowledge Retrieval for Agentic Systems', { doi: '10.1234/seakr', arxivId: '2401.00001', author: 'Yao' })
  for (const pid of [p7, p8, p9]) member(pid)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('迁移 086（paper_references 重匹配，uat6 M2）', () => {
  it('DOI / arXiv / 标题三种入口的 NULL 行都重匹配到库内论文；AI 边补 cites、no_ref_basis 1→0', () => {
    // 论文 7 的三条引用行，matched_paper_id 全 NULL（UAT 旧数据形态）
    insRef(p7, { doi: 'https://doi.org/10.1234/SeaKR', year: 2024 }) // DOI 径（前缀+大小写差异）
    insRef(p7, { doi: '10.48550/arXiv.2401.00001v2', year: 2024 }) // arXiv 径（带版本号）
    insRef(p7, { title: 'SeaKR: Self-aware Knowledge Retrieval for Agentic Systems', year: 2025 }) // 标题径（年份 ±1）
    const ai = insRelation(p7, p9, '["based_on"]', { noRefBasis: 1 })
    const beforeUpdatedAt = (db.prepare('SELECT updated_at AS v FROM relations WHERE id = ?').get(ai) as { v: string }).v
    const beforeStatement = (db.prepare('SELECT statement_text AS v FROM relations WHERE id = ?').get(ai) as { v: string }).v

    migration086.up(db)

    const matched = db.prepare('SELECT matched_paper_id AS v FROM paper_references ORDER BY id').all() as Array<{ v: number | null }>
    expect(matched.map((r) => r.v)).toEqual([p9, p9, p9])
    expect(autoTypesOf(ai)).toContain('cites') // 7 引 9 → AI 边补引用类型
    expect(noRefBasisOf(ai)).toBe(0) // 1 → 0（D174 重算）
    // 084 口径：不写 statement_text、不改 updated_at、不改方向
    const after = db.prepare('SELECT statement_text AS s, updated_at AS u, src_paper AS p FROM relations WHERE id = ?').get(ai) as { s: string; u: string; p: number }
    expect(after.s).toBe(beforeStatement)
    expect(after.u).toBe(beforeUpdatedAt)
    expect(after.p).toBe(p7)
  })

  it('D174：手工/session 边不重算（cites 不附加、现值 auto_types 保留）', () => {
    insRef(p7, { doi: '10.1234/seakr', year: 2024 }) // 7 引 9
    const manual = insRelation(p7, p9, '["based_on"]', { sourceType: 'session', noRefBasis: 0, autoTypes: '["same_author"]' })
    migration086.up(db)
    expect(autoTypesOf(manual)).toEqual(['same_author']) // 不附加 cites（论文未登记共同作者，重算会清空——保留即证明没动）
    expect(noRefBasisOf(manual)).toBe(0)
  })

  it('两端都没有 paper_references 行的 AI 边：no_ref_basis 保持 0（084 同口径）', () => {
    insRef(p7, { doi: '10.1234/seakr', year: 2024 }) // 只有 7 有引用行；8、9 无行
    const isolated = insRelation(p8, p9, '["based_on"]', { noRefBasis: 0 })
    migration086.up(db)
    expect(noRefBasisOf(isolated)).toBe(0)
    expect(autoTypesOf(isolated)).toEqual([])
  })

  it('已非空的 matched_paper_id 不清空、不回填覆盖（默认口径）', () => {
    insRef(p7, { doi: '10.1234/seakr', year: 2024, matched: p7 }) // 现行规则会匹配到 9，但已有非空值不动
    migration086.up(db)
    const v = (db.prepare('SELECT matched_paper_id AS v FROM paper_references').get() as { v: number }).v
    expect(v).toBe(p7)
  })

  it('软删论文不作为匹配目标', () => {
    db.prepare('UPDATE papers SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), p9)
    insRef(p7, { doi: '10.1234/seakr', year: 2024 })
    migration086.up(db)
    expect((db.prepare('SELECT matched_paper_id AS v FROM paper_references').get() as { v: number | null }).v).toBeNull()
  })

  it('幂等：第二遍零写入（paper_references 与 relations 表级快照一致）', () => {
    insRef(p7, { doi: 'https://doi.org/10.1234/SeaKR', year: 2024 })
    insRef(p7, { doi: '10.48550/arXiv.2401.00001v2', year: 2024 })
    insRef(p7, { title: 'SeaKR: Self-aware Knowledge Retrieval for Agentic Systems', year: 2025 })
    insRef(p8, { title: '完全不相干的文献标题', year: 1999 }) // 匹配不上，保持 NULL
    insRelation(p7, p9, '["based_on"]', { noRefBasis: 1 })
    insRelation(p8, p9, '["based_on"]', { noRefBasis: 0 })

    const first = rematchPaperReferences(db)
    expect(first.filled).toBe(3)
    expect(first.papersTouched).toEqual([p7])
    const snapRefs = refRows()
    const snapRels = relRows()
    const second = rematchPaperReferences(db)
    expect(second.filled).toBe(0) // 第二遍没有可填的 NULL 行
    expect(second.papersTouched).toEqual([])
    expect(refRows()).toEqual(snapRefs)
    expect(relRows()).toEqual(snapRels)
  })

  it('全量迁移：user_version=85 的库升上来，086 在列、版本到 90，再跑是空操作', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(85)
    const applied = runMigrations(db, MIGRATIONS)
    expect(applied).toEqual([86, 87, 88, 89, 90])
    expect(db.pragma('user_version', { simple: true })).toBe(90)
    expect(runMigrations(db, MIGRATIONS)).toEqual([])
  })
})
