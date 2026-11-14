import { ipcMain, nativeTheme } from 'electron'
import { IPC, type ThemePref, type UsageCategory, type UsageSeriesInput } from '../../shared/ipc'
import * as svc from '../appService'
import { getLlmSettings, providerBaseUrl, readApiKey, setLlmSettings, writeApiKey } from '../llm/config'
import { fetchBalance } from '../llm/client'
import { testLlmConnection } from '../llm/probe'
import { monthUsageSummary, recentUsageCalls, usageByPeriod, usageBySession, usageSeries } from '../llm/usage'
import { openAlexKeyStatus, readOpenAlexSettings, writeOpenAlexApiKey } from '../openalex/env'
import { openAlexBaseUrl, probeOpenAlex } from '../openalex/probe'
import { setLlmQueuePaused } from '../jobs/store'
import { readThemePref, setThemePref, themeView } from '../theme'
import { pushTheme } from '../themeInstall'
import type { AppState, IpcWrap } from './types'

function systemDark(): boolean {
  return nativeTheme?.shouldUseDarkColors === true
}

/** M2 第一批：任务状态 / LLM 设置 / 用量（D34/D53/D58/D70；设置页与顶栏状态点共用） */
export function registerSettingsIpc(state: AppState, h: IpcWrap): void {
  ipcMain.handle(IPC.jobsOverview, h(() => svc.jobsOverview(state.db)))
  ipcMain.handle(
    IPC.jobsRetry,
    h((_e, jobId: number) => {
      svc.retryJobById(state.db, jobId)
      void state.runner?.drain() // 手动重试后立即调度
      void state.relEngine?.drain() // D101-③：relation_gen 任务同样立即调度
    })
  )
  ipcMain.handle(IPC.settingsGetLlm, h(() => getLlmSettings(state.db, state.dataDir)))
  ipcMain.handle(IPC.settingsSetLlm, h((_e, provider: string, model: string) => setLlmSettings(state.db, provider, model)))
  ipcMain.handle(
    IPC.settingsSetApiKey,
    h((_e, key: string) => {
      const trimmed = typeof key === 'string' ? key.trim() : ''
      if (!trimmed) throw new Error('请输入 API Key')
      const s = getLlmSettings(state.db, state.dataDir)
      writeApiKey(state.dataDir, s.provider, trimmed) // Key 只进数据目录 .env（D34），不落库不打日志
      setLlmQueuePaused(state.db, null) // 换了 Key：解除 401/402 的 LLM 队列暂停（D70）
      void state.runner?.drain() // waiting_key 任务自动继续（D53）
      void state.relEngine?.drain() // D101-③：关系引擎的 waiting_key 任务自动继续
    })
  )
  // uat8c：清除与保存分开。删行，但不解除暂停（没有 Key 时 drain 会空转）。
  ipcMain.handle(
    IPC.settingsClearApiKey,
    h(() => {
      const s = getLlmSettings(state.db, state.dataDir)
      writeApiKey(state.dataDir, s.provider, '')
    })
  )
  ipcMain.handle(
    IPC.settingsTestLlm,
    h(async () => {
      const s = getLlmSettings(state.db, state.dataDir)
      const key = readApiKey(state.dataDir, s.provider)
      return testLlmConnection({ baseUrl: providerBaseUrl(s.provider), apiKey: key })
    })
  )
  ipcMain.handle(IPC.settingsGetOpenAlex, h(() => openAlexKeyStatus(state.dataDir)))
  ipcMain.handle(
    IPC.settingsSetOpenAlexKey,
    h((_e, key: string) => {
      const trimmed = typeof key === 'string' ? key.trim() : ''
      if (!trimmed) throw new Error('请输入 API Key')
      writeOpenAlexApiKey(state.dataDir, trimmed)
    })
  )
  ipcMain.handle(
    IPC.settingsClearOpenAlexKey,
    h(() => {
      writeOpenAlexApiKey(state.dataDir, '')
    })
  )
  ipcMain.handle(
    IPC.settingsTestOpenAlex,
    h(async () => {
      const key = readOpenAlexSettings(state.dataDir).apiKey
      return probeOpenAlex({ baseUrl: openAlexBaseUrl(), apiKey: key })
    })
  )
  ipcMain.handle(IPC.settingsGetTheme, h(() => themeView(readThemePref(state.db), systemDark())))
  ipcMain.handle(
    IPC.settingsSetTheme,
    h((_e, pref: ThemePref) => {
      const saved = setThemePref(state.db, pref)
      try {
        pushTheme(state.db)
      } catch {
        // 单测 mock 没有 nativeTheme 时，偏好仍已写入
      }
      return themeView(saved, systemDark())
    })
  )
  // uat4：月份切换（「YYYY-MM」，无参 = 本月，向后兼容）
  ipcMain.handle(IPC.settingsUsageSummary, h((_e, month?: string) => monthUsageSummary(state.db, month)))
  ipcMain.handle(IPC.settingsUsageSeries, h((_e, input: UsageSeriesInput) => usageSeries(state.db, input)))
  ipcMain.handle(IPC.settingsUsageBySession, h((_e, input: UsageSeriesInput) => usageBySession(state.db, input)))
  ipcMain.handle(IPC.settingsUsageByPeriod, h((_e, input: UsageSeriesInput) => usageByPeriod(state.db, input)))
  ipcMain.handle(
    IPC.settingsUsageRecent,
    h((_e, input?: { category?: UsageCategory | null }) => recentUsageCalls(state.db, input ?? {}))
  )
  ipcMain.handle(
    IPC.settingsBalance,
    h(async () => {
      const s = getLlmSettings(state.db, state.dataDir)
      const key = readApiKey(state.dataDir, s.provider)
      if (!key) throw new Error('缺少 API Key，请先填写')
      return fetchBalance({ baseUrl: providerBaseUrl(s.provider), apiKey: key })
    })
  )
}
