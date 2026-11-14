import { ipcRenderer } from 'electron'
import {
  IPC_AGENT,
  type AgentApi,
  type AgentCandidatesEvent,
  type AgentStreamEvent,
  type CandidateView,
  type CardLiveQuery,
  type CardLiveState,
  type ChatMessageView,
  type CreateSessionInput,
  type SendInput,
  type SessionEntryType,
  type SessionCostBreakdown,
  type SessionSummary
} from '../../shared/ipc/agent'

/**
 * M5 lane/agent 车道的 preload 片段（骨架，M5 预备提交建立）。
 * 主进程实装归 lane/agent（src/main/ipc/agent.ts）；本文件只做 invoke 转发与
 * 事件 on/off 封装（对齐 core.ts / detail.ts 口径，返回取消订阅函数），
 * 车道期间不改（通道与类型都在 src/shared/ipc/agent.ts 契约里）。
 */
export const agentApi: AgentApi = {
  listSessions: (graphId: number, entryType: SessionEntryType, entryId: number | null) =>
    ipcRenderer.invoke(IPC_AGENT.listSessions, graphId, entryType, entryId) as Promise<SessionSummary[]>,
  createSession: (input: CreateSessionInput) =>
    ipcRenderer.invoke(IPC_AGENT.createSession, input) as Promise<SessionSummary>,
  renameSession: (sessionId: number, name: string) =>
    ipcRenderer.invoke(IPC_AGENT.renameSession, sessionId, name) as Promise<void>,
  deleteSession: (sessionId: number) => ipcRenderer.invoke(IPC_AGENT.deleteSession, sessionId) as Promise<void>,
  getMessages: (sessionId: number) => ipcRenderer.invoke(IPC_AGENT.getMessages, sessionId) as Promise<ChatMessageView[]>,
  send: (input: SendInput) => ipcRenderer.invoke(IPC_AGENT.send, input) as Promise<void>,
  stop: (sessionId: number) => ipcRenderer.invoke(IPC_AGENT.stop, sessionId) as Promise<void>,
  retryMessage: (sessionId: number, messageId: number) =>
    ipcRenderer.invoke(IPC_AGENT.retryMessage, sessionId, messageId) as Promise<void>,
  candidateConfirm: (candidateId: number) =>
    ipcRenderer.invoke(IPC_AGENT.candidateConfirm, candidateId) as Promise<CandidateView>,
  candidateIgnore: (candidateId: number) =>
    ipcRenderer.invoke(IPC_AGENT.candidateIgnore, candidateId) as Promise<CandidateView>,
  listCandidates: (graphId: number) => ipcRenderer.invoke(IPC_AGENT.listCandidates, graphId) as Promise<CandidateView[]>,
  cardLiveStates: (graphId: number, queries: CardLiveQuery[]) =>
    ipcRenderer.invoke(IPC_AGENT.cardLiveStates, graphId, queries) as Promise<CardLiveState[]>,
  moveCandidate: (candidateId: number, x: number, y: number) =>
    ipcRenderer.invoke(IPC_AGENT.moveCandidate, candidateId, x, y) as Promise<void>,
  sessionCost: (sessionId: number) => ipcRenderer.invoke(IPC_AGENT.sessionCost, sessionId) as Promise<number>,
  sessionCostBreakdown: (sessionId: number) =>
    ipcRenderer.invoke(IPC_AGENT.sessionCostBreakdown, sessionId) as Promise<SessionCostBreakdown>,
  appendSystemNote: (sessionId: number, text: string) =>
    ipcRenderer.invoke(IPC_AGENT.appendSystemNote, sessionId, text) as Promise<ChatMessageView>,
  onSessionCost: (cb: (e: { sessionId: number }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: { sessionId: number }): void => cb(ev)
    ipcRenderer.on(IPC_AGENT.eventSessionCost, listener)
    return () => {
      ipcRenderer.removeListener(IPC_AGENT.eventSessionCost, listener)
    }
  },
  onAgentStream: (cb: (e: AgentStreamEvent) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: AgentStreamEvent): void => cb(ev)
    ipcRenderer.on(IPC_AGENT.eventStream, listener)
    return () => {
      ipcRenderer.removeListener(IPC_AGENT.eventStream, listener)
    }
  },
  onAgentCandidates: (cb: (e: AgentCandidatesEvent) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: AgentCandidatesEvent): void => cb(ev)
    ipcRenderer.on(IPC_AGENT.eventCandidates, listener)
    return () => {
      ipcRenderer.removeListener(IPC_AGENT.eventCandidates, listener)
    }
  }
}
