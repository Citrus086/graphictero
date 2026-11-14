import { BrowserWindow, ipcMain, nativeTheme } from 'electron'
import type Database from 'better-sqlite3'
import { readThemePref, resolveTheme, themeBackground, themeView, type ThemeView } from './theme'

/**
 * 首帧前的主题（D194①）。
 * - nativeTheme.themeSource 跟随偏好；窗口 backgroundColor 用 --bg 的浅/深值。
 * - preload 用 sendSync('settings:themeSync') 在页面脚本前写 <html data-theme>。
 * - 偏好为「跟随系统」时，nativeTheme updated 再广播给已打开的窗口。
 */

const SYNC_CHANNEL = 'settings:themeSync'
const EVENT_CHANNEL = 'event:theme'

let currentDb: Database.Database | null = null

export function currentThemeView(db: Database.Database = currentDb!): ThemeView {
  const pref = readThemePref(db)
  return themeView(pref, nativeTheme.shouldUseDarkColors)
}

/**
 * uat18：只在值变化时写 themeSource。macOS 上给 themeSource 赋值（哪怕同值）会重设
 * NSApp.appearance 并再触发一次 nativeTheme 'updated'；「跟随系统」时 updated → pushTheme →
 * 赋值 → updated… 形成每秒数万次的事件风暴，主线程一直有活，app.quit / process.exit
 * 走到 will-quit / exit 后进程却永远不退（Cmd+Q、SIGTERM 都退不掉，只能 SIGKILL）。
 */
export function applyThemeSource(pref: ThemeView['pref']): void {
  if (nativeTheme.themeSource !== pref) nativeTheme.themeSource = pref
}

function paintWindows(view: ThemeView): void {
  applyThemeSource(view.pref)
  const bg = themeBackground(view.resolved)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.setBackgroundColor(bg)
  }
}

export function pushTheme(db: Database.Database = currentDb!): ThemeView {
  const view = currentThemeView(db)
  paintWindows(view)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(EVENT_CHANNEL, view)
  }
  return view
}

export function installTheme(db: Database.Database): void {
  currentDb = db
  const view = currentThemeView(db)
  applyThemeSource(view.pref)
  ipcMain.on(SYNC_CHANNEL, (event) => {
    event.returnValue = currentThemeView(db)
  })
  nativeTheme.on('updated', () => {
    if (readThemePref(db) !== 'system') return
    pushTheme(db)
  })
}

export function windowBackgroundFor(db: Database.Database): string {
  const pref = readThemePref(db)
  return themeBackground(resolveTheme(pref, nativeTheme.shouldUseDarkColors))
}
