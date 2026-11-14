import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { MIGRATIONS, runMigrations } from './index'
import { rematchPaperReferences } from '../../relations/refRematch'

/**
 * uat6b M3：验证 uat6 M2（迁移 086）对「UAT 形态」数据确实回填——测试者 在 63ab720
 * （不含 uat6）复测见 paper_references 非空 matched_paper_id = 0/375。本测试自造
 * 接近 UAT 的 fixture：
 * - 库从 user_version 85 起升级（与 UAT 库同路径：initDataLayer → runMigrations，
 *   086 经 UAT1_MIGRATIONS 注册，不会跳过）；
 * - ≥9 篇论文、≥300 条已存在且 matched_paper_id 全 NULL 的引用行，DOI 大小写 /
 *   https://doi.org/ 前缀 / arXiv 10.48550/arxiv. 形式 / 仅标题（带标点与大小写差异）
 *   混合；论文 7、8 引用 SeaKR（论文 9）；
 * - 断言：非空匹配数 > 0、7/8→9 填上、对应 AI 自动边（source_type='job'）获得 cites
 *   且 no_ref_basis 1→0、手工/session 边不动、幂等（第二遍零写入）。
 * 全程离线（无 fetch、无 LLM）。
 */

let dir: string
let db: Database.Database
let graphId: number
let p7: number
let p8: number
let p9: number

const SEAKR_TITLE = 'SeaKR: Self-aware Knowledge Retrieval for Adaptive Retrieval Augmented Generation'
const SEAKR_DOI = '10.48550/arxiv.2310.11511'
const SEAKR_WID = 'W4379500198'

