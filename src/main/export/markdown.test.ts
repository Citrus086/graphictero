import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { buildMarkdown, formatReferenceAuthors, loadExportGraph, localDateString, markdownFileName, OVERVIEW_PLACEHOLDER, type ExportGraph } from './markdown'

/**
 * Markdown 导出（D31/D60）：整理顺序、关系过滤、参考文献、无 DOI 不带链接。
 */

let dir: string
let db: Database.Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-export-md-'))
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function seed(): number {
  const now = '2026-10-27T00:00:00.000Z'
  const graphId = Number(
    db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('研究线', now, now).lastInsertRowid
  )
  const insertPaper = db.prepare(
    `INSERT INTO papers (title, first_author, year, doi, one_liner, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'zotero', ?, ?)`
  )
  const lowY = Number(insertPaper.run('后写的论文', 'Fallback', 2024, null, '靠上', now, now).lastInsertRowid)
  const highY = Number(insertPaper.run('先写的论文', 'Fallback', 2020, '10.1/First', '靠下', now, now).lastInsertRowid)
  const side = Number(insertPaper.run('旁支论文', 'Side', 2021, null, null, now, now).lastInsertRowid)
  const gone = Number(insertPaper.run('已删论文', 'Gone', 2019, '10.1/gone', null, now, now).lastInsertRowid)
  db.prepare('UPDATE papers SET deleted_at = ? WHERE id = ?').run(now, gone)
  db.prepare(
    'INSERT INTO paper_authors (paper_id, position, family, given, normalized) VALUES (?, 0, ?, ?, ?)'
  ).run(highY, 'Lovelace', 'Ada', 'ada lovelace')
  db.prepare(
    `INSERT INTO paper_details (paper_id, parts, generated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(highY, JSON.stringify([{ type: 'text', text: '详情第一行\n详情第二行' }, { type: 'data-figure', figureNo: 1 }]), now, now, now)
  const member = db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, ?, ?, ?)')
  member.run(graphId, lowY, 5, 0, now)
  member.run(graphId, highY, 0, 10, now)
  member.run(graphId, side, 0, 20, now)
  member.run(graphId, gone, 0, 0, now)
  const rel = db.prepare(
    `INSERT INTO relations (graph_id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types, source_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'session', ?, ?)`
  )
  rel.run(graphId, Math.min(lowY, highY), Math.max(lowY, highY), highY, '对照了停止规则', '["compares"]', '["same_author"]', now, now)
  rel.run(graphId, Math.min(highY, side), Math.max(highY, side), highY, '改进了旁支', '["based_on"]', '[]', now, now)
  return graphId
}

describe('buildMarkdown', () => {
  it('按 y 再 x 排列，过滤关系，有 DOI 才带链接，详情进引用块', () => {
    const graphId = seed()
    const graph = loadExportGraph(db, graphId)
    expect(graph).not.toBeNull()
    const md = buildMarkdown(graph!, { overview: false, details: true, relationTypes: ['compares'], references: true }, {
      exportedAt: new Date('2026-10-27T08:00:00.000Z'),
      overviewText: null
    })
    const top = md.indexOf('## 后写的论文')
    const bottom = md.indexOf('## 先写的论文')
    expect(top).toBeGreaterThan(0)
    expect(bottom).toBeGreaterThan(top)
    expect(md).toContain('# 研究线')
    expect(md).toContain('导出于 2026-10-27 · 3 篇论文 · 1 条关系')
    expect(md).toContain('## 先写的论文（Ada Lovelace, 2020）')
    expect(md).toContain('## 后写的论文（Fallback, 2024）')
    expect(md).toContain('- 对比 · 同一作者 → 后写的论文：对照了停止规则')
    expect(md.indexOf('## 旁支论文')).toBeGreaterThan(bottom)
    expect(md).not.toContain('基于/改进')
    expect(md).not.toContain('改进了旁支')
    expect(md).not.toContain('已删论文')
    expect(md).toContain('> 详情第一行\n> 详情第二行')
    const refs = md.split('## 参考文献\n\n')[1] ?? ''
    expect(refs).toContain('- Ada Lovelace, 2020, 先写的论文 https://doi.org/10.1/First')
    const noDoi = refs.split('\n').find((line) => line.includes('后写的论文'))
    expect(noDoi).toBe('- Fallback, 2024, 后写的论文')
    expect(noDoi).not.toContain('http')
    expect(md).not.toContain('## 概览')
  })

  it('勾选概览时没有正文就放占位，传入正文则原样放上', () => {
    const graph = loadExportGraph(db, seed())!
    const empty = buildMarkdown(graph, { overview: true, details: false, relationTypes: [], references: false }, {
      exportedAt: new Date('2026-10-27T00:00:00.000Z'),
      overviewText: null
    })
    expect(empty).toContain(`## 概览\n\n${OVERVIEW_PLACEHOLDER}`)
    expect(empty).not.toContain('> 详情第一行')
    const filled = buildMarkdown(graph, { overview: true, details: false, relationTypes: ['cites'], references: false }, {
      exportedAt: new Date('2026-10-27T00:00:00.000Z'),
      overviewText: '这条线讨论停止。'
    })
    expect(filled).toContain('## 概览\n\n这条线讨论停止。')
    expect(filled).toContain('· 0 条关系')
    expect(filled).not.toContain('对照了停止规则')
  })

  it('uat4 建议修 1：空数组 = 0 条关系；文件名不带目录', () => {
    const now = '2026-10-27T00:00:00.000Z'
    const graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('a/b', now, now).lastInsertRowid)
    const paperId = Number(
      db.prepare("INSERT INTO papers (title, source, created_at, updated_at) VALUES ('无类型', 'zotero', ?, ?)").run(now, now).lastInsertRowid
    )
    const otherId = Number(
      db.prepare("INSERT INTO papers (title, source, created_at, updated_at) VALUES ('对方', 'zotero', ?, ?)").run(now, now).lastInsertRowid
    )
    db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)').run(graphId, paperId, now)
    db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 1, 0, ?)').run(graphId, otherId, now)
    const low = Math.min(paperId, otherId)
    const high = Math.max(paperId, otherId)
    db.prepare(
      `INSERT INTO relations (graph_id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types, source_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', '[]', '[]', 'session', ?, ?)`
    ).run(graphId, low, high, paperId, now, now)
    db.prepare(
      `INSERT INTO relations (graph_id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types, source_type, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, '已删边', '["cites"]', '[]', 'session', ?, ?, ?)`
    ).run(graphId, low, high, otherId, now, now, now)
    const md = buildMarkdown(loadExportGraph(db, graphId)!, { overview: false, details: false, relationTypes: [], references: true }, {
      exportedAt: new Date('2026-10-27T00:00:00.000Z'),
      overviewText: null
    })
    expect(md).toContain('· 0 条关系')
    expect(md).not.toContain('- 未定类型 → 对方')
    expect(md).not.toContain('已删边')
    expect(md).toContain('- 佚名, 无类型')
    expect(markdownFileName('a/b:c')).toBe('a b c.md')
    expect(markdownFileName('   ')).toBe('graph.md')
    expect(loadExportGraph(db, 99999)).toBeNull()
  })
})

