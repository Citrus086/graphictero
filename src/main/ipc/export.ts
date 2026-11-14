import { BrowserWindow, dialog, ipcMain } from 'electron'
import { writeFileSync } from 'node:fs'
import { z } from 'zod'
import { IPC_EXPORT, ExportOptionsSchema, type ExportOptions } from '../../shared/ipc/export'
import type { TokenUsage } from '../llm/pricing'
import { readApiKey, getLlmSettings, providerBaseUrl } from '../llm/config'
import { streamChat } from '../llm/client'
import { recordUsage } from '../llm/usage'
import { latestGraphSessionId } from '../jobs/sessionAttr'
import { buildMarkdown, loadExportGraph, markdownFileName, type ExportGraph } from '../export/markdown'
import type { AppState, IpcWrap } from './types'

/**
 * export:* 实装（D31/D60/D132）。
 *
 * preview 不调用模型：勾了概览但还没生成时放占位。overview 调一次模型，
 * 记入 overview（D142，不再是 chat），并按 graphId + 图谱内容签名缓存在主进程。
 * 空图谱那句不进缓存。save 复用缓存，没有缓存或签名变了才再调一次。
 * 契约没有 overviewText 字段，所以已生成的概览进不了另一次 preview，除非走这份缓存。
 * 保存框的 defaultPath 只是文件名，不把数据目录交给渲染层（D115/D116）。
 */

export interface ExportOverviewResult {
  text: string
  model: string
  usage: TokenUsage
}

type ExportHost = AppState & {
  exportOverview?: (prompt: string) => Promise<ExportOverviewResult>
}

interface CachedOverview {
  sig: string
  text: string
}

const overviewCache = new Map<number, CachedOverview>()

/** 成员 id / 标题 / 一句话 + 关系端点、类型、陈述。内容变了就重新生成。 */
function graphSignature(graph: ExportGraph): string {
  const members = [...graph.papers]
    .sort((a, b) => a.id - b.id)
    .map((p) => `${p.id}|${p.title}|${p.oneLiner ?? ''}`)
    .join('\n')
  const edges = [...graph.edges]
    .sort((a, b) => a.srcId - b.srcId || a.dstId - b.dstId || a.statement.localeCompare(b.statement))
    .map((e) => `${e.srcId}>${e.dstId}:${e.types.join(',')}:${e.statement}`)
    .join('\n')
  return `${members}\n--\n${edges}`
}

function cachedOverview(graphId: number, graph: ExportGraph): string | null {
  const hit = overviewCache.get(graphId)
  if (!hit || hit.sig !== graphSignature(graph)) return null
  return hit.text
}

export function clearExportOverviewCache(): void {
  overviewCache.clear()
}

function overviewPrompt(graph: ExportGraph): string {
  const papers = [...graph.papers].sort((a, b) => a.y - b.y || a.x - b.x || a.id - b.id)
  const lines = papers.map((paper) => {
    const year = paper.year != null ? ` (${paper.year})` : ''
    const one = paper.oneLiner?.trim() ? `：${paper.oneLiner.trim()}` : ''
    return `- ${paper.title}${year}${one}`
  })
  return `图谱「${graph.name}」的论文如下。请用中文写一段研究线概览，不超过 200 字，只依据这些信息，不要编造。\n${lines.join('\n')}`
}

async function defaultOverview(state: AppState, prompt: string): Promise<ExportOverviewResult> {
  const settings = getLlmSettings(state.db, state.dataDir)
  if (!settings.hasApiKey) throw new Error('缺少 API Key，无法生成研究线概览')
  const apiKey = readApiKey(state.dataDir, settings.provider)
  if (!apiKey) throw new Error('缺少 API Key，无法生成研究线概览')
  const result = await streamChat(
    { apiKey, baseUrl: providerBaseUrl(settings.provider), model: settings.model },
    [{ role: 'user', content: prompt }]
  )
  return { text: result.text, model: settings.model, usage: result.usage }
}

async function generateOverview(state: ExportHost, graph: ExportGraph, graphId: number): Promise<string> {
  if (graph.papers.length === 0) return '这张图谱还没有论文。'
  const sig = graphSignature(graph)
  const hit = overviewCache.get(graphId)
  if (hit && hit.sig === sig) return hit.text
  const caller = state.exportOverview ?? ((prompt: string) => defaultOverview(state, prompt))
  const result = await caller(overviewPrompt(graph))
  const text = result.text.trim()
  if (!text) throw new Error('研究线概览为空')
  recordUsage(state.db, {
    category: 'overview',
    model: result.model,
    usage: result.usage,
    sessionId: latestGraphSessionId(state.db, graphId)
  })
  overviewCache.set(graphId, { sig, text })
  return text
}

function requireGraph(state: AppState, graphId: number): ExportGraph {
  const graph = loadExportGraph(state.db, graphId)
  if (!graph) throw new Error('图谱不存在')
  return graph
}

function render(graph: ExportGraph, options: ExportOptions, overviewText: string | null): string {
  return buildMarkdown(graph, options, { exportedAt: new Date(), overviewText })
}

export function registerExportIpc(state: AppState, h: IpcWrap): void {
  const host = state as ExportHost

  ipcMain.handle(IPC_EXPORT.preview, h((_e, options: unknown) => {
    const opts = ExportOptionsSchema.parse(options)
    const graph = requireGraph(state, opts.graphId)
    const overviewText = opts.overview ? cachedOverview(opts.graphId, graph) : null
    return render(graph, opts, overviewText)
  }))

  ipcMain.handle(IPC_EXPORT.save, h(async (_e, options: unknown) => {
    const opts = ExportOptionsSchema.parse(options)
    const graph = requireGraph(state, opts.graphId)
    const overviewText = opts.overview
      ? (cachedOverview(opts.graphId, graph) ?? (await generateOverview(host, graph, opts.graphId)))
      : null
    const markdown = render(graph, opts, overviewText)
    const dialogOpts = {
      title: '导出 Markdown',
      defaultPath: markdownFileName(graph.name),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    }
    const win = BrowserWindow.getAllWindows()[0]
    const picked = win ? await dialog.showSaveDialog(win, dialogOpts) : await dialog.showSaveDialog(dialogOpts)
    if (picked.canceled || !picked.filePath) return null
    writeFileSync(picked.filePath, markdown, 'utf8')
    return picked.filePath
  }))

  ipcMain.handle(IPC_EXPORT.overview, h(async (_e, options: unknown) => {
    const opts = ExportOptionsSchema.parse(options)
    const graph = requireGraph(state, opts.graphId)
    // uat4 建议修 2：空图谱与缓存命中都不调模型，cached=true 让对话框显示「不再计费」
    if (graph.papers.length === 0) return { text: '这张图谱还没有论文。', cached: true }
    const hit = cachedOverview(opts.graphId, graph)
    if (hit != null) return { text: hit, cached: true }
    return { text: await generateOverview(host, graph, opts.graphId), cached: false }
  }))

  // uat4-fix1 S4：只读查询概览缓存（不调模型）——对话框打开时先问这里，
  // 命中则直接显示「已生成（缓存，不再计费）」而不是「预计」
  ipcMain.handle(IPC_EXPORT.peekOverview, h((_e, graphId: unknown) => {
    const id = z.number().int().positive().parse(graphId)
    const graph = loadExportGraph(state.db, id)
    if (!graph || graph.papers.length === 0) return { cached: false }
    return { cached: cachedOverview(id, graph) != null }
  }))
}