function insPaper(title: string, extra: { doi?: string | null; arxivId?: string | null; wid?: string | null; author?: string | null; year?: number } = {}): number {
  const now = new Date().toISOString()
  return Number(
    db
      .prepare(
        'INSERT INTO papers (title, source, has_pdf, first_author, year, doi, arxiv_id, openalex_wid, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(title, 'zotero', extra.author ?? null, extra.year ?? 2023, extra.doi ?? null, extra.arxivId ?? null, extra.wid ?? null, now, now).lastInsertRowid
  )
}

function insRef(paperId: number, cols: { wid?: string | null; doi?: string | null; title?: string | null; year?: number | null }): void {
  db.prepare(
    `INSERT INTO paper_references (paper_id, openalex_wid, doi, title, year, matched_paper_id, source, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, 'openalex', ?)`
  ).run(paperId, cols.wid ?? null, cols.doi ?? null, cols.title ?? null, cols.year ?? null, new Date().toISOString())
}

function insRelation(src: number, dst: number, sourceType: 'job' | 'session', noRefBasis: number): number {
  const now = new Date().toISOString()
  return Number(
    db
      .prepare(
        `INSERT INTO relations (graph_id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types,
           source_type, no_ref_basis, created_at, updated_at)
         VALUES (?, ?, ?, ?, '陈述原文', '["based_on"]', '[]', ?, ?, ?, ?)`
      )
      .run(graphId, Math.min(src, dst), Math.max(src, dst), src, sourceType, noRefBasis, now, now).lastInsertRowid
  )
}

const snapshot = (): { refs: string; rels: string } => ({
  refs: JSON.stringify(db.prepare('SELECT * FROM paper_references ORDER BY id').all()),
  rels: JSON.stringify(db.prepare('SELECT * FROM relations ORDER BY id').all())
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-rematch-uat-'))
  db = new Database(join(dir, 'graphictero.db'))
  // UAT 库同路径：先升到 85（uat5 已占 085），数据在 086 之前造好
  runMigrations(db, MIGRATIONS.filter((m) => m.version <= 85))
  const now = new Date().toISOString()
  graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('UAT 图', now, now).lastInsertRowid)
  for (let i = 1; i <= 8; i++) {
    const pid = insPaper(`成员论文 ${i}: A Study Number ${i}`, { doi: `10.1000/member.${i}`, wid: `W100${i}`, year: 2022 })
    db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)').run(graphId, pid, now)
    if (i === 7) p7 = pid
    if (i === 8) p8 = pid
  }
  p9 = insPaper(SEAKR_TITLE, { doi: SEAKR_DOI, arxivId: '2310.11511', wid: SEAKR_WID, author: 'Vu', year: 2023 })
  db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)').run(graphId, p9, now)

  // ≥300 条遗留引用行，matched_paper_id 全 NULL，形态混合
  for (let i = 0; i < 150; i++) {
    // 不匹配行：库外 DOI / wid / 标题
    insRef(p7, { wid: `W9000${i}`, doi: `10.9999/external.${i}`, title: `Unrelated External Work ${i}`, year: 2019 })
  }
  for (let i = 0; i < 40; i++) {
    // DOI 带 https://doi.org/ 前缀
    insRef(p7, { doi: `https://doi.org/${SEAKR_DOI}`, title: 'some seakr variant', year: 2023 })
  }
  for (let i = 0; i < 30; i++) {
    // DOI 大写形态
    insRef(p7, { doi: SEAKR_DOI.toUpperCase(), year: 2023 })
  }
  for (let i = 0; i < 30; i++) {
    // arXiv DOI 形式（10.48550/arxiv.，小写 arxiv）
    insRef(p8, { doi: '10.48550/arxiv.2310.11511', year: 2023 })
  }
  for (let i = 0; i < 20; i++) {
    // 仅标题：标点与大小写差异（冒号、连字符）
    insRef(p8, { title: 'seakr: self-aware knowledge retrieval for adaptive retrieval augmented generation', year: 2023 })
  }
  for (let i = 0; i < 20; i++) {
    // wid 路径（大写）；另给一条小写 wid（wid 径 miss，但标题径兜底命中）
    insRef(i % 2 === 0 ? p7 : p8, { wid: SEAKR_WID, title: SEAKR_TITLE, year: 2023 })
  }
  for (let i = 0; i < 16; i++) {
    insRef(p8, { wid: 'w4379500198', title: 'Seakr self aware knowledge retrieval for adaptive retrieval augmented generation', year: 2023 })
  }
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('uat6b M3：uat6 M2（迁移 086）对 UAT 形态数据的重匹配', () => {
  it('启动升级路径（user_version 85 → 90）确实跑到重匹配并回填已有行', () => {
    const applied = runMigrations(db, MIGRATIONS)
    expect(applied).toEqual([86, 87, 88, 89, 90]) // 086 引用重匹配 + 087 候选收口 + 088 推理 token 列 + 089 候选理由恢复 + 090 superseded_at
    expect(db.pragma('user_version', { simple: true })).toBe(90)
    const matched = db.prepare('SELECT COUNT(*) AS n FROM paper_references WHERE matched_paper_id IS NOT NULL').get() as { n: number }
    expect(matched.n).toBeGreaterThan(0) // 测试者 复测的 0/375 在此形态下被回填
    const to9 = db
      .prepare('SELECT COUNT(*) AS n FROM paper_references WHERE matched_paper_id = ?')
      .get(p9) as { n: number }
    expect(to9.n).toBe(40 + 30 + 30 + 20 + 20 + 16) // 7/8 的全部 SeaKR 引用行都填上 9
  })

  it('论文 7、8 的 SeaKR 引用行全部回填 matched_paper_id=9（按引用方分组核对）', () => {
    runMigrations(db, MIGRATIONS)
    const by7 = db.prepare('SELECT COUNT(*) AS n FROM paper_references WHERE paper_id = ? AND matched_paper_id = ?').get(p7, p9) as { n: number }
    const by8 = db.prepare('SELECT COUNT(*) AS n FROM paper_references WHERE paper_id = ? AND matched_paper_id = ?').get(p8, p9) as { n: number }
    expect(by7.n).toBe(40 + 30 + 10) // p7：前缀 DOI 40 + 大写 DOI 30 + 偶数 wid 10
    expect(by8.n).toBe(30 + 20 + 10 + 16) // p8：arXiv DOI 30 + 标题 20 + 奇数 wid 10 + 小写 wid+标题 16
    // 库外引用行保持 NULL
    const nulls = db.prepare('SELECT COUNT(*) AS n FROM paper_references WHERE matched_paper_id IS NULL').get() as { n: number }
    expect(nulls.n).toBe(150)
  })

  it('受影响 AI 自动边（source_type=job）获得 cites 且 no_ref_basis 1→0；手工/session 边不动', () => {
    const auto7 = insRelation(p7, p9, 'job', 1)
    const auto8 = insRelation(p8, p9, 'job', 1)
    // 手工边：同一对端点的唯一约束下用 7→8（session 边，D174 口径本就不动它）
    const manual = insRelation(p7, p8, 'session', 1)
    runMigrations(db, MIGRATIONS)
    const row = (id: number): { auto_types: string; no_ref_basis: number } =>
      db.prepare('SELECT auto_types, no_ref_basis FROM relations WHERE id = ?').get(id) as { auto_types: string; no_ref_basis: number }
    expect(JSON.parse(row(auto7).auto_types)).toContain('cites')
    expect(row(auto7).no_ref_basis).toBe(0)
    expect(JSON.parse(row(auto8).auto_types)).toContain('cites')
    expect(row(auto8).no_ref_basis).toBe(0)
    // 手工边：D174 口径不触碰（7→8 无端点引用行也不获得 cites）
    expect(JSON.parse(row(manual).auto_types)).not.toContain('cites')
    expect(row(manual).no_ref_basis).toBe(1)
  })

  it('幂等：第二遍（直接再调重匹配）零写入，表级快照一致', () => {
    runMigrations(db, MIGRATIONS)
    const s1 = snapshot()
    expect(rematchPaperReferences(db).filled).toBe(0) // 只剩匹配不上的 NULL 行
    expect(snapshot()).toEqual(s1)
  })
})
