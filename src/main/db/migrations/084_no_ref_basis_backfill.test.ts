import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { MIGRATIONS, runMigrations } from './index'
import { migration084 } from './084_no_ref_basis_backfill'
import { recalcNoRefBasis } from '../../relations/autoTypes'

/**
 * uat4 建议修14b / uat4-fix1 D173（M2）：迁移 084（no_ref_basis 回填）测试。
 *
 * 模拟 UAT 老库（迁移跑到 83）：「基于/改进」关系的 no_ref_basis 全是默认值 0。
 * 回填口径（D173 修订）：
 * - 两端都没有 paper_references 行（引用匹配从没跑过）→ **保持 0**（还没核过，不标 1）；
 * - 有引用数据且有 cites 证据（computeAutoTypes 双向匹配，与 D150 同源）→ 显式 0；
 * - 有引用数据但无 cites 证据 → 1。
 * 引用数据写入后由 autoTypes.recalcNoRefBasis 重算（1→0 / 0→1 都允许）。
 * 不调 LLM、不联网、幂等。
 */

let dir: string
let db: Database.Database
let graphId: number
let paperA: number
let paperB: number
let paperC: number
let paperD: number

function insPaper(title: string): number {
  const now = new Date().toISOString()
  return Number(
    db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES (?, 'zotero', 1, ?, ?)").run(title, now, now).lastInsertRowid
  )
}

function insRelation(
  src: number,
  dst: number,
  llmTypes: string,
  extra: Partial<{ deletedAt: string | null; noRefBasis: number; sourceType: 'job' | 'session' }> = {}
): number {
  const now = new Date().toISOString()
  return Number(
    db
      .prepare(
        `INSERT INTO relations (graph_id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types,
           source_type, no_ref_basis, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, '陈述', ?, '[]', ?, ?, ?, ?, ?)`
      )
      .run(
        graphId,
        Math.min(src, dst),
        Math.max(src, dst),
        src,
        llmTypes,
        extra.sourceType ?? 'job',
        extra.noRefBasis ?? 0,
        extra.deletedAt ?? null,
        now,
        now
      ).lastInsertRowid
  )
}

function member(pid: number): void {
  db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)').run(
    graphId,
    pid,
    new Date().toISOString()
  )
}

function noRefBasisOf(relationId: number): number {
  return (db.prepare('SELECT no_ref_basis AS v FROM relations WHERE id = ?').get(relationId) as { v: number }).v
}

