import type { RelationType } from '../relationTypes'
import type { PdfApi } from './pdf'
import type { RelApi } from './relations'
import type { DetailApi } from './detail'
import type { AgentApi } from './agent'
import type { CandApi } from './cand'
import type { ExportApi } from './export'
import type { SidebarSearchResult } from '../sidebarSearch'

/**
 * 渲染进程 ↔ 主进程 IPC 契约（M1 第三批）。
 * preload 暴露 window.graphictero（见 src/preload/index.ts），类型即 GraphicteroApi。
 * 主进程只补接线：业务逻辑在 src/main/appService.ts（可单测）。
 *
 * 并行车道约定：本文件是核心契约，车道期间冻结——车道（lane/pdf、
 * lane/relations）的新通道与类型加在 ./pdf.ts / ./relations.ts，由 GraphicteroApi
 * 在此组合。IPC 是核心通道常量；车道通道是 IPC_PDF / IPC_REL。
 */

export interface PaperSummary {
  id: number
  title: string
  firstAuthor: string | null
  year: number | null
  hasPdf: boolean
  doi: string | null
  arxivId: string | null
  source: string
  /** 相对传入的 graphId 是否已在图中 */
  inGraph: boolean
}

export interface GraphSummary {
  id: number
  name: string
  createdAt: string
  updatedAt: string
  paperCount: number
  relationCount: number
}

export interface GraphDetail {
  graph: GraphSummary
  members: Array<{ paper: PaperSummary; x: number; y: number }>
  relations: RelationView[]
}

export interface RelationView {
  id: number
  /** 无序对（paperLow < paperHigh） */
  paperLow: number
  paperHigh: number
  /** 方向端：等于 paperLow 或 paperHigh；src → dst 表示「dst 基于 / 针对 src」（D75） */
  srcPaper: number
  statement: string
  llmTypes: RelationType[]
  autoTypes: RelationType[]
  createdAt: string
  /** uat2b c)：完整行 provenance——⌘Z 快照原样恢复来源/模型/任务 id（D88/D148） */
  sourceType: 'job' | 'session'
  sourceJobId: number | null
  /** uat2-fix1 建议修 4：会话边撤销删除复活时保留会话 id */
  sourceSessionId: number | null
  model: string | null
  promptVersion: string | null
  /** uat2b D149：手动编辑过（来源仍 job，另显示「已编辑」） */
  editedAt: string | null
  /** uat2b D150：基于/改进 无引用依据（AI 推断） */
  noRefBasis: boolean
  /** uat4-fix1 S2：原 updated_at——画布 ⌘Z 快照原样恢复时间戳（D148/D164），不盖成撤销时刻 */
  updatedAt: string
}

export interface RelationInput {
  graphId: number
  srcPaperId: number
  dstPaperId: number
  statement: string
  types: RelationType[]
}

export interface DataInfo {
  /** 当前生效的根位置（不含 Graphictero/） */
  root: string
  /** 完整数据目录（根位置 + Graphictero/） */
  dataDir: string
  defaultRoot: string
  /** 本机 home，渲染端把路径收成 ~。不是秘密。 */
  homeDir: string
}

export type ZoteroSourceStatus =
  | { kind: 'local_api' }
  | { kind: 'sqlite'; sqlitePath: string; hint: string | null }

export interface ZoteroCollectionNode {
  key: string
  name: string
  /** 所属库 ID：1 = 用户个人库；>1 = 群组库（仅 sqlite 来源有；UI 据此过滤/标注，建 5） */
  libraryID?: number
  parentKey: string | null
}

/** uat13（D207-③）：添加论文弹窗选中 Zotero 分类后的条目预览（只读，标题 + 作者/年份） */
export interface ZoteroCollectionItemView {
  key: string
  title: string
  firstAuthor: string | null
  year: number | null
  /** 有 PDF 附件（与导入同一判定：条目下挂 attachment） */
  hasPdf: boolean
  /**
   * uat14（D209）：已在本机论文库（按 Zotero (libraryID, itemKey) 命中未软删论文行）。
   * 由主进程在带 db 查询时填；无法判断时不填。
   */
  alreadyImported?: boolean
}

