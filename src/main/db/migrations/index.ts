import type Database from 'better-sqlite3'
import { migration001 } from './001_init'
import { migration002 } from './002_settings_trace_authors'
import { migration003 } from './003_job_steps_retry'
import { PDF_MIGRATIONS } from './pdf'
import { REL_MIGRATIONS } from './relations'
import { DETAIL_MIGRATIONS } from './detail'
import { AGENT_MIGRATIONS } from './agent'
import { M6CORE_MIGRATIONS } from './m6core'
import { FETCH_MIGRATIONS } from './fetch'
import { UAT1_MIGRATIONS } from './uat1'

/**
 * 带编号的数据库升级脚本（D59）。
 *
 * - 当前版本记在 PRAGMA user_version；
 * - 启动时按版本号顺序补跑缺失的脚本，全部在一个事务里，任一脚本出错整体回退
 *   （user_version 也在同一事务里推进，回退后回到升级前的版本，数据完好）；
 * - 有缺失脚本时先调用 beforeUpgrade 钩子（自动备份，D59/D76）。
 *
 * 并行车道约定：本文件只聚合核心迁移（001–003），每来源一行；
 * 迁移号按车道预留——lane/pdf 用 004–009（./pdf.ts 的 PDF_MIGRATIONS）；
 * lane/relations 用 010（./relations.ts 的 REL_MIGRATIONS；**user_version 是单一
 * 高水位无号段**，后续 relations 迁移 081 也在此聚合，见该文件头注释）；
 * M4：lane/detail 用 020–029、lane/render 预留 030–039（均在 ./detail.ts 的 DETAIL_MIGRATIONS）；M5：lane/agent 用 040–049、
 * 备用 050–059（./agent.ts 的 AGENT_MIGRATIONS）；M6：维护者前置 060–062
（./m6core.ts 的 M6CORE_MIGRATIONS，061 候选直达列 / 062 usage 'web' 同处）；
 * lane/fetch 用 063–069（./fetch.ts 的 FETCH_MIGRATIONS，骨架已建）；备用 070–079；
 * lane/uat1(b) 用 080–090（./uat1.ts 的 UAT1_MIGRATIONS，080 pdf_unresolved；
 * 089 候选理由恢复 / 090 superseded_at 为 uat6c）。
 * MIGRATIONS 数组内顺序不影响执行（runMigrations 按 version 排序）。
 */

export interface Migration {
  version: number
  name: string
  up: (db: Database.Database) => void
}

export const MIGRATIONS: Migration[] = [
  migration001,
  migration002,
  migration003,
  ...PDF_MIGRATIONS,
  ...REL_MIGRATIONS,
  ...DETAIL_MIGRATIONS,
  ...AGENT_MIGRATIONS,
  ...M6CORE_MIGRATIONS,
  ...FETCH_MIGRATIONS,
  ...UAT1_MIGRATIONS
]

export class MigrationError extends Error {
  constructor(
    public readonly version: number,
    public readonly migrationName: string,
    cause: unknown
  ) {
    super(`数据库升级脚本 ${version} (${migrationName}) 执行失败，已整体回退: ${String(cause)}`)
    this.name = 'MigrationError'
  }
}

export interface RunMigrationsOptions {
  /** 存在待跑脚本时先调用（如升级前自动备份，D59）。抛错则终止升级。 */
  beforeUpgrade?: (pending: Migration[]) => void
}

/** 返回本次应用的迁移版本号列表；无待跑脚本时返回空数组。 */
export function runMigrations(
  db: Database.Database,
  migrations: Migration[] = MIGRATIONS,
  opts?: RunMigrationsOptions
): number[] {
  const versions = new Set(migrations.map((m) => m.version))
  if (versions.size !== migrations.length) throw new Error('迁移脚本版本号重复')

  const current = db.pragma('user_version', { simple: true }) as number
  const maxVersion = Math.max(0, ...migrations.map((m) => m.version))
  // 旧版本 App 打开新版本数据库：明确拒绝，避免旧代码对着新 schema 跑坏在暗处
  if (current > maxVersion) {
    throw new Error(
      `数据库版本（user_version=${current}）高于本程序支持的最新版本（v${maxVersion}），` +
        '请升级 App 后再打开'
    )
  }
  const pending = migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version)

  if (pending.length === 0) return []
  opts?.beforeUpgrade?.(pending)

  const applied: number[] = []
  // 所有待跑脚本在单个事务里执行：任一步抛错整体回退，数据完好（D59）
  const runAll = db.transaction(() => {
    for (const m of pending) {
      try {
        m.up(db)
      } catch (e) {
        throw new MigrationError(m.version, m.name, e)
      }
      db.pragma(`user_version = ${m.version}`)
      applied.push(m.version)
    }
  })
  runAll()
  return applied
}
