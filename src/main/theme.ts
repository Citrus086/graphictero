import type Database from 'better-sqlite3'

/** 外观偏好（D194① / D195）：非敏感，存 app_settings。默认跟随系统。 */
export const THEME_SETTING_KEY = 'ui_theme'

export type ThemePref = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

export interface ThemeView {
  pref: ThemePref
  resolved: ResolvedTheme
}

export function parseThemePref(raw: string | null | undefined): ThemePref {
  if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  return 'system'
}

export function readThemePref(db: Database.Database): ThemePref {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(THEME_SETTING_KEY) as { value: string } | undefined
  return parseThemePref(row?.value)
}

export function writeThemePref(db: Database.Database, pref: ThemePref): void {
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).run(THEME_SETTING_KEY, pref, now)
}

/** 写入前校验。非法值拒绝，不把脏数据收成「跟随系统」。 */
export function setThemePref(db: Database.Database, raw: string): ThemePref {
  if (raw !== 'light' && raw !== 'dark' && raw !== 'system') throw new Error('主题无效')
  writeThemePref(db, raw)
  return raw
}

export function resolveTheme(pref: ThemePref, systemDark: boolean): ResolvedTheme {
  if (pref === 'light' || pref === 'dark') return pref
  return systemDark ? 'dark' : 'light'
}

/** 与原型 --bg 一致：浅色 #FFFFFF，深色 #1C1C1E。窗口 backgroundColor 用它，避免首帧闪白。 */
export function themeBackground(resolved: ResolvedTheme): string {
  return resolved === 'dark' ? '#1C1C1E' : '#FFFFFF'
}

export function themeView(pref: ThemePref, systemDark: boolean): ThemeView {
  return { pref, resolved: resolveTheme(pref, systemDark) }
}
