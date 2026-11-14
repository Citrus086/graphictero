import { ipcMain, BrowserWindow } from 'electron'
import { IPC_AGENT } from '../../shared/ipc/agent'
import {
  CreateSessionInputSchema,
  SendInputSchema,
  SESSION_ENTRY_TYPES,
  type CandidateView,
  type CardLiveQuery,
  type ChatMessageView,
  type SessionEntryType,
  type SessionSummary
} from '../../shared/ipc/agent'
import { z } from 'zod'
import type Database from 'better-sqlite3'
import { AgentRuntime } from '../agent/runtime'
import { confirmCandidate, ignoreCandidate, listCandidates, moveCandidate } from '../agent/candidates'
import { cardLiveStates } from '../agent/cardLive'
import { appendSystemMessage } from '../agent/sessionStore'
import { createOpenAlexClient } from '../openalex/client'
import { readOpenAlexSettings } from '../openalex/env'
import { bumpOpenAlexDailyCount } from '../openalex/search'
import {
  createSession,
  deleteSession,
  getMessages,
  listSessions,
  renameSession,
  sessionCost,
  sessionCostBreakdown
} from '../agent/sessionStore'
import { getLlmSettings, readApiKey, providerBaseUrl } from '../llm/config'
import { setUsagePostedHandler } from '../llm/usage'
import { MissingKeyError } from '../llm/errors'
import type { AppState, IpcWrap } from './types'

