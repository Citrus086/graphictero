import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from './db/connection'
import { MIGRATIONS, runMigrations } from './db/migrations'
import { HINT_403, backfillProcessJobs, countWaitingPapers, enqueueProcessJobs, importZoteroCollection, importZoteroItemsByKeys, listRelations, listZoteroCollectionItems, probeZoteroStatus, unprocessedWithPdfIds, zoteroDisplayStatus } from './appService'
import { getPapersProcessStatus } from './parser/paperStatus'
import type { PaperParser } from './jobs/mineru'

/** D95 测试用假解析器：可用 / 不可用两路 */
class StubParser implements PaperParser {
  constructor(private ok: boolean) {}
  available(): boolean {
    return this.ok
  }

  async parse(): Promise<never> {
    throw new Error('stub')
  }
}
const availableParser = new StubParser(true)
const unavailableParser = new StubParser(false)

/**
 * appService 单测（M1 第三批）：Zotero 来源探测（403 → sqlite 兜底 + 中文提示）
 * 与分类导入编排（进度上报、去重计数、加入图谱）。
 * 全部合成 fixture：假 fetch 响应 + 假 zotero.sqlite，不碰真实 Zotero。
 */

let dir: string
let db: Database.Database
let dataDir: string

const FAKE_PDF = '%PDF-1.4 fake\n'

function fakeFetch(routes: Record<string, { status: number; body: unknown }>) {
  return async (url: string): Promise<Response> => {
    const hit =
      Object.entries(routes).find(([prefix]) => url.startsWith(`http://localhost:23119/api${prefix}`))?.[1] ??
      ({ status: 404, body: {} } as const)
    return {
      ok: hit.status >= 200 && hit.status < 300,
      status: hit.status,
      json: async () => hit.body,
      // uat1b：attachmentFilePath 读 text()（纯文本/JSON 双格式）
      text: async () => (typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body))
    } as Response
  }
}

