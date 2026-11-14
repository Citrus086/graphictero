import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import type { ZoteroCollection, ZoteroCreator, ZoteroItem } from './types'

/**
 * zotero.sqlite 只读读取器（D26 兜底路径：Zotero 未运行时）。
 *
 * 安全性（绝不写或锁原库）：
 * - 先把 zotero.sqlite（连同存在的 -wal）复制到系统临时目录的独立副本，
 *   之后只打开副本；原库从头到尾不被打开、不加锁；
 * - WAL 一起复制是为了让副本带上未 checkpoint 的近期数据。
 *
 * 活库竞态防护（评审建议修 1）：主库与 -wal 两步复制之间 Zotero 可能在写
 * （checkpoint / WAL reset），复制完 re-stat 源 -wal 的 size/mtime，变了就整体
 * 重复制（有上限）；副本打开后先跑 PRAGMA quick_check，不过则再试一次，
 * 仍不过才抛错——失败宁可重试也不给下游一个主库旧 + WAL 不匹配的副本。
 *
 * 读取范围：分类、分类内顶层条目（不含 attachment/note 条目本身）、
 * 条目的创作者与子附件（含附件路径）。
 */

export interface ZoteroSqliteHandle {
  db: Database.Database
  /** 用完必须调用：关库并删除临时副本。 */
  close(): void
}

const MAX_COPY_ATTEMPTS = 3

/** 单次复制：主库 + -wal（若存在），返回源 -wal 复制前后的 size/mtime 快照。 */
function copyOnce(sqlitePath: string, copyPath: string): { size: number; mtimeMs: number } | null {
  const walPath = `${sqlitePath}-wal`
  const copyWalPath = `${copyPath}-wal`
  copyFileSync(sqlitePath, copyPath)
  if (existsSync(copyWalPath)) rmSync(copyWalPath) // 上一次尝试的残留
  if (!existsSync(walPath)) return null
  const before = statSync(walPath)
  copyFileSync(walPath, copyWalPath)
  const after = statSync(walPath)
  // 复制窗口内源 -wal 变了（Zotero 在写）：size/mtime 任一不一致都重试
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return { size: -1, mtimeMs: -1 }
  return { size: after.size, mtimeMs: after.mtimeMs }
}

/** 打开副本并做完整性自检；副本不可用返回 null（调用方重试）。 */
function openCopyOrNull(copyPath: string): Database.Database | null {
  let db: Database.Database
  try {
    db = new Database(copyPath, { readonly: true, fileMustExist: true })
    const row = db.prepare('PRAGMA quick_check').get() as { quick_check: string }
    if (row.quick_check !== 'ok') {
      db.close()
      return null
    }
  } catch {
    return null
  }
  return db
}

/** 复制 zotero.sqlite（含 -wal）到临时副本并打开。原库只被读取（复制），不被打开。 */
export function openZoteroDatabaseCopy(sqlitePath: string, tempDir = tmpdir()): ZoteroSqliteHandle {
  const workDir = mkdtempSync(join(tempDir, 'gt-zotero-copy-'))
  const copyPath = join(workDir, 'zotero.sqlite')
  let db: Database.Database | null = null
  try {
    for (let attempt = 0; attempt < MAX_COPY_ATTEMPTS && !db; attempt++) {
      copyOnce(sqlitePath, copyPath)
      db = openCopyOrNull(copyPath)
    }
    if (!db) {
      throw new Error('zotero.sqlite 只读副本复制后自检未通过（源库可能正在写入），请重试导入')
    }
  } catch (e) {
    rmSync(workDir, { recursive: true, force: true })
    throw e
  }
  return {
    db,
    close() {
      db.close()
      rmSync(workDir, { recursive: true, force: true })
    }
  }
}

/** Zotero data dir 下的 storage/<key>/ 目录（attachment path 为 storage:xxx 时拼路径用）。 */
export function zoteroStorageDir(zoteroDataDir: string, attachmentItemKey: string): string {
  return join(zoteroDataDir, 'storage', attachmentItemKey)
}

interface ItemRow {
  itemID: number
  itemType: string
  key: string
  libraryID: number
}

/** 附件 path 字段 → 本地文件绝对路径；返回 null 表示解析不了（如 linked URL）。 */
export function attachmentAbsolutePath(path: string | null, attachmentKey: string, zoteroDataDir?: string): string | null {
  if (!path) return null
  if (path.startsWith('storage:')) {
    if (!zoteroDataDir) return null
    return join(zoteroStorageDir(zoteroDataDir, attachmentKey), path.slice('storage:'.length))
  }
  if (isAbsolute(path)) return path
  return null
}

/** 回收站表是否存在（Zotero 7 才有 deletedItems/deletedCollections；旧版库没有，需兼容）。 */
function hasTable(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null
}

