import type Database from 'better-sqlite3'
import type { OpenAlexClient } from '../openalex/client'
import { BadRequestLlmError, NetworkLlmError, RetryableLlmError } from '../llm/errors'
import type { PdfSources } from '../../shared/ipc/cand'
import { arxivPdfUrl } from './arxiv'
import { openAlexOaUrl } from './oa'
import { unpaywallOaUrl } from './unpaywall'
import { customTemplateUrl } from './customTemplate'
import { recordPdfAttempt, type PdfAttemptResult } from './attempts'

/**
 * lane/fetch 批 1：PDF 查找链（m6_plan §3.1「chain.ts」；D54/D131/D133）。
 *
 * - 按设置里的来源顺序执行，找到第一条链接即停（后面的来源等这条下载失败再问）；
 * - 「开放获取」内建链展开为 arXiv → OpenAlex → Unpaywall 固定子顺序（D131）；
 * - 每个来源写一行 pdf_attempts（not_found / error / ok，ok 由下载端补写）；
 * - 自定义模板的 BadRequest（SSRF）记 error 后继续，不丢掉已经找到的链接；
 * - 网络类错误原样抛出（runner 进 waiting_network / 自动重试），不被后面的内容错误覆盖；
 * - 只有「干净的全 not_found」或「有链接但全是内容错误」才是无 PDF 路径（D54/D85）。
 *   来源里只有非法模板、没有任何干净未命中时，抛 BadRequest（failed_action）。
 */

export interface LocatedPdf {
  /** arxiv / openalex / unpaywall / custom:<host>（PdfAttemptView.source 同口径） */
  source: string
  url: string
}

export interface LocatePdfInput {
  db: Database.Database
  paperId: number
  doi: string | null
  arxivId: string | null
  openalexWid: string | null
  /** 检索时缓存的 best_oa_location（任务 payload 传来） */
  cachedOaUrl?: string | null
  settings: PdfSources
  openAlex: OpenAlexClient
  fetchImpl?: typeof fetch
}

export interface PdfSourceSpec {
  source: string
  kind: 'open_access' | 'custom'
  template?: string
}

/** 一次查找的游标。next 是下一个还没问过的来源下标。 */
export interface PdfWalk {
  input: LocatePdfInput
  sources: PdfSourceSpec[]
  next: number
  sawCleanMiss: boolean
  badRequest: BadRequestLlmError | null
}

/** 设置项 → 有序子来源列表（open_access 展开为内建三链，D131） */
export function expandSources(settings: PdfSources): PdfSourceSpec[] {
  const out: PdfSourceSpec[] = []
  for (const item of settings.sources) {
    if (!item.enabled) continue
    if (item.kind === 'open_access') {
      out.push({ source: 'arxiv', kind: 'open_access' }, { source: 'openalex', kind: 'open_access' }, { source: 'unpaywall', kind: 'open_access' })
    } else if (item.template) {
      let host = 'custom'
      try {
        host = new URL(item.template).hostname
      } catch {
        // 模板非法：下载端会拒，这里仍按顺序占位
      }
      out.push({ source: `custom:${host}`, kind: 'custom', template: item.template })
    }
  }
  return out
}

export function startPdfWalk(input: LocatePdfInput, fromIndex = 0): PdfWalk {
  return {
    input,
    sources: expandSources(input.settings),
    next: fromIndex,
    sawCleanMiss: false,
    badRequest: null
  }
}

/**
 * 拉下一条可用链接。
 * - 命中：next 移到该来源之后，返回链接（调用方下载失败后再拉）；
 * - not_found：记一行，继续；
 * - BadRequest（坏模板 / SSRF）：记 error，继续，不丢已经拿到的链接；
 * - 网络 / 可重试：记 error，不前进游标，原样抛出（重试会再问同一个来源）。
 */
export async function pullNextPdf(walk: PdfWalk): Promise<LocatedPdf | null> {
  const { db, paperId } = walk.input
  const attempt = (source: string, result: PdfAttemptResult, url?: string | null): void => {
    recordPdfAttempt(db, paperId, source, result, url)
  }
  while (walk.next < walk.sources.length) {
    const src = walk.sources[walk.next]
    if (!src) break
    try {
      let url: string | null = null
      if (src.source === 'arxiv') {
        url = walk.input.arxivId ? arxivPdfUrl(walk.input.arxivId) : null
      } else if (src.source === 'openalex') {
        url = await openAlexOaUrl(walk.input.openAlex, {
          doi: walk.input.doi,
          openalexWid: walk.input.openalexWid,
          cachedOaUrl: walk.input.cachedOaUrl
        })
      } else if (src.source === 'unpaywall') {
        const email = walk.input.settings.unpaywallEmail?.trim()
        url = walk.input.doi && email ? await unpaywallOaUrl(walk.input.doi, email, { fetchImpl: walk.input.fetchImpl }) : null
      } else if (src.kind === 'custom' && src.template) {
        url = customTemplateUrl(src.template, walk.input.doi)
      }
      if (url) {
        walk.next += 1
        return { source: src.source, url }
      }
      attempt(src.source, 'not_found')
      walk.sawCleanMiss = true
      walk.next += 1
    } catch (e) {
      if (e instanceof NetworkLlmError || e instanceof RetryableLlmError) {
        attempt(src.source, 'error')
        throw e
      }
      if (e instanceof BadRequestLlmError) {
        attempt(src.source, 'error')
        walk.badRequest = e
        walk.next += 1
        continue
      }
      throw e
    }
  }
  return null
}

/** 找到第一条链接即返回。全未命中返回 []；只有非法模板时抛 BadRequest。 */
export async function locatePdfUrls(input: LocatePdfInput): Promise<LocatedPdf[]> {
  const walk = startPdfWalk(input)
  const first = await pullNextPdf(walk)
  if (first) return [first]
  if (walk.badRequest && !walk.sawCleanMiss) throw walk.badRequest
  return []
}
