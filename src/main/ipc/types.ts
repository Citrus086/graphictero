import type Database from 'better-sqlite3'
import type { PaperParser } from '../jobs/mineru'
import type { JobRunner } from '../jobs/runner'
import type { MineruSidecar } from '../sidecar/mineruSidecar'
import type { RelationGenEngine } from '../relations/engine'

export interface AppState {
  db: Database.Database
  dataDir: string
  backupDir: string
  root: string
  /** M2：任务调度器（index.ts 启动时接线；测试可留空，手动重试后不触发调度） */
  runner?: JobRunner | null
  /** D101：关系生成引擎（registerIpc 的返回值；jobsRetry / setApiKey 补 drain 用） */
  relEngine?: RelationGenEngine | null
  /** D95：MinerU 解析器（导入入队与启动补排据此判断是否可用） */
  parser?: PaperParser
  /** lane/pdf：MinerU sidecar 管理器（UI 冒烟 / 测试模式不挂） */
  sidecar?: MineruSidecar
}

/**
 * ipcMain.handle 的统一包装签名：electron 以 (event, ...args) 调 handler，
 * 包装器原样把参数传给服务层（评审必须修 1 的透传口径，历史教训见 ipc/index.ts）。
 * 各注册模块（./core.ts 等）经它包装自己的 handler，保证参数透传口径一致。
 */
export type IpcWrap = <T, A extends unknown[]>(
  fn: (...a: A) => T | Promise<T>
) => (...a: A) => Promise<T>