export interface ImportProgress {
  phase: 'reading' | 'importing'
  done: number
  total: number
}

export interface ImportSummary {
  imported: number // created
  updated: number // updated / restored / skipped（已在库）
  addedToGraph: number
  /** 本次真正加入图谱的 paperIds（INSERT OR IGNORE 的 changes，评审建 6 的自动整理判据） */
  addedToGraphIds: number[]
  failed: number
  /** 有 PDF 附件但取路径失败的条目数（评审建议修 2：与「本就无附件」区分） */
  pdfUnresolved: number
  /** uat1b：重新导入给缺 PDF 的已在库论文补齐的篇数（D75 只补空字段） */
  pdfAdded: number
  /** Local API 403 等走 sqlite 兜底时的中文提示（没有为 null） */
  hint: string | null
}

export interface IpcResult<T> {
  ok: boolean
  value?: T
  /** 主进程返回的用户可读中文错误 */
  error?: string
}

// ── M2 第一批：LLM 设置 / 用量 / 任务状态 ──────────────────────────────

export const USAGE_CATEGORIES = ['chat', 'detail', 'relation', 'card', 'web', 'overview'] as const
export type UsageCategory = (typeof USAGE_CATEGORIES)[number]

/** uat7 D180：用量图表单个类别的聚合；reasoningTokens=null 表示该聚合未知。 */
export interface UsageAgg {
  costCny: number
  calls: number
  inputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  outputTokens: number
  reasoningTokens: number | null
}

export type UsageByCategory = Record<UsageCategory, UsageAgg>

export interface UsageSeriesInput {
  range: '7d' | '30d' | 'month' | 'all'
  /** range='month' 时生效；缺省为本月，格式 YYYY-MM。 */
  month?: string
  category?: UsageCategory
}

export interface UsageSeriesDay {
  /** 本地时区日期 YYYY-MM-DD。 */
  date: string
  byCategory: UsageByCategory
}

export interface UsageSeriesView {
  days: UsageSeriesDay[]
  totals: UsageByCategory
  /** 所选范围内是否至少有一条记录上报了 reasoning_tokens。 */
  reasoningKnown: boolean
}

/** uat8b D185/D193：按 session_id 汇总的一行。记账列不变，只读聚合。 */
export type UsageSessionKind = 'session' | 'background' | 'deleted'

export interface UsageSessionRow {
  kind: UsageSessionKind
  sessionId: number | null
  /** 会话标题；空标题为「会话 #id」；已删为「已删除的会话 #id」；无 session_id 为「后台任务（无会话）」 */
  title: string
  /** 所属图谱名；无会话 / 已删 / 会话未挂图谱时为 null */
  graphName: string | null
  costCny: number
  calls: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number | null
  /** MAX(occurred_at)，ISO；¥ 相同时按它降序 */
  lastUsedAt: string
}

export interface LlmSettingsView {
  provider: string
  model: string
  /** 只回传是否已配置，Key 本体绝不出主进程（D34） */
  hasApiKey: boolean
  /** 末 4 位；未配置或短于 4 位为 null */
  keyTail: string | null
}

/** 测试连接的人话结果。message 只有固定中文，不含 URL / Key。 */
export interface ConnectionTestView {
  ok: boolean
  message: string
}

/** OpenAlex Key 对渲染进程的视图（D71 / uat8c）。不含明文。 */
export interface OpenAlexKeyView {
  configured: boolean
  tail: string | null
}

export type ThemePref = 'light' | 'dark' | 'system'

export interface ThemeView {
  pref: ThemePref
  resolved: 'light' | 'dark'
}

/** uat8c：高峰 / 空闲费用。判定与计价共用 isPeakHour。 */
export interface UsagePeriodView {
  peakCny: number
  offPeakCny: number
  nowPeak: boolean
}

export interface RecentUsageCall {
  occurredAt: string
  category: string
  peak: boolean
  costCny: number
}

/** 设置页导入来源：只展示，探测失败也不抛。 */
export interface ZoteroDisplayView {
  apiUp: boolean
  endpoint: 'localhost:23119'
  sqliteFallback: true
  dataDir: string | null
}

