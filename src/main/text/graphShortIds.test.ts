import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { buildGraphShortIdReplacer } from './graphShortIds'
import { replaceInternalRefTokens } from './internalRefs'

/**
 * D150：图谱级 P0x → 简称 替换。口径：图内论文按 id 升序 P01 起；命中映射换
 * 《短标题》（无标题退「作者, 年份」）；越界编号 / NEW / #N 直接剔除。
 */

let dir: string
let db: Database.Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-shortids-'))
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** 6 篇成员（id 升序 = P01…P06），另加 1 篇图外论文、1 篇已删成员。返回 [graphId, ids]。 */
function seed(): { graphId: number; ids: number[] } {
  const now = '2026-10-27T00:00:00.000Z'
  const graphId = Number(
    db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('短id图', now, now).lastInsertRowid
  )
  const insert = db.prepare(
    `INSERT INTO papers (title, first_author, year, source, created_at, updated_at) VALUES (?, ?, ?, 'zotero', ?, ?)`
  )
  const ids: number[] = []
  const titles = ['甲之研究', '乙之研究', '丙之研究', '丁之研究', '戊之研究', '己之研究']
  titles.forEach((title, i) => {
    ids.push(Number(insert.run(title, `作者${i + 1}`, 2020 + i, now, now).lastInsertRowid))
  })
  const outside = Number(insert.run('图外论文', '外人', 2024, now, now).lastInsertRowid)
  const gone = Number(insert.run('已删成员', '没了', 2024, now, now).lastInsertRowid)
  db.prepare('UPDATE papers SET deleted_at = ? WHERE id = ?').run(now, gone)
  const member = db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)')
  for (const id of [...ids, gone]) member.run(graphId, id, now)
  void outside
  return { graphId, ids }
}

describe('buildGraphShortIdReplacer（D150）', () => {
  it('P01/P06 命中映射换《短标题》，越界 P99 剔除，导出口径无 P0x 残留', () => {
    const { graphId, ids } = seed()
    const rel = db.prepare(
      `INSERT INTO relations (graph_id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types, source_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '["based_on"]', '[]', 'session', ?, ?)`
    )
    rel.run(graphId, ids[0], ids[5], ids[5], '改进了 P01 的停止规则并引用 P06；另见 P99', ...Array(2).fill('2026-10-27T00:00:00.000Z'))
    const replace = buildGraphShortIdReplacer(db, graphId)
    // 成员按 id 升序：P01=甲之研究，P06=己之研究
    const out = replace('改进了 P01 的停止规则并引用 P06；另见 P99。')
    expect(out).toContain('《甲之研究》')
    expect(out).toContain('《己之研究》')
    expect(out).not.toContain('P99')
    expect(out).not.toMatch(/\bP\d{2}\b/)
  })

  it('无标题成员退「作者, 年份」；NEW / #N 记号一律剔除', () => {
    const { graphId, ids } = seed()
    db.prepare('UPDATE papers SET title = ? WHERE id = ?').run('', ids[0])
    const replace = buildGraphShortIdReplacer(db, graphId)
    expect(replace('基于 P01 与 NEW 及 #3')).toBe('基于 作者1, 2020 与 及')
    expect(replace('P01')).toBe('作者1, 2020')
  })

  it('replaceInternalRefTokens 兜底：resolve 返回 null 时 token 被剔除', () => {
    const out = replaceInternalRefTokens('见 P01 与 P07', (token) => (token === 'P01' ? '《甲》' : null))
    expect(out).toBe('见《甲》与') // uat6 S2/S4：》后紧跟中文、中文与《之间的空格都收紧
  })
})
