import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keyTail, readEnvValue, writeEnvValue } from './config'
import { openAlexKeyStatus, writeOpenAlexApiKey } from '../openalex/env'

/** 不含 sk- 长串，避免整段 diff 的密钥扫描误伤。 */
const DEEPSEEK = 'ds-dummy-key-abcd'
const OPENALEX = 'oa-dummy-key-zzzz'
const OPENALEX_NEXT = 'oa-dummy-key-yyyy'
const MAIL = 'name@example.com'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-env-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('数据目录 .env 只改目标行', () => {
  it('改 OpenAlex 不动 DeepSeek 与 mailto，渲染端只有末 4 位', () => {
    writeEnvValue(dir, 'DEEPSEEK_API_KEY', DEEPSEEK)
    writeEnvValue(dir, 'OPENALEX_API_KEY', OPENALEX)
    writeEnvValue(dir, 'OPENALEX_MAILTO', MAIL)
    writeEnvValue(dir, 'OPENALEX_API_KEY', OPENALEX_NEXT)

    expect(readEnvValue(dir, 'DEEPSEEK_API_KEY')).toBe(DEEPSEEK)
    expect(readEnvValue(dir, 'OPENALEX_MAILTO')).toBe(MAIL)
    expect(readEnvValue(dir, 'OPENALEX_API_KEY')).toBe(OPENALEX_NEXT)

    const status = openAlexKeyStatus(dir)
    expect(status).toEqual({ configured: true, tail: 'yyyy' })
    expect(Object.keys(status).sort()).toEqual(['configured', 'tail'])
    expect(JSON.stringify(status)).not.toContain(OPENALEX_NEXT)
    expect(keyTail('ab')).toBeNull()
    expect(keyTail(OPENALEX_NEXT)).toBe('yyyy')
  })

  it('空串只删目标行', () => {
    writeEnvValue(dir, 'DEEPSEEK_API_KEY', DEEPSEEK)
    writeOpenAlexApiKey(dir, OPENALEX)
    writeEnvValue(dir, 'OPENALEX_MAILTO', MAIL)
    writeOpenAlexApiKey(dir, '')
    const text = readFileSync(join(dir, '.env'), 'utf8')
    expect(text).not.toContain('OPENALEX_API_KEY')
    expect(text).toContain(`DEEPSEEK_API_KEY=${DEEPSEEK}`)
    expect(text).toContain(`OPENALEX_MAILTO=${MAIL}`)
    expect(openAlexKeyStatus(dir)).toEqual({ configured: false, tail: null })
  })
})