export interface LastSnapshotView {
  /** 最新 snapshot-YYYY-MM-DD.db 的 mtime（ISO）；没有为 null */
  at: string | null
}

export interface LastImportView {
  /** 论文库里最近一条 Zotero 导入的 created_at；没有为 null */
  at: string | null
}

export interface UsageSummaryView {
  /** uat4：本次汇总对应的「YYYY-MM」月份 */
  month: string
  /** uat4：库中最早有记录的月份（‹ 切换下界）；无记录为 null */
  earliestMonth: string | null
  totalCny: number
  byCategory: Array<{ category: string; costCny: number; calls: number }>
}

/** uat4：DeepSeek 账户余额（元，数字；currency 仅内部使用，页面统一显示 ¥） */
export interface BalanceView {
  total: number
  /** 赠送余额；旧格式响应缺字段时为 null（页面显示「—」） */
  granted: number | null
  /** 充值余额；缺字段同上 */
  toppedUp: number | null
  currency: string
  /** 响应解析完成时刻（ISO），页面显示「更新于 HH:MM」 */
  at: string
}

export interface JobFailedItem {
  jobId: number
  paperId: number | null
  paperTitle: string
  failedStep: string | null
  error: string | null
  status: string
  /** uat8b B2：同一论文 + 同一动作合并后的条数。1 或省略时不显示 ×N。 */
  count?: number
}

/** 顶栏全局状态点的数据（D53/D65 09：分「需要你处理」和「可重试」两组） */
export interface JobsOverview {
  queued: number
  running: number
  waitingNetwork: number
  waitingKey: number
  failedRetryable: number
  failedAction: number
  /** 401/402 暂停时的一行汇总，如「API Key 无效 · 影响 2 个任务」（D70）；未暂停为 null */
  pauseSummary: string | null
  failed: JobFailedItem[]
  /** uat4 D167：正在处理 / 排队中的任务（含等待联网 / 等待 Key），弹层列出论文简称 */
  active?: JobActiveItem[]
}

export interface JobActiveItem {
  jobId: number
  paperId: number | null
  /** 论文简称（截断短标题；无标题显示「任务 N」） */
  paperTitle: string
  status: 'running' | 'queued' | 'waiting_network' | 'waiting_key'
  /** 当前步骤（parse/card/detail），无步骤信息为 null */
  step: string | null
}

export const IPC = {
  graphsList: 'graphs:list',
  graphsCreate: 'graphs:create',
  graphGet: 'graph:get',
  libraryList: 'library:list',
  libraryDeletePaper: 'library:deletePaper',
  /** uat8a D188：侧栏搜索合并标题子串与 papers_text_fts 正文命中 */
  librarySearchSidebar: 'library:searchSidebar',
  /** uat7b S2：从库删除确认框用——跨图谱有效关系数（未软删，与 D75 实际移除同口径） */
  libraryPaperRelationStats: 'library:paperRelationStats',
  graphAddPapers: 'graph:addPapers',
  graphRemovePaper: 'graph:removePaper',
  graphSetPosition: 'graph:setPosition',
  relationCreate: 'relation:create',
  relationDelete: 'relation:delete',
  dataInfo: 'data:info',
  dataChooseRoot: 'data:chooseRoot',
  dataExportBackup: 'data:exportBackup',
  dataRestoreBackup: 'data:restoreBackup',
  zoteroStatus: 'zotero:status',
  zoteroListCollections: 'zotero:listCollections',
  /** uat13（D207-③）：分类内条目预览列表（只读） */
  zoteroCollectionItems: 'zotero:collectionItems',
  zoteroImport: 'zotero:import',
  /** uat14（D209）：只导入分类内所选 item keys（同款编排：来源探测/去重/进度/入图谱） */
  zoteroImportItems: 'zotero:importItems',
  eventZoteroImportProgress: 'event:zoteroImportProgress',
  settingsGetLlm: 'settings:getLlm',
  settingsSetLlm: 'settings:setLlm',
  settingsSetApiKey: 'settings:setApiKey',
  /** uat8c：清除 Key 的单独入口。空保存不再等于清除。 */
  settingsClearApiKey: 'settings:clearApiKey',
  settingsTestLlm: 'settings:testLlm',
  settingsGetOpenAlex: 'settings:getOpenAlex',
  settingsSetOpenAlexKey: 'settings:setOpenAlexKey',
  settingsClearOpenAlexKey: 'settings:clearOpenAlexKey',
  settingsTestOpenAlex: 'settings:testOpenAlex',
  settingsGetTheme: 'settings:getTheme',
  settingsSetTheme: 'settings:setTheme',
  eventTheme: 'event:theme',
  settingsUsageSummary: 'settings:usageSummary',
  settingsUsageSeries: 'usage:series',
  /** uat8b D185/D193：按会话汇总（只读，过滤与 usage:series 同一套） */
  settingsUsageBySession: 'usage:bySession',
  /** uat8c：高峰 / 空闲汇总（只读） */
  settingsUsageByPeriod: 'usage:byPeriod',
  /** uat8c：最近调用（只读，最多 20） */
  settingsUsageRecent: 'usage:recent',
  settingsBalance: 'settings:balance',
  jobsOverview: 'jobs:overview',
  jobsRetry: 'jobs:retry',
  openExternal: 'app:openExternal',
  appVersion: 'app:version',
  dataLastSnapshot: 'data:lastSnapshot',
  dataLastImport: 'data:lastImport',
  zoteroDisplay: 'zotero:display'
} as const

