import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { searchPapers } from '../db/fts'
import { importZoteroItems, paperFolder } from './importer'
import { indexFullTextFts, searchFullText } from '../db/fulltextFts'
import { ZoteroLocalApi } from './localApi'
import { listCollections, openZoteroDatabaseCopy, readCollectionItems } from './sqliteReader'
import { importZoteroCollection } from '../appService'
import type { PaperParser } from '../jobs/mineru'
import type { ZoteroItem } from './types'

/**
 * M1 第二批：Zotero 导入（D26/D61/D62/D75/D82/D93）。
 * 全部合成 fixture：假 Local API 响应、假 zotero.sqlite、几 KB 假 PDF 字节。
 */

function makeItem(partial: Partial<ZoteroItem> & { key: string }): ZoteroItem {
  return { version: 1, itemType: 'journalArticle', attachments: [], ...partial }
}

const FAKE_PDF = Buffer.concat([
  Buffer.from('%PDF-1.4\n% synthetic test pdf for graphictero importer\n'),
  Buffer.alloc(2048, 7),
  Buffer.from('\n%%EOF\n')
])

let dir: string
let db: Database.Database
let dataDir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-import-'))
  dataDir = join(dir, 'data')
  mkdirSync(dataDir, { recursive: true })
  db = openDatabase(join(dataDir, 'graphictero.db'))
  runMigrations(db, MIGRATIONS)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const IMPORT = { libraryId: 1 }