describe('uat4 导出组（D150 / 建议修 3-6）', () => {
  it('D150：陈述里的 P0x 换成《短标题》，越界剔除，导出无 P0x 残留', () => {
    const now = '2026-10-27T00:00:00.000Z'
    const graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('短id', now, now).lastInsertRowid)
    const insert = db.prepare(
      `INSERT INTO papers (title, first_author, year, source, created_at, updated_at) VALUES (?, ?, ?, 'zotero', ?, ?)`
    )
    const ids: number[] = []
    ;['甲之研究', '乙之研究', '丙之研究', '丁之研究', '戊之研究', '己之研究'].forEach((title, i) => {
      ids.push(Number(insert.run(title, `作者${i + 1}`, 2020 + i, now, now).lastInsertRowid))
    })
    const member = db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, ?, ?)')
    ids.forEach((id, i) => member.run(graphId, id, i, now))
    db.prepare(
      `INSERT INTO relations (graph_id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types, source_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '["based_on"]', '[]', 'session', ?, ?)`
    ).run(graphId, ids[0], ids[5], ids[5], '改进了 P01 的停止规则并引用 P06；另见 P99', now, now)
    const md = buildMarkdown(loadExportGraph(db, graphId)!, { overview: false, details: false, relationTypes: ['based_on'], references: false }, {
      exportedAt: new Date('2026-10-27T00:00:00.000Z'),
      overviewText: null
    })
    expect(md).toContain('改进了《甲之研究》的停止规则并引用《己之研究》；另见') // uat6 S2 / uat6c S4：》后与《前紧跟中文都收紧
    expect(md).not.toMatch(/\bP\d{2}\b/)
  })

  it('建议修 5：入边也列出并标明方向，头部计数不翻倍', () => {
    const graph = loadExportGraph(db, seed())!
    const md = buildMarkdown(graph, { overview: false, details: false, relationTypes: ['compares'], references: false }, {
      exportedAt: new Date('2026-10-27T00:00:00.000Z'),
      overviewText: null
    })
    expect(md).toContain('导出于 2026-10-27 · 3 篇论文 · 1 条关系')
    // 出边（起点小节）与入边（终点小节，← 来自）都出现
    expect(md).toContain('- 对比 · 同一作者 → 后写的论文：对照了停止规则')
    expect(md).toContain('- 对比 · 同一作者 ← 来自 先写的论文：对照了停止规则')
  })

  it('建议修 3：参考文献作者 ≤3 位照列，>3 位前 3 位接 et al.', () => {
    expect(formatReferenceAuthors('Ada Lovelace')).toBe('Ada Lovelace')
    expect(formatReferenceAuthors('甲, 乙, 丙')).toBe('甲, 乙, 丙')
    expect(formatReferenceAuthors('甲, 乙, 丙, 丁')).toBe('甲, 乙, 丙, et al.')
    const many = Array.from({ length: 21 }, (_, i) => `作者${i + 1}`).join(', ')
    expect(formatReferenceAuthors(many)).toBe('作者1, 作者2, 作者3, et al.')
    expect(formatReferenceAuthors('')).toBe('佚名')
  })

  it('建议修 6：导出于用本地时区（偏移可注入，不依赖运行时切 TZ）', () => {
    const utc = new Date('2026-05-04T16:00:00.000Z')
    expect(localDateString(utc, 480)).toBe('2026-05-05') // Asia/Shanghai UTC+8
    expect(localDateString(utc, -240)).toBe('2026-05-04') // America/New_York 夏令时 UTC-4
    expect(localDateString(new Date('2026-01-01T00:30:00.000Z'), 480)).toBe('2026-01-01')
  })
})

