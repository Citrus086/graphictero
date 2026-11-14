import './themePaint'
import { contextBridge, webUtils } from 'electron'
import type { GraphicteroApi } from '../shared/ipc'
import { coreApi } from './api/core'
import { pdfApi } from './api/pdf'
import { relApi } from './api/relations'
import { detailApi } from './api/detail'
import { agentApi } from './api/agent'
import { candApi } from './api/cand'
import { exportApi } from './api/export'

/**
 * M1 第三批：暴露 window.graphictero（类型见 src/shared/ipc 的 GraphicteroApi）。
 * 渲染进程只通过它访问主进程；事件用 on/off 封装，返回取消订阅函数。
 *
 * 并行车道约定：本文件只做组合，每模块一行 spread，车道期间冻结。
 * 车道只改 src/preload/api/pdf.ts / relations.ts，不动本文件。
 */
const api: GraphicteroApi = {
  ...coreApi,
  ...pdfApi,
  ...relApi,
  ...detailApi,
  ...agentApi,
  ...candApi,
  ...exportApi,
  // M6 预备提交（§4-6）：拖入文件取路径（File.path 已移除的现代替代，webUtils）
  getPathForFile: (file: File) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('graphictero', api)
