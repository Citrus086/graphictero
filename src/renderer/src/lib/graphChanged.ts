import type { AgentStreamEvent } from '../../../shared/ipc/agent'

/**
 * uat3b 必须修 1：Agent 回合改图（data-graph-change part 定稿）后刷新画布与顶栏。
 *
 * 事件路径（写进进度文档）：主进程 runtime 回合末对每个改图小结发 `part-done`
 *（event:agent:stream）→ 渲染层 useAgentSession 的流订阅收到 → 这里派发渲染层
 * window CustomEvent `gt:graph-changed` → GraphPage 监听（reload + listCandidates）。
 * 与候选确认/撤销/done 刷新共用同一事件与监听，不另造事件。
 * 只有真正改图成功的 part 才触发；addRelation 被拒（D143）根本不发 part，天然不漏不误报。
 */

export function isGraphChangePartDone(e: AgentStreamEvent): boolean {
  return e.kind === 'part-done' && e.part.type === 'data-graph-change'
}

/** 改图小结定稿 → 派发 gt:graph-changed；返回是否派发（测试用）。 */
export function dispatchGraphChangedIfNeeded(e: AgentStreamEvent): boolean {
  if (!isGraphChangePartDone(e)) return false
  window.dispatchEvent(new CustomEvent('gt:graph-changed'))
  return true
}