describe('uat6 S3：标题行作者与参考文献同一 et al. 函数', () => {
  it('20 位作者 → 前 3 位 + et al.（标题行与参考文献同一口径）', () => {
    const graph: ExportGraph = {
      name: '作者图',
      papers: [
        {
          id: 1,
          title: 'BrowseComp-Plus: A More Fair and Transparent Evaluation',
          authors: Array.from({ length: 20 }, (_, i) => `作者${i + 1}`).join(', '),
          year: 2025,
          oneLiner: null,
          doi: null,
          x: 0,
          y: 0,
          detailText: null
        }
      ],
      edges: []
    }
    const md = buildMarkdown(graph, { overview: false, details: false, relationTypes: [], references: true }, { exportedAt: new Date('2026-10-27T08:00:00.000Z'), overviewText: null })
    expect(md).toContain('## BrowseComp-Plus: A More Fair and Transparent Evaluation（作者1, 作者2, 作者3, et al., 2025）')
    expect(md).not.toContain('作者4')
    expect(md).toContain('- 作者1, 作者2, 作者3, et al., 2025, BrowseComp-Plus')
  })

  it('≤3 位全列；无作者行不写作者段', () => {
    const graph: ExportGraph = {
      name: '少作者图',
      papers: [
        { id: 1, title: '三作者论文', authors: '甲, 乙, 丙', year: 2025, oneLiner: null, doi: null, x: 0, y: 0, detailText: null },
        { id: 2, title: '无作者论文', authors: '', year: 2024, oneLiner: null, doi: null, x: 0, y: 100, detailText: null }
      ],
      edges: []
    }
    const md = buildMarkdown(graph, { overview: false, details: false, relationTypes: [], references: false }, { exportedAt: new Date('2026-10-27T08:00:00.000Z'), overviewText: null })
    expect(md).toContain('## 三作者论文（甲, 乙, 丙, 2025）')
    expect(md).toContain('## 无作者论文（2024）')
  })
})

describe('uat6 D175(a)：导出标「AI 推断 · 无引用依据」（与画布/面板同判定）', () => {
  const graphWith = (noRefBasis: boolean, sourceJob: boolean): ExportGraph => ({
    name: '标记图',
    papers: [
      { id: 1, title: '甲文', authors: '甲', year: 2020, oneLiner: null, doi: null, x: 0, y: 0, detailText: null },
      { id: 2, title: '乙文', authors: '乙', year: 2021, oneLiner: null, doi: null, x: 0, y: 100, detailText: null }
    ],
    edges: [
      { srcId: 1, dstId: 2, srcTitle: '甲文', dstTitle: '乙文', types: ['based_on' as const], statement: '改进了停止规则', noRefBasis }
    ].map((e) => ({ ...e, noRefBasis: noRefBasis && sourceJob }))
  })

  it('noRefBasis 的 AI 自动边：出边与入边行都标（预览与保存同一 render()）', () => {
    const md = buildMarkdown(graphWith(true, true), { overview: false, details: false, relationTypes: ['based_on'], references: false }, { exportedAt: new Date('2026-10-27T08:00:00.000Z'), overviewText: null })
    expect(md).toContain('- 基于/改进 → 乙文：改进了停止规则（AI 推断 · 无引用依据）')
    expect(md).toContain('- 基于/改进 ← 来自 甲文：改进了停止规则（AI 推断 · 无引用依据）')
  })

  it('手工/session 边不标（loadExportGraph 已按 source_type 过滤）', () => {
    const md = buildMarkdown(graphWith(true, false), { overview: false, details: false, relationTypes: ['based_on'], references: false }, { exportedAt: new Date('2026-10-27T08:00:00.000Z'), overviewText: null })
    expect(md).toContain('- 基于/改进 → 乙文：改进了停止规则')
    expect(md).not.toContain('AI 推断')
  })
})