describe('Zotero 导入：去重（D82/D75）', () => {
  it('同一 DOI 的两条 Zotero 条目只进库一次（D82 精确去重）', async () => {
    const a = makeItem({
      key: 'ITEM0001',
      title: 'Paper A',
      DOI: 'https://doi.org/10.1000/ABC',
      date: '2023'
    })
    const r1 = await importZoteroItems(db, dataDir, [a], IMPORT)
    expect(r1[0].action).toBe('created')
    // D71：导入原有 DOI 记录匹配方式 original（合并批次维护者补写）
    expect(
      (db.prepare('SELECT doi_match_method FROM papers WHERE id = ?').get(r1[0].paperId) as { doi_match_method: string }).doi_match_method
    ).toBe('original')

    // 同 DOI、不同 itemKey、带 PDF（模拟预印本/正式版两条）
    const pdfSrc = join(dir, 'zotero-storage', 'ITEM0002', 'paper.pdf')
    mkdirSync(join(dir, 'zotero-storage', 'ITEM0002'), { recursive: true })
    writeFileSync(pdfSrc, FAKE_PDF)
    const b = makeItem({
      key: 'ITEM0002',
      title: 'Paper A (published)',
      DOI: '10.1000/abc', // 大小写/前缀不同，归一化后相同
      attachments: [{ key: 'ATT1', title: 'paper.pdf', contentType: 'application/pdf', path: pdfSrc }]
    })
    const r2 = await importZoteroItems(db, dataDir, [b], IMPORT)
    expect(r2[0].paperId).toBe(r1[0].paperId)
    // 原 itemKey 不被覆盖；PDF 被复制进来
    const row = db.prepare('SELECT zotero_item_key, has_pdf, pdf_source FROM papers WHERE id = ?').get(r1[0].paperId) as
      { zotero_item_key: string; has_pdf: number; pdf_source: string }
    expect(row.zotero_item_key).toBe('ITEM0001')
    expect(row.has_pdf).toBe(1)
    expect(row.pdf_source).toBe('zotero')
    expect(existsSync(join(paperFolder(dataDir, r1[0].paperId), 'paper.pdf'))).toBe(true)
    // 原 Zotero 文件不被动过（复制不移动）
    expect(readFileSync(pdfSrc).equals(FAKE_PDF)).toBe(true)
    expect(db.prepare('SELECT COUNT(*) c FROM papers').get()).toEqual({ c: 1 })
  })

  it('arXiv ID 去重：URL 与 extra 里的 arXiv 编号（含版本号）归一化后视为同一条', async () => {
    const a = makeItem({
      key: 'ARX00001',
      itemType: 'preprint',
      title: 'Preprint X',
      url: 'http://arxiv.org/abs/2403.00001v2'
    })
    await importZoteroItems(db, dataDir, [a], IMPORT)
    const b = makeItem({
      key: 'ARX00002',
      itemType: 'preprint',
      title: 'Preprint X v3',
      DOI: '10.4000/arxivdup', // 空字段，重新导入时补上
      extra: 'arXiv: 2403.00001'
    })
    const r = await importZoteroItems(db, dataDir, [b], IMPORT)
    expect(r[0].action).toBe('updated')
    expect(db.prepare('SELECT COUNT(*) c FROM papers').get()).toEqual({ c: 1 })
    expect(db.prepare('SELECT arxiv_id, doi FROM papers').get()).toEqual({ arxiv_id: '2403.00001', doi: '10.4000/arxivdup' })
  })

  it('重新导入同一 (libraryID, itemKey)：内部 ID 不变、只补空字段、不覆盖 App 内编辑', async () => {
    const a = makeItem({ key: 'REIM0001', title: 'Original Title', date: '2021' })
    const r1 = await importZoteroItems(db, dataDir, [a], IMPORT)
    const id = r1[0].paperId

    // 用户在 App 内改了标题（编辑优先级高于重新导入，D75）
    db.prepare("UPDATE papers SET title = 'User Edited Title' WHERE id = ?").run(id)
    // 重新导入：Zotero 侧标题变了、补上了 DOI
    const b = makeItem({ key: 'REIM0001', title: 'Zotero Renamed', DOI: '10.2000/XYZ', date: '2021' })
    const r2 = await importZoteroItems(db, dataDir, [b], IMPORT)
    expect(r2[0].paperId).toBe(id)
    expect(r2[0].action).toBe('updated')
    const row = db.prepare('SELECT title, doi FROM papers WHERE id = ?').get(id) as { title: string; doi: string }
    expect(row.title).toBe('User Edited Title') // 不覆盖
    expect(row.doi).toBe('10.2000/xyz') // 空字段被补上（归一化小写）
  })

  it('软删除后重新导入：恢复同一内部 ID（D75）', async () => {
    const a = makeItem({ key: 'SOFT0001', title: 'To Be Deleted' })
    const r1 = await importZoteroItems(db, dataDir, [a], IMPORT)
    const id = r1[0].paperId
    db.prepare('UPDATE papers SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), id)

    const r2 = await importZoteroItems(db, dataDir, [a], IMPORT)
    expect(r2[0].action).toBe('restored')
    expect(r2[0].paperId).toBe(id)
    const row = db.prepare('SELECT deleted_at, zotero_item_key FROM papers WHERE id = ?').get(id) as
      { deleted_at: string | null; zotero_item_key: string }
    expect(row.deleted_at).toBeNull()
    expect(row.zotero_item_key).toBe('SOFT0001')
    expect(db.prepare('SELECT COUNT(*) c FROM papers').get()).toEqual({ c: 1 })
  })

  it('软删除恢复（重新导入）后立即补全文索引（review_uat3 建议修 4）', async () => {
    const a = makeItem({ key: 'SOFT0002', title: 'Restore With Fulltext' })
    const r1 = await importZoteroItems(db, dataDir, [a], IMPORT)
    const id = r1[0].paperId
    mkdirSync(join(dataDir, 'papers', String(id), 'mineru'), { recursive: true })
    writeFileSync(join(dataDir, 'papers', String(id), 'mineru', 'full.md'), '# 方法\n本文使用 CRISPR 技术。\n', 'utf8')
    indexFullTextFts(db, id, '# 方法\n本文使用 CRISPR 技术。\n')
    db.prepare('UPDATE papers SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), id)
    db.prepare('DELETE FROM papers_text_fts WHERE rowid = ?').run(id) // 软删清索引

    const r2 = await importZoteroItems(db, dataDir, [a], IMPORT)
    expect(r2[0].action).toBe('restored')
    // 恢复即刻可搜，不用等下次启动 backfill
    expect(searchFullText(db, 'CRISPR').map((h) => h.paper_id)).toEqual([id])
  })

  it('重复导入同一条什么都不改（skipped）', async () => {
    const a = makeItem({ key: 'SKIP0001', title: 'Same', DOI: '10.1/abc' })
    await importZoteroItems(db, dataDir, [a], IMPORT)
    const r = await importZoteroItems(db, dataDir, [a], IMPORT)
    expect(r[0].action).toBe('skipped')
  })

  it('软删行+活行同 DOI 并存：命中活行，不恢复软删行撞唯一索引（评审建议修 3）', async () => {
    const a = makeItem({ key: 'DELDOI01', title: 'Old Deleted', DOI: '10.3000/dup' })
    const r1 = await importZoteroItems(db, dataDir, [a], IMPORT)
    const idDeleted = r1[0].paperId
    db.prepare('UPDATE papers SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), idDeleted)

    // 手工/Agent 建了同 DOI 的活行（唯一索引只约束活行，允许并存）
    const now = new Date().toISOString()
    const live = db
      .prepare("INSERT INTO papers (csl_json, title, doi, source, created_at, updated_at) VALUES ('{}', 'Live Row', '10.3000/dup', 'agent', ?, ?)")
      .run(now, now)
    const idLive = Number(live.lastInsertRowid)

    // 从 Zotero 新条目（不同 itemKey）重新导入该 DOI：应命中活行而不是软删行
    const b = makeItem({ key: 'NEWDOI01', title: 'Reimported Same DOI', DOI: '10.3000/DUP' })
    const r2 = await importZoteroItems(db, dataDir, [b], IMPORT)
    expect(r2[0].paperId).toBe(idLive)
    expect(r2[0].action).not.toBe('restored')
    // 软删行仍是软删（未被恢复去撞唯一索引）
    const row = db.prepare('SELECT deleted_at FROM papers WHERE id = ?').get(idDeleted) as { deleted_at: string | null }
    expect(row.deleted_at).not.toBeNull()
  })
})

describe('Zotero 导入：PDF 与元数据（D62/D61/D93）', () => {
  it('无附件条目以「无 PDF」入库（D62）', async () => {
    const a = makeItem({ key: 'NOPDF001', title: 'Metadata Only' })
    const r = await importZoteroItems(db, dataDir, [a], IMPORT)
    expect(r[0].hasPdf).toBe(false)
    expect(r[0].pdfUnresolved).toBe(false) // 本就无附件，不算「取路径失败」
    const row = db.prepare('SELECT has_pdf, pdf_source FROM papers WHERE id = ?').get(r[0].paperId) as
      { has_pdf: number; pdf_source: string | null }
    expect(row).toEqual({ has_pdf: 0, pdf_source: null })
    expect(existsSync(paperFolder(dataDir, r[0].paperId))).toBe(false)
  })

  it('有 PDF 附件但取路径失败：pdfUnresolved 标记，不静默当「无 PDF」（评审建议修 2）', async () => {
    const a = makeItem({
      key: 'UNRES001',
      title: 'Has Unresolved PDF',
      attachments: [{ key: 'ATT9', title: 'full.pdf', contentType: 'application/pdf' }] // 无 path，需 resolveAttachmentPath
    })
    const r = await importZoteroItems(db, dataDir, [a], { libraryId: 0, resolveAttachmentPath: async () => null })
    expect(r[0].hasPdf).toBe(false)
    expect(r[0].pdfUnresolved).toBe(true)
    const row = db.prepare('SELECT has_pdf FROM papers WHERE id = ?').get(r[0].paperId) as { has_pdf: number }
    expect(row.has_pdf).toBe(0)
  })

  it('第一作者优先 creatorType=author（editor 排第一也不当第一作者，评审建议修 6）', async () => {
    const a = makeItem({
      key: 'FA000001',
      title: 'Editor First',
      creators: [
        { creatorType: 'editor', lastName: 'Boss', firstName: 'Big' },
        { creatorType: 'author', lastName: 'Real', firstName: 'Author' }
      ]
    })
    const r = await importZoteroItems(db, dataDir, [a], IMPORT)
    expect(db.prepare('SELECT first_author FROM papers WHERE id = ?').get(r[0].paperId)).toEqual({
      first_author: 'Real'
    })
  })

  it('作者写入 paper_authors 并按 D93 规范化（名姓顺序、去重音、去标点）', async () => {
    const a = makeItem({
      key: 'AUTH0001',
      title: 'Authors',
      creators: [
        { creatorType: 'author', lastName: 'Smith', firstName: 'John' },
        { creatorType: 'author', lastName: 'García-Márquez', firstName: 'José' },
        { creatorType: 'editor', lastName: 'Boss', firstName: 'Big' }
      ]
    })
    const r = await importZoteroItems(db, dataDir, [a], IMPORT)
    const authors = db
      .prepare('SELECT position, family, given, normalized FROM paper_authors WHERE paper_id = ? ORDER BY position')
      .all(r[0].paperId) as Array<{ position: number; family: string; given: string; normalized: string }>
    expect(authors.map((x) => x.normalized)).toEqual(['john smith', 'jose garcia marquez'])
    expect(db.prepare('SELECT first_author FROM papers WHERE id = ?').get(r[0].paperId)).toEqual({
      first_author: 'Smith'
    })
  })

  it('入库的标题/摘要进 FTS5（D74）', async () => {
    const a = makeItem({ key: 'FTS00001', title: 'Retrieval Augmented Generation Survey', abstractNote: 'A survey of RAG methods.' })
    await importZoteroItems(db, dataDir, [a], IMPORT)
    expect(searchPapers(db, 'Retrieval Augmented')).not.toHaveLength(0)
  })
})

// ─── Local API 客户端：假 fetch，不碰真实 Zotero ───────────────────────────
describe('Zotero Local API 客户端（假响应）', () => {
  function fakeFetch(routes: Record<string, unknown>): typeof fetch {
    return (async (url: string | URL) => {
      const u = String(url)
      for (const [prefix, body] of Object.entries(routes)) {
        if (u.startsWith(prefix)) {
          return new Response(JSON.stringify(body), { status: 200 })
        }
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch
  }

  it('available：200 可用，连不上为 false', async () => {
    const ok = new ZoteroLocalApi('http://localhost:23119/api', fakeFetch({ 'http://localhost:23119/api/users/0/items': [] }))
    expect(await ok.available()).toBe(true)
    const down = new ZoteroLocalApi('http://localhost:23119/api', (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch)
    expect(await down.available()).toBe(false)
  })

  it('collections 与 collectionItems（含 children 附件）', async () => {
    const routes = {
      'http://localhost:23119/api/users/0/collections?': [
        { key: 'C1', data: { name: 'NLP', parentCollection: false } },
        { key: 'C2', data: { name: 'RAG', parentCollection: 'C1' } }
      ],
      'http://localhost:23119/api/users/0/collections/C1/items/top?': [
        // 真实 Local API 实测：`-attachment || note` 查询不生效时附件会漏进 top 列表，
        // collectionItems 必须客户端过滤（回归：K-ATT / K-NOTE 不得成为论文条目）
        { key: 'K-ATT', version: 1, data: { itemType: 'attachment', title: 'Preprint PDF' } },
        { key: 'K-NOTE', version: 1, data: { itemType: 'note', note: 'x' } },
        {
          key: 'K1',
          version: 9,
          data: {
            itemType: 'journalArticle',
            title: 'Fake Paper',
            DOI: '10.9999/fake',
            creators: [{ creatorType: 'author', firstName: 'A', lastName: 'One' }]
          }
        }
      ],
      'http://localhost:23119/api/users/0/items/K1/children?': [
        { key: 'ATT9', data: { itemType: 'attachment', title: 'full.pdf', contentType: 'application/pdf' } }
      ],
      'http://localhost:23119/api/users/0/items/ATT9/file/view/url?': { url: 'file:///Users/fake/Zotero/storage/ATT9/full.pdf' }
    }
    const api = new ZoteroLocalApi('http://localhost:23119/api', fakeFetch(routes))
    const cols = await api.collections()
    expect(cols).toEqual([
      { key: 'C1', name: 'NLP', parentKey: null },
      { key: 'C2', name: 'RAG', parentKey: 'C1' }
    ])
    const items = await api.collectionItems('C1')
    expect(items).toHaveLength(1)
    expect(items.map((i) => i.key)).toEqual(['K1'])
    expect(items[0].title).toBe('Fake Paper')
    expect(items[0].creators).toEqual([{ creatorType: 'author', firstName: 'A', lastName: 'One', name: undefined }])
    expect(items[0].attachments).toEqual([
      { key: 'ATT9', title: 'full.pdf', contentType: 'application/pdf', path: undefined }
    ])
    // 附件路径走 file/view/url
    expect(await api.attachmentFilePath('ATT9')).toBe('/Users/fake/Zotero/storage/ATT9/full.pdf')
  })

  it('导入可走 Local API：resolveAttachmentPath 拼 PDF 路径', async () => {
    const pdfSrc = join(dir, 'fake-zotero', 'full.pdf')
    mkdirSync(join(dir, 'fake-zotero'), { recursive: true })
    writeFileSync(pdfSrc, FAKE_PDF)
    const item = makeItem({
      key: 'LKP00001',
      title: 'Via Local API',
      attachments: [{ key: 'ATT9', title: 'full.pdf', contentType: 'application/pdf' }]
    })
    const r = await importZoteroItems(db, dataDir, [item], {
      libraryId: 0, // Local API 用户库
      resolveAttachmentPath: async () => pdfSrc
    })
    expect(r[0].hasPdf).toBe(true)
    expect(existsSync(join(paperFolder(dataDir, r[0].paperId), 'paper.pdf'))).toBe(true)
  })
})

// ─── zotero.sqlite 副本读取器：假库 ─────────────────────────────────────────
describe('zotero.sqlite 临时副本读取器（假库，D26）', () => {
  function buildFakeZoteroDb(path: string): void {
    const z = new Database(path)
    z.exec(`
      CREATE TABLE itemTypes (itemTypeID INTEGER PRIMARY KEY, typeName TEXT);
      CREATE TABLE fields (fieldID INTEGER PRIMARY KEY, fieldName TEXT);
      CREATE TABLE itemDataValues (valueID INTEGER PRIMARY KEY, value TEXT);
      CREATE TABLE itemData (itemID INTEGER, fieldID INTEGER, valueID INTEGER);
      CREATE TABLE items (itemID INTEGER PRIMARY KEY, itemTypeID INTEGER, key TEXT, libraryID INTEGER);
      CREATE TABLE creators (creatorID INTEGER PRIMARY KEY, firstName TEXT, lastName TEXT, fieldMode INTEGER);
      CREATE TABLE creatorTypes (creatorTypeID INTEGER PRIMARY KEY, creatorType TEXT);
      CREATE TABLE itemCreators (itemID INTEGER, creatorID INTEGER, creatorTypeID INTEGER, orderIndex INTEGER);
      CREATE TABLE collections (collectionID INTEGER PRIMARY KEY, collectionName TEXT, parentCollectionID INTEGER, key TEXT, libraryID INTEGER);
      CREATE TABLE collectionItems (collectionID INTEGER, itemID INTEGER, orderIndex INTEGER);
      CREATE TABLE itemAttachments (itemID INTEGER PRIMARY KEY, parentItemID INTEGER, linkMode INTEGER, contentType TEXT, path TEXT);
      CREATE TABLE deletedItems (itemID INTEGER PRIMARY KEY);
      CREATE TABLE deletedCollections (collectionID INTEGER PRIMARY KEY);
      INSERT INTO itemTypes VALUES (1, 'journalArticle'), (2, 'attachment'), (3, 'note');
      INSERT INTO creatorTypes VALUES (1, 'author'), (2, 'editor');
      INSERT INTO fields VALUES (1, 'title'), (2, 'DOI'), (3, 'date'), (4, 'publicationTitle'), (5, 'abstractNote');
      INSERT INTO collections VALUES (1, '假分类', NULL, 'COLLFAKE', 1);
      INSERT INTO collections VALUES (2, '回收站分类', NULL, 'COLLTRASH', 1);
      INSERT INTO deletedCollections VALUES (2);
    `)
    const fieldId = (name: string) =>
      (z.prepare('SELECT fieldID FROM fields WHERE fieldName = ?').get(name) as { fieldID: number }).fieldID
    let valueId = 0
    const setField = (itemID: number, name: string, value: string): void => {
      valueId += 1
      z.prepare('INSERT INTO itemDataValues VALUES (?, ?)').run(valueId, value)
      z.prepare('INSERT INTO itemData VALUES (?, ?, ?)').run(itemID, fieldId(name), valueId)
    }
    // 一个期刊条目 + 一个无附件条目 + 一个 note（应被排除）
    z.prepare("INSERT INTO items VALUES (100, 1, 'SQL10001', 1)").run()
    setField(100, 'title', 'SQLite 导入的论文')
    setField(100, 'DOI', '10.5555/SQLITE')
    setField(100, 'date', '2022')
    setField(100, 'publicationTitle', 'Journal of Synthetic Tests')
    setField(100, 'abstractNote', 'Abstract from fake zotero.sqlite.')
    z.prepare("INSERT INTO items VALUES (101, 1, 'SQL10002', 1)").run()
    setField(101, 'title', '无附件条目')
    z.prepare("INSERT INTO items VALUES (102, 3, 'SQL10003', 1)").run()
    // 作者：双字段 + 单字段
    z.prepare("INSERT INTO creators VALUES (1, 'Zhang', 'Wei', 0)").run()
    z.prepare("INSERT INTO creators VALUES (2, NULL, 'ACME Lab', 1)").run()
    z.prepare('INSERT INTO itemCreators VALUES (100, 1, 1, 0)').run()
    z.prepare('INSERT INTO itemCreators VALUES (100, 2, 1, 1)').run()
    // 附件（storage: 相对路径）
    z.prepare("INSERT INTO items VALUES (200, 2, 'ATT20001', 1)").run()
    z.prepare(
      "INSERT INTO itemAttachments VALUES (200, 100, 0, 'application/pdf', 'storage:sql10001.pdf')"
    ).run()
    z.prepare('INSERT INTO collectionItems VALUES (1, 100, 0)').run()
    z.prepare('INSERT INTO collectionItems VALUES (1, 101, 1)').run()
    z.prepare('INSERT INTO collectionItems VALUES (1, 102, 2)').run()
    // 回收站条目：仍在 collectionItems 里（Zotero 恢复出厂位依赖这一点），必须被排除
    z.prepare("INSERT INTO items VALUES (103, 1, 'SQL10004', 1)").run()
    setField(103, 'title', '已被丢进回收站的论文')
    z.prepare('INSERT INTO collectionItems VALUES (1, 103, 3)').run()
    z.prepare('INSERT INTO deletedItems VALUES (103)').run()
    z.close()
  }

  it('只读副本：复制后读取，原库文件不被修改', () => {
    const zoteroDir = join(dir, 'fake-zotero-profile')
    mkdirSync(zoteroDir, { recursive: true })
    const zoteroDbPath = join(zoteroDir, 'zotero.sqlite')
    buildFakeZoteroDb(zoteroDbPath)
    const before = readFileSync(zoteroDbPath)

    const handle = openZoteroDatabaseCopy(zoteroDbPath)
    try {
      // 副本是 readonly：写直接报错
      expect(() => handle.db.prepare('CREATE TABLE nope (x)').run()).toThrow()
      const cols = listCollections(handle.db)
      expect(cols).toEqual([{ key: 'COLLFAKE', name: '假分类', libraryID: 1, parentKey: null }])

      const zoteroDataDir = join(zoteroDir, 'zotero-data')
      const items = readCollectionItems(handle.db, 'COLLFAKE', zoteroDataDir)
      // note 条目被排除
      expect(items.map((i) => i.key).sort()).toEqual(['SQL10001', 'SQL10002'])
      const paper = items[0]
      expect(paper.title).toBe('SQLite 导入的论文')
      expect(paper.DOI).toBe('10.5555/SQLITE')
      expect((paper as unknown as Record<string, unknown>).year ?? null).toBeNull() // sqlite 路径不提取 year，year 由 meta 提取
      expect(paper.date).toBe('2022')
      expect(paper.creators).toEqual([
        { creatorType: 'author', firstName: 'Zhang', lastName: 'Wei' },
        { creatorType: 'author', name: 'ACME Lab' }
      ])
      expect(paper.attachments[0].path).toBe(join(zoteroDataDir, 'storage', 'ATT20001', 'sql10001.pdf'))
    } finally {
      handle.close()
    }
    // 原库字节级不动
    expect(readFileSync(zoteroDbPath).equals(before)).toBe(true)
  })

  it('副本路径随 close 清理，不残留临时文件', () => {
    const zoteroDbPath = join(dir, 'zotero.sqlite')
    buildFakeZoteroDb(zoteroDbPath)
    const handle = openZoteroDatabaseCopy(zoteroDbPath)
    const copyPath = handle.db.name
    expect(existsSync(copyPath)).toBe(true)
    handle.close()
    expect(existsSync(copyPath)).toBe(false)
  })

  it('WAL 模式的活库：未 checkpoint 的数据随 -wal 一起复制可读（评审建议修 1）', () => {
    const zoteroDbPath = join(dir, 'zotero-wal.sqlite')
    const z = new Database(zoteroDbPath)
    z.exec(`
      CREATE TABLE collections (collectionID INTEGER PRIMARY KEY, collectionName TEXT, parentCollectionID INTEGER, key TEXT, libraryID INTEGER);
      CREATE TABLE deletedItems (itemID INTEGER PRIMARY KEY);
      CREATE TABLE deletedCollections (collectionID INTEGER PRIMARY KEY);
      PRAGMA journal_mode=WAL;
    `)
    // 写入后保持连接开着：-wal 不 checkpoint，数据只在 WAL 里（模拟 Zotero 运行中）
    z.prepare("INSERT INTO collections VALUES (1, 'WAL分类', NULL, 'COLLWAL', 1)").run()

    const handle = openZoteroDatabaseCopy(zoteroDbPath)
    try {
      const cols = listCollections(handle.db)
      expect(cols).toEqual([{ key: 'COLLWAL', name: 'WAL分类', libraryID: 1, parentKey: null }])
    } finally {
      handle.close()
    }
    z.close()
  })

  it('回收站条目与回收站分类被排除（deletedItems/deletedCollections）', () => {
    const zoteroDbPath = join(dir, 'zotero.sqlite')
    buildFakeZoteroDb(zoteroDbPath)
    const handle = openZoteroDatabaseCopy(zoteroDbPath)
    try {
      // 回收站分类不出现；个人库分类带 libraryID
      expect(listCollections(handle.db)).toEqual([
        { key: 'COLLFAKE', name: '假分类', libraryID: 1, parentKey: null }
      ])
      const items = readCollectionItems(handle.db, 'COLLFAKE')
      expect(items.map((i) => i.key).sort()).toEqual(['SQL10001', 'SQL10002']) // 回收站条目 SQL10004 被排除
    } finally {
      handle.close()
    }
  })

  it('旧版 Zotero（无 deletedItems/deletedCollections 表）兼容读取', () => {
    const zoteroDbPath = join(dir, 'zotero-old.sqlite')
    buildFakeZoteroDb(zoteroDbPath)
    const z = new Database(zoteroDbPath)
    z.exec('DROP TABLE deletedItems; DROP TABLE deletedCollections;')
    // 删掉回收站条目本身，保证旧库语义下结果与上面一致
    z.prepare("DELETE FROM items WHERE key = 'SQL10004'").run()
    z.close()
    const handle = openZoteroDatabaseCopy(zoteroDbPath)
    try {
      // 旧版无回收站概念：COLLTRASH 作为普通分类出现（行为正确）
      const cols = listCollections(handle.db)
      expect(cols).toHaveLength(2)
      expect(cols.map((c) => c.name)).toContain('假分类')
      const items = readCollectionItems(handle.db, 'COLLFAKE')
      expect(items.map((i) => i.key).sort()).toEqual(['SQL10001', 'SQL10002'])
    } finally {
      handle.close()
    }
  })

  it('端到端：sqlite 来源的条目导入 App 库（含 PDF 复制）', async () => {
    const zoteroDir = join(dir, 'fake-zotero-profile')
    mkdirSync(zoteroDir, { recursive: true })
    const zoteroDbPath = join(zoteroDir, 'zotero.sqlite')
    buildFakeZoteroDb(zoteroDbPath)
    const zoteroDataDir = join(zoteroDir, 'zotero-data')
    const attDir = join(zoteroDataDir, 'storage', 'ATT20001')
    mkdirSync(attDir, { recursive: true })
    writeFileSync(join(attDir, 'sql10001.pdf'), FAKE_PDF)

    const handle = openZoteroDatabaseCopy(zoteroDbPath)
    let items: ReturnType<typeof readCollectionItems>
    try {
      items = readCollectionItems(handle.db, 'COLLFAKE', zoteroDataDir)
    } finally {
      handle.close()
    }

    const r = await importZoteroItems(db, dataDir, items, { libraryId: 1 })
    expect(r).toHaveLength(2)
    expect(r[0].hasPdf).toBe(true)
    expect(r[1].hasPdf).toBe(false) // 无附件条目
    const row = db.prepare('SELECT doi, year, title FROM papers WHERE zotero_item_key = ?').get('SQL10001') as
      { doi: string; year: number; title: string }
    expect(row.doi).toBe('10.5555/sqlite')
    expect(row.year).toBe(2022)
    expect(row.title).toBe('SQLite 导入的论文')
  })
})


// ─── uat1b：Local API 纯文本 file URL + sqlite 副本兜底 + 重新导入补 PDF ──────
describe('uat1b：Local API 附件 file URL（纯文本与 JSON 都接受）', () => {
  /** 返回原始文本体的假 fetch（Content-Type 照真实端点给 text/plain） */
  function fakeFetchRaw(routes: Record<string, { body: string; status?: number; contentType?: string }>): typeof fetch {
    return (async (url: string | URL) => {
      const u = String(url)
      for (const [prefix, r] of Object.entries(routes)) {
        if (u.startsWith(prefix)) {
          return new Response(r.body, {
            status: r.status ?? 200,
            headers: { 'Content-Type': r.contentType ?? 'text/plain' }
          })
        }
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch
  }

  it('纯文本 file://（含 %20 与中文，Content-Type text/plain）解码成绝对路径', async () => {
    const api = new ZoteroLocalApi(
      'http://localhost:23119/api',
      fakeFetchRaw({
        'http://localhost:23119/api/users/0/items/ATT1/file/view/url?': {
          body: 'file:///Users/fake/Zotero/storage/ATT1/a%20b/%E8%AE%BA%E6%96%87.pdf\n',
          contentType: 'text/plain'
        }
      })
    )
    expect(await api.attachmentFilePath('ATT1')).toBe(join('/Users/fake/Zotero/storage/ATT1', 'a b', '论文.pdf'))
  })

  it('JSON {"url":"file://..."} 继续可用（兼容旧行为）', async () => {
    const api = new ZoteroLocalApi(
      'http://localhost:23119/api',
      fakeFetchRaw({
        'http://localhost:23119/api/users/0/items/ATT2/file/view/url?': {
          body: JSON.stringify({ url: 'file:///Users/fake/Zotero/storage/ATT2/full.pdf' }),
          contentType: 'application/json'
        }
      })
    )
    expect(await api.attachmentFilePath('ATT2')).toBe('/Users/fake/Zotero/storage/ATT2/full.pdf')
  })

  it('非 file URL（http 重定向）/ 空串 / 404 / fetch 抛错 → null', async () => {
    const http = new ZoteroLocalApi(
      'http://localhost:23119/api',
      fakeFetchRaw({
        'http://localhost:23119/api/users/0/items/ATT3/file/view/url?': { body: 'https://example.com/x.pdf' }
      })
    )
    expect(await http.attachmentFilePath('ATT3')).toBeNull()
    const empty = new ZoteroLocalApi(
      'http://localhost:23119/api',
      fakeFetchRaw({ 'http://localhost:23119/api/users/0/items/ATT4/file/view/url?': { body: '   ' } })
    )
    expect(await empty.attachmentFilePath('ATT4')).toBeNull()
    const missing = new ZoteroLocalApi('http://localhost:23119/api', fakeFetchRaw({}))
    expect(await missing.attachmentFilePath('ATT404')).toBeNull()
    const down = new ZoteroLocalApi(
      'http://localhost:23119/api',
      (async () => {
        throw new Error('ECONNREFUSED')
      }) as typeof fetch
    )
    expect(await down.attachmentFilePath('ATT5')).toBeNull()
  })
})

describe('uat1b：重新导入补 PDF（D75 缺 PDF 视为空字段）', () => {
  const itemWithAtt = (key: string) =>
    makeItem({
      key,
      title: '补 PDF 的论文',
      attachments: [{ key: `${key}-ATT`, title: 'full.pdf', contentType: 'application/pdf' }]
    })

  it('先无 PDF（附件没取到）再导入同一 itemKey：内部 ID 不变、补上 PDF、计为已更新、标记清除', async () => {
    // 第一次：附件路径取不到 → 无 PDF + pdf_unresolved 标记
    const r1 = await importZoteroItems(db, dataDir, [itemWithAtt('REFILL1')], {
      libraryId: 0,
      resolveAttachmentPath: async () => null
    })
    expect(r1[0].action).toBe('created')
    expect(r1[0].hasPdf).toBe(false)
    expect(r1[0].pdfUnresolved).toBe(true)
    const pending = db.prepare('SELECT pdf_unresolved FROM papers WHERE id = ?').get(r1[0].paperId) as { pdf_unresolved: number }
    expect(pending.pdf_unresolved).toBe(1)

    // 第二次：同一 itemKey，附件可解析 → 补 PDF
    const pdfSrc = join(dir, 'refill1.pdf')
    writeFileSync(pdfSrc, FAKE_PDF)
    const r2 = await importZoteroItems(db, dataDir, [itemWithAtt('REFILL1')], {
      libraryId: 0,
      resolveAttachmentPath: async () => pdfSrc
    })
    expect(r2[0].paperId).toBe(r1[0].paperId) // D75：内部 ID 不变
    expect(r2[0].action).toBe('updated') // 补齐计为已更新，不是 skipped
    expect(r2[0].hasPdf).toBe(true)
    expect(r2[0].pdfAdded).toBe(true)
    expect(r2[0].pdfUnresolved).toBe(false)
    expect(existsSync(join(paperFolder(dataDir, r2[0].paperId), 'paper.pdf'))).toBe(true)
    expect(
      (db.prepare('SELECT pdf_unresolved, pdf_source, pdf_hash FROM papers WHERE id = ?').get(r2[0].paperId) as {
        pdf_unresolved: number
        pdf_source: string
        pdf_hash: string
      }).pdf_unresolved
    ).toBe(0)
  })

  it('D147：Zotero 补 PDF 保留已有 pdf_source（COALESCE）；原来为空的按现有规则填 zotero', async () => {
    const pdfSrc = join(dir, 'd147.pdf')
    writeFileSync(pdfSrc, FAKE_PDF)
    // 场景一：库里已有 pdf_source（如开放获取下载过的残留记录）——补 PDF 不得覆盖来源
    const r1 = await importZoteroItems(db, dataDir, [itemWithAtt('D147A')], {
      libraryId: 0,
      resolveAttachmentPath: async () => null
    })
    db.prepare("UPDATE papers SET pdf_source = 'open_access' WHERE id = ?").run(r1[0].paperId)
    const r2 = await importZoteroItems(db, dataDir, [itemWithAtt('D147A')], {
      libraryId: 0,
      resolveAttachmentPath: async () => pdfSrc
    })
    expect(r2[0].pdfAdded).toBe(true)
    expect(db.prepare('SELECT has_pdf, pdf_source FROM papers WHERE id = ?').get(r2[0].paperId)).toEqual({
      has_pdf: 1,
      pdf_source: 'open_access' // D147：保留已有 pdf_source
    })
    // 场景二：原来为空 → 按现有规则填 zotero
    await importZoteroItems(db, dataDir, [itemWithAtt('D147B')], { libraryId: 0, resolveAttachmentPath: async () => null })
    const r4 = await importZoteroItems(db, dataDir, [itemWithAtt('D147B')], {
      libraryId: 0,
      resolveAttachmentPath: async () => pdfSrc
    })
    expect(db.prepare('SELECT has_pdf, pdf_source FROM papers WHERE id = ?').get(r4[0].paperId)).toEqual({
      has_pdf: 1,
      pdf_source: 'zotero'
    })
  })

  it('已有 PDF 的论文再导入：不覆盖文件、action 不变、pdfAdded=false', async () => {
    const pdfSrc = join(dir, 'keep1.pdf')
    writeFileSync(pdfSrc, FAKE_PDF)
    const r1 = await importZoteroItems(db, dataDir, [itemWithAtt('KEEPDF1')], {
      libraryId: 0,
      resolveAttachmentPath: async () => pdfSrc
    })
    expect(r1[0].hasPdf).toBe(true)
    const dest = join(paperFolder(dataDir, r1[0].paperId), 'paper.pdf')
    const before = readFileSync(dest)

    const other = join(dir, 'other1.pdf')
    writeFileSync(other, Buffer.concat([FAKE_PDF, Buffer.from('different')]))
    const r2 = await importZoteroItems(db, dataDir, [itemWithAtt('KEEPDF1')], {
      libraryId: 0,
      resolveAttachmentPath: async () => other
    })
    expect(r2[0].action).toBe('skipped')
    expect(r2[0].pdfAdded).toBe(false)
    expect(r2[0].hasPdf).toBe(true)
    expect(readFileSync(dest).equals(before)).toBe(true) // 不覆盖（哈希不变）
  })

  it('一批多篇只给其中几篇补 PDF：逐篇 pdfAdded / pdfUnresolved 计数正确（uat1-fix1 建议修 8）', async () => {
    const pdfSrc = join(dir, 'batch1.pdf')
    writeFileSync(pdfSrc, FAKE_PDF)
    const items = ['BATCH1', 'BATCH2', 'BATCH3'].map((k) => itemWithAtt(k))
    const r = await importZoteroItems(db, dataDir, items, {
      libraryId: 0,
      resolveAttachmentPath: async (att) => (att.key === 'BATCH1-ATT' ? pdfSrc : null)
    })
    expect(r.map((x) => x.action)).toEqual(['created', 'created', 'created'])
    expect(r.filter((x) => x.pdfAdded)).toHaveLength(1)
    expect(r.filter((x) => x.pdfUnresolved)).toHaveLength(2)
    expect(r.filter((x) => x.hasPdf)).toHaveLength(1)
    // 事实标记：补上的清 0，没拿到的置 1
    const flags = db
      .prepare('SELECT zotero_item_key, pdf_unresolved, has_pdf FROM papers ORDER BY zotero_item_key')
      .all() as Array<{ zotero_item_key: string; pdf_unresolved: number; has_pdf: number }>
    expect(flags).toEqual([
      { zotero_item_key: 'BATCH1', pdf_unresolved: 0, has_pdf: 1 },
      { zotero_item_key: 'BATCH2', pdf_unresolved: 1, has_pdf: 0 },
      { zotero_item_key: 'BATCH3', pdf_unresolved: 1, has_pdf: 0 }
    ])
  })

  it('目标 paper.pdf 已存在但 has_pdf=0：覆盖复制，不把旧文件记成这篇的 PDF（uat1-fix1 建议修 5）', async () => {
    const first = await importZoteroItems(db, dataDir, [itemWithAtt('STALE1')], {
      libraryId: 0,
      resolveAttachmentPath: async () => null
    })
    const pid = first[0].paperId
    // 造残留：论文文件夹里有一个来路不明的旧文件，库里 has_pdf=0
    mkdirSync(paperFolder(dataDir, pid), { recursive: true })
    writeFileSync(join(paperFolder(dataDir, pid), 'paper.pdf'), Buffer.from('%PDF-1.4 stale old file'))
    const goodSrc = join(dir, 'good1.pdf')
    writeFileSync(goodSrc, FAKE_PDF)
    const r2 = await importZoteroItems(db, dataDir, [itemWithAtt('STALE1')], {
      libraryId: 0,
      resolveAttachmentPath: async () => goodSrc
    })
    expect(r2[0].hasPdf).toBe(true)
    // 磁盘文件被本次来源覆盖（哈希 = 新文件），不是旧残留
    expect(createHash('sha256').update(readFileSync(join(paperFolder(dataDir, pid), 'paper.pdf'))).digest('hex')).toBe(
      createHash('sha256').update(FAKE_PDF).digest('hex')
    )
  })
})

describe('uat1b：导入编排（Local API 可用 + sqlite 副本兜底）', () => {
  const unavailableParser = (): PaperParser => ({
    available: () => false, // D95：不可用期间不入队
    parse: async () => {
      throw new Error('test parser')
    }
  })

  /** Local API 假响应：探测可用 + 分类内一篇带附件的条目；file/view/url 走 routes 自定义 */
  function localApiFetch(fileViewUrl: { body: string; status: number }): typeof fetch {
    return (async (url: string | URL) => {
      const u = String(url)
      if (u.includes('/file/view/url?')) {
        return new Response(fileViewUrl.body, { status: fileViewUrl.status })
      }
      if (u.includes('/users/0/items?limit=1')) return new Response('[]', { status: 200 })
      if (u.includes('/items/top?')) {
        return new Response(
          JSON.stringify([
            {
              key: 'LK1',
              version: 1,
              data: { itemType: 'journalArticle', title: 'Local API 论文', creators: [] }
            }
          ]),
          { status: 200 }
        )
      }
      if (u.includes('/items/LK1/children?')) {
        return new Response(
          JSON.stringify([
            { key: 'LK-ATT', version: 1, data: { itemType: 'attachment', title: 'full.pdf', contentType: 'application/pdf' } }
          ]),
          { status: 200 }
        )
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch
  }

  /** 兜底用假 zotero.sqlite：只含附件项（items + itemAttachments），path 为 storage: 相对路径 */
  function buildFallbackSqlite(sqlitePath: string): void {
    const z = new Database(sqlitePath)
    z.exec(`
      CREATE TABLE items (itemID INTEGER PRIMARY KEY, itemTypeID INTEGER, key TEXT, libraryID INTEGER);
      CREATE TABLE itemAttachments (itemID INTEGER PRIMARY KEY, parentItemID INTEGER, linkMode INTEGER, contentType TEXT, path TEXT);
      INSERT INTO items VALUES (300, 2, 'LK-ATT', 1);
      INSERT INTO itemAttachments VALUES (300, 299, 0, 'application/pdf', 'storage:lk1.pdf');
    `)
    z.close()
  }

  it('Local API 返回 404 时走 sqlite 只读副本兜底找到文件；不出现「允许本机通信」提示', async () => {
    const zoteroDir = join(dir, 'fb-zotero')
    mkdirSync(join(zoteroDir, 'storage', 'LK-ATT'), { recursive: true })
    const sqlitePath = join(zoteroDir, 'zotero.sqlite')
    buildFallbackSqlite(sqlitePath)
    writeFileSync(join(zoteroDir, 'storage', 'LK-ATT', 'lk1.pdf'), FAKE_PDF)

    const db2 = db // 复用迁移好的库
    const graph = db2.prepare("INSERT INTO graphs (name, created_at, updated_at) VALUES ('uat1b', 't', 't')").run()
    const graphId = Number(graph.lastInsertRowid)
    const summary = await importZoteroCollection(db2, dataDir, graphId, 'C1', () => {},
      { fetchImpl: localApiFetch({ body: 'not found', status: 404 }), sqlitePath },
      unavailableParser()
    )
    expect(summary.imported).toBe(1)
    expect(summary.pdfUnresolved).toBe(0)
    expect(summary.hint).toBeNull() // Local API 可用：不提示开「允许本机通信」
    const paper = db2.prepare("SELECT has_pdf, pdf_source, pdf_unresolved FROM papers WHERE zotero_item_key = 'LK1'").get() as {
      has_pdf: number
      pdf_source: string
      pdf_unresolved: number
    }
    expect(paper.has_pdf).toBe(1)
    expect(paper.pdf_source).toBe('zotero')
    expect(paper.pdf_unresolved).toBe(0)
  })

  it('uat1 建议 4：sqlite 兜底按附件 key 查限定个人库（libraryID=1）——群组库同 key 附件不混进来', async () => {
    const zoteroDir = join(dir, 'fb-zotero-libid')
    mkdirSync(join(zoteroDir, 'storage', 'ATT4'), { recursive: true })
    const sqlitePath = join(zoteroDir, 'zotero.sqlite')
    // 同一附件 key：群组库行先插入。没有 libraryID=1 限定时 .get() 会先拿到群组路径。
    const z = new Database(sqlitePath)
    z.exec(`
      CREATE TABLE items (itemID INTEGER PRIMARY KEY, itemTypeID INTEGER, key TEXT, libraryID INTEGER);
      CREATE TABLE itemAttachments (itemID INTEGER PRIMARY KEY, parentItemID INTEGER, linkMode INTEGER, contentType TEXT, path TEXT);
      INSERT INTO items VALUES (301, 2, 'ATT4', 2);
      INSERT INTO itemAttachments VALUES (301, 299, 0, 'application/pdf', 'storage:group.pdf');
      INSERT INTO items VALUES (300, 2, 'ATT4', 1);
      INSERT INTO itemAttachments VALUES (300, 299, 0, 'application/pdf', 'storage:personal.pdf');
    `)
    z.close()
    const personalPdf = Buffer.from('%PDF-1.4 personal-library')
    const groupPdf = Buffer.from('%PDF-1.4 group-library-must-not-win')
    // attachmentAbsolutePath 用 API 附件 key 拼 storage 目录，两份文件都放这里
    writeFileSync(join(zoteroDir, 'storage', 'ATT4', 'personal.pdf'), personalPdf)
    writeFileSync(join(zoteroDir, 'storage', 'ATT4', 'group.pdf'), groupPdf)

    const fetchImpl = (async (url: string | URL) => {
      const u = String(url)
      if (u.includes('/file/view/url?')) return new Response('not found', { status: 404 })
      if (u.includes('/users/0/items?limit=1')) return new Response('[]', { status: 200 })
      if (u.includes('/items/top?')) {
        return new Response(
          JSON.stringify([{ key: 'ITEM4', version: 1, data: { itemType: 'journalArticle', title: '库限定', creators: [] } }]),
          { status: 200 }
        )
      }
      if (u.includes('/items/ITEM4/children?')) {
        return new Response(
          JSON.stringify([{ key: 'ATT4', version: 1, data: { itemType: 'attachment', title: 'full.pdf', contentType: 'application/pdf' } }]),
          { status: 200 }
        )
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch

    const graph = db.prepare("INSERT INTO graphs (name, created_at, updated_at) VALUES ('uat1s4', 't', 't')").run()
    const graphId = Number(graph.lastInsertRowid)
    const summary = await importZoteroCollection(db, dataDir, graphId, 'C1', () => {},
      { fetchImpl, sqlitePath },
      unavailableParser()
    )
    expect(summary.imported).toBe(1)
    expect(summary.pdfUnresolved).toBe(0)
    const paper = db.prepare("SELECT id FROM papers WHERE zotero_item_key = 'ITEM4'").get() as { id: number }
    const copied = readFileSync(join(paperFolder(dataDir, paper.id), 'paper.pdf'))
    expect(copied.equals(personalPdf)).toBe(true)
    expect(copied.equals(groupPdf)).toBe(false)
  })

  it('Local API 与 sqlite 都找不到附件文件：pdfUnresolved 计数，提示如实但仍不叫开通信开关', async () => {
    // sqlitePath 指向不存在的文件 → 跳过兜底
    const graph = db.prepare("INSERT INTO graphs (name, created_at, updated_at) VALUES ('uat1b2', 't', 't')").run()
    const graphId = Number(graph.lastInsertRowid)
    const summary = await importZoteroCollection(db, dataDir, graphId, 'C1', () => {},
      { fetchImpl: localApiFetch({ body: 'not found', status: 404 }), sqlitePath: join(dir, 'no-such.sqlite') },
      unavailableParser()
    )
    expect(summary.imported).toBe(1)
    expect(summary.pdfUnresolved).toBe(1)
    expect(summary.hint).toBeNull()
    const paper = db.prepare("SELECT has_pdf, pdf_unresolved FROM papers WHERE zotero_item_key = 'LK1'").get() as {
      has_pdf: number
      pdf_unresolved: number
    }
    expect(paper.has_pdf).toBe(0)
    expect(paper.pdf_unresolved).toBe(1)
  })

  it('纯文本 file URL 端到端：Local API 直接给路径 → 复制入库、无兜底、无提示', async () => {
    const pdfSrc = join(dir, 'plain-text-url.pdf')
    writeFileSync(pdfSrc, FAKE_PDF)
    const fileUrl = `file://${pdfSrc.split('/').map(encodeURIComponent).join('/')}` // %20 等编码形态
    const graph = db.prepare("INSERT INTO graphs (name, created_at, updated_at) VALUES ('uat1b3', 't', 't')").run()
    const graphId = Number(graph.lastInsertRowid)
    const summary = await importZoteroCollection(db, dataDir, graphId, 'C1', () => {},
      { fetchImpl: localApiFetch({ body: fileUrl, status: 200 }), sqlitePath: join(dir, 'no-such.sqlite') },
      unavailableParser()
    )
    expect(summary.imported).toBe(1)
    expect(summary.pdfUnresolved).toBe(0)
    const paper = db.prepare("SELECT id, has_pdf FROM papers WHERE zotero_item_key = 'LK1'").get() as { id: number; has_pdf: number }
    expect(paper.has_pdf).toBe(1)
    expect(existsSync(join(paperFolder(dataDir, paper.id), 'paper.pdf'))).toBe(true)
  })
})
