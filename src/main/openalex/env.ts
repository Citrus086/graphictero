import { keyTail, readEnvValue, writeEnvValue } from '../llm/config'

/**
 * OpenAlex 的 .env 读取（D34/D71：Key 与 mailto 存数据目录 .env，不进库/日志/备份）。
 * 与 DeepSeek Key 共用 readEnvValue / writeEnvValue（只改目标行）。
 * 不走 readApiKey：那个按服务商名查 PROVIDER_KEY_NAMES，OpenAlex 不在其中会回落到 DEEPSEEK_API_KEY。
 */

export const OPENALEX_API_KEY_NAME = 'OPENALEX_API_KEY'
export const OPENALEX_MAILTO_NAME = 'OPENALEX_MAILTO'

export interface OpenAlexSettings {
  apiKey: string | null
  mailto: string | null
}

/** 渲染进程可见的状态：已配置与否 + 末 4 位。不含明文。 */
export interface OpenAlexKeyStatus {
  configured: boolean
  tail: string | null
}

export function readOpenAlexSettings(dataDir: string): OpenAlexSettings {
  return {
    apiKey: readEnvValue(dataDir, OPENALEX_API_KEY_NAME),
    mailto: readEnvValue(dataDir, OPENALEX_MAILTO_NAME)
  }
}

export function openAlexKeyStatus(dataDir: string): OpenAlexKeyStatus {
  const apiKey = readEnvValue(dataDir, OPENALEX_API_KEY_NAME)
  return { configured: apiKey != null, tail: keyTail(apiKey) }
}

/** 空串删除该行。调用方不得记录 value。 */
export function writeOpenAlexApiKey(dataDir: string, value: string): void {
  writeEnvValue(dataDir, OPENALEX_API_KEY_NAME, value)
}
