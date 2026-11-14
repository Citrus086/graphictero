import type Database from 'better-sqlite3'
import type { CardLiveQuery, CardLiveState } from '../../shared/ipc/agent'

/**
 * uat8b D191：旧会话里的候选卡片按论文当前状态刷新。
 * 只读、按候选 id / 论文 id / DOI / arXiv 批量查，不改历史消息。
 *
 * 优先级：已软删 > 仍在本图谱 > 已忽略 > 仍待确认 > 在库但不在本图谱 > 无法判断。
 */

const KIND_RANK: Record<string, number> = { pending: 0, ignored: 1, confirmed: 2, dismissed: 3 }

export function classifyCardLive(input: {
  candidateStatus: string | null
  paperDeleted: boolean
  paperKnown: boolean
  inGraph: boolean
}): CardLiveState['kind'] {
  if (input.paperDeleted) return 'deleted'
  if (input.paperKnown && input.inGraph) return 'in_graph'
  if (input.candidateStatus === 'ignored') return 'ignored'
  if (input.candidateStatus === 'pending') return 'pending'
  if (input.paperKnown) return 'in_library'
  return 'unknown'
}

function normDoi(value: string | null | undefined): string | null {
  const text = value?.trim().toLowerCase() ?? ''
  return text.length > 0 ? text : null
}

function normArxiv(value: string | null | undefined): string | null {
  const text = value?.trim() ?? ''
  return text.length > 0 ? text : null
}

interface CandRow {
  id: number
  status: string
  doi: string | null
  arxiv_id: string | null
  existing_paper_id: number | null
  paper_id: number | null
}

interface PaperRow {
  id: number
  doi: string | null
  arxiv_id: string | null
  deleted_at: string | null
}