/** 与 zotero.test.ts 同款的最小假 zotero.sqlite（结构对齐真实库读取 SQL）。 */
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
    INSERT INTO creatorTypes VALUES (1, 'author');
    INSERT INTO fields VALUES (1, 'title'), (2, 'DOI'), (3, 'date');
    INSERT INTO collections VALUES (1, 'Benchmarks', NULL, 'COLL1', 1);
  `)
  const fieldId = (name: string) =>
    (z.prepare('SELECT fieldID FROM fields WHERE fieldName = ?').get(name) as { fieldID: number }).fieldID
  let valueId = 0
  const setField = (itemID: number, name: string, value: string): void => {
    valueId += 1
    z.prepare('INSERT INTO itemDataValues VALUES (?, ?)').run(valueId, value)
    z.prepare('INSERT INTO itemData VALUES (?, ?, ?)').run(itemID, fieldId(name), valueId)
  }
  z.prepare("INSERT INTO items VALUES (100, 1, 'TOP1', 1)").run()
  setField(100, 'title', 'Graph Paper One')
  setField(100, 'DOI', '10.5555/GP1')
  z.prepare("INSERT INTO items VALUES (101, 1, 'TOP2', 1)").run()
  setField(101, 'title', 'Graph Paper Two')
  z.prepare("INSERT INTO items VALUES (200, 2, 'ATT1', 1)").run()
  z.prepare("INSERT INTO itemAttachments VALUES (200, 100, 0, 'application/pdf', 'storage:top1.pdf')").run()
  z.prepare('INSERT INTO collectionItems VALUES (1, 100, 0)').run()
  z.prepare('INSERT INTO collectionItems VALUES (1, 101, 1)').run()
  z.close()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-appsvc-'))
  dataDir = join(dir, 'Graphictero')
  mkdirSync(dataDir, { recursive: true })
  db = openDatabase(join(dataDir, 'graphictero.db'))
  runMigrations(db, MIGRATIONS)
  const now = new Date().toISOString()
  db.prepare(
    "INSERT INTO graphs (name, created_at, updated_at) VALUES ('测试图谱', ?, ?)"
  ).run(now, now)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('probeZoteroStatus（D26：Local API 优先，403/未运行走 sqlite 副本）', () => {
  it('Local API 200 → local_api', async () => {
    const status = await probeZoteroStatus({ fetchImpl: fakeFetch({ '/users/0/items': { status: 200, body: [] } }) })
    expect(status.kind).toBe('local_api')
  })

  it('Local API 403 + 注入 sqlite 路径 → sqlite 兜底并给中文提示', async () => {
    const sqlitePath = join(dir, 'zotero.sqlite')
    buildFakeZoteroDb(sqlitePath)
    const status = await probeZoteroStatus({
      fetchImpl: fakeFetch({ '/users/0/items': { status: 403, body: {} } }),
      sqlitePath
    })
    expect(status.kind).toBe('sqlite')
    if (status.kind === 'sqlite') {
      expect(status.hint).toBe(HINT_403)
      expect(status.hint).toContain('403')
      expect(status.hint).toContain('允许本机其他应用与 Zotero 通信')
    }
  })

  it('Local API 连不上 + 无 sqlite → 抛中文错误', async () => {
    await expect(
      probeZoteroStatus({ fetchImpl: async () => ({ ok: false, status: 0, json: async () => ({}) }) as unknown as Promise<Response>, sqlitePath: join(dir, 'none.sqlite') })
    ).rejects.toThrow('没有找到在运行的 Zotero')
  })
})

describe('listZoteroCollectionItems（uat13 D207-③：分类内条目预览，只读）', () => {
  it('Local API：返回标题 + 作者/年份 + PDF 标记，附件/笔记条目被过滤', async () => {
    const item = (key: string, extra: Record<string, unknown>) => ({ key, version: 1, data: { itemType: 'journalArticle', title: `T-${key}`, creators: [{ creatorType: 'author', firstName: 'San', lastName: 'Zhang' }], date: '2024-05', ...extra } })
    const routes = {
      // 注意：fakeFetch 按前缀匹配且取首个命中，'/users/0/items' 是 children 的前缀，必须先放具体路由
      '/users/0/items/TOP1/children': {
        status: 200,
        body: [{ key: 'CH1', version: 1, data: { itemType: 'attachment', title: 'top1.pdf', contentType: 'application/pdf' } }]
      },
      '/users/0/items': { status: 200, body: [] },
      '/users/0/collections/C1/items/top': {
        status: 200,
        body: [
          item('TOP1', {}),
          item('NOTE1', { itemType: 'note', title: undefined }),
          item('ATT1', { itemType: 'attachment', title: 'top1.pdf' })
        ]
      }
    }
    const items = await listZoteroCollectionItems('C1', { fetchImpl: fakeFetch(routes) })
    expect(items.length).toBe(1) // note / attachment 被过滤
    expect(items[0]).toMatchObject({ key: 'TOP1', title: 'T-TOP1', firstAuthor: 'Zhang', year: 2024, hasPdf: true })
  })

  it('Local API 连不上且无 sqlite → 抛中文错误', async () => {
    await expect(
      listZoteroCollectionItems('C1', { fetchImpl: async () => ({ ok: false, status: 0, json: async () => ({}) }) as unknown as Promise<Response>, sqlitePath: join(dir, 'none.sqlite') })
    ).rejects.toThrow('没有找到在运行的 Zotero')
  })

  it('sqlite 副本兜底：返回分类内条目', async () => {
    const sqlitePath = join(dir, 'zotero.sqlite')
    buildFakeZoteroDb(sqlitePath)
    const items = await listZoteroCollectionItems('COLL1', {
      fetchImpl: async () => ({ ok: false, status: 0, json: async () => ({}) }) as unknown as Promise<Response>,
      sqlitePath
    })
    expect(items.length).toBe(2)
    expect(items.map((i) => i.title).sort()).toEqual(['Graph Paper One', 'Graph Paper Two'])
    const one = items.find((i) => i.title === 'Graph Paper One')!
    expect(one.hasPdf).toBe(true) // ATT1 附件挂在 TOP1 下
    expect(items.find((i) => i.title === 'Graph Paper Two')!.hasPdf).toBe(false)
  })
})

describe('zoteroDisplayStatus（导入来源只展示，探测失败不抛）', () => {
  it('Local API 不可用且 sqlite 在 → 不可用，目录是 sqlite 所在目录', async () => {
    const sqlitePath = join(dir, 'Zotero', 'zotero.sqlite')
    mkdirSync(join(dir, 'Zotero'), { recursive: true })
    buildFakeZoteroDb(sqlitePath)
    const view = await zoteroDisplayStatus({
      fetchImpl: async () => {
        throw new Error('down')
      },
      sqlitePath
    })
    expect(view).toEqual({
      apiUp: false,
      endpoint: 'localhost:23119',
      sqliteFallback: true,
      dataDir: dirname(sqlitePath)
    })
  })

  it('Local API 可用 → apiUp，没有 sqlite 时不造目录', async () => {
    const view = await zoteroDisplayStatus({
      fetchImpl: fakeFetch({ '/users/0/items': { status: 200, body: [] } }),
      home: dir
    })
    expect(view.apiUp).toBe(true)
    expect(view.endpoint).toBe('localhost:23119')
    expect(view.sqliteFallback).toBe(true)
    expect(view.dataDir).toBeNull()
  })

  it('两边都没有 → 不可用且 dataDir 为空，不抛错', async () => {
    const view = await zoteroDisplayStatus({
      fetchImpl: async () => {
        throw new Error('down')
      },
      home: dir
    })
    expect(view.apiUp).toBe(false)
    expect(view.dataDir).toBeNull()
    expect(view.sqliteFallback).toBe(true)
  })
})

describe('importZoteroCollection（分类导入编排：进度 + 去重 + 加入图谱）', () => {
  it('Local API 来源：导入分类、逐篇进度、全部加入图谱', async () => {
    const pdfSrc = join(dir, 'storage', 'ATT9')
    mkdirSync(pdfSrc, { recursive: true })
    writeFileSync(join(pdfSrc, 'full.pdf'), FAKE_PDF)
    const fetchImpl = fakeFetch({
      '/users/0/items?limit=1': { status: 200, body: [] },
      '/users/0/collections?format=json': {
        status: 200,
        body: [{ key: 'COLL1', data: { name: 'Benchmarks', parentCollection: false } }]
      },
      '/users/0/collections/COLL1/items/top': {
        status: 200,
        body: [
          {
            key: 'TOP1',
            version: 1,
            data: { itemType: 'journalArticle', title: 'API Paper One', DOI: '10.5555/API1', creators: [] }
          },
          {
            key: 'TOP2',
            version: 1,
            data: { itemType: 'journalArticle', title: 'API Paper Two', creators: [] }
          }
        ]
      },
      '/users/0/items/TOP1/children': {
        status: 200,
        body: [
          { key: 'ATT9', data: { itemType: 'attachment', title: 'full.pdf', contentType: 'application/pdf' } }
        ]
      },
      '/users/0/items/TOP2/children': { status: 200, body: [] },
      '/users/0/items/ATT9/file/view/url': {
        status: 200,
        body: { url: `file://${pdfSrc}/full.pdf` }
      }
    })
    const progress: Array<{ done: number; total: number }> = []
    const summary = await importZoteroCollection(
      db,
      dataDir,
      1,
      'COLL1',
      (p) => progress.push(p),
      { fetchImpl },
      availableParser
    )
    expect(summary).toMatchObject({ imported: 2, updated: 0, addedToGraph: 2, failed: 0, pdfUnresolved: 0, hint: null })
    // 进度：reading(0/0) → importing 0/2、1/2、2/2
    expect(progress.filter((p) => p.total === 2).map((p) => p.done)).toEqual([0, 1, 2])
    expect(listRelations(db, 1)).toEqual([])
    const members = db.prepare('SELECT COUNT(*) c FROM graph_members WHERE graph_id = 1').get() as { c: number }
    expect(members.c).toBe(2)
  })

  it('Local API 403 → sqlite 副本兜底导入并返回中文提示', async () => {
    const zoteroDir = join(dir, 'fake-zotero')
    mkdirSync(zoteroDir, { recursive: true })
    const sqlitePath = join(zoteroDir, 'zotero.sqlite')
    buildFakeZoteroDb(sqlitePath)
    // storage: 附件的相对路径以 zotero.sqlite 所在目录为数据目录解析
    const attDir = join(zoteroDir, 'storage', 'ATT1')
    mkdirSync(attDir, { recursive: true })
    writeFileSync(join(attDir, 'top1.pdf'), FAKE_PDF)

    const progress: number[] = []
    const summary = await importZoteroCollection(
      db,
      dataDir,
      1,
      'COLL1',
      (p) => progress.push(p.done),
      { fetchImpl: fakeFetch({ '/users/0/items': { status: 403, body: {} } }), sqlitePath },
      availableParser
    )
    expect(summary.imported).toBe(2)
    expect(summary.addedToGraph).toBe(2)
    expect(summary.hint).toBe(HINT_403)
    expect(progress).toEqual([0, 0, 1, 2]) // reading(0) + importing 0/2、1/2、2/2
    // TOP1 有 PDF 复制进论文文件夹；TOP2 无附件「无 PDF」入库（D62）
    const rows = db.prepare('SELECT zotero_item_key, has_pdf FROM papers ORDER BY zotero_item_key').all() as Array<{
      zotero_item_key: string
      has_pdf: number
    }>
    expect(rows).toEqual([
      { zotero_item_key: 'TOP1', has_pdf: 1 },
      { zotero_item_key: 'TOP2', has_pdf: 0 }
    ])
  })

  it('重复导入同一分类：计数归为 updated，图内成员不重复', async () => {
    const zoteroDir = join(dir, 'fake-zotero')
    mkdirSync(zoteroDir, { recursive: true })
    const sqlitePath = join(zoteroDir, 'zotero.sqlite')
    buildFakeZoteroDb(sqlitePath)
    const opts = {
      fetchImpl: fakeFetch({ '/users/0/items': { status: 403, body: {} } }),
      sqlitePath
    }
    await importZoteroCollection(db, dataDir, 1, 'COLL1', () => {}, opts, availableParser)
    const again = await importZoteroCollection(db, dataDir, 1, 'COLL1', () => {}, opts, availableParser)
    expect(again.imported).toBe(0)
    expect(again.updated).toBe(2)
    expect(again.addedToGraph).toBe(0)
  })

  it('uat2：补齐 PDF 的论文经 onPdfAdded 回调一次（IPC 事件数据源）；无补齐不调', async () => {
    const zoteroDir = join(dir, 'fake-zotero')
    mkdirSync(zoteroDir, { recursive: true })
    const sqlitePath = join(zoteroDir, 'zotero.sqlite')
    buildFakeZoteroDb(sqlitePath)
    // TOP1 的附件源文件：第一次导入就补得上（之后人为重置 has_pdf 模拟 D75 补齐场景）
    const attDir = join(zoteroDir, 'storage', 'ATT1')
    mkdirSync(attDir, { recursive: true })
    writeFileSync(join(attDir, 'top1.pdf'), FAKE_PDF)
    const opts = {
      fetchImpl: fakeFetch({ '/users/0/items': { status: 403, body: {} } }),
      sqlitePath
    }
    const calls: number[][] = []
    const first = await importZoteroCollection(db, dataDir, 1, 'COLL1', () => {}, opts, availableParser, (ids) => calls.push(ids))
    expect(first.pdfAdded).toBe(0)
    expect(calls).toEqual([]) // 无补齐不调
    // 删掉 TOP1 的 PDF 并置 has_pdf=0，模拟「上次没取到附件」的论文被 D75 补齐
    const top1 = db.prepare("SELECT id FROM papers WHERE zotero_item_key = 'TOP1'").get() as { id: number }
    db.prepare('UPDATE papers SET has_pdf = 0, pdf_hash = NULL WHERE id = ?').run(top1.id)
    rmSync(join(dataDir, 'papers', String(top1.id), 'paper.pdf'))
    const again = await importZoteroCollection(db, dataDir, 1, 'COLL1', () => {}, opts, availableParser, (ids) => calls.push(ids))
    expect(again.pdfAdded).toBe(1)
    expect(calls).toEqual([[top1.id]]) // uat2：事件只带本次补齐的论文
    const row = db.prepare('SELECT has_pdf, pdf_source FROM papers WHERE id = ?').get(top1.id) as { has_pdf: number; pdf_source: string }
    expect(row).toEqual({ has_pdf: 1, pdf_source: 'zotero' })
  })
})

