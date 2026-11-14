import type { AppState, IpcWrap } from './types'
import type { RelationGenEngine } from '../relations/engine'
import { registerCoreIpc } from './core'
import { registerSettingsIpc } from './settings'
import { registerDataIpc } from './data'
import { registerZoteroIpc } from './zotero'
import { registerPdfIpc } from './pdf'
import { registerRelationsIpc } from './relations'
import { registerDetailIpc } from './detail'
import { registerAgentIpc } from './agent'
import { registerCandIpc } from './cand'
import { registerExportIpc } from './export'

/**
 * M1 第三批：IPC 接线按模块注册（renderer + preload 的所有入口；业务逻辑在 appService.ts）。
 * 从 index.ts 抽成独立模块：不带副作用导入（electron 仅解构使用），
 * vitest 里 mock electron 即可单测接线层（评审建议修 10：IPC 参数穿透测试）。
 *
 * 并行车道约定：本文件只做组合，每个模块一行。车道期间冻结，
 * 合并批次（维护者授权）起 registerIpc 返回 relations 车道引擎实例，供
 * main/index.ts 接线 startRelationsBackground（D101）与 settings.ts 补 drain。
 */
export function registerIpc(state: AppState): RelationGenEngine {
  // h 透传 renderer 参数：ipcMain.handle 以 (event, ...args) 调 handler，第一参是 event，
  // 其余原样传给服务层。评审必须修 1：旧实现 `const h = <T>(fn: () => T) => async () => fn()`
  // 零参调用 fn()，所有带参 IPC 运行时拿到 undefined（打开图谱/新建/加论文/连边全部失效）。
  const h: IpcWrap = <T, A extends unknown[]>(fn: (...a: A) => T | Promise<T>) => async (...a: A): Promise<T> => fn(...a)

  registerCoreIpc(state, h) // 图谱 / 论文库 / 手工关系
  registerSettingsIpc(state, h) // M2 第一批：任务状态 / LLM 设置 / 用量
  registerDataIpc(state, h) // 数据目录与备份
  registerZoteroIpc(state, h) // Zotero 导入
  registerPdfIpc(state, h) // lane/pdf（骨架）
  registerDetailIpc(state, h) // M4 lane/detail
  registerAgentIpc(state, h) // M5 lane/agent（骨架）
  registerCandIpc(state, h) // M6 lane/fetch 骨架（批 1 实装）
  registerExportIpc(state, h) // M6 lane/fetch 骨架（批 2 实装）
  return registerRelationsIpc(state, h) // lane/relations：返回引擎句柄（D101 接线）
}

export type { AppState } from './types'
