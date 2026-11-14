import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { fetchOpenAlexReferences } from './references'
import { makeFakeOpenAlex } from './testing'
import type { OpenAlexWork } from './client'

/**
 * OpenAlex 引用落库测试（D40/D49/D71）：内存库 + 假客户端，无网络。
 */

let db: Database.Database

function addPaper(p: {
  title: string
  doi?: string | null
  wid?: string | null
  firstAuthor?: string | null
  year?: number | null
}): number {
  const now = new Date().toISOString()
  const r = db
    .prepare(
      `INSERT INTO papers (title, first_author, year, doi, openalex_wid, source, has_pdf, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'zotero', 1, ?, ?)`
    )
    .run(p.title, p.firstAuthor ?? null, p.year ?? null, p.doi ?? null, p.wid ?? null, now, now)
  return Number(r.lastInsertRowid)
}

function work(p: Partial<OpenAlexWork>): OpenAlexWork {
  return {
    wid: 'W100',
    doi: '10.1000/self',
    title: 'Self Work',
    publicationYear: 2021,
    firstAuthorSurname: null,
    referencedWorks: [],
    ...p
  }
}

function refsRows(paperId: number): Array<{ openalex_wid: string | null; doi: string | null; matched_paper_id: number | null; source: string }> {
  return db.prepare('SELECT openalex_wid, doi, matched_paper_id, source FROM paper_references WHERE paper_id = ? ORDER BY id').all(paperId) as Array<{
    openalex_wid: string | null
    doi: string | null
    matched_paper_id: number | null
    source: string
  }>
}

beforeEach(() => {
  db = new Database(':memory:')
  runMigrations(db, MIGRATIONS)
})

afterEach(() => {
  db.close()
})

