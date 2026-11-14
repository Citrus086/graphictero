import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { DEEPSEEK_FLASH_MAX_OUTPUT } from '../llm/client'
import { startStubLlm, type StubLlm } from '../llm/stubServer'
import { extractReferencesSection, parseRefsJson, extractReferencesWithLlm } from './referencesExtract'

/**
 * D40 兜底测试：deepseek 从 References 段抽取（本地 stub LLM + fixture Markdown，
 * 不依赖真 MinerU——Markdown 直接写到 papers/<id>/mineru/full.md）。
 */

const MD_WITH_REFS = `# Paper

## Introduction
Body text.

## References

[1] R. Bommasani et al. "On the Opportunities and Risks of Foundation Models." 2021. doi:10.1145/foundation
[2] Y. LeCun, Y. Bengio, and G. Hinton. "Deep learning." Nature, 2015. doi:10.1038/nature14539
[3] Someone Else. "No Match Work At All." 1999.
`

let dir: string
let dataDir: string
let db: Database.Database
let stub: StubLlm

function addPaper(title: string, doi: string | null = null): number {
  const now = new Date().toISOString()
  const r = db
    .prepare("INSERT INTO papers (title, doi, source, has_pdf, created_at, updated_at) VALUES (?, ?, 'zotero', 1, ?, ?)")
    .run(title, doi, now, now)
  return Number(r.lastInsertRowid)
}

function writeMd(paperId: number, md: string): void {
  const d = join(dataDir, 'papers', String(paperId), 'mineru')
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'full.md'), md, 'utf8')
}

const LLM_REFS_JSON = JSON.stringify([
  { title: 'On the Opportunities and Risks of Foundation Models', year: 2021, doi: '10.1145/foundation' },
  { title: 'Deep Learning', year: 2015, doi: '10.1038/nature14539' },
  { title: 'No Match Work At All', year: 1999 }
])

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gt-refs-'))
  dataDir = join(dir, 'Graphictero')
  mkdirSync(dataDir, { recursive: true })
  db = new Database(join(dataDir, 'graphictero.db'))
  runMigrations(db, MIGRATIONS)
  stub = await startStubLlm([{ kind: 'ok', text: LLM_REFS_JSON }])
})