/**
 * M5 lane/agent 车道的 IPC 注册模块（批 1 实装）。
 *
 * - 12 个 agent: 通道全部注册（channel 名与契约冻结，ipc.test 断言守门）；
 * - 会话 CRUD / 消息 / 费用走 sessionStore；send/stop/retryMessage 走 AgentRuntime
 *   （回合在主进程异步跑，结果经 event:agent:stream 广播，D118）；
 * - 候选：批 1 只做 listCandidates（只读）；确认/忽略状态机归批 3（candidates.ts，
 *   D117 去重命中 + 「加入图谱」链路），本批抛中文「批 3 实装」；
 * - handler 一律经 IpcWrap（h）包装（参数透传口径，见 ipc/index.ts）。
 */

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function registerAgentIpc(state: AppState, h: IpcWrap): AgentRuntime {
  // 名片 / 详情 / 概览 / 关系生成写入 usage 且带 sessionId 时，让打开着的抽屉再拉一次分项（D160）
  setUsagePostedHandler((posted) => {
    broadcast(IPC_AGENT.eventSessionCost, { sessionId: posted.sessionId })
  })
  // 候选状态变化（proposeCandidate 落库 / 确认 / 忽略）统一经此广播：画布虚线节点、
  // 图例与对话卡片两处实时同步（D117；payload 带 sessionId = 候选来源会话，评审建议修 3）
  const broadcastCandidates = (graphId: number, sessionId: number | null): void => {
    broadcast(IPC_AGENT.eventCandidates, { graphId, sessionId, candidates: listCandidates(state.db, graphId) })
  }
  const runtime = new AgentRuntime({
    db: state.db,
    dataDir: state.dataDir,
    llm: () => {
      const s = getLlmSettings(state.db, state.dataDir)
      const key = readApiKey(state.dataDir, s.provider)
      if (!key) throw new MissingKeyError()
      return { baseUrl: providerBaseUrl(s.provider), apiKey: key, model: s.model }
    },
    broadcast: (e) => broadcast(IPC_AGENT.eventStream, e),
    onCandidates: broadcastCandidates,
    openAlex: () => {
      const s = readOpenAlexSettings(state.dataDir)
      return createOpenAlexClient({
        apiKey: s.apiKey,
        mailto: s.mailto,
        onBillable: () => bumpOpenAlexDailyCount(state.db)
      })
    }
  })

  ipcMain.handle(
    IPC_AGENT.listSessions,
    h((_e, graphId: number, entryType: SessionEntryType, entryId: number | null): SessionSummary[] =>
      listSessions(
        state.db,
        z.number().int().positive().parse(graphId),
        z.enum(SESSION_ENTRY_TYPES).parse(entryType),
        entryId === null ? null : z.number().int().positive().parse(entryId)
      )
    )
  )
  ipcMain.handle(IPC_AGENT.createSession, h((_e, input) => createSession(state.db, CreateSessionInputSchema.parse(input))))
  ipcMain.handle(
    IPC_AGENT.renameSession,
    h((_e, sessionId: number, name: string) =>
      renameSession(state.db, z.number().int().positive().parse(sessionId), z.string().min(1).max(200).parse(name))
    )
  )
  ipcMain.handle(IPC_AGENT.deleteSession, h((_e, sessionId: number) => {
    const sid = z.number().int().positive().parse(sessionId)
    runtime.stop(sid) // 运行中先停止回合（abort），再物理删除（评审必须修 5：防在跑回合打已删消息/FK）
    deleteSession(state.db, sid)
  }))
  ipcMain.handle(IPC_AGENT.getMessages, h((_e, sessionId: number) => getMessages(state.db, z.number().int().positive().parse(sessionId))))
  // uat5 D172：系统记录（撤销通知等）——不作用户消息，落库即入下轮上下文
  ipcMain.handle(IPC_AGENT.appendSystemNote, h((_e, sessionId: number, text: string): ChatMessageView => {
    const sid = z.number().int().positive().parse(sessionId)
    const t = z.string().min(1).max(500).parse(text)
    const view = appendSystemMessage(state.db, sid, t)
    // 借 'stopped' 事件让渲染层回源消息（无副作用分支：只删 turn 标记 + refreshMessages）
    broadcast(IPC_AGENT.eventStream, { sessionId: sid, turnId: '', kind: 'stopped' })
    return view
  }))
  ipcMain.handle(IPC_AGENT.send, h((_e, input) => {
    runtime.startTurn(SendInputSchema.parse(input))
  }))
  ipcMain.handle(IPC_AGENT.stop, h((_e, sessionId: number) => {
    runtime.stop(z.number().int().positive().parse(sessionId))
  }))
  ipcMain.handle(IPC_AGENT.retryMessage, h((_e, sessionId: number, messageId: number) => {
    runtime.retryMessage(
      z.number().int().positive().parse(sessionId),
      z.number().int().positive().parse(messageId)
    ) // busy 时抛错（评审必须修 6），IPC 直接 reject
  }))
  // 候选状态机（批 3 实装）：确认/忽略后广播（broadcastCandidates 见上，与 proposeCandidate 共用）
  ipcMain.handle(
    IPC_AGENT.candidateConfirm,
    h((_e, candidateId: number): CandidateView => {
      const id = z.number().int().positive().parse(candidateId)
      const r = confirmCandidate(state.db, id) // 「已在库中→加入图谱」；库外禁用提示 M6（D117）
      broadcastCandidates(r.candidate.graphId, r.sessionId)
      return r.candidate
    })
  )
  ipcMain.handle(
    IPC_AGENT.candidateIgnore,
    h((_e, candidateId: number): CandidateView => {
      const id = z.number().int().positive().parse(candidateId)
      const v = ignoreCandidate(state.db, id)
      broadcastCandidates(v.candidate.graphId, v.sessionId)
      return v.candidate
    })
  )
  ipcMain.handle(IPC_AGENT.listCandidates, h((_e, graphId: number): CandidateView[] => listCandidates(state.db, z.number().int().positive().parse(graphId))))
  ipcMain.handle(
    IPC_AGENT.cardLiveStates,
    h((_e, graphId: number, queries: CardLiveQuery[]) => {
      const parsed = z
        .array(
          z.object({
            key: z.string().min(1).max(200),
            candidateId: z.number().int().positive().nullable().optional(),
            paperId: z.number().int().positive().nullable().optional(),
            doi: z.string().max(300).nullable().optional(),
            arxivId: z.string().max(120).nullable().optional()
          })
        )
        .max(500)
        .parse(queries)
      return cardLiveStates(state.db, z.number().int().positive().parse(graphId), parsed)
    })
  )
  ipcMain.handle(
    IPC_AGENT.moveCandidate,
    h((_e, candidateId: number, x: number, y: number) => {
      moveCandidate(
        state.db,
        z.number().int().positive().parse(candidateId),
        z.number().finite().parse(x),
        z.number().finite().parse(y)
      )
    })
  )
  ipcMain.handle(IPC_AGENT.sessionCost, h((_e, sessionId: number) => sessionCost(state.db, z.number().int().positive().parse(sessionId))))
  ipcMain.handle(
    IPC_AGENT.sessionCostBreakdown,
    h((_e, sessionId: number) => sessionCostBreakdown(state.db, z.number().int().positive().parse(sessionId)))
  )

  return runtime
}
