import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { normalizeAuthorName } from './authorName'
import { itemToCsl } from './csl'
import { extractArxivId, extractYear, normalizeDoi } from './ids'
import type { ZoteroAttachmentRef, ZoteroItem } from './types'
import { indexPaperFts } from '../db/fts'
import { reindexFullTextFtsIfPresent } from '../db/fulltextFts'

/**
 * Zotero 导入器：去重入库 + PDF 复制（D26/D55/D61/D62/D75/D82）。
 *
 * 去重（D82：只按 DOI 和 arXiv ID 精确匹配，另加 D75 的 (libraryID, itemKey)）：
 *   1. (zotero_library_id, zotero_item_key)——重新导入同一条恢复内部 ID（D75）；
 *   2. DOI（归一化后精确相等）；
 *   3. arXiv ID（归一化后精确相等）。
 * 重新导入（D75）：
 *   - 内部 ID 不变；只补空字段，不覆盖 App 内的编辑；
 *   - 软删除后重新导入 → 恢复同一条（deleted_at 置空，内部 ID 不变）。
 * PDF（D62）：复制进数据目录的论文文件夹 `<dataDir>/papers/<id>/paper.pdf`
 * （复制不移动，Zotero storage 不动）；无附件条目以「无 PDF」入库（has_pdf=0）。
 * 作者写入 paper_authors（D93 规范化名支撑列）。
 */

export interface PaperMeta {
  cslJson: string
  title: string
  year: number | null
  doi: string | null
  arxivId: string | null
  firstAuthor: string | null
  abstract: string | null
  authors: Array<{ family: string | null; given: string | null; normalized: string }>
}

export function buildPaperMeta(item: ZoteroItem): PaperMeta {
  const csl = itemToCsl(item)
  const authors = (item.creators ?? [])
    .filter((c) => c.creatorType === 'author')
    .map((c) => ({
      family: c.name ? null : (c.lastName ?? null),
      given: c.name ? null : (c.firstName ?? null),
      normalized: normalizeAuthorName(
        c.name ?? (c.lastName ? (c.firstName ? `${c.firstName} ${c.lastName}` : c.lastName) : '')
      )
    }))
    .filter((a) => a.normalized !== '')
  const creators = item.creators ?? []
  // 第一作者优先取 creatorType=author（editor 排第一也不能当第一作者，评审建议修 6）
  const first = creators.find((c) => c.creatorType === 'author') ?? creators[0]
  const firstAuthor = first ? (first.lastName ?? first.name ?? null) : null
  return {
    cslJson: JSON.stringify(csl),
    title: item.title?.trim() ?? '',
    year: extractYear(item.date),
    doi: normalizeDoi(item.DOI),
    arxivId: extractArxivId(item),
    firstAuthor,
    abstract: item.abstractNote?.trim() ? item.abstractNote.trim() : null,
    authors
  }
}

export interface ImportItemResult {
  itemKey: string
  paperId: number
  action: 'created' | 'updated' | 'restored' | 'skipped'
  hasPdf: boolean
  /** uat1b：本次新补上 PDF（重新导入补空字段，D75「缺 PDF 视为空字段」）；创建时不另算 */
  pdfAdded: boolean
  /**
   * 有 PDF 附件但取不到本地文件（Local API 端点失败、路径解析失败、源文件不存在）：
   * 与「本就无附件」区分开，不静默标成「无 PDF」（评审建议修 2）。写入 papers.pdf_unresolved。
   */
  pdfUnresolved: boolean
}

export interface ImportOptions {
  /** Zotero 库 ID（Local API 固定 0；sqlite 路径用 items.libraryID）。D75 复合键的一部分。 */
  libraryId: number
  /** 附件 → 本地文件路径（Local API 来源必须提供；sqlite 来源附件已带 path）。 */
  resolveAttachmentPath?: (att: ZoteroAttachmentRef) => string | null | Promise<string | null>
  now?: string
}

export function paperFolder(dataDir: string, paperId: number): string {
  return join(dataDir, 'papers', String(paperId))
}

function pickPdfAttachment(item: ZoteroItem): ZoteroAttachmentRef | null {
  const pdfs = item.attachments.filter(
    (a) => a.contentType === 'application/pdf' || /\.pdf$/i.test(a.path ?? a.title)
  )
  // 优先有路径的（可直接复制）
  return pdfs.find((a) => a.path) ?? pdfs[0] ?? null
}

