import type { PaperSummary } from '../../../shared/ipc'

/**
 * uat5 必须修 4：候选确认的乐观更新（画布）。
 *
 * 确认点击的同一 tick 内：候选虚线节点撤下、换成正式论文节点样式、顶栏计数 +1；
 * 后台导入 / 解析照旧走 event:cand:progress；失败经 ROLLBACK 事件回滚（候选节点
 * 回来）并由触发方 toast。成功路径不变（gt:graph-changed 重载用真实数据替换占位）。
 *
 * 事件走 window CustomEvent（与既有 gt:graph-changed / gt:open-paper 同口径），
 * CandidateNode（画布）派发、GraphPage 监听；纯函数层供单测。
 */

export const CAND_CONFIRM_START = 'gt:cand-confirm-start'
export const CAND_CONFIRM_ROLLBACK = 'gt:cand-confirm-rollback'

export interface CandOptimisticEntry {
  candidateId: number
  /** 已在库中候选的真实论文 id；库外导入进行中为 null（占位节点，完成后来源数据替换） */
  paperId: number | null
  title: string
  authors: string[]
  year: number | null
  x: number
  y: number
}

export function withCandConfirmStart(m: Map<number, CandOptimisticEntry>, e: CandOptimisticEntry): Map<number, CandOptimisticEntry> {
  const n = new Map(m)
  n.set(e.candidateId, e)
  return n
}

export function withCandConfirmRollback(m: Map<number, CandOptimisticEntry>, candidateId: number): Map<number, CandOptimisticEntry> {
  const n = new Map(m)
  n.delete(candidateId)
  return n
}

/**
 * uat5-fix1 M2：gt:graph-changed 重载完成后修剪乐观项——候选已不再是 pending
 * （确认成功 → 真实成员节点已到场，乐观占位必须撤掉，否则同 id 两套节点、
 * 计数一直多 1）；仍是 pending 的保留（如确认失败后的回滚窗口）。返回原 Map
 * 引用表示无变化（避免无谓重渲）。
 */
export function pruneCandOptimistic(
  m: Map<number, CandOptimisticEntry>,
  pendingCandidateIds: ReadonlySet<number>
): Map<number, CandOptimisticEntry> {
  if (m.size === 0) return m
  let changed = false
  const n = new Map<number, CandOptimisticEntry>()
  for (const [k, v] of m) {
    if (pendingCandidateIds.has(k)) n.set(k, v)
    else changed = true
  }
  return changed ? n : m
}

/** 乐观论文节点用的占位摘要（hasPdf 未知按 false，完成重载后由真实数据替换） */
export function optimisticPaperOf(e: CandOptimisticEntry): PaperSummary {
  return {
    id: e.paperId != null && e.paperId > 0 ? e.paperId : -e.candidateId,
    title: e.title,
    firstAuthor: e.authors[0] ?? null,
    year: e.year,
    hasPdf: false,
    doi: null,
    arxivId: null,
    source: 'agent',
    inGraph: true
  }
}

export function dispatchCandConfirmStart(e: CandOptimisticEntry): void {
  window.dispatchEvent(new CustomEvent(CAND_CONFIRM_START, { detail: e }))
}

export function dispatchCandConfirmRollback(candidateId: number): void {
  window.dispatchEvent(new CustomEvent(CAND_CONFIRM_ROLLBACK, { detail: candidateId }))
}
