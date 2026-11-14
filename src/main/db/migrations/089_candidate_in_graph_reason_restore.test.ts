import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from '../connection'
import { MIGRATIONS, runMigrations } from './index'
import { migration087 } from './087_pending_in_graph_dismissed'
import { migration089 } from './089_candidate_in_graph_reason_restore'

/**
 * 089（uat6c M1）：087 把 reason 覆盖成 'in_graph' 的数据修复——
 * in_graph 列补 1；reason 从库内可靠来源（session_messages parts 里同号
 * data-paper-card 的最早一条）恢复，找不到置 NULL；正常行不动；幂等。
 */

let dir: string
let db: Database.Database
let graphId: number
let memberPaper: number

const now = (): string => new Date().toISOString()

function insertPaper(title: string): number {
  const t = now()
  return Number(
    db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES (?, 'zotero', 1, ?, ?)").run(title, t, t).lastInsertRowid
  )
}

function insertCandidate(over: Partial<{ reason: string; inGraph: number; status: string; title: string }> = {}): number {
  return Number(
    db
      .prepare(
        `INSERT INTO graph_candidates
           (graph_id, title, authors_json, year, doi, arxiv_id, existing_paper_id, reason, x, y, status,
            session_id, abstract, venue, oa_url, openalex_wid, title_dup, in_graph, verified, created_at, updated_at)
         VALUES (?, ?, '[]', 2024, NULL, NULL, ?, ?, 0, 0, ?, NULL, NULL, NULL, NULL, NULL, 0, ?, 1, ?, ?)`
      )
      .run(graphId, over.title ?? '候选', memberPaper, over.reason ?? '提议', over.status ?? 'dismissed', over.inGraph ?? 0, now(), now()).lastInsertRowid
  )
}

/** 造一条 assistant 消息，parts 里带一张 data-paper-card（id = `c{候选id}`）。 */
function insertCardMessage(candidateId: number, reason: string, title = '候选'): number {
  const t = now()
  const sid = Number(
    db.prepare("INSERT INTO sessions (graph_id, entry_type, entry_id, name, created_at, updated_at) VALUES (?, 'graph', NULL, ?, ?, ?)").run(graphId, 's', t, t).lastInsertRowid
  )
  const parts = JSON.stringify([{ type: 'data-paper-card', id: `c${candidateId}`, status: 'done', title, reason, cardStatus: 'candidate' }])
  return Number(
    db.prepare("INSERT INTO session_messages (session_id, seq, role, parts, created_at) VALUES (?, 1, 'assistant', ?, ?)").run(sid, parts, t).lastInsertRowid
  )
}

