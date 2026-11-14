import type Database from 'better-sqlite3'
import { PdfSourcesSchema, type PdfSources } from '../../shared/ipc/cand'
import { readOpenAlexSettings } from '../openalex/env'

/**
 * lane/fetch 批 1：「PDF 来源」设置存取（D54/D131；契约 src/shared/ipc/cand.ts）。
 *
 * - 存 app_settings kv（key 'pdf_sources'，JSON；非敏感）；
 * - 默认只开「开放获取」（arXiv → OpenAlex → Unpaywall 内建链），自定义来源默认空（D54）；
 * - Unpaywall 邮箱默认取 .env 的 OPENALEX_MAILTO（D131），设置页可改后存 kv 优先。
 */

const KEY = 'pdf_sources'

/**
 * D140：设置里的 Unpaywall 邮箱留空 = 回退数据目录里的 OPENALEX_MAILTO，不是跳过。
 * 两者都没有才不带邮箱（查找链会跳过 Unpaywall 并记 not_found）。
 * `env` 只给测试注入；不传时才读数据目录环境文件。
 */
function resolveMailto(dataDir: string, env?: { mailto: string | null }): string | null {
  if (env) return env.mailto?.trim() || null
  return readOpenAlexSettings(dataDir).mailto?.trim() || null
}

function withMailto(parsed: PdfSources, mailto: string | null): PdfSources {
  const explicit = parsed.unpaywallEmail?.trim()
  if (explicit) return { ...parsed, unpaywallEmail: explicit }
  const { unpaywallEmail: _blank, ...rest } = parsed
  return mailto ? { ...rest, unpaywallEmail: mailto } : rest
}

export function getPdfSources(db: Database.Database, dataDir: string, env?: { mailto: string | null }): PdfSources {
  const mailto = resolveMailto(dataDir, env)
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(KEY) as { value: string } | undefined
  if (row) {
    try {
      return withMailto(PdfSourcesSchema.parse(JSON.parse(row.value)), mailto)
    } catch {
      // 存量值坏掉/不合契约：回落默认（不抛，设置页总能打开）
    }
  }
  return withMailto({ sources: [{ kind: 'open_access', enabled: true }] }, mailto)
}

export function setPdfSources(db: Database.Database, input: PdfSources): void {
  const value = PdfSourcesSchema.parse(input) // 双保险：IPC 层已校验，服务层再锁一次口径
  db.prepare(
    'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).run(KEY, JSON.stringify(value), new Date().toISOString())
}
