import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { extractAbstract, generateCard, isReasonableAbstract, normalizeKeyword } from './card'
import { startStubLlm, type StubLlm, type StubBehavior } from './stubServer'

/**
 * 名片后处理测试（D39/D45/D46）：Abstract 提取与判定、AI 摘要兜底标「AI 生成」、
 * 一句话摘要、关键词归一化与落库。LLM 全部走本地 stub。
 */

const ABSTRACT_TEXT =
  'This paper presents a novel approach to graph reasoning with language models. ' +
  'We describe the method, the datasets used for evaluation, and extensive experiments ' +
  'that demonstrate consistent improvements over strong baselines on three benchmarks.'

const MD_WITH_ABSTRACT = `# My Paper\n\n## Abstract\n\n${ABSTRACT_TEXT}\n\n## 1. Introduction\n\nIntro text.\n`
const MD_INLINE_ABSTRACT = `# My Paper\n\nAbstract: ${ABSTRACT_TEXT}\n\n# Introduction\n\nIntro text.\n`
const MD_NO_ABSTRACT = `# My Paper\n\n## 1. Introduction\n\nNo abstract section here at all.\n`
const MD_SHORT_ABSTRACT = `# My Paper\n\n## Abstract\n\nToo short.\n\n## Body\n\nText.\n`

let dir: string
let db: Database.Database
let stub: StubLlm | null = null

function insertPaper(title: string): number {
  const now = new Date().toISOString()
  const r = db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES (?, 'zotero', 1, ?, ?)").run(title, now, now)
  return Number(r.lastInsertRowid)
}

async function cardWith(behaviors: StubBehavior[], paperId: number, markdown: string) {
  stub = await startStubLlm(behaviors)
  const llm = () => ({ baseUrl: stub!.baseUrl, apiKey: 'k', model: 'deepseek-flash' })
  return generateCard({ db, paperId, markdown, llm, now: () => new Date('2026-10-26T12:00:00Z') })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-card-'))
  db = openDatabase(join(dir, 'graphictero.db'))
  runMigrations(db, MIGRATIONS)
})

afterEach(async () => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
  await stub?.close()
  stub = null
})

describe('extractAbstract / isReasonableAbstract（D39/D46）', () => {
  it('标题式 Abstract 段：提取到下一标题为止', () => {
    expect(extractAbstract(MD_WITH_ABSTRACT)).toBe(ABSTRACT_TEXT)
  })
  it('「Abstract: 正文」同行形式', () => {
    expect(extractAbstract(MD_INLINE_ABSTRACT)).toBe(ABSTRACT_TEXT)
  })
  it('没有 Abstract 段返回 null；过短判定为不合理', () => {
    expect(extractAbstract(MD_NO_ABSTRACT)).toBeNull()
    expect(isReasonableAbstract('Too short.')).toBe(false)
    expect(isReasonableAbstract(ABSTRACT_TEXT)).toBe(true)
  })
  it('中文「摘要」标题也可提取', () => {
    const md = '# 标题\n\n## 摘要\n\n' + '这是一段足够长的中文摘要，介绍本文提出的方法、实验设置与主要结果，覆盖背景动机与贡献。'.repeat(2) + '\n\n## 引言\n\n正文。\n'
    const abs = extractAbstract(md)
    expect(abs).toContain('这是一段足够长的中文摘要')
    expect(isReasonableAbstract(abs!)).toBe(true)
  })
})

