import Database from 'better-sqlite3'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { resolveDataDir, resolveRealPath } from './dataDir'
import { DataDirBlockedError } from './dataLayer'
import { createSnapshot } from './db/backup'

/**
 * 数据目录迁移（D83：改根位置时先做一次快照，再把现有数据迁到新位置）。
 *
 * 流程：校验新根位置（iCloud/Dropbox 拦截规则不变）→ 打快照 → 关库 →
 * 整树复制到新位置 → 校验（目标库存在 + PRAGMA quick_check）→
 * persistNewRoot 写设置（第三批接线：userData/data-root.json）→ 删除旧目录。
 *
 * 复制而非移动：任何一步失败旧数据原地不动；「写设置」失败同样不删旧——
 * 否则删旧与记住新根之间的崩溃窗口会让下次启动按旧根建空库（评审必须修 2）。
 *
 * 嵌套/相等检查复用 dataDir.ts 的符号链接解引用（resolveRealPath）与
 * darwin 大小写不敏感比较，新根是指向数据目录内部的软链也绕不过（评审建议修 6）。
 */

export interface MigrateOptions {
  home?: string
  now?: Date
  /**
   * 删旧目录之前持久化新根位置（评审必须修 2 的契约：写设置失败就不删旧，
   * 下次启动仍解析到旧根、旧数据完好）。抛错则迁移中止，新副本被清理。
   */
  persistNewRoot?: (root: string) => void
}

export interface MigrateResult {
  dataDir: string
  snapshot: string
  /** 持久化的新根位置（不含 Graphictero/） */
  root: string
}

/** darwin 文件系统默认大小写不敏感（与 dataDir.ts 同口径） */
const normCase = (p: string): string => (process.platform === 'darwin' ? p.toLowerCase() : p)
/** realpath 解引用 + 大小写规范化后的比较基准 */
const realNorm = (p: string): string => normCase(resolveRealPath(p))

/** p 是否在 root 之内（不含相等） */
function inside(p: string, root: string): boolean {
  return realNorm(p).startsWith(realNorm(root) + sep)
}

export function migrateDataDir(
  db: Database.Database,
  currentDataDir: string,
  newRootPath: string,
  opts: MigrateOptions = {}
): MigrateResult {
  const resolved = resolveDataDir(newRootPath, opts.home)
  if (!resolved.ok) throw new DataDirBlockedError(resolved.reason)
  const target = resolved.dir
  const root = resolve(newRootPath)

  if (realNorm(target) === realNorm(currentDataDir)) {
    throw new Error('新位置与当前数据目录相同，无需迁移')
  }
  // 避免自我复制/自我删除
  if (inside(target, currentDataDir)) {
    throw new Error('新位置不能放在当前数据目录里面')
  }
  if (inside(currentDataDir, target)) {
    throw new Error('新位置不能是当前数据目录的父目录')
  }
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error(`目标 ${target} 不是空目录，拒绝覆盖`)
  }

  // D83：先做一次快照
  const backupDir = join(currentDataDir, 'backups')
  mkdirSync(backupDir, { recursive: true })
  const snapshot = createSnapshot(db, backupDir, opts.now ?? new Date())

  db.close()
  try {
    cpSync(currentDataDir, target, { recursive: true })
    const targetDb = join(target, 'graphictero.db')
    if (!existsSync(targetDb)) {
      throw new Error('迁移后新位置缺少 graphictero.db，已保留旧目录不动')
    }
    // 评审必须修 2：复制产物本身要可打开且无损坏（不再只是 existsSync 摆设）
    const check = new Database(targetDb, { readonly: true, fileMustExist: true })
    try {
      const row = check.prepare('PRAGMA quick_check').get() as { quick_check: string }
      if (row.quick_check !== 'ok') {
        throw new Error(`迁移后数据库 quick_check 未通过（${row.quick_check}），已保留旧目录不动`)
      }
    } finally {
      check.close()
    }
    // 删旧之前记住新根：失败则中止，旧目录与新副本都保留（评审必须修 2）
    opts.persistNewRoot?.(root)
    rmSync(currentDataDir, { recursive: true, force: true })
  } catch (e) {
    // 失败：旧目录仍在（db 已关，由调用方决定重开）；清掉不完整的新副本
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    throw e
  }
  return { dataDir: target, snapshot, root }
}