describe('fetchOpenAlexReferences', () => {
  it('已有 W-ID：取 referenced_works，按 W-ID 匹配库内论文', async () => {
    const lib1 = addPaper({ title: 'Lib One', wid: 'W201' })
    const lib2 = addPaper({ title: 'Lib Two', wid: 'W202' })
    const me = addPaper({ title: 'Me', wid: 'W100' })
    const client = makeFakeOpenAlex({
      async fetchWorkByWid(wid) {
        return wid === 'W100' ? work({ referencedWorks: ['W201', 'W202', 'W999'] }) : null
      },
      async fetchWorksByWids(wids) {
        return wids.map((w) => work({ wid: w, doi: `10.9/${w}`, title: `T ${w}` }))
      }
    })
    const r = await fetchOpenAlexReferences(db, client, me)
    expect(r.workFound).toBe(true)
    expect(r.refCount).toBe(3)
    expect(r.matchedCount).toBe(2)
    const rows = refsRows(me)
    expect(rows).toHaveLength(3)
    expect(rows[0].matched_paper_id).toBe(lib1)
    expect(rows[1].matched_paper_id).toBe(lib2)
    expect(rows[2].matched_paper_id).toBeNull() // W999 不在库
    expect(rows.every((x) => x.source === 'openalex')).toBe(true)
  })

  it('无 DOI：按标题三条阈值找回，记录 doi_match_method=openalex_title', async () => {
    const me = addPaper({ title: 'On the Opportunities and Risks of Foundation Models', firstAuthor: 'Bommasani', year: 2021 })
    const client = makeFakeOpenAlex({
      async searchWorksByTitle() {
        return [work({ wid: 'W300', doi: '10.1145/foundation', title: 'On the Opportunities and Risks of Foundation Models', publicationYear: 2021, firstAuthorSurname: 'bommasani' })]
      }
    })
    const r = await fetchOpenAlexReferences(db, client, me)
    expect(r.workFound).toBe(true)
    expect(r.recoveredDoi).toBe('10.1145/foundation')
    const p = db.prepare('SELECT doi, doi_match_method, openalex_wid FROM papers WHERE id = ?').get(me) as {
      doi: string
      doi_match_method: string
      openalex_wid: string
    }
    expect(p.doi).toBe('10.1145/foundation')
    expect(p.doi_match_method).toBe('openalex_title')
    expect(p.openalex_wid).toBe('W300')
  })

  it('标题找回不达阈值 → workFound=false，不写行（留空，D49）', async () => {
    const me = addPaper({ title: 'Some Brand New Preprint', firstAuthor: 'Wang', year: 2026 })
    const client = makeFakeOpenAlex({
      async searchWorksByTitle() {
        return [work({ wid: 'W301', doi: '10.1/other', title: 'Completely Different', publicationYear: 2020, firstAuthorSurname: 'li' })]
      }
    })
    const r = await fetchOpenAlexReferences(db, client, me)
    expect(r.workFound).toBe(false)
    expect(r.recoveredDoi).toBeNull()
    expect(refsRows(me)).toHaveLength(0)
    const p = db.prepare('SELECT doi, doi_match_method FROM papers WHERE id = ?').get(me) as { doi: string | null; doi_match_method: string | null }
    expect(p.doi).toBeNull()
    expect(p.doi_match_method).toBeNull()
  })

  it('按 DOI 查 + 参考文献按 DOI/标题匹配', async () => {
    const byDoi = addPaper({ title: 'DOI Match', doi: '10.5/target' })
    const byTitle = addPaper({ title: 'Joint Product Quantisation for Recommender Systems', firstAuthor: 'Spillo', year: 2025 })
    const me = addPaper({ title: 'Me With DOI', doi: '10.1000/self' })
    const client = makeFakeOpenAlex({
      async fetchWorkByDoi(doi) {
        return doi === '10.1000/self'
          ? work({ referencedWorks: ['W401', 'W402'] })
          : null
      },
      async fetchWorksByWids(wids) {
        return wids.map((w) =>
          w === 'W401'
            ? work({ wid: w, doi: '10.5/target', title: 'Whatever' })
            : work({ wid: w, doi: null, title: 'Joint Product Quantisation for Recommender Systems', publicationYear: 2025, firstAuthorSurname: 'spillo' })
        )
      }
    })
    const r = await fetchOpenAlexReferences(db, client, me)
    expect(r.matchedCount).toBe(2)
    const rows = refsRows(me)
    expect(rows.find((x) => x.openalex_wid === 'W401')?.matched_paper_id).toBe(byDoi)
    expect(rows.find((x) => x.openalex_wid === 'W402')?.matched_paper_id).toBe(byTitle)
  })

  it('幂等重取：openalex 行被替换而不是累积', async () => {
    const me = addPaper({ title: 'Me', wid: 'W100' })
    const mk = () =>
      makeFakeOpenAlex({
        async fetchWorkByWid() {
          return work({ referencedWorks: ['W201'] })
        },
        async fetchWorksByWids(wids) {
          return wids.map((w) => work({ wid: w }))
        }
      })
    await fetchOpenAlexReferences(db, mk(), me)
    await fetchOpenAlexReferences(db, mk(), me)
    expect(refsRows(me)).toHaveLength(1)
  })

  it('软删除的库内论文不参与匹配；referenced_works 为空时如实上报（走 D40 兜底由上层决定）', async () => {
    const dead = addPaper({ title: 'Deleted', wid: 'W201' })
    db.prepare('UPDATE papers SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), dead)
    const me = addPaper({ title: 'Me', wid: 'W100' })
    const client = makeFakeOpenAlex({
      async fetchWorkByWid() {
        return work({ referencedWorks: ['W201'] })
      },
      async fetchWorksByWids(wids) {
        return wids.map((w) => work({ wid: w }))
      }
    })
    const r = await fetchOpenAlexReferences(db, client, me)
    expect(r.refCount).toBe(1)
    expect(r.matchedCount).toBe(0)

    const empty = makeFakeOpenAlex({
      async fetchWorkByWid() {
        return work({ referencedWorks: [] })
      }
    })
    const r2 = await fetchOpenAlexReferences(db, empty, me)
    expect(r2.workFound).toBe(true)
    expect(r2.refCount).toBe(0)
  })
})