/** 列出分类树（平铺，parentKey 表达层级）。排除回收站分类（deletedCollections，Zotero 7）。 */
export function listCollections(db: Database.Database): ZoteroCollection[] {
  const excludeDeleted = hasTable(db, 'deletedCollections')
    ? 'AND NOT EXISTS (SELECT 1 FROM deletedCollections d WHERE d.collectionID = c.collectionID)'
    : ''
  const rows = db
    .prepare(
      `SELECT c.key, c.collectionName AS name, c.libraryID, p.key AS parentKey
       FROM collections c LEFT JOIN collections p ON p.collectionID = c.parentCollectionID
       WHERE 1 = 1 ${excludeDeleted}
       ORDER BY c.collectionName`
    )
    .all() as Array<{ key: string; name: string; libraryID: number; parentKey: string | null }>
  return rows.map((r) => ({ key: r.key, name: r.name, libraryID: r.libraryID, parentKey: r.parentKey }))
}

function readItemData(db: Database.Database, itemID: number): Record<string, string> {
  const rows = db
    .prepare(
      `SELECT f.fieldName AS fieldName, v.value AS value
       FROM itemData d
       JOIN fields f ON f.fieldID = d.fieldID
       JOIN itemDataValues v ON v.valueID = d.valueID
       WHERE d.itemID = ?`
    )
    .all(itemID) as Array<{ fieldName: string; value: string }>
  const out: Record<string, string> = {}
  for (const r of rows) out[r.fieldName] = r.value
  return out
}

function readCreators(db: Database.Database, itemID: number): ZoteroCreator[] {
  const rows = db
    .prepare(
      `SELECT c.firstName, c.lastName, c.fieldMode, t.creatorType AS creatorType
       FROM itemCreators ic
       JOIN creators c ON c.creatorID = ic.creatorID
       JOIN creatorTypes t ON t.creatorTypeID = ic.creatorTypeID
       WHERE ic.itemID = ?
       ORDER BY ic.orderIndex`
    )
    .all(itemID) as Array<{ firstName: string | null; lastName: string | null; fieldMode: number; creatorType: string }>
  return rows.map((r) =>
    r.fieldMode === 1 || (!r.firstName && !r.lastName)
      ? { creatorType: r.creatorType, name: r.lastName ?? '' }
      : { creatorType: r.creatorType, firstName: r.firstName ?? '', lastName: r.lastName ?? '' }
  )
}

function readAttachments(db: Database.Database, itemID: number, zoteroDataDir?: string) {
  const rows = db
    .prepare(
      `SELECT i.key, a.contentType, a.path
       FROM itemAttachments a
       JOIN items i ON i.itemID = a.itemID
       WHERE a.parentItemID = ?
       ORDER BY a.itemID`
    )
    .all(itemID) as Array<{ key: string; contentType: string | null; path: string | null }>
  // path → 绝对路径在下文按 zoteroDataDir 解析
  return rows.map((a) => ({
    key: a.key,
    title: basename(a.path ?? ''),
    contentType: a.contentType ?? '',
    path: attachmentAbsolutePath(a.path, a.key, zoteroDataDir) ?? undefined
  }))
}

/** 分类内的顶层条目（不含 attachment/note 条目本身）。zoteroDataDir 用于解析 storage: 附件路径。 */
export function readCollectionItems(
  db: Database.Database,
  collectionKey: string,
  zoteroDataDir?: string
): ZoteroItem[] {
  // 回收站条目仍在 collectionItems 里（Zotero 恢复出厂位依赖这一点），必须排除，
  // 否则用户删掉的论文会被静默导回（评审必须修 1）；旧版 Zotero 无 deletedItems 表，兼容。
  const excludeDeleted = hasTable(db, 'deletedItems')
    ? 'AND NOT EXISTS (SELECT 1 FROM deletedItems d WHERE d.itemID = i.itemID)'
    : ''
  const rows = db
    .prepare(
      `SELECT i.itemID, t.typeName AS itemType, i.key, i.libraryID
       FROM collectionItems ci
       JOIN collections c ON c.collectionID = ci.collectionID
       JOIN items i ON i.itemID = ci.itemID
       JOIN itemTypes t ON t.itemTypeID = i.itemTypeID
       WHERE c.key = ? AND t.typeName NOT IN ('attachment', 'note') ${excludeDeleted}
       ORDER BY ci.orderIndex`
    )
    .all(collectionKey) as ItemRow[]

  return rows.map((row) => {
    const d = readItemData(db, row.itemID)
    return {
      key: row.key,
      version: 0, // sqlite 路径不取 version（Local API 才有）
      libraryID: row.libraryID,
      itemType: row.itemType,
      title: d.title,
      creators: readCreators(db, row.itemID),
      abstractNote: d.abstractNote,
      publicationTitle: d.publicationTitle,
      proceedingsTitle: d.proceedingsTitle,
      bookTitle: d.bookTitle,
      volume: d.volume,
      issue: d.issue,
      pages: d.pages,
      DOI: d.DOI,
      url: d.url,
      date: d.date,
      publisher: d.publisher,
      place: d.place,
      extra: d.extra,
      accessDate: d.accessDate,
      language: d.language,
      ISBN: d.ISBN,
      ISSN: d.ISSN,
      archive: d.archive,
      archiveID: d.archiveID,
      repository: d.repository,
      attachments: readAttachments(db, row.itemID, zoteroDataDir)
    }
  })
}
