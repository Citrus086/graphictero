import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'

/**
 * LLM 设置（D12/D25/D34）。
 *
 * - 服务商 / 模型：app_settings（kv），非敏感；
 * - API Key：数据目录下的 .env（D34），绝不进库、不进日志、不进备份
 *   （备份排除 .env 见 fullBackup.ts）。读写只动目标行，其余行原样保留
 *   （OPENALEX_API_KEY 等共用同一文件）。
 */

export const DEFAULT_LLM_PROVIDER = 'deepseek'
export const DEFAULT_LLM_MODEL = 'deepseek-flash'
export const KNOWN_MODELS = ['deepseek-flash', 'deepseek-v4-pro'] as const

/** 服务商 baseUrl 注册表（本批只有 DeepSeek，D12；测试可指向本地 stub） */
export const PROVIDER_BASE_URLS: Record<string, string> = {
  deepseek: 'https://api.deepseek.com'
}

/** .env 里各服务商的 Key 名 */
export const PROVIDER_KEY_NAMES: Record<string, string> = {
  deepseek: 'DEEPSEEK_API_KEY'
}

/**
 * e2e/stub 测试缝（chat→main 合并批清单①）：设 GRAPHICTERO_LLM_BASE_URL 时覆盖所有
 * provider 的 baseUrl，主进程 LLM 出口统一经此解析。生产/日常使用不设该变量，
 * 行为与直读 PROVIDER_BASE_URLS 完全一致；真实 IPC e2e（scripts/run-agent-e2e.mjs →
 * src/main/agentE2e.ts）用它把 agent 运行时指到本地 stubServer，绝不触碰真实 DeepSeek。
 */
export function providerBaseUrl(provider: string): string {
  return process.env.GRAPHICTERO_LLM_BASE_URL || PROVIDER_BASE_URLS[provider] || PROVIDER_BASE_URLS[DEFAULT_LLM_PROVIDER]
}

export interface LlmSettings {
  provider: string
  model: string
  /** 只返回是否已配置，绝不返回 Key 本体（不入库明文日志） */
  hasApiKey: boolean
  /** 已配置且长度 ≥ 4 时的末 4 位；否则 null。不是 Key 本体。 */
  keyTail: string | null
}

const nowIso = (): string => new Date().toISOString()

export function getLlmSettings(db: Database.Database, dataDir: string): LlmSettings {
  const rows = db.prepare("SELECT key, value FROM app_settings WHERE key IN ('llm_provider', 'llm_model')").all() as Array<{
    key: string
    value: string
  }>
  const kv = new Map(rows.map((r) => [r.key, r.value]))
  const provider = kv.get('llm_provider') || DEFAULT_LLM_PROVIDER
  const key = readApiKey(dataDir, provider)
  return {
    provider,
    model: kv.get('llm_model') || DEFAULT_LLM_MODEL,
    hasApiKey: key != null,
    keyTail: keyTail(key)
  }
}

export function setLlmSettings(db: Database.Database, provider: string, model: string): void {
  if (!PROVIDER_BASE_URLS[provider]) throw new Error(`未知的服务商：${provider}`)
  if (!model.trim()) throw new Error('模型不能为空')
  const now = nowIso()
  const up = db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
  const tx = db.transaction(() => {
    up.run('llm_provider', provider, now)
    up.run('llm_model', model.trim(), now)
  })
  tx()
}

/** 末 4 位，供渲染端掩码。短于 4 位或未配置返回 null，绝不返回全文。 */
export function keyTail(value: string | null): string | null {
  if (!value || value.length < 4) return null
  return value.slice(-4)
}

/**
 * 从数据目录 .env 读指定变量。只解析目标行，空值视为未配置。
 * 调用方不得把返回值打进日志或回传渲染进程。
 */
export function readEnvValue(dataDir: string, name: string): string | null {
  const path = join(dataDir, '.env')
  if (!existsSync(path)) return null
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && m[1] === name) {
      const v = m[2].trim().replace(/^["']|["']$/g, '')
      return v || null
    }
  }
  return null
}

/**
 * 写数据目录 .env 的一行：只替换目标行 / 追加，其余行原样保留。
 * 传空串 = 删除该行。调用方与日志绝不打印 value。
 */
export function writeEnvValue(dataDir: string, name: string, value: string): void {
  const path = join(dataDir, '.env')
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : []
  let replaced = false
  const out: string[] = []
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/)
    if (m && m[1] === name) {
      replaced = true
      if (value) out.push(`${name}=${value}`)
      continue
    }
    out.push(line)
  }
  if (!replaced && value) {
    if (out.length > 0 && out[out.length - 1] !== '') out.push('')
    out.push(`${name}=${value}`)
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  writeFileSync(path, out.join('\n') + (out.length > 0 ? '\n' : ''), { mode: 0o600 })
}

/** 从数据目录 .env 读指定服务商的 API Key；不存在返回 null。 */
export function readApiKey(dataDir: string, provider: string = DEFAULT_LLM_PROVIDER): string | null {
  const name = PROVIDER_KEY_NAMES[provider] ?? 'DEEPSEEK_API_KEY'
  return readEnvValue(dataDir, name)
}

/**
 * 写 API Key 进数据目录 .env：只替换目标行 / 追加，其余行原样保留。
 * 传空串 = 删除该 Key 行。注意：调用方与日志绝不打印 value。
 * 设置页不再用空串保存来清除（uat8c：清除走单独 IPC）；本函数仍是删除原语。
 */
export function writeApiKey(dataDir: string, provider: string, value: string): void {
  const name = PROVIDER_KEY_NAMES[provider] ?? 'DEEPSEEK_API_KEY'
  writeEnvValue(dataDir, name, value)
}
