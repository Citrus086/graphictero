import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from './db/connection'
import { MIGRATIONS, runMigrations } from './db/migrations'
import {
  parseThemePref,
  readThemePref,
  resolveTheme,
  setThemePref,
  themeBackground,
  writeThemePref
} from './theme'

let dir: string
let db: ReturnType<typeof openDatabase>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-theme-'))
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('主题偏好（D194①）', () => {
  it('非法值解析为跟随系统，写入时拒绝', () => {
    expect(parseThemePref(null)).toBe('system')
    expect(parseThemePref('')).toBe('system')
    expect(parseThemePref('blue')).toBe('system')
    expect(readThemePref(db)).toBe('system')
    expect(() => setThemePref(db, 'blue')).toThrow('主题无效')
    expect(readThemePref(db)).toBe('system')
  })

  it('light / dark / system 可存可取，system 按系统深浅解析', () => {
    for (const pref of ['light', 'dark', 'system'] as const) {
      writeThemePref(db, pref)
      expect(readThemePref(db)).toBe(pref)
      expect(setThemePref(db, pref)).toBe(pref)
    }
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(themeBackground('dark')).toBe('#1C1C1E')
    expect(themeBackground('light')).toBe('#FFFFFF')
  })
})