const rowOf = (id: number): Record<string, unknown> =>
  db.prepare('SELECT status, reason, in_graph FROM graph_candidates WHERE id = ?').get(id) as Record<string, unknown>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-mig089-'))
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS.filter((m) => m.version <= 88)) // 089 之前
  graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('图', now(), now()).lastInsertRowid)
  memberPaper = insertPaper('成员论文')
  db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)').run(graphId, memberPaper, now())
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('089（uat6c M1）：reason=in_graph 的数据修复（状态与理由分开存）', () => {
  it('有同号卡片消息（创建时出卡）→ reason 恢复为原文，in_graph 补 1', () => {
    const cid = insertCandidate({ reason: 'in_graph', inGraph: 0 })
    insertCardMessage(cid, '与图中 SeekBench（《Do LLM Agents …》）同名同题，值得对照') // sanitize 会剥《》回声括注（与落库同口径）
    migration089.up(db)
    expect(rowOf(cid)).toEqual({ status: 'dismissed', reason: '与图中 SeekBench 同名同题，值得对照', in_graph: 1 })
  })

  it('同号卡片有多条（后来重复提议去重命中卡）→ 取最早一条（创建时原文），不采用后写的新理由', () => {
    const cid = insertCandidate({ reason: 'in_graph', inGraph: 1 })
    const firstMsg = insertCardMessage(cid, '原始中文理由')
    const laterMsg = insertCardMessage(cid, '后写的新理由')
    expect(laterMsg).toBeGreaterThan(firstMsg) // 消息 id 自增 = 时间序
    migration089.up(db)
    expect(rowOf(cid).reason).toBe('原始中文理由')
    expect(rowOf(cid).in_graph).toBe(1)
  })

  it('uat6c-fix1 S1：同号卡片标题全不符 → 不采用（去掉 ?? cards[0] fallback），reason 置 NULL', () => {
    const cid = insertCandidate({ reason: 'in_graph', inGraph: 1, title: '候选甲' })
    // 同号卡存在但标题完全对不上（展示标题漂移）——不信任、不猜
    insertCardMessage(cid, '某条对不上的理由', '另一篇完全不相干的论文')
    migration089.up(db)
    expect(rowOf(cid)).toEqual({ status: 'dismissed', reason: null, in_graph: 1 })
  })

  it('库内无可恢复来源（无同号卡片消息）→ reason 置 NULL、in_graph 补 1（不猜）', () => {
    const cid = insertCandidate({ reason: 'in_graph', inGraph: 0 })
    migration089.up(db)
    expect(rowOf(cid)).toEqual({ status: 'dismissed', reason: null, in_graph: 1 })
  })

  it('正常中文理由的 dismissed / pending / confirmed 行一律不动（含 in_graph 列原样）', () => {
    const dismissed = insertCandidate({ reason: '人在回路验证方法相关', status: 'dismissed', inGraph: 0 })
    const pending = insertCandidate({ reason: '另一个候选理由', status: 'pending', inGraph: 1 })
    const confirmed = insertCandidate({ reason: '已确认的理由', status: 'confirmed', inGraph: 0 })
    migration089.up(db)
    expect(rowOf(dismissed)).toEqual({ status: 'dismissed', reason: '人在回路验证方法相关', in_graph: 0 })
    expect(rowOf(pending)).toEqual({ status: 'pending', reason: '另一个候选理由', in_graph: 1 })
    expect(rowOf(confirmed)).toEqual({ status: 'confirmed', reason: '已确认的理由', in_graph: 0 })
  })

  it('幂等：第二遍零写入（表级快照一致）', () => {
    const a = insertCandidate({ reason: 'in_graph', inGraph: 0 })
    const b = insertCandidate({ reason: 'in_graph', inGraph: 1 })
    insertCardMessage(a, '可恢复的原文')
    migration089.up(db)
    const snap = JSON.stringify(db.prepare('SELECT * FROM graph_candidates ORDER BY id').all())
    migration089.up(db)
    expect(JSON.stringify(db.prepare('SELECT * FROM graph_candidates ORDER BY id').all())).toBe(snap)
    expect(rowOf(a).reason).toBe('可恢复的原文')
    expect(rowOf(b).reason).toBeNull()
  })

  it('087→089 链路：087 覆盖的行经 089 恢复（卡片消息存在 → 原文；不存在 → NULL）', () => {
    const withCard = insertCandidate({ reason: '原理由甲', status: 'pending', inGraph: 1 })
    const withoutCard = insertCandidate({ reason: '原理由乙', status: 'pending', inGraph: 1 })
    // 087 前卡片消息里还是原理由（089 从消息恢复，不靠候选行）
    insertCardMessage(withCard, '原理由甲')
    migration087.up(db)
    expect(rowOf(withCard).reason).toBe('in_graph')
    expect(rowOf(withoutCard).reason).toBe('in_graph')
    migration089.up(db)
    expect(rowOf(withCard).reason).toBe('原理由甲')
    expect(rowOf(withCard).in_graph).toBe(1)
    expect(rowOf(withoutCard).reason).toBeNull()
    expect(rowOf(withoutCard).in_graph).toBe(1)
  })

  it('全量迁移 88→90 在启动路径上应用', () => {
    insertCandidate({ reason: 'in_graph', inGraph: 1 })
    const applied = runMigrations(db, MIGRATIONS)
    expect(applied).toEqual([89, 90])
    expect(db.pragma('user_version', { simple: true })).toBe(90)
  })
})
