import type { CandidateView } from '../../../shared/ipc/agent'

/** 画布上的候选：待确认，且不在本图谱（D161：在图中的只出卡片）。 */
export function canvasCandidates(candidates: CandidateView[]): CandidateView[] {
  return candidates.filter((c) => c.status === 'pending' && !c.inGraph)
}

/**
 * 候选坐标。库里已有非 (0,0) 的用原值；缺坐标的堆在现有内容左下方，
 * 避开右侧对话抽屉。
 */
export function candidatePositions(
  members: Array<{ x: number; y: number }>,
  candidates: CandidateView[]
): Map<number, { x: number; y: number }> {
  const placed = members.map((m) => ({ x: m.x, y: m.y }))
  const out = new Map<number, { x: number; y: number }>()
  for (const c of candidates) {
    if (c.x !== 0 || c.y !== 0) {
      out.set(c.id, { x: c.x, y: c.y })
      placed.push({ x: c.x, y: c.y })
      continue
    }
    const pos =
      placed.length === 0
        ? { x: 12, y: 12 }
        : { x: Math.min(...placed.map((p) => p.x)), y: Math.max(...placed.map((p) => p.y)) + 160 }
    out.set(c.id, pos)
    placed.push(pos)
  }
  return out
}