function sha256Of(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** 查已存在的论文：先 (libraryID, itemKey)，再 DOI，再 arXiv ID（含软删除行，D75）。
 *  同键多行（软删行+活行并存）时活行优先，避免恢复软删行撞活行唯一索引（评审建议修 3）。 */
function findExistingPaper(
  db: Database.Database,
  libraryId: number,
  itemKey: string,
  meta: PaperMeta
): { id: number; deleted_at: string | null } | undefined {
  // 1) (libraryID, itemKey)：重新导入同一条（D75），优先级最高
  const byKey = db
    .prepare(
      `SELECT id, deleted_at FROM papers WHERE zotero_library_id = ? AND zotero_item_key = ?
       ORDER BY (deleted_at IS NULL) DESC, id`
    )
    .get(libraryId, itemKey) as { id: number; deleted_at: string | null } | undefined
  if (byKey) return byKey
  // 2) DOI 精确（D82）
  if (meta.doi) {
    const byDoi = db
      .prepare('SELECT id, deleted_at FROM papers WHERE doi = ? ORDER BY (deleted_at IS NULL) DESC, id')
      .get(meta.doi) as { id: number; deleted_at: string | null } | undefined
    if (byDoi) return byDoi
  }
  // 3) arXiv ID 精确（D82）
  if (meta.arxivId) {
    return db
      .prepare('SELECT id, deleted_at FROM papers WHERE arxiv_id = ? ORDER BY (deleted_at IS NULL) DESC, id')
      .get(meta.arxivId) as { id: number; deleted_at: string | null } | undefined
  }
  return undefined
}

/** 导入一批 Zotero 条目（同一分类下的顶层条目）。 */
export async function importZoteroItems(
  db: Database.Database,
  dataDir: string,
  items: ZoteroItem[],
  opts: ImportOptions
): Promise<ImportItemResult[]> {
  const now = opts.now ?? new Date().toISOString()
  const results: ImportItemResult[] = []

  for (const item of items) {
    const meta = buildPaperMeta(item)

    const existing = findExistingPaper(db, opts.libraryId, item.key, meta)
    let paperId = 0 // tx() 同步执行后必被赋值（TS 无法追踪回调内赋值，给个初值）
    let action: ImportItemResult['action']

    const tx = db.transaction(() => {
      if (existing) {
        const row = db.prepare('SELECT * FROM papers WHERE id = ?').get(existing.id) as Record<string, unknown>
        // 只补空字段，不覆盖 App 内的编辑（D75）
        const patch: Record<string, unknown> = { updated_at: now }
        if (existing.deleted_at != null) patch.deleted_at = null // 软删除恢复，内部 ID 不变
        const fill = (col: string, value: unknown): void => {
          const cur = row[col]
          const empty = cur === null || cur === undefined || cur === '' || (col === 'csl_json' && cur === '{}')
          if (empty && value != null && value !== '' && value !== '{}') patch[col] = value
        }
        fill('title', meta.title)
        fill('year', meta.year)
        fill('doi', meta.doi)
        // lane-rel.md 备忘（维护者合并时实现）：导入补空 DOI 时记 doi_match_method='original'
        // （Zotero 条目原有的 DOI，区别于 openalex_title 按标题找回，D71）
        const doiWasEmpty = row['doi'] === null || row['doi'] === undefined || row['doi'] === ''
        if (doiWasEmpty && meta.doi) patch['doi_match_method'] = 'original'
        fill('arxiv_id', meta.arxivId)
        fill('first_author', meta.firstAuthor)
        fill('abstract', meta.abstract)
        fill('csl_json', meta.cslJson)
        if (row['zotero_item_key'] == null) {
          patch['zotero_library_id'] = opts.libraryId
          patch['zotero_item_key'] = item.key
        }
        const cols = Object.keys(patch)
        db.prepare(
          `UPDATE papers SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`
        ).run(...cols.map((c) => patch[c]), existing.id)

        // 作者：paper_authors 为空才补（不覆盖、不重建）
        const authorCount = (
          db.prepare('SELECT COUNT(*) c FROM paper_authors WHERE paper_id = ?').get(existing.id) as { c: number }
        ).c
        if (authorCount === 0) {
          const ins = db.prepare(
            'INSERT INTO paper_authors (paper_id, position, family, given, normalized) VALUES (?, ?, ?, ?, ?)'
          )
          meta.authors.forEach((a, i) => ins.run(existing.id, i, a.family, a.given, a.normalized))
        }
        paperId = existing.id
        action = existing.deleted_at != null ? 'restored' : Object.keys(patch).length > 1 ? 'updated' : 'skipped'
      } else {
        const r = db
          .prepare(
            `INSERT INTO papers (
               csl_json, title, first_author, year, doi, doi_match_method, arxiv_id,
               zotero_library_id, zotero_item_key, source,
               has_pdf, abstract, abstract_source, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'zotero', 0, ?, ?, ?, ?)`
          )
          .run(
            meta.cslJson,
            meta.title,
            meta.firstAuthor,
            meta.year,
            meta.doi,
            meta.doi ? 'original' : null, // D71：导入原有 DOI 的匹配方式
            meta.arxivId,
            opts.libraryId,
            item.key,
            meta.abstract,
            meta.abstract ? 'original' : null,
            now,
            now
          )
        paperId = Number(r.lastInsertRowid)
        const ins = db.prepare(
          'INSERT INTO paper_authors (paper_id, position, family, given, normalized) VALUES (?, ?, ?, ?, ?)'
        )
        meta.authors.forEach((a, i) => ins.run(paperId, i, a.family, a.given, a.normalized))
        action = 'created'
      }
    })
    tx()

    // PDF：复制进论文文件夹（复制不移动，Zotero storage 不动）；无附件 → 「无 PDF」入库（D62）
    const pdfAtt = pickPdfAttachment(item)
    let pdfUnresolved = false
    let pdfAdded = false
    let hasPdf = (
      db.prepare('SELECT has_pdf FROM papers WHERE id = ?').get(paperId) as { has_pdf: number }
    ).has_pdf === 1
    if (pdfAtt && !hasPdf) {
      let src = pdfAtt.path ?? null
      if (!src && opts.resolveAttachmentPath) {
        try {
          src = await opts.resolveAttachmentPath(pdfAtt)
        } catch {
          src = null // 取路径异常按「取路径失败」处理，不中断导入
        }
      }
      if (src && existsSync(src)) {
        const dir = paperFolder(dataDir, paperId)
        mkdirSync(dir, { recursive: true })
        const dest = join(dir, 'paper.pdf')
        // uat1-fix1 建议修 5：目标文件已存在但库里 has_pdf=0（残留旧文件）时覆盖复制——
        // 保证磁盘文件就是本次来源的文件，不把来路不明的旧文件记成这篇的 PDF
        copyFileSync(src, dest)
        db.prepare(
          `UPDATE papers SET has_pdf = 1, pdf_source = COALESCE(pdf_source, 'zotero'),
             pdf_hash = ?, pdf_unresolved = 0, updated_at = ? WHERE id = ?`
        ).run(sha256Of(dest), now, paperId)
        hasPdf = true
        pdfAdded = true
        // uat1b：补上 PDF 后「条目有附件但没取到文件」的标记清除
        if (action! === 'skipped') action = 'updated' // D75：缺 PDF 视为空字段，补齐计为已更新
      } else {
        // 有 PDF 附件但拿不到文件：与「本就无附件」区分（评审建议修 2）；事实记进
        // papers.pdf_unresolved，详情页来源行如实显示（uat1b）
        pdfUnresolved = true
        db.prepare('UPDATE papers SET pdf_unresolved = 1, updated_at = ? WHERE id = ?').run(now, paperId)
      }
    }

    // 标题/摘要进 FTS（D33/D74）
    const row = db.prepare('SELECT title, abstract FROM papers WHERE id = ?').get(paperId) as {
      title: string
      abstract: string | null
    }
    indexPaperFts(db, paperId, { title: row.title, abstract: row.abstract, keywords: [] })
    // review_uat3 建议修 4：软删恢复的论文立即补全文索引（不用等下次启动 backfill）
    if (action! === 'restored') reindexFullTextFtsIfPresent(db, dataDir, paperId)

    results.push({ itemKey: item.key, paperId, action: action!, hasPdf, pdfAdded, pdfUnresolved })
  }
  return results
}