describe('importZoteroItemsByKeys（uat14 D209：按所选 item keys 导入）', () => {
  const twoItemRoutes = {
    '/users/0/items?limit=1': { status: 200, body: [] },
    '/users/0/collections/COLL1/items/top': {
      status: 200,
      body: [
        { key: 'TOP1', version: 1, data: { itemType: 'journalArticle', title: 'Subset One', DOI: '10.5555/S1', creators: [] } },
        { key: 'TOP2', version: 1, data: { itemType: 'journalArticle', title: 'Subset Two', creators: [] } }
      ]
    }
  }

  it('只导入所选 key：未选的条目不入库、不进图谱', async () => {
    const progress: Array<{ done: number; total: number }> = []
    const summary = await importZoteroItemsByKeys(
      db,
      dataDir,
      1,
      'COLL1',
      ['TOP1'],
      (p) => progress.push(p),
      { fetchImpl: fakeFetch(twoItemRoutes) },
      availableParser
    )
    expect(summary).toMatchObject({ imported: 1, updated: 0, addedToGraph: 1, failed: 0 })
    expect(summary.addedToGraphIds).toHaveLength(1)
    // 进度只覆盖所选条目
    expect(progress.filter((p) => p.total === 1).map((p) => p.done)).toEqual([0, 1])
    const keys = db.prepare('SELECT zotero_item_key FROM papers').all() as Array<{ zotero_item_key: string }>
    expect(keys.map((k) => k.zotero_item_key)).toEqual(['TOP1']) // TOP2 未导入
    const members = db.prepare('SELECT COUNT(*) c FROM graph_members WHERE graph_id = 1').get() as { c: number }
    expect(members.c).toBe(1)
  })

  it('重复导入所选同一 key：去重计为 updated，图内成员不重复', async () => {
    const opts = { fetchImpl: fakeFetch(twoItemRoutes) }
    await importZoteroItemsByKeys(db, dataDir, 1, 'COLL1', ['TOP1'], () => {}, opts, availableParser)
    const again = await importZoteroItemsByKeys(db, dataDir, 1, 'COLL1', ['TOP1'], () => {}, opts, availableParser)
    expect(again.imported).toBe(0)
    expect(again.updated).toBe(1)
    expect(again.addedToGraph).toBe(0)
    expect(again.addedToGraphIds).toEqual([])
    const papers = db.prepare('SELECT COUNT(*) c FROM papers').get() as { c: number }
    expect(papers.c).toBe(1) // 库内不重复
    const members = db.prepare('SELECT COUNT(*) c FROM graph_members WHERE graph_id = 1').get() as { c: number }
    expect(members.c).toBe(1)
  })

  it('空 key 列表抛中文错误（IPC 层兜底，不会走到来源探测）', async () => {
    await expect(
      importZoteroItemsByKeys(db, dataDir, 1, 'COLL1', [], () => {}, {}, availableParser)
    ).rejects.toThrow('未选择要导入的 Zotero 条目')
  })

  it('listZoteroCollectionItems 带 db：按 (libraryID, itemKey) 标 alreadyImported（软删不算）', async () => {
    const opts = { fetchImpl: fakeFetch(twoItemRoutes) }
    await importZoteroItemsByKeys(db, dataDir, 1, 'COLL1', ['TOP1'], () => {}, opts, availableParser)
    const items = await listZoteroCollectionItems('COLL1', opts, db)
    const one = items.find((i) => i.key === 'TOP1')!
    const two = items.find((i) => i.key === 'TOP2')!
    expect(one.alreadyImported).toBe(true)
    expect(two.alreadyImported).toBe(false)
    // 软删后不再算「已导入」
    db.prepare("UPDATE papers SET deleted_at = '2026-11-06' WHERE zotero_item_key = 'TOP1'").run()
    const after = await listZoteroCollectionItems('COLL1', opts, db)
    expect(after.find((i) => i.key === 'TOP1')!.alreadyImported).toBe(false)
    // 不传 db：字段缺省（undefined），不抛错
    const noDb = await listZoteroCollectionItems('COLL1', opts)
    expect(noDb.find((i) => i.key === 'TOP1')!.alreadyImported).toBeUndefined()
  })
})

