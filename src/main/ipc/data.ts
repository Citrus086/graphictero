import { app, dialog, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { latestSnapshotAt } from '../db/backup'
import { dataDirBlockMessage, defaultDataRoot, resolveDataDir } from '../dataDir'
import { DataDirBlockedError } from '../dataLayer'
import { exportFullBackup, restoreFullBackup } from '../db/fullBackup'
import { migrateDataDir } from '../migrateDataDir'
import { openDatabase } from '../db/connection'
import { writeRootOverride } from '../rootSetting'
import { IPC, type IpcResult } from '../../shared/ipc'
import type { AppState, IpcWrap } from './types'

/** 数据目录与备份（D59/D76/D81/D83）：存储位置显示、改根、导出/恢复完整备份 */

/** 统一抛错给渲染进程：剥掉 DataDirBlockedError 的内部 reason，返回中文文案 */
const blockMessage = (e: unknown): string =>
  e instanceof DataDirBlockedError ? dataDirBlockMessage(e.reason) : e instanceof Error ? e.message : String(e)

function dialogGetWindow(): BrowserWindow {
  const { BrowserWindow } = require('electron') as typeof import('electron')
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) throw new Error('没有可用的窗口')
  return win
}

export function registerDataIpc(state: AppState, h: IpcWrap): void {
  ipcMain.handle(IPC.dataInfo, h(() => ({
    root: state.root,
    dataDir: state.dataDir,
    defaultRoot: defaultDataRoot(),
    homeDir: homedir()
  })))
  ipcMain.handle(IPC.appVersion, h(() => app.getVersion()))
  ipcMain.handle(IPC.dataLastSnapshot, h(() => ({ at: latestSnapshotAt(state.backupDir) })))
  ipcMain.handle(
    IPC.dataLastImport,
    h(() => {
      const row = state.db
        .prepare(
          `SELECT MAX(created_at) AS at FROM papers
           WHERE zotero_item_key IS NOT NULL AND deleted_at IS NULL`
        )
        .get() as { at: string | null } | undefined
      return { at: row?.at ?? null }
    })
  )

  // 设置页「数据与备份」：改根位置（D83）。契约（评审必须修 2）：
  // 快照 → 关库 → 复制 → quick_check 校验 → persistNewRoot 写落点（失败不删旧）→ 删旧 → 重启生效
  ipcMain.handle(IPC.dataChooseRoot, async (): Promise<IpcResult<null>> => {
    const win = dialogGetWindow()
    const picked = await dialog.showOpenDialog(win, { title: '选择数据目录的根位置', properties: ['openDirectory', 'createDirectory'] })
    if (picked.canceled || !picked.filePaths[0]) return { ok: true, value: null } // 用户取消
    const root = picked.filePaths[0]
    const resolved = resolveDataDir(root)
    if (!resolved.ok) return { ok: false, error: blockMessage(new DataDirBlockedError(resolved.reason)) }
    try {
      migrateDataDir(state.db, state.dataDir, root, {
        persistNewRoot: (r) => writeRootOverride(app.getPath('userData'), r) // 删旧之前写；失败不删旧
      })
    } catch (e) {
      // 迁移失败：旧目录原地不动（migrateDataDir 保证），重开旧库继续用
      try {
        state.db = openDatabase(join(state.dataDir, 'graphictero.db'))
      } catch (reopenErr) {
        console.error('[graphictero] 迁移失败后重开数据库也失败：', reopenErr)
      }
      return { ok: false, error: blockMessage(e) }
    }
    app.relaunch()
    app.exit(0)
    return { ok: true, value: null }
  })

  ipcMain.handle(IPC.dataExportBackup, async (): Promise<string | null> => {
    const stamp = new Date().toISOString().slice(0, 10)
    const win = dialogGetWindow()
    const picked = await dialog.showSaveDialog(win, {
      title: '导出完整备份',
      defaultPath: `graphictero-backup-${stamp}.zip`,
      filters: [{ name: 'Graphictero 备份', extensions: ['zip'] }]
    })
    if (picked.canceled || !picked.filePath) return null
    return exportFullBackup(state.db, state.dataDir, picked.filePath) // D162：异步流式导出
  })

  // 从备份恢复（D59/D76）：选 zip + 空目标根位置 → 恢复 → 写落点 → 重启生效。
  // 「会替换当前数据」的二次确认由渲染进程弹（原型 05e 的说明文案）。
  ipcMain.handle(IPC.dataRestoreBackup, async (): Promise<IpcResult<null>> => {
    const win = dialogGetWindow()
    const zip = await dialog.showOpenDialog(win, {
      title: '选择 Graphictero 备份文件',
      properties: ['openFile'],
      filters: [{ name: 'Graphictero 备份', extensions: ['zip'] }]
    })
    if (zip.canceled || !zip.filePaths[0]) return { ok: true, value: null }
    const target = await dialog.showOpenDialog(win, {
      title: '选择恢复到哪个空文件夹（将创建其中的 Graphictero/ 目录）',
      properties: ['openDirectory', 'createDirectory']
    })
    if (target.canceled || !target.filePaths[0]) return { ok: true, value: null }
    try {
      state.db.close() // 恢复前关库（D76 口径）
      const result = await restoreFullBackup(zip.filePaths[0], target.filePaths[0]) // D162：异步流式恢复
      writeRootOverride(app.getPath('userData'), target.filePaths[0])
      console.log(`[graphictero] 已从备份恢复（含 ${result.paperFolders} 个论文文件夹），重启生效`)
    } catch (e) {
      try {
        state.db = openDatabase(join(state.dataDir, 'graphictero.db'))
      } catch (reopenErr) {
        console.error('[graphictero] 恢复失败后重开数据库也失败：', reopenErr)
      }
      return { ok: false, error: blockMessage(e) }
    }
    app.relaunch()
    app.exit(0)
    return { ok: true, value: null }
  })
}