describe('generateCard（D45/D46）', () => {
  it('Abstract 正常：用原文（abstract_source=original），只做一句话摘要+关键词两次 LLM 调用', async () => {
    const pid = insertPaper('Graph Reasoning')
    const r = await cardWith(
      [{ kind: 'ok', text: '提出图推理新方法。' }, { kind: 'ok', text: '["Graph Reasoning", " RL ", "graph reasoning"]' }],
      pid,
      MD_WITH_ABSTRACT
    )
    expect(r.abstractSource).toBe('original')
    expect(r.abstract).toBe(ABSTRACT_TEXT)
    expect(r.oneLiner).toBe('提出图推理新方法。')
    expect(r.keywords).toEqual(['graph reasoning', 'rl']) // 归一化 + 去重（D74 最小口径）
    expect(stub!.requests).toHaveLength(2)

    const row = db.prepare('SELECT abstract_source, one_liner FROM papers WHERE id = ?').get(pid) as Record<string, unknown>
    expect(row.abstract_source).toBe('original')
    expect(row.one_liner).toBe('提出图推理新方法。')
    const kws = db.prepare('SELECT keyword FROM paper_keywords WHERE paper_id = ? ORDER BY keyword').all(pid) as Array<{ keyword: string }>
    expect(kws.map((k) => k.keyword)).toEqual(['graph reasoning', 'rl'])
    // 记账：2 次调用、类别 card、thinking 开（D58/D92）
    const usage = db.prepare("SELECT category, thinking, cost_cny FROM usage_records WHERE paper_id = ?").all(pid) as Array<Record<string, unknown>>
    expect(usage).toHaveLength(2)
    expect(usage.every((u) => u.category === 'card' && u.thinking === 1 && (u.cost_cny as number) > 0)).toBe(true)
  })

  it('Abstract 提取失败：AI 生成摘要并标「AI 生成」（D46），不冒充原文', async () => {
    const pid = insertPaper('No Abstract Paper')
    const aiAbstract = '本文提出一种图学习方法，在两个数据集上验证了有效性。'
    const r = await cardWith(
      [{ kind: 'ok', text: aiAbstract }, { kind: 'ok', text: '一句话。' }, { kind: 'ok', text: '["gnn"]' }],
      pid,
      MD_NO_ABSTRACT
    )
    expect(r.abstractSource).toBe('ai')
    expect(r.abstract).toBe(aiAbstract)
    const row = db.prepare('SELECT abstract_source FROM papers WHERE id = ?').get(pid) as { abstract_source: string }
    expect(row.abstract_source).toBe('ai')
    expect(stub!.requests).toHaveLength(3) // 多了一次 AI 摘要调用
  })

  it('Abstract 过短视为不合理，走 AI 兜底', async () => {
    const pid = insertPaper('Short Abstract')
    const r = await cardWith(
      [{ kind: 'ok', text: 'AI 摘要内容。' }, { kind: 'ok', text: '一句话。' }, { kind: 'ok', text: '[]' }],
      pid,
      MD_SHORT_ABSTRACT
    )
    expect(r.abstractSource).toBe('ai')
  })

  it('AI 摘要为空时不覆盖已有摘要，FTS 仍能搜到原词（D134 bug5）', async () => {
    const pid = insertPaper('Keep Abstract')
    const kept = 'm6fixUniqueAbstractToken 来自 OpenAlex 的摘要，足够长，不能被空的 AI 结果盖掉。'
    db.prepare("UPDATE papers SET abstract = ?, abstract_source = 'openalex' WHERE id = ?").run(kept, pid)
    const r = await cardWith(
      [{ kind: 'ok', text: '   ' }, { kind: 'ok', text: '一句话。' }, { kind: 'ok', text: '[]' }],
      pid,
      MD_NO_ABSTRACT
    )
    expect(r.abstract).toBe(kept)
    expect(r.abstractSource).toBe('openalex')
    const row = db.prepare('SELECT abstract, abstract_source FROM papers WHERE id = ?').get(pid) as {
      abstract: string
      abstract_source: string
    }
    expect(row).toEqual({ abstract: kept, abstract_source: 'openalex' })
    const fts = db.prepare('SELECT abstract_seg FROM papers_fts WHERE rowid = ?').get(pid) as { abstract_seg: string }
    expect(fts.abstract_seg).toContain('m6fixuniqueabstracttoken')
  })

  it('normalizeKeyword：小写、合并空白、去首尾标点', () => {
    expect(normalizeKeyword('  Deep Learning ')).toBe('deep learning')
    expect(normalizeKeyword('"RL；"。')).toBe('rl')
  })
})
