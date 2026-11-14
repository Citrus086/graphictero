import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * uat18 回归：macOS 上给 nativeTheme.themeSource 赋值（哪怕同值）会再发一次 'updated'。
 * 假 nativeTheme 照此行为（setImmediate 异步发），「跟随系统」时 updated 处理不能再赋值，
 * 否则 updated ↔ 赋值无限循环，App 退不掉（Cmd+Q / SIGTERM 均无效）。
 */
const fake = vi.hoisted(() => ({ theme: null as unknown as EventEmitter & Record<string, unknown> }))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  const nt = new EventEmitter() as EventEmitter & Record<string, unknown>
  let source = 'system'
  nt.sets = 0
  nt.shouldUseDarkColors = false
  Object.defineProperty(nt, 'themeSource', {
    get: () => source,
    set: (v: string) => {
      source = v
      ;(nt.sets as number)++
      setImmediate(() => nt.emit('updated'))
    }
  })
  fake.theme = nt
  return {
    nativeTheme: nt,
    ipcMain: { on: vi.fn() },
    BrowserWindow: { getAllWindows: () => [] }
  }
})

import { openDatabase } from './db/connection'
import { MIGRATIONS, runMigrations } from './db/migrations'
import { writeThemePref } from './theme'
import { installTheme, pushTheme } from './themeInstall'

let dir: string
let db: ReturnType<typeof openDatabase>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-theme-install-'))
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS)
})

afterEach(() => {
  fake.theme.removeAllListeners('updated')
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const settle = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('themeInstall（uat18 退不掉回归）', () => {
  it('跟随系统：系统外观变化后不会 updated ↔ themeSource 赋值循环', async () => {
    writeThemePref(db, 'system')
    installTheme(db)
    let updates = 0
    fake.theme.on('updated', () => updates++)
    fake.theme.emit('updated') // 模拟系统切换外观
    await settle()
    expect(updates).toBeLessThan(5)
    const sets = fake.theme.sets as number
    await settle()
    expect(fake.theme.sets).toBe(sets) // 安静下来，不再赋值
  })

  it('偏好变化时仍会写 themeSource', async () => {
    writeThemePref(db, 'system')
    installTheme(db)
    const before = fake.theme.sets as number
    writeThemePref(db, 'dark')
    pushTheme(db)
    expect(fake.theme.themeSource).toBe('dark')
    expect(fake.theme.sets).toBe(before + 1)
    writeThemePref(db, 'system')
    pushTheme(db)
    expect(fake.theme.themeSource).toBe('system')
    await settle()
    expect((fake.theme.sets as number) - before).toBe(2)
  })
})
