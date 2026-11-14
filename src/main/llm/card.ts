import type Database from 'better-sqlite3'
import { indexPaperFts } from '../db/fts'
import { DEEPSEEK_FLASH_MAX_OUTPUT, streamChat, type LlmClientDeps, type LlmStreamResult } from './client'
import { AI_ABSTRACT_PROMPT, KEYWORDS_PROMPT, ONE_LINER_PROMPT } from './prompts'
import { stripInlineImages } from '../text/stripInlineImages'
import { recordUsage } from './usage'

/**
 * 名片后处理（D39/D45/D46）：解析完成即跑。
 * 1. 摘要原文提取与 Abstract 判定（D39/D46）：从 MinerU Markdown 提取 Abstract 段；
 *    提取不到或不合理（过短/过长，判定规则为【建议】阈值）→ AI 生成 ≤ 1k token
 *    摘要并标「AI 生成」（abstract_source='ai'），不冒充原文；
 * 2. 一句话摘要（D45，图上悬停 / Agent 快速上下文）；
 * 3. 关键词标签（D45/D40(b)，归一化后进 paper_keywords + FTS5，D74）。
 */

export interface CardResult {
  abstract: string
  abstractSource: 'original' | 'ai' | 'openalex'
  oneLiner: string
  keywords: string[]
}

// D46「过短 / 过长」判定规则（文档为【建议】，取保守阈值）：
// 词数 < 30 或 > 1200（英文按词、中文按字粗略折算）视为不合理
const ABSTRACT_MIN_WORDS = 30
const ABSTRACT_MAX_WORDS = 1200