/** 造一篇带 PDF 的论文（papers/<id>/paper.pdf），返回 id 与文件哈希 */
function addPaperWithPdf(title: string): { id: number; pdfHash: string } {
  const now = new Date().toISOString()
  const r = db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES (?, 'zotero', 1, ?, ?)").run(title, now, now)
  const id = Number(r.lastInsertRowid)
  mkdirSync(join(dataDir, 'papers', String(id)), { recursive: true })
  const pdf = Buffer.from(`%PDF-fake-${id}`)
  writeFileSync(join(dataDir, 'papers', String(id), 'paper.pdf'), pdf)
  return { id, pdfHash: createHash('sha256').update(pdf).digest('hex') }
}

const jobCount = (): number => (db.prepare('SELECT COUNT(*) c FROM jobs').get() as { c: number }).c

describe('D95：MinerU 不可用不入队，可用后补排「未处理」论文', () => {
  it('解析器不可用时导入不入队：不产生失败任务，jobs 表为空', () => {
    const { id } = addPaperWithPdf('未处理论文')
    const ids = enqueueProcessJobs(db, dataDir, [id], unavailableParser)
    expect(ids).toEqual([])
    expect(jobCount()).toBe(0) // 不点红状态点的前提：根本没有任务
  })

  it('解析器可用时正常入队（行为与不传 parser 前一致）', () => {
    const { id } = addPaperWithPdf('待处理论文')
    const ids = enqueueProcessJobs(db, dataDir, [id], availableParser)
    expect(ids).toHaveLength(1)
    expect(jobCount()).toBe(1)
  })

  it('backfillProcessJobs：只补排「未处理」的——已成功且 PDF 未变的跳过', () => {
    const a = addPaperWithPdf('未处理 A')
    const b = addPaperWithPdf('已处理 B')
    // B 模拟处理成功：succeeded 任务 + paper_details.pdf_hash 与当前 PDF 一致（D67/D29 口径）
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO jobs (kind, paper_id, status, payload, created_at, updated_at) VALUES ('process_paper', ?, 'succeeded', '{}', ?, ?)"
    ).run(b.id, now, now)
    db.prepare(
      "INSERT INTO paper_details (paper_id, parts, model, prompt_version, pdf_hash, generated_at, created_at, updated_at) VALUES (?, '[]', 'deepseek-flash', 'detail-v1', ?, ?, ?, ?)"
    ).run(b.id, b.pdfHash, now, now, now)

    const ids = backfillProcessJobs(db, dataDir, availableParser)
    expect(ids).toHaveLength(1)
    // 补排的任务属于 A；B（已成功且 PDF 未变）不重复排
    const row = db.prepare('SELECT paper_id FROM jobs WHERE id = ?').get(ids[0]) as { paper_id: number }
    expect(row.paper_id).toBe(a.id)
    expect(jobCount()).toBe(2) // B 的手动 succeeded 记录 + A 的新任务
  })

  it('backfillProcessJobs：已成功的论文即使哈希不符或缺文件也不重排（D134 bug4）', () => {
    const mismatch = addPaperWithPdf('哈希已变')
    const missing = addPaperWithPdf('文件已删')
    const now = new Date().toISOString()
    const ins = db.prepare(
      "INSERT INTO jobs (kind, paper_id, status, payload, created_at, updated_at) VALUES ('process_paper', ?, 'succeeded', '{}', ?, ?)"
    )
    ins.run(mismatch.id, now, now)
    ins.run(missing.id, now, now)
    db.prepare(
      "INSERT INTO paper_details (paper_id, parts, model, prompt_version, pdf_hash, generated_at, created_at, updated_at) VALUES (?, '[]', 'deepseek-flash', 'detail-v1', 'not-the-current-hash', ?, ?, ?)"
    ).run(mismatch.id, now, now, now)
    rmSync(join(dataDir, 'papers', String(missing.id), 'paper.pdf'))
    expect(backfillProcessJobs(db, dataDir, availableParser)).toEqual([])
    expect(backfillProcessJobs(db, dataDir, availableParser)).toEqual([])
    expect(jobCount()).toBe(2)
  })

  it('backfillProcessJobs：解析器不可用时什么也不做', () => {
    addPaperWithPdf('未处理论文')
    expect(backfillProcessJobs(db, dataDir, unavailableParser)).toEqual([])
    expect(jobCount()).toBe(0)
  })

  it('backfillProcessJobs：终态失败（failed_action）的论文重启不补排（D53 留待手动重试）', () => {
    const { id } = addPaperWithPdf('终态失败论文')
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO jobs (kind, paper_id, status, payload, created_at, updated_at) VALUES ('process_paper', ?, 'failed_action', '{}', ?, ?)"
    ).run(id, now, now)

    expect(backfillProcessJobs(db, dataDir, availableParser)).toEqual([])
    expect(jobCount()).toBe(1) // 不新增任务；失败任务仍在，等用户手动重试
  })

  it('backfillProcessJobs：failed_retryable 的论文同样不自动补排', () => {
    const { id } = addPaperWithPdf('可重试失败论文')
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO jobs (kind, paper_id, status, payload, created_at, updated_at) VALUES ('process_paper', ?, 'failed_retryable', '{}', ?, ?)"
    ).run(id, now, now)

    expect(backfillProcessJobs(db, dataDir, availableParser)).toEqual([])
    expect(jobCount()).toBe(1)
  })

  it('backfillProcessJobs：排队中的论文不重复入队', () => {
    const { id } = addPaperWithPdf('排队中论文')
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO jobs (kind, paper_id, status, payload, created_at, updated_at) VALUES ('process_paper', ?, 'queued', '{}', ?, ?)"
    ).run(id, now, now)

    expect(backfillProcessJobs(db, dataDir, availableParser)).toEqual([])
    expect(jobCount()).toBe(1) // 仍是原来那个 queued 任务
  })

  it('D95 全链路：MinerU 不可用期间导入显示「未处理」，变可用后自动补排', () => {
    const a = addPaperWithPdf('不可用期间导入 A')
    const b = addPaperWithPdf('不可用期间导入 B')
    // 不可用期间导入：不入队、不产生失败任务；读取侧显示「未处理」（不点红状态点）
    expect(enqueueProcessJobs(db, dataDir, [a.id, b.id], unavailableParser)).toEqual([])
    expect(
      getPapersProcessStatus(db, [a.id, b.id]).map((s) => s.state)
    ).toEqual(['unprocessed', 'unprocessed'])
    // MinerU 变可用（sidecar ready / 启动检测到）：补排全部「未处理」论文
    expect(backfillProcessJobs(db, dataDir, availableParser)).toHaveLength(2)
    expect(jobCount()).toBe(2)
    expect(
      getPapersProcessStatus(db, [a.id, b.id]).map((s) => s.state)
    ).toEqual(['queued', 'queued'])
  })

  it('backfillProcessJobs：从未入队的论文会被补排', () => {
    const a = addPaperWithPdf('从未入队 A')
    const b = addPaperWithPdf('从未入队 B')
    expect(backfillProcessJobs(db, dataDir, availableParser)).toHaveLength(2)
    const queuedPapers = db
      .prepare("SELECT paper_id FROM jobs WHERE kind = 'process_paper' AND status = 'queued' ORDER BY paper_id")
      .all() as Array<{ paper_id: number }>
    expect(queuedPapers.map((r) => r.paper_id)).toEqual([a.id, b.id])
  })
})