function preferCandidate(rows: CandRow[]): CandRow | null {
  if (rows.length === 0) return null
  return [...rows].sort((a, b) => (KIND_RANK[a.status] ?? 9) - (KIND_RANK[b.status] ?? 9) || b.id - a.id)[0]
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export function cardLiveStates(db: Database.Database, graphId: number, queries: readonly CardLiveQuery[]): CardLiveState[] {
  if (!Number.isInteger(graphId) || graphId <= 0) throw new Error('图谱不存在')
  if (queries.length === 0) return []

  const candidateIds = new Set<number>()
  const paperIds = new Set<number>()
  const dois = new Set<string>()
  const arxivs = new Set<string>()
  for (const query of queries) {
    if (query.candidateId != null && query.candidateId > 0) candidateIds.add(query.candidateId)
    if (query.paperId != null && query.paperId > 0) paperIds.add(query.paperId)
    const doi = normDoi(query.doi)
    const arxiv = normArxiv(query.arxivId)
    if (doi) dois.add(doi)
    if (arxiv) arxivs.add(arxiv)
  }

  const candidates: CandRow[] = []
  for (const ids of chunk([...candidateIds], 200)) {
    if (ids.length === 0) continue
    candidates.push(
      ...db.prepare(
        `SELECT id, status, doi, arxiv_id, existing_paper_id, paper_id
         FROM graph_candidates WHERE graph_id = ? AND id IN (${ids.map(() => '?').join(',')})`
      ).all(graphId, ...ids) as CandRow[]
    )
  }
  for (const batch of chunk([...dois], 200)) {
    candidates.push(
      ...db.prepare(
        `SELECT id, status, doi, arxiv_id, existing_paper_id, paper_id
         FROM graph_candidates WHERE graph_id = ? AND lower(trim(doi)) IN (${batch.map(() => '?').join(',')})`
      ).all(graphId, ...batch) as CandRow[]
    )
  }
  for (const batch of chunk([...arxivs], 200)) {
    candidates.push(
      ...db.prepare(
        `SELECT id, status, doi, arxiv_id, existing_paper_id, paper_id
         FROM graph_candidates WHERE graph_id = ? AND trim(arxiv_id) IN (${batch.map(() => '?').join(',')})`
      ).all(graphId, ...batch) as CandRow[]
    )
  }

  const candById = new Map<number, CandRow>()
  const candByDoi = new Map<string, CandRow[]>()
  const candByArxiv = new Map<string, CandRow[]>()
  for (const row of candidates) {
    candById.set(row.id, row)
    const doi = normDoi(row.doi)
    const arxiv = normArxiv(row.arxiv_id)
    if (doi) candByDoi.set(doi, [...(candByDoi.get(doi) ?? []), row])
    if (arxiv) candByArxiv.set(arxiv, [...(candByArxiv.get(arxiv) ?? []), row])
    if (row.existing_paper_id != null) paperIds.add(row.existing_paper_id)
    if (row.paper_id != null) paperIds.add(row.paper_id)
  }

  const papers: PaperRow[] = []
  for (const ids of chunk([...paperIds], 200)) {
    papers.push(
      ...db.prepare(
        `SELECT id, doi, arxiv_id, deleted_at FROM papers WHERE id IN (${ids.map(() => '?').join(',')})`
      ).all(...ids) as PaperRow[]
    )
  }
  for (const batch of chunk([...dois], 200)) {
    papers.push(
      ...db.prepare(
        `SELECT id, doi, arxiv_id, deleted_at FROM papers WHERE lower(trim(doi)) IN (${batch.map(() => '?').join(',')})`
      ).all(...batch) as PaperRow[]
    )
  }
  for (const batch of chunk([...arxivs], 200)) {
    papers.push(
      ...db.prepare(
        `SELECT id, doi, arxiv_id, deleted_at FROM papers WHERE trim(arxiv_id) IN (${batch.map(() => '?').join(',')})`
      ).all(...batch) as PaperRow[]
    )
  }

  const paperById = new Map<number, PaperRow>()
  const paperByDoi = new Map<string, PaperRow>()
  const paperByArxiv = new Map<string, PaperRow>()
  const putIdent = (map: Map<string, PaperRow>, key: string | null, row: PaperRow): void => {
    if (!key) return
    const prev = map.get(key)
    if (!prev || (prev.deleted_at != null && row.deleted_at == null)) map.set(key, row)
  }
  for (const row of papers) {
    paperById.set(row.id, row)
    putIdent(paperByDoi, normDoi(row.doi), row)
    putIdent(paperByArxiv, normArxiv(row.arxiv_id), row)
  }

  const memberIds = new Set<number>()
  const aliveIds = [...paperById.values()].filter((p) => p.deleted_at == null).map((p) => p.id)
  for (const ids of chunk(aliveIds, 200)) {
    const rows = db.prepare(
      `SELECT paper_id AS paperId FROM graph_members WHERE graph_id = ? AND paper_id IN (${ids.map(() => '?').join(',')})`
    ).all(graphId, ...ids) as Array<{ paperId: number }>
    for (const row of rows) memberIds.add(row.paperId)
  }

  return queries.map((query) => {
    const doi = normDoi(query.doi)
    const arxiv = normArxiv(query.arxivId)
    const cand =
      (query.candidateId != null ? candById.get(query.candidateId) : undefined) ??
      (doi ? preferCandidate(candByDoi.get(doi) ?? []) : null) ??
      (arxiv ? preferCandidate(candByArxiv.get(arxiv) ?? []) : null)
    const paper =
      (query.paperId != null ? paperById.get(query.paperId) : undefined) ??
      (cand?.existing_paper_id != null ? paperById.get(cand.existing_paper_id) : undefined) ??
      (cand?.paper_id != null ? paperById.get(cand.paper_id) : undefined) ??
      (doi ? paperByDoi.get(doi) : undefined) ??
      (arxiv ? paperByArxiv.get(arxiv) : undefined) ??
      null
    const kind = classifyCardLive({
      candidateStatus: cand?.status ?? null,
      paperDeleted: paper?.deleted_at != null,
      paperKnown: paper != null,
      inGraph: paper != null && paper.deleted_at == null && memberIds.has(paper.id)
    })
    return {
      key: query.key,
      kind,
      paperId: paper?.deleted_at == null ? paper?.id ?? null : paper?.id ?? null,
      candidateId: cand?.id ?? query.candidateId ?? null
    }
  })
}
