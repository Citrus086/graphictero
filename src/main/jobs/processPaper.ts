import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { ParseProgressView } from '../../shared/ipc/pdf'
import { generateCard } from '../llm/card'
import { generateDetail } from '../llm/detail'
import type { LlmClientDeps } from '../llm/client'
import { BadRequestLlmError, ParseStepError } from '../llm/errors'
import type { PaperParser } from './mineru'
import { indexFullTextFts } from '../db/fulltextFts'

/**
 * process_paper 任务的三个步骤（D67/D85：解析 + 名片 + 详情 = 一篇论文一个任务）。
 * 步骤间经磁盘传递：解析把 MinerU 输出写进 <数据目录>/papers/<id>/mineru/，
 * 名片 / 详情步骤从那里读（与将来接真 MinerU sidecar 同一路径约定，D23）。
 */

export interface ProcessPaperCtx {
  db: Database.Database
  dataDir: string
  paperId: number
  parser: PaperParser
  llm: () => LlmClientDeps
  now: () => Date
  /** 解析进度回调（runner 注入；IPC 层据此广播 event:pdf:parseProgress） */
  onProgress?: (p: ParseProgressView) => void
  /** D42/D108：detail_regen 任务置 true，详情步骤绕过「版本+哈希未变跳过」强制覆盖 */
  forceDetail?: boolean
  /** D142：候选链带进来的会话；没有则名片/详情不归任何会话 */
  sessionId?: number | null
}

export function paperDir(dataDir: string, paperId: number): string {
  return join(dataDir, 'papers', String(paperId))
}

export function mineruMarkdownPath(dataDir: string, paperId: number): string {
  return join(paperDir(dataDir, paperId), 'mineru', 'full.md')
}

/**
 * Q5 缓存短路（D98「恢复后无需重新解析」）：mineru/full.md 存在且当前 PDF 哈希与
 * paper_details.pdf_hash 一致（即上次解析用的就是当前这份 PDF）→ 跳过 MinerU 解析。
 * 哈希不一致或缓存缺失返回 false，照常解析。
 */
function parseCacheMatches(ctx: ProcessPaperCtx, pdfPath: string): boolean {
  if (!existsSync(mineruMarkdownPath(ctx.dataDir, ctx.paperId))) return false
  const detail = ctx.db.prepare('SELECT pdf_hash FROM paper_details WHERE paper_id = ?').get(ctx.paperId) as
    | { pdf_hash: string | null }
    | undefined
  if (!detail?.pdf_hash) return false
  const currentHash = createHash('sha256').update(readFileSync(pdfPath)).digest('hex')
  return detail.pdf_hash === currentHash
}

/** 步骤 1：MinerU 解析（手动重试步骤，D85；本批 parser 是可注入假实现占位） */
export async function runParseStep(ctx: ProcessPaperCtx): Promise<void> {
  const paper = ctx.db.prepare('SELECT has_pdf FROM papers WHERE id = ? AND deleted_at IS NULL').get(ctx.paperId) as
    | { has_pdf: number }
    | undefined
  if (!paper) throw new ParseStepError(`论文 ${ctx.paperId} 不存在或已删除`)
  if (paper.has_pdf !== 1) throw new ParseStepError('该论文没有 PDF（无 PDF 论文不参与解析，D62）')
  const pdfPath = join(paperDir(ctx.dataDir, ctx.paperId), 'paper.pdf')
  // D134 bug4：文件没了重试也没用，进 failed_action，backfill 不再反复重排
  if (!existsSync(pdfPath)) {
    throw new BadRequestLlmError('找不到 PDF 文件（papers/' + ctx.paperId + '/paper.pdf）', 400)
  }
  if (parseCacheMatches(ctx, pdfPath)) return // Q5：缓存命中，直接进入名片/详情步骤
  const outDir = join(paperDir(ctx.dataDir, ctx.paperId), 'mineru')
  mkdirSync(outDir, { recursive: true })
  const result = await ctx.parser.parse(pdfPath, outDir, ctx.onProgress)
  writeFileSync(join(outDir, 'full.md'), result.markdown, 'utf8')
  // uat3b 必须修 2：原文写盘即重建全文索引（searchLibrary 原文检索用，迁移 082）
  indexFullTextFts(ctx.db, ctx.paperId, result.markdown)
}

/**
 * 读解析产物 full.md。缺失时给中文原因（评审建 6：不直曝 ENOENT）；
 * 抛 ParseStepError → 只手动重试，不烧 LLM 自动重试次数。
 */
function readMineruMarkdown(ctx: ProcessPaperCtx): string {
  const p = mineruMarkdownPath(ctx.dataDir, ctx.paperId)
  if (!existsSync(p)) {
    throw new ParseStepError(
      `解析结果不存在（papers/${ctx.paperId}/mineru/full.md）：解析步骤尚未成功或结果文件已被删除，请在任务状态里手动重试`
    )
  }
  return readFileSync(p, 'utf8')
}

/** 步骤 2：名片后处理（D39/D45/D46：Abstract 判定 + 一句话摘要 + 关键词） */
export async function runCardStep(ctx: ProcessPaperCtx): Promise<void> {
  const markdown = readMineruMarkdown(ctx)
  await generateCard({
    db: ctx.db,
    paperId: ctx.paperId,
    markdown,
    llm: ctx.llm,
    now: ctx.now,
    sessionId: ctx.sessionId ?? null
  })
}

/** 步骤 3：详情生成（D67；先按 UIMessage parts 存储，渲染在 M4） */
export async function runDetailStep(ctx: ProcessPaperCtx): Promise<void> {
  const markdown = readMineruMarkdown(ctx)
  const pdfPath = join(paperDir(ctx.dataDir, ctx.paperId), 'paper.pdf')
  const pdfHash = existsSync(pdfPath) ? createHash('sha256').update(readFileSync(pdfPath)).digest('hex') : null
  await generateDetail({
    db: ctx.db,
    paperId: ctx.paperId,
    markdown,
    pdfHash,
    llm: ctx.llm,
    now: ctx.now,
    force: ctx.forceDetail === true,
    sessionId: ctx.sessionId ?? null
  })
}