/** 核心方法的 API 形状（车道片段见 ./pdf.ts 的 PdfApi、./relations.ts 的 RelApi） */
export interface CoreApi {
  listGraphs(): Promise<GraphSummary[]>
  createGraph(name: string): Promise<GraphSummary>
  getGraph(id: number): Promise<GraphDetail>
  listLibrary(graphId?: number): Promise<PaperSummary[]>
  /** 从库删除（软删除，D75）：论文从论文库和所有图谱移除，可恢复 */
  deletePaperFromLibrary(paperId: number): Promise<void>
  /**
   * uat8a D188：侧栏「搜索论文库」。members / others 各自标题命中在前、正文命中在后，
   * 同一篇只出现一次。短于 2 个码位不查正文。
   */
  searchSidebar(graphId: number, query: string): Promise<SidebarSearchResult>
  /** uat7b S2：所有图谱里与这篇论文相连的有效关系数 / 涉及图谱数（确认框文案用） */
  paperRelationStats(paperId: number): Promise<{ count: number; graphCount: number }>
  /** 添加论文进图谱；resolve 为本次真正新增的 paperIds（已在上图的不重复计数） */
  addPapersToGraph(graphId: number, paperIds: number[]): Promise<number[]>
  removePaperFromGraph(
    graphId: number,
    paperId: number
  ): Promise<{ hadProgress: boolean; addedAt: string; doneAt: string | null; graphUpdatedAt: string }>
  setNodePosition(graphId: number, paperId: number, x: number, y: number): Promise<void>
  createRelation(input: RelationInput): Promise<number>
  deleteRelation(id: number): Promise<void>
  getDataInfo(): Promise<DataInfo>
  /** 弹目录选择框 → 校验 → 快照 → 迁移 → 重启应用；被拦返回 {ok:false,error:中文} */
  chooseDataRoot(): Promise<IpcResult<null>>
  /** 弹保存框导出完整备份；返回导出路径（取消为 null） */
  exportBackup(): Promise<string | null>
  /** 选备份 zip + 空目录 → 恢复 → 重启应用；返回中文错误或被拦提示 */
  restoreBackup(): Promise<IpcResult<null>>
  getZoteroStatus(): Promise<ZoteroSourceStatus>
  listZoteroCollections(): Promise<ZoteroCollectionNode[]>
  /** uat13（D207-③）：选中分类后预览其中的论文（标题 + 作者/年份；附件/笔记过滤与导入一致） */
  listZoteroCollectionItems(collectionKey: string): Promise<ZoteroCollectionItemView[]>
  /** 导入分类并加入图谱；进度经 onZoteroImportProgress 推送 */
  importZoteroCollection(collectionKey: string, graphId: number): Promise<ImportSummary>
  /** uat14（D209）：只导入分类内所选 item keys 并加入图谱；进度经 onZoteroImportProgress 推送 */
  importZoteroItems(collectionKey: string, itemKeys: string[], graphId: number): Promise<ImportSummary>
  onZoteroImportProgress(cb: (p: ImportProgress) => void): () => void
  // M2 第一批：LLM 设置 / 用量 / 任务
  getLlmSettings(): Promise<LlmSettingsView>
  setLlmSettings(provider: string, model: string): Promise<void>
  /** 保存 API Key 到数据目录 .env（D34）。空串拒绝，不清除。保存后解除 LLM 队列暂停并继续排队任务。 */
  setApiKey(key: string): Promise<void>
  /** 清除已配置的 Key（需渲染端先确认）。只删 .env 目标行，不解除队列暂停。 */
  clearApiKey(): Promise<void>
  /** 测试 DeepSeek 连接。结果是固定中文，不含余额数字。 */
  testLlmConnection(): Promise<ConnectionTestView>
  getOpenAlexKey(): Promise<OpenAlexKeyView>
  /** 空串拒绝。写 OPENALEX_API_KEY 行，下次请求即生效。 */
  setOpenAlexKey(key: string): Promise<void>
  clearOpenAlexKey(): Promise<void>
  /** 测试 OpenAlex。遵守 GRAPHICTERO_OPENALEX_BASE_URL。不回显 api_key。 */
  testOpenAlex(): Promise<ConnectionTestView>
  getTheme(): Promise<ThemeView>
  setTheme(pref: ThemePref): Promise<ThemeView>
  onTheme(cb: (view: ThemeView) => void): () => void
  getAppVersion(): Promise<string>
  getLastSnapshot(): Promise<LastSnapshotView>
  getLastImport(): Promise<LastImportView>
  /** 导入来源页：可用 / 不可用，不抛错 */
  getZoteroDisplay(): Promise<ZoteroDisplayView>
  /** month 为「YYYY-MM」，缺省 = 本月（向后兼容无参调用） */
  getUsageSummary(month?: string): Promise<UsageSummaryView>
  /** uat7 D180：本地日 × 类别的只读用量序列（含推理 token 未知态）。 */
  getUsageSeries(input: UsageSeriesInput): Promise<UsageSeriesView>
  /** uat8b D185/D193：按会话汇总费用 / 次数 / token。过滤与序列同一套入参。 */
  getUsageBySession(input: UsageSeriesInput): Promise<UsageSessionRow[]>
  /** uat8c：高峰 / 空闲。时间范围与来源过滤与序列同一套。 */
  getUsageByPeriod(input: UsageSeriesInput): Promise<UsagePeriodView>
  /** uat8c：最近 20 条。只跟随来源过滤，不跟随时间范围。 */
  getRecentUsage(input?: { category?: UsageCategory | null }): Promise<RecentUsageCall[]>
  /** 从 DeepSeek 查账户余额（D58；uat4 结构化三字段）；无 Key / 网络错误会 reject 中文原因 */
  getBalance(): Promise<BalanceView>
  getJobsOverview(): Promise<JobsOverview>
  /** 手动重试失败任务（从失败步骤接着跑，D85） */
  retryJob(jobId: number): Promise<void>
  /** 用系统浏览器打开 http/https 链接 */
  openExternal(url: string): Promise<void>
}

/**
 * preload 暴露给渲染进程的完整 API 形状（核心 + 各车道片段的组合）。
 * M6 预备提交：组合 CandApi / ExportApi（骨架）；getPathForFile 见下方独立方法。
 */
export interface GraphicteroApi extends CoreApi, PdfApi, RelApi, DetailApi, AgentApi, CandApi, ExportApi {
  /**
   * 拖入文件取绝对路径（Electron webUtils，M6 §4-6）：渲染层只拿 File.path 的
   * 现代替代——经它传给 cand:attachPdf，不读字节过 IPC。参数是渲染进程的 File 对象。
   */
  getPathForFile(file: File): string
}
