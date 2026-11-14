import { describe, expect, it } from 'vitest'
import type { CandidateView } from '../../../shared/ipc/agent'
import { canvasCandidates, candidatePositions } from './candidateLayout'

function cand(partial: Partial<CandidateView> & Pick<CandidateView, 'id'>): CandidateView {
  return {
    graphId: 1,
    title: 't',
    authors: [],
    year: null,
    doi: null,
    arxivId: null,
    existingPaperId: null,
    reason: null,
    x: 0,
    y: 0,
    status: 'pending',
    createdAt: '',
    updatedAt: '',
    ...partial
  }
}

describe('候选画布布局', () => {
  it('在图中的 pending 不进画布；已确认的也不进', () => {
    const rows = canvasCandidates([
      cand({ id: 1 }),
      cand({ id: 2, inGraph: true }),
      cand({ id: 3, status: 'confirmed' })
    ])
    expect(rows.map((c) => c.id)).toEqual([1])
  })

  it('(0,0) 落在成员左下方并纵向堆叠；已有坐标保持', () => {
    const pos = candidatePositions(
      [{ x: 100, y: 100 }],
      [cand({ id: 1 }), cand({ id: 2, x: 40, y: 50 })]
    )
    expect(pos.get(1)).toEqual({ x: 100, y: 260 })
    expect(pos.get(2)).toEqual({ x: 40, y: 50 })
  })
})
