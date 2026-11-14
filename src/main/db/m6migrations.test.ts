import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from './connection'
import { MIGRATIONS, runMigrations } from './migrations'
import { toCandidateView } from '../agent/candidates'

/**
 * M6 预备提交迁移回归（维护者）：061 候选直达列、062 usage_records 放宽 'web'
 * （重建表：行数与费用合计不变；D132：不加 'export'，导出概览计入 chat）。
 */

let dir: string
let db: Database.Database

const now = (): string => new Date().toISOString()

/** 升到 062 之前版本（060/061 已应用、062 未应用）的库。 */
function migrateTo61(): void {
  runMigrations(
    db,
    MIGRATIONS.filter((m) => m.version < 62)
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-m6mig-'))
  db = openDatabase(join(dir, 't.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('062 usage_records 放宽 web（重建表数据保持）', () => {
  it('旧库升级：行数、逐行字段、费用合计不变；新类别 web 可写、export 仍被拒', () => {
    migrateTo61()
    const ins = db.prepare(
      `INSERT INTO usage_records (occurred_at, category, session_id, paper_id, model,
         input_tokens, cache_hit_tokens, cache_miss_tokens, output_tokens, cost_cny, thinking)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    ins.run('2026-10-20T10:00:00.000Z', 'chat', 1, null, 'deepseek-flash', 1000, 800, 200, 50, 0.0123, 1)
    ins.run('2026-10-21T10:00:00.000Z', 'detail', null, 7, 'deepseek-flash', 2000, 0, 2000, 100, 0.0456, 1)
    ins.run('2026-10-22T10:00:00.000Z', 'card', null, 7, 'deepseek-flash', 300, 0, 300, 10, 0.001, 0)
    ins.run('2026-10-23T10:00:00.000Z', 'relation', null, 9, 'deepseek-flash', 500, 100, 400, 20, 0.0089, 1)
    const before = db.prepare('SELECT * FROM usage_records ORDER BY id').all() as Array<Record<string, unknown>>
    const sumBefore = (db.prepare('SELECT SUM(cost_cny) AS s FROM usage_records').get() as { s: number }).s

    const applied = runMigrations(db, MIGRATIONS)
    expect(applied).toEqual([62, 63, 64, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90]) // 063 pdf_attempts；064 概览类别 overview（D142）；080 pdf_unresolved（uat1b）；081 relations edited_at/no_ref_basis（uat2-fix1）；082 papers_text_fts 全文索引、083 候选去重标记列（uat3b）；084 no_ref_basis 回填（uat4 建议修14b）；085 候选 verified + status dismissed（uat5 D168/D169）；086 引用重匹配（uat6 M2）；087 遗留 pending+in_graph 候选改 dismissed（uat6b S2）；088 推理 token 列（uat7 D180）

    const after = db.prepare('SELECT * FROM usage_records ORDER BY id').all() as Array<Record<string, unknown>>
    expect(after).toHaveLength(before.length)
    // 原列逐行一致（含 id）；088 新增的可空推理列对旧行一律为 NULL。
    expect(after).toEqual(before.map((row) => ({ ...row, reasoning_tokens: null })))
    expect((db.prepare('SELECT SUM(cost_cny) AS s FROM usage_records').get() as { s: number }).s).toBeCloseTo(sumBefore, 10)

    // 新类别 web 可写（DeepSeek Search/Fetch 记账，D125）
    expect(() =>
      db.prepare("INSERT INTO usage_records (occurred_at, category, cost_cny) VALUES (?, 'web', 0.005)").run(now())
    ).not.toThrow()
    expect(() =>
      db.prepare("INSERT INTO usage_records (occurred_at, category, cost_cny) VALUES (?, 'overview', 0.05)").run(now())
    ).not.toThrow()
    // D132：不加 export。D142 用 overview，不把概览记回 chat
    expect(() =>
      db.prepare("INSERT INTO usage_records (occurred_at, category, cost_cny) VALUES (?, 'export', 0.005)").run(now())
    ).toThrow()
    // 索引重建生效
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_usage_time'").get()
    expect(idx).toBeTruthy()
  })

  it('全新库直接全量迁移：category CHECK 含 web 与 overview，仍拒绝 export', () => {
    runMigrations(db, MIGRATIONS)
    expect(() =>
      db.prepare("INSERT INTO usage_records (occurred_at, category, cost_cny) VALUES (?, 'web', 0)").run(now())
    ).not.toThrow()
    expect(() =>
      db.prepare("INSERT INTO usage_records (occurred_at, category, cost_cny) VALUES (?, 'overview', 0)").run(now())
    ).not.toThrow()
    expect(() =>
      db.prepare("INSERT INTO usage_records (occurred_at, category, cost_cny) VALUES (?, 'export', 0)").run(now())
    ).toThrow()
    runMigrations(db, MIGRATIONS) // 064 幂等：已含 overview 时不再重建
  })
})

describe('061 候选直达列（2b）', () => {
  it('新列可空不影响旧行；有值时 toCandidateView 透出可选字段', () => {
    migrateTo61()
    runMigrations(db, MIGRATIONS)
    const g = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('g', now(), now()).lastInsertRowid)
    const sess = Number(db.prepare("INSERT INTO sessions (graph_id, entry_type, entry_id, name, created_at, updated_at) VALUES (?, 'graph', NULL, 's', ?, ?)").run(g, now(), now()).lastInsertRowid)
    const p = Number(db.prepare("INSERT INTO papers (title, source, created_at, updated_at) VALUES ('入库论文', 'agent', ?, ?)").run(now(), now()).lastInsertRowid)

    // 旧式行（五列全空）→ 可选字段不透出
    db.prepare(
      `INSERT INTO graph_candidates (graph_id, title, authors_json, year, doi, reason, x, y, status, session_id, created_at, updated_at)
       VALUES (?, '旧候选', '[]', null, '10.1/a', 'r', 0, 0, 'pending', ?, ?, ?)`
    ).run(g, sess, now(), now())
    const oldView = toCandidateView(db.prepare('SELECT * FROM graph_candidates WHERE id = 1').get() as never)
    expect(oldView.sessionId).toBe(sess)
    expect(oldView.paperId).toBeUndefined()
    expect(oldView.venue).toBeUndefined()
    expect(oldView.oaUrl).toBeUndefined()

    // 061 直达列有值 → 透出（确认入库回填 paperId 的场景）
    db.prepare(
      `INSERT INTO graph_candidates (graph_id, title, authors_json, doi, reason, x, y, status, session_id,
         paper_id, venue, openalex_wid, abstract, oa_url, created_at, updated_at)
       VALUES (?, '新候选', '[]', '10.1/b', 'r', 0, 0, 'confirmed', ?, ?, 'NeurIPS 2025', 'W123', '摘要', 'https://oa.example/x.pdf', ?, ?)`
    ).run(g, sess, p, now(), now())
    const view = toCandidateView(db.prepare('SELECT * FROM graph_candidates WHERE id = 2').get() as never)
    expect(view).toMatchObject({ paperId: p, venue: 'NeurIPS 2025', oaUrl: 'https://oa.example/x.pdf', sessionId: sess })
  })
})
