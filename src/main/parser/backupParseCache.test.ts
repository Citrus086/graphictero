import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { exportFullBackup, restoreFullBackup } from '../db/fullBackup'
import { backfillProcessJobs } from '../appService'
import type { PaperParser } from '../jobs/mineru'

/**
 * D98（细化 D76）：「导出完整备份」包含每篇论文的 MinerU 解析输出
 * （Markdown + 图片，即解析缓存），恢复后无需重新解析。
 *
 * 本测试是 lane/pdf 一侧的 D98 验证（备份/恢复实现在核心 src/main/db/fullBackup.ts，
 * 该实现按整棵数据目录文件树打包，papers/<id>/mineru/ 天然在备份内——本测试锁定
 * 这一行为 + 恢复后不重新排队）。合成数据，无真实论文。
 */

let dir: string
let dataDir: string
let db: Database.Database
let now: string

const FAKE_PDF = Buffer.concat([Buffer.from('%PDF-1.4\nfake\n'), Buffer.alloc(1024, 3), Buffer.from('\n%%EOF\n')])
const FULL_MD = '# 解析正文\n\nfake markdown 正文。\n'
const FIG_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

/** 可用假解析器（D95 口径：backfill 只认 available()） */
const availableParser: PaperParser = {
  available: () => true,
  parse: () => Promise.resolve({ markdown: '', outDir: '' })
}

function insertPaper(fields: Record<string, unknown>): number {
  const cols = Object.keys(fields)
  const r = db
    .prepare(`INSERT INTO papers (${cols.join(', ')}, created_at, updated_at) VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`)
    .run(...cols.map((c) => fields[c]), now, now)
  return Number(r.lastInsertRowid)
}

function enqueueJobRow(paperId: number, status: string): void {
  db.prepare(
    `INSERT INTO jobs (kind, paper_id, status, payload, created_at, updated_at)
     VALUES ('process_paper', ?, ?, '{}', ?, ?)`
  ).run(paperId, status, now, now)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-backup-cache-'))
  dataDir = join(dir, 'data')
  mkdirSync(dataDir, { recursive: true })
  db = openDatabase(join(dataDir, 'graphictero.db'))
  runMigrations(db, MIGRATIONS)
  now = new Date().toISOString()
  db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('备份缓存测试图', now, now)
})

afterEach(() => {
  if (db.open) db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('D98：完整备份包含 MinerU 解析缓存，恢复后无需重新解析', () => {
  it('备份→恢复：解析缓存（Markdown+图片）原样还原、.env 排除、已成功的论文不被重新排队', async () => {
    // 论文 A：无 DOI 手动拖入（PDF 进备份）+ 已成功任务 + 解析缓存
    const a = insertPaper({ title: '已解析论文', has_pdf: 1, pdf_source: 'user_drop' })
    // 论文 B：从未入过队（D95 口径的「未处理」）→ 恢复补排时应补排
    const b = insertPaper({ title: '从未处理论文', has_pdf: 1, pdf_source: 'user_drop' })
    // 论文 C：终态失败（failed_action，D53 手动重试）→ 不自动重排
    const c = insertPaper({ title: '失败论文', has_pdf: 1, pdf_source: 'user_drop' })
    const pdfHash = createHash('sha256').update(FAKE_PDF).digest('hex')
    for (const id of [a, b, c]) {
      mkdirSync(join(dataDir, 'papers', String(id)), { recursive: true })
      writeFileSync(join(dataDir, 'papers', String(id), 'paper.pdf'), FAKE_PDF)
    }
    // A 的解析缓存：正文 + 按图号图片
    mkdirSync(join(dataDir, 'papers', String(a), 'mineru', 'images'), { recursive: true })
    writeFileSync(join(dataDir, 'papers', String(a), 'mineru', 'full.md'), FULL_MD, 'utf8')
    writeFileSync(join(dataDir, 'papers', String(a), 'mineru', 'images', 'fig1.png'), FIG_PNG)
    // 任务与详情记录（恢复后「不重新排队」的判定依据）
    enqueueJobRow(a, 'succeeded')
    enqueueJobRow(c, 'failed_action')
    db.prepare(
      `INSERT INTO paper_details (paper_id, parts, model, prompt_version, pdf_hash, generated_at, created_at, updated_at)
       VALUES (?, '[]', 'deepseek-flash', 'v1', ?, ?, ?, ?)`
    ).run(a, pdfHash, now, now, now)
    // 密钥文件：任何情况下都不进备份（D76/D98）
    writeFileSync(join(dataDir, '.env'), 'DEEPSEEK_API_KEY=secret-should-not-leak\n')

    // 备份（写 .env 之后再导出，确保 .env 已在数据目录里）
    const zipPath = await exportFullBackup(db, dataDir, join(dir, 'backup.zip'))
    db.close()

    // 恢复到空数据目录
    const result = await restoreFullBackup(zipPath, join(dir, 'new-root'))

    // 1) 解析缓存原样还原（Markdown 字节一致 + 图片字节一致）
    const restoredMd = join(result.dataDir, 'papers', String(a), 'mineru', 'full.md')
    expect(existsSync(restoredMd)).toBe(true)
    expect(readFileSync(restoredMd, 'utf8')).toBe(FULL_MD)
    const restoredFig = join(result.dataDir, 'papers', String(a), 'mineru', 'images', 'fig1.png')
    expect(existsSync(restoredFig)).toBe(true)
    expect(readFileSync(restoredFig).equals(FIG_PNG)).toBe(true)

    // 2) .env 被排除（D76/D98）
    expect(existsSync(join(result.dataDir, '.env'))).toBe(false)

    // 3) 恢复后 D95 自动补排：A 已成功且 PDF 哈希未变 → 不重新排队；
    //    B 从未入队 → 补排；C 终态失败（D53）→ 不自动重排
    const restored = openDatabase(join(result.dataDir, 'graphictero.db'))
    try {
      const enqueued = backfillProcessJobs(restored, result.dataDir, availableParser)
      expect(enqueued).toHaveLength(1)
      const queued = restored
        .prepare("SELECT paper_id FROM jobs WHERE kind = 'process_paper' AND status = 'queued'")
        .all() as Array<{ paper_id: number }>
      expect(queued.map((r) => r.paper_id)).toEqual([b])
      // C 仍只有原来那条 failed_action（没有新任务）
      const cJobs = restored
        .prepare("SELECT status FROM jobs WHERE kind = 'process_paper' AND paper_id = ?")
        .all(c) as Array<{ status: string }>
      expect(cJobs).toEqual([{ status: 'failed_action' }])
      // A 仍只有原来那条 succeeded
      const aJobs = restored
        .prepare("SELECT status FROM jobs WHERE kind = 'process_paper' AND paper_id = ?")
        .all(a) as Array<{ status: string }>
      expect(aJobs).toEqual([{ status: 'succeeded' }])
    } finally {
      restored.close()
    }
  })
})