/** 模拟「现有库」：只跑到 83（不含 084），user_version=83 */
function migrateUpTo83(): void {
  runMigrations(
    db,
    MIGRATIONS.filter((m) => m.version <= 83)
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-mig84-'))
  db = new Database(join(dir, 'graphictero.db'))
  migrateUpTo83()
  const now = new Date().toISOString()
  graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('回填图', now, now).lastInsertRowid)
  paperA = insPaper('甲')
  paperB = insPaper('乙')
  paperC = insPaper('丙')
  paperD = insPaper('丁')
  for (const pid of [paperA, paperB, paperC, paperD]) member(pid)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('迁移 084（no_ref_basis 回填，uat4 建议修14b / fix1 D173 修订）', () => {
  it('有引用证据的「基于/改进」→ 显式 0；核过引用但无证据 → 1；非基于/改进与已软删的边不动', () => {
    const withEvidence = insRelation(paperA, paperB, '["based_on"]')
    const withoutEvidence = insRelation(paperA, paperC, '["based_on"]')
    const compares = insRelation(paperA, paperD, '["compares"]')
    const deleted = insRelation(paperB, paperC, '["based_on"]', { deletedAt: new Date().toISOString() })
    const now = new Date().toISOString()
    // 引用证据：B 的参考文献匹配到 A（B 引 A，方向不影响 cites 判定，双向核）
    db.prepare(
      `INSERT INTO paper_references (paper_id, openalex_wid, doi, title, year, matched_paper_id, source, created_at)
       VALUES (?, 'W9', NULL, '甲', 2020, ?, 'openalex', ?)`
    ).run(paperB, paperA, now)
    // C 核过引用但没匹配到本图任何论文（matched_paper_id 为 NULL 的行也算「核过」）
    db.prepare(
      `INSERT INTO paper_references (paper_id, openalex_wid, doi, title, year, matched_paper_id, source, created_at)
       VALUES (?, 'W10', NULL, '外部文献', 2019, NULL, 'openalex', ?)`
    ).run(paperC, now)

    migration084.up(db)

    expect(noRefBasisOf(withEvidence)).toBe(0) // 已核过、有依据（显式 0）
    expect(noRefBasisOf(withoutEvidence)).toBe(1) // 核过引用、确无证据
    expect(noRefBasisOf(compares)).toBe(0) // 非「基于/改进」不参与回填
    expect(noRefBasisOf(deleted)).toBe(0) // 软删行不动
  })

  it('D173：引用证据尚未核过（两端都无 paper_references 行）→ 保持 0，不写 1', () => {
    const neverChecked = insRelation(paperA, paperB, '["based_on"]')
    migration084.up(db)
    expect(noRefBasisOf(neverChecked)).toBe(0) // 还没核过 ≠ 无依据
  })

  it('D173：引用数据写入后重算——补 cites 证据 1→0 与 0→1 都允许（recalcNoRefBasis）', () => {
    const rel = insRelation(paperA, paperB, '["based_on"]') // src=A dst=B
    const now = new Date().toISOString()
    // ① 先核过引用但无证据：迁移标 1
    db.prepare(
      `INSERT INTO paper_references (paper_id, openalex_wid, doi, title, year, matched_paper_id, source, created_at)
       VALUES (?, 'W1', NULL, '外部文献', 2019, NULL, 'openalex', ?)`
    ).run(paperB, now)
    migration084.up(db)
    expect(noRefBasisOf(rel)).toBe(1)
    // ② 补上 cites 证据（A 的参考文献匹配到 B）→ 重算改回 0
    db.prepare(
      `INSERT INTO paper_references (paper_id, openalex_wid, doi, title, year, matched_paper_id, source, created_at)
       VALUES (?, 'W2', NULL, '乙', 2021, ?, 'deepseek', ?)`
    ).run(paperA, paperB, now)
    recalcNoRefBasis(db, paperA)
    expect(noRefBasisOf(rel)).toBe(0) // 1 → 0
    // ③ 证据行删掉（引用数据重写后没了这条匹配）→ 重算又变 1（0→1 也允许）
    db.prepare("DELETE FROM paper_references WHERE paper_id = ? AND source = 'deepseek'").run(paperA)
    recalcNoRefBasis(db, paperA)
    expect(noRefBasisOf(rel)).toBe(1)
  })

  it('幂等：重复执行结果一致（是 paper_references 的纯函数）', () => {
    const withEvidence = insRelation(paperA, paperB, '["based_on"]')
    const withoutEvidence = insRelation(paperA, paperC, '["based_on"]')
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO paper_references (paper_id, openalex_wid, doi, title, year, matched_paper_id, source, created_at)
       VALUES (?, NULL, NULL, '甲', 2020, ?, 'deepseek', ?)`
    ).run(paperB, paperA, now)
    db.prepare(
      `INSERT INTO paper_references (paper_id, openalex_wid, doi, title, year, matched_paper_id, source, created_at)
       VALUES (?, NULL, NULL, '外部文献', 2019, NULL, 'openalex', ?)`
    ).run(paperC, now)

    migration084.up(db)
    const first = [noRefBasisOf(withEvidence), noRefBasisOf(withoutEvidence)]
    migration084.up(db) // 手动再调一次（模拟重复跑）
    migration084.up(db)
    expect([noRefBasisOf(withEvidence), noRefBasisOf(withoutEvidence)]).toEqual(first)
    expect(first).toEqual([0, 1])
  })

  it('D174：手工 / session 边不参与回填（不是「AI 推断」，不打无引用依据标记）', () => {
    const manual = insRelation(paperA, paperB, '["based_on"]', { sourceType: 'session' })
    const sessionEdge = insRelation(paperA, paperC, '["based_on"]', { sourceType: 'session' })
    const now = new Date().toISOString()
    // A 核过引用、无 cites 证据（按旧口径会标 1——D174 后 session 边不动）
    db.prepare(
      `INSERT INTO paper_references (paper_id, openalex_wid, doi, title, year, matched_paper_id, source, created_at)
       VALUES (?, 'W1', NULL, '外部文献', 2019, NULL, 'openalex', ?)`
    ).run(paperA, now)

    migration084.up(db)
    expect(noRefBasisOf(manual)).toBe(0)
    expect(noRefBasisOf(sessionEdge)).toBe(0)
  })

  it('D174：recalcNoRefBasis 同样只处理 AI 边，且两端无引用行保持现值（084 同口径）', () => {
    const ai = insRelation(paperA, paperB, '["based_on"]')
    const manual = insRelation(paperA, paperC, '["based_on"]', { sourceType: 'session' })
    // ① 两端都无 paper_references 行：recalc 保持 0（还没核过，不标 1）
    recalcNoRefBasis(db, paperA)
    expect(noRefBasisOf(ai)).toBe(0)
    // ② 核过但无 cites：AI 边标 1；session 边不动
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO paper_references (paper_id, openalex_wid, doi, title, year, matched_paper_id, source, created_at)
       VALUES (?, 'W1', NULL, '外部文献', 2019, NULL, 'openalex', ?)`
    ).run(paperA, now)
    recalcNoRefBasis(db, paperA)
    expect(noRefBasisOf(ai)).toBe(1)
    expect(noRefBasisOf(manual)).toBe(0)
    // ③ 补上 cites 证据：AI 边 1→0；session 边仍不动
    db.prepare(
      `INSERT INTO paper_references (paper_id, openalex_wid, doi, title, year, matched_paper_id, source, created_at)
       VALUES (?, 'W2', NULL, '乙', 2021, ?, 'deepseek', ?)`
    ).run(paperB, paperA, now)
    recalcNoRefBasis(db, paperB)
    expect(noRefBasisOf(ai)).toBe(0)
    expect(noRefBasisOf(manual)).toBe(0)
  })

  it('引用数据方向反过来（A 引 B）同样算证据——与 D150 双向口径一致', () => {
    const rel = insRelation(paperA, paperB, '["based_on"]') // src=A dst=B
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO paper_references (paper_id, openalex_wid, doi, title, year, matched_paper_id, source, created_at)
       VALUES (?, NULL, NULL, '乙', 2021, ?, 'openalex', ?)`
    ).run(paperA, paperB, now) // A 的参考文献匹配到 B

    migration084.up(db)
    expect(noRefBasisOf(rel)).toBe(0)
  })

  it('全量迁移：user_version=83 的库升上来，084 在列、版本到 90', () => {
    insRelation(paperA, paperB, '["based_on"]')
    expect(db.pragma('user_version', { simple: true })).toBe(83)
    const applied = runMigrations(db, MIGRATIONS)
    expect(applied).toEqual([84, 85, 86, 87, 88, 89, 90])
    expect(db.pragma('user_version', { simple: true })).toBe(90)
    // 再跑是空操作
    expect(runMigrations(db, MIGRATIONS)).toEqual([])
  })
})
