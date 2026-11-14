import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { extname, join } from 'node:path'
import type Database from 'better-sqlite3'
import { createHash, randomBytes } from 'node:crypto'
import { paperFolder } from '../zotero/importer'
import { PDF_MAX_BYTES } from './download'
import { recordPdfAttempt } from './attempts'

const PDF_HEAD_LEN = 5

/**
 * lane/fetch 批 1：03e 拖入 / 选择 PDF（D111/D133；契约 cand:attachPdf）。
 *
 * 主进程校验：论文存在且未删除 → 扩展名 .pdf → 普通文件（拒绝符号链接，O_NOFOLLOW）
 * → 大小 0 < n ≤ 50MB → `%PDF-` 头 → 同一把文件描述符读完并哈希（不读两遍）
 * → 写入 `papers/<id>/paper.pdf`（目标也拒绝符号链接）→ has_pdf=1 /
 * pdf_source='user_drop' / pdf_hash。解析排队走 D95 口径。
 */

function openNoFollow(path: string, flags: number): number {
  try {
    return openSync(path, flags)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw new Error(`文件不存在：${path}`)
    if (code === 'ELOOP') throw new Error('不能通过符号链接读取或写入 PDF')
    throw e
  }
}

export function attachUserPdf(db: Database.Database, dataDir: string, paperId: number, filePath: string): void {
  const paper = db.prepare('SELECT id, deleted_at FROM papers WHERE id = ?').get(paperId) as
    | { id: number; deleted_at: string | null }
    | undefined
  if (!paper) throw new Error(`论文 ${paperId} 不存在`)
  if (paper.deleted_at != null) throw new Error('已删除的论文不能添加 PDF')
  if (!existsSync(filePath)) throw new Error(`文件不存在：${filePath}`)
  if (!/\.pdf$/i.test(extname(filePath))) throw new Error('只支持 PDF 文件')

  const src = openNoFollow(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const st = fstatSync(src)
    if (!st.isFile()) throw new Error('不是普通文件')
    if (st.size <= 0) throw new Error('PDF 文件为空')
    if (st.size > PDF_MAX_BYTES) throw new Error(`PDF 超过 ${Math.round(PDF_MAX_BYTES / 1024 / 1024)}MB 上限`)
    const head = Buffer.alloc(PDF_HEAD_LEN)
    const headN = readSync(src, head, 0, PDF_HEAD_LEN, 0)
    if (headN < PDF_HEAD_LEN || head.toString('latin1') !== '%PDF-') {
      throw new Error('文件不是有效的 PDF（缺少 %PDF- 文件头）')
    }

    const dir = paperFolder(dataDir, paperId)
    mkdirSync(dir, { recursive: true })
    const destPath = join(dir, 'paper.pdf')
    // 同目录临时文件写完并 fsync 后再改名覆盖。失败只删本次创建的临时文件，原 PDF 保持完好。
    const tmpPath = join(dir, `.paper.pdf.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
    const tmp = openNoFollow(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW)
    let tmpOpen = true
    const hash = createHash('sha256')
    try {
      hash.update(head)
      writeSync(tmp, head)
      let pos = PDF_HEAD_LEN
      const buf = Buffer.alloc(64 * 1024)
      while (pos < st.size) {
        const got = readSync(src, buf, 0, Math.min(buf.length, st.size - pos), pos)
        if (got <= 0) break
        hash.update(buf.subarray(0, got))
        writeSync(tmp, buf.subarray(0, got))
        pos += got
      }
      fsyncSync(tmp)
      closeSync(tmp)
      tmpOpen = false
      let destKind: 'absent' | 'file' | 'symlink' | 'other' = 'absent'
      try {
        const destSt = lstatSync(destPath)
        destKind = destSt.isSymbolicLink() ? 'symlink' : destSt.isFile() ? 'file' : 'other'
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') throw e
      }
      if (destKind === 'symlink') throw new Error('不能通过符号链接读取或写入 PDF')
      if (destKind === 'other') throw new Error('目标不是普通文件')
      renameSync(tmpPath, destPath)
    } catch (e) {
      if (tmpOpen) {
        try {
          closeSync(tmp)
        } catch {
          /* 描述符已关 */
        }
      }
      try {
        unlinkSync(tmpPath)
      } catch {
        /* 已改名，或临时文件本来就不在 */
      }
      throw e
    }
    db.prepare(
      "UPDATE papers SET has_pdf = 1, pdf_source = 'user_drop', pdf_hash = ?, pdf_unresolved = 0, updated_at = ? WHERE id = ?"
    ).run(hash.digest('hex'), new Date().toISOString(), paperId)
    recordPdfAttempt(db, paperId, 'user_drop', 'ok')
  } finally {
    closeSync(src)
  }
}