afterEach(async () => {
  await stub.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('extractReferencesSection / parseRefsJson', () => {
  it('截出 References 段（英文/中文标题、到下一个标题为止）', () => {
    const s = extractReferencesSection(MD_WITH_REFS)
    expect(s).toContain('Bommasani')
    expect(s).toContain('LeCun')
    expect(s).not.toContain('Introduction')
    expect(extractReferencesSection('# 论文\n\n## 参考文献\n\n[1] 张三. 标题. 2020.\n')).toContain('张三')
    expect(extractReferencesSection('# 没有参考文献段\n\n正文')).toBeNull()
  })

  it('parseRefsJson：完整数组解析；截断按括号深度捞完整对象并上报 truncated', () => {
    expect(parseRefsJson(LLM_REFS_JSON).refs).toHaveLength(3)
    expect(parseRefsJson(LLM_REFS_JSON).truncated).toBe(false)
    expect(parseRefsJson('前言 [{"title":"A","year":2020}] 后记').refs).toHaveLength(1)
    // 评审必须修 3：截断不再静默返回 []——捞出完整对象并标记 truncated
    const cut = parseRefsJson('[{"title":"A","year":2020,"doi":"x"},{"title":"B"')
    expect(cut.refs).toEqual([{ title: 'A', year: 2020, doi: 'x' }])
    expect(cut.truncated).toBe(true)
    expect(parseRefsJson('没有数组')).toEqual({ refs: [], truncated: true })
  })
})

describe('extractReferencesWithLlm（D40 兜底）', () => {
  it('抽取 References 段 → deepseek 抽取 → 匹配库内论文（标题阈值 + DOI 精确）', async () => {
    const libByTitle = addPaper('On the Opportunities and Risks of Foundation Models')
    const libByDoi = addPaper('In Library', '10.1038/nature14539')
    const me = addPaper('Me')
    writeMd(me, MD_WITH_REFS)
    const r = await extractReferencesWithLlm({
      db,
      dataDir,
      paperId: me,
      llm: () => ({ baseUrl: stub.baseUrl, apiKey: 'k', model: 'deepseek-flash' })
    })
    expect(r.sectionFound).toBe(true)
    expect(r.wroteCount).toBe(3)
    expect(r.matchedCount).toBe(2)
    expect(r.truncated).toBe(false)
    expect(stub.requests[0].body?.max_tokens).toBe(DEEPSEEK_FLASH_MAX_OUTPUT) // D100
    const rows = db
      .prepare("SELECT matched_paper_id, source, doi FROM paper_references WHERE paper_id = ? ORDER BY id")
      .all(me) as Array<{ matched_paper_id: number | null; source: string; doi: string | null }>
    expect(rows).toHaveLength(3)
    expect(rows.every((x) => x.source === 'deepseek')).toBe(true)
    expect(rows[0].matched_paper_id).toBe(libByTitle) // 标题三条阈值命中
    expect(rows[1].matched_paper_id).toBe(libByDoi) // DOI 精确命中
    expect(rows[2].matched_paper_id).toBeNull() // No Match 不在库
  })

  it('Markdown 缺失或没有 References 段：不调 LLM、不写行', async () => {
    const me = addPaper('Me')
    const llm = () => ({ baseUrl: stub.baseUrl, apiKey: 'k', model: 'deepseek-flash' })
    const r1 = await extractReferencesWithLlm({ db, dataDir, paperId: me, llm })
    expect(r1).toEqual({ sectionFound: false, wroteCount: 0, matchedCount: 0, truncated: false })
    writeMd(me, '# 只有正文\n\n没有参考文献。')
    const r2 = await extractReferencesWithLlm({ db, dataDir, paperId: me, llm })
    expect(r2.sectionFound).toBe(false)
    expect(stub.requests).toHaveLength(0) // 0 token 消耗
  })

  it('截断输出：捞回完整条目写入并上报 truncated（评审必须修 3）', async () => {
    const me = addPaper('Me')
    writeMd(me, MD_WITH_REFS)
    await stub.close()
    stub = await startStubLlm([
      { kind: 'ok', text: '[{"title":"Recovered Ref","year":2021},{"title":"Cut Off' } // mid-JSON 截断
    ])
    const r = await extractReferencesWithLlm({
      db,
      dataDir,
      paperId: me,
      llm: () => ({ baseUrl: stub.baseUrl, apiKey: 'k', model: 'deepseek-flash' })
    })
    expect(r.truncated).toBe(true)
    expect(r.wroteCount).toBe(1) // 捞回的那条落了库，不是静默 0 条
    const n = (db.prepare("SELECT COUNT(*) AS n FROM paper_references WHERE paper_id = ? AND source = 'deepseek'").get(me) as { n: number }).n
    expect(n).toBe(1)
  })

  it('幂等重跑：deepseek 行替换不累积', async () => {
    const me = addPaper('Me')
    writeMd(me, MD_WITH_REFS)
    const llm = () => ({ baseUrl: stub.baseUrl, apiKey: 'k', model: 'deepseek-flash' })
    await extractReferencesWithLlm({ db, dataDir, paperId: me, llm })
    const stub2 = await startStubLlm([{ kind: 'ok', text: LLM_REFS_JSON }])
    try {
      await extractReferencesWithLlm({ db, dataDir, paperId: me, llm: () => ({ baseUrl: stub2.baseUrl, apiKey: 'k', model: 'deepseek-flash' }) })
    } finally {
      await stub2.close()
    }
    const n = (db.prepare('SELECT COUNT(*) AS n FROM paper_references WHERE paper_id = ?').get(me) as { n: number }).n
    expect(n).toBe(3) // 仍是 3 行，不是 6 行
  })
})