describe('uat1b D144：等待解析组件计数与恰好一次补排', () => {
  it('countWaitingPapers：有 PDF、未处理且未入队才计；入队/无 PDF/软删不计', () => {
    const a = addPaperWithPdf('等待 A')
    const b = addPaperWithPdf('等待 B')
    const c = addPaperWithPdf('等待 C')
    expect(countWaitingPapers(db)).toBe(3)
    // 无 PDF 不计
    const now = new Date().toISOString()
    db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES ('无 PDF 的', 'zotero', 0, ?, ?)").run(now, now)
    // 软删不计
    db.prepare('UPDATE papers SET deleted_at = ? WHERE id = ?').run(now, c.id)
    expect(countWaitingPapers(db)).toBe(2)
    // 入队一个 → N 减一
    enqueueProcessJobs(db, dataDir, [a.id], availableParser)
    expect(countWaitingPapers(db)).toBe(1)
    expect(countWaitingPapers(db)).toBe(unprocessedWithPdfIds(db).length)
    void b
  })

  it('变可用后自动补排恰好一次：重复 backfill 不重复入队，N 归零', () => {
    const a = addPaperWithPdf('补排一次 A')
    const b = addPaperWithPdf('补排一次 B')
    // 不可用期间：N 照常计数（渲染层显示「等待解析组件」），但不入队
    expect(enqueueProcessJobs(db, dataDir, [a.id, b.id], unavailableParser)).toEqual([])
    expect(countWaitingPapers(db)).toBe(2)
    // 切到 ready：第一次补排 2 个；第二次（重复触发，如多条 ready 路径）为空、任务数不变
    expect(backfillProcessJobs(db, dataDir, availableParser)).toHaveLength(2)
    expect(jobCount()).toBe(2)
    expect(backfillProcessJobs(db, dataDir, availableParser)).toEqual([])
    expect(jobCount()).toBe(2)
    expect(countWaitingPapers(db)).toBe(0)
    expect(
      getPapersProcessStatus(db, [a.id, b.id]).map((s) => s.state)
    ).toEqual(['queued', 'queued'])
  })
})