/** 从 MinerU Markdown 提取 Abstract 段：标题行（#/Abstract/摘要/ABSTRACT）到下一标题。 */
export function extractAbstract(markdown: string): string | null {
  const lines = markdown.split('\n')
  let start = -1
  let inlineFirst = ''
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim().replace(/^#{1,6}\s*/, '').replace(/[*_]/g, '').trim()
    if (/^(abstract|摘\s*要)\s*$/i.test(t)) {
      start = i + 1
      break
    }
    const m = t.match(/^(abstract|摘\s*要)\s*[:：.]\s*(\S[\s\S]*)$/i)
    if (m) {
      start = i + 1
      inlineFirst = m[2]
      break
    }
  }
  if (start === -1) return null
  const body: string[] = []
  if (inlineFirst) body.push(inlineFirst)
  for (let i = start; i < lines.length; i++) {
    const t = lines[i]
    if (/^\s*#{1,6}\s+\S/.test(t)) break // 下一个标题结束
    if (/^\s*(1\.?\s+)?(introduction|引\s*言|绪\s*论)\s*$/i.test(t.trim())) break // 无标题正文的常见分界
    body.push(t)
  }
  const text = body.join('\n').trim()
  return text || null
}

/** Abstract 合理性判定（D46，规则为【建议】）：词数折算后落在 [30, 1200]。 */
export function isReasonableAbstract(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  const latinWords = (trimmed.match(/[A-Za-z0-9'-]+/g) ?? []).length
  const cjkChars = (trimmed.match(/[一-鿿]/g) ?? []).length
  const words = latinWords + cjkChars / 2 // 中文两字折算一「词」
  return words >= ABSTRACT_MIN_WORDS && words <= ABSTRACT_MAX_WORDS
}

/** 关键词归一化（D74 口径的最小实现：小写、合并空白、去首尾标点）。 */
export function normalizeKeyword(k: string): string {
  return k.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^["'`.,;；，。]+|["'`.,;；，。]+$/g, '')
}

function parseKeywordsJson(text: string): string[] {
  const m = text.match(/\[[\s\S]*\]/)
  if (!m) return []
  try {
    const arr = JSON.parse(m[0]) as unknown[]
    return arr.filter((x): x is string => typeof x === 'string').map(normalizeKeyword).filter(Boolean)
  } catch {
    return []
  }
}

export interface CardDeps {
  db: Database.Database
  paperId: number
  markdown: string
  llm: () => LlmClientDeps // 取当前 Key/模型（缺 Key 时调用方已拦在 waiting_key）
  now?: () => Date
  /** D142：该会话触发的名片记到会话后台；与会话无关（Zotero / 手动）留空 */
  sessionId?: number | null
  onUsage?: (r: LlmStreamResult, kind: 'abstract' | 'oneLiner' | 'keywords') => void
}

/**
 * 生成名片（摘要 + 一句话摘要 + 关键词标签），写回 papers / paper_keywords / FTS。
 */
export async function generateCard(deps: CardDeps): Promise<CardResult> {
  const { db, paperId } = deps
  const markdown = stripInlineImages(deps.markdown)
  const now = (): Date => deps.now?.() ?? new Date()
  const paper = db.prepare('SELECT title FROM papers WHERE id = ?').get(paperId) as { title: string } | undefined
  if (!paper) throw new Error(`论文 ${paperId} 不存在`)

  const usageOf = async (
    kind: 'abstract' | 'oneLiner' | 'keywords',
    prompt: { system: string },
    user: string
  ): Promise<string> => {
    const llm = deps.llm()
    const r = await streamChat(
      { ...llm, maxOutputTokens: DEEPSEEK_FLASH_MAX_OUTPUT }, // D100：不设低固定上限
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: user }
      ]
    )
    recordUsage(db, {
      category: 'card',
      paperId,
      sessionId: deps.sessionId ?? null,
      model: llm.model,
      usage: r.usage,
      at: now(),
      thinking: true
    })
    deps.onUsage?.(r, kind)
    return r.text.trim()
  }

  // 1. Abstract 判定（D46）
  const extracted = extractAbstract(markdown)
  let abstract: string
  let abstractSource: 'original' | 'ai' | 'openalex'
  if (extracted && isReasonableAbstract(extracted)) {
    abstract = extracted
    abstractSource = 'original'
  } else {
    abstract = await usageOf('abstract', AI_ABSTRACT_PROMPT, `论文标题：${paper.title}\n\n正文：\n${markdown}`)
    abstractSource = 'ai' // 标「AI 生成」，不冒充原文（D46）
  }

  // 2. 一句话摘要（D45）
  const oneLiner = await usageOf('oneLiner', ONE_LINER_PROMPT, `标题：${paper.title}\n摘要：${abstract}`)

  // 3. 关键词标签（D45）
  const kwText = await usageOf('keywords', KEYWORDS_PROMPT, `标题：${paper.title}\n摘要：${abstract}`)
  const keywords = [...new Set(parseKeywordsJson(kwText))].slice(0, 12)

  const iso = now().toISOString()
  // D134 bug5：名片拿不到摘要时，不得用空值盖掉入库时已写入的摘要
  const prev = db.prepare('SELECT abstract, abstract_source FROM papers WHERE id = ?').get(paperId) as
    | { abstract: string | null; abstract_source: string | null }
    | undefined
  if (!abstract.trim() && prev?.abstract?.trim()) {
    abstract = prev.abstract
    if (prev.abstract_source === 'original' || prev.abstract_source === 'ai' || prev.abstract_source === 'openalex') {
      abstractSource = prev.abstract_source
    }
  }
  const tx = db.transaction(() => {
    db.prepare('UPDATE papers SET abstract = ?, abstract_source = ?, one_liner = ?, updated_at = ? WHERE id = ?').run(
      abstract,
      abstractSource,
      oneLiner,
      iso,
      paperId
    )
    db.prepare('DELETE FROM paper_keywords WHERE paper_id = ?').run(paperId)
    const ins = db.prepare('INSERT OR IGNORE INTO paper_keywords (paper_id, keyword) VALUES (?, ?)')
    for (const k of keywords) ins.run(paperId, k)
    indexPaperFts(db, paperId, { title: paper.title, abstract, keywords })
  })
  tx()
  return { abstract, abstractSource, oneLiner, keywords }
}
