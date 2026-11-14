import type Database from 'better-sqlite3'
import type { OpenAlexClient, OpenAlexWork } from './client'
import { findTitleMatch, titleSim } from './match'
import { recalcNoRefBasis } from '../relations/autoTypes'

/**
 * OpenAlex 引用数据落库（D40(a)/D49/D71）：
 *
 * 1. 解析论文的 OpenAlex work：优先已有 W-ID → DOI → 按标题找回（三条阈值，
 *    找回的 DOI 记 papers.doi_match_method='openalex_title'，不参与自动去重）；
 * 2. referenced_works 只有 W-ID 列表——批量取回各篇元数据（每 50 个一 filter 批），
 *    与库内论文按 W-ID → DOI → 标题（同三条阈值）匹配，写 paper_references
 *    （source='openalex'，matched_paper_id 未匹配为空）；
 * 3. OpenAlex 查不到本篇或 referenced_works 为空（最新预印本常态，M0 实测）时
 *    返回 workFound/refCount 供上层走 D40 deepseek 兜底；本函数不写 deepseek 行。
 *
 * 写入口径：先清本篇 source='openalex' 的旧行再插（同一来源幂等重取）；
 * deepseek 行由兜底路径自己管理，不被清掉。
 * 网络/限流错误抛 RetryableLlmError/NetworkLlmError，由任务引擎分类重试。
 */

export interface FetchOpenAlexRefsResult {
  workFound: boolean
  wid: string | null
  /** 按标题找回的 DOI（无找回为 null） */
  recoveredDoi: string | null
  /** referenced_works 条数（workFound 为 false 时为 0） */
  refCount: number
  /** 匹配到库内论文的条数 */
  matchedCount: number
  /** 本次写入的 paper_references 行数 */
  wroteCount: number
}

interface LibraryPaper {
  id: number
  title: string
  firstAuthor: string | null
  year: number | null
  doi: string | null
  wid: string | null
}

/** DOI 规范化：剥 https?://(dx.)?doi.org/ 前缀 + 小写（referencesExtract DOI 匹配共用） */
export function normDoi(doi: string): string {
  return doi.trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
}

/** 匹配一条参考文献到库内论文：W-ID 精确 → DOI 精确 → 标题三条阈值（D71） */
export function matchRefToLibrary(
  ref: OpenAlexWork,
  lib: { byWid: Map<string, LibraryPaper>; byDoi: Map<string, LibraryPaper>; all: LibraryPaper[] }
): number | null {
  if (ref.wid && lib.byWid.has(ref.wid)) return lib.byWid.get(ref.wid)!.id
  if (ref.doi && lib.byDoi.has(normDoi(ref.doi))) return lib.byDoi.get(normDoi(ref.doi))!.id
  if (ref.title) {
    let best: { id: number; sim: number } | null = null
    for (const p of lib.all) {
      const sim = titleSim(ref.title, p.title)
      if (sim < 0.95) continue // 阈值①
      // 阈值②（参考方无姓信息时放行；库内论文缺 first_author 时无法核姓，uat4 D165：
      // 不因此拒掉 0.95 以上的标题强匹配）
      const libSurname = (p.firstAuthor ?? '').toLowerCase()
      const surnameOk = !ref.firstAuthorSurname || !libSurname || libSurname === ref.firstAuthorSurname
      if (!surnameOk) continue
      const yearOk = ref.publicationYear == null || p.year == null || Math.abs(p.year - ref.publicationYear) <= 1
      if (!yearOk) continue // 阈值③
      if (!best || sim > best.sim) best = { id: p.id, sim }
    }
    if (best) return best.id
  }
  return null
}

export async function fetchOpenAlexReferences(
  db: Database.Database,
  client: OpenAlexClient,
  paperId: number
): Promise<FetchOpenAlexRefsResult> {
  const paper = db
    .prepare('SELECT id, title, first_author, year, doi, openalex_wid FROM papers WHERE id = ? AND deleted_at IS NULL')
    .get(paperId) as
    | { id: number; title: string; first_author: string | null; year: number | null; doi: string | null; openalex_wid: string | null }
    | undefined
  if (!paper) throw new Error(`论文 ${paperId} 不存在或已删除`)

  // 1. 解析本篇的 work
  let work: OpenAlexWork | null = null
  let recoveredDoi: string | null = null
  if (paper.openalex_wid) {
    work = await client.fetchWorkByWid(paper.openalex_wid)
    if (!work && paper.doi) work = await client.fetchWorkByDoi(paper.doi)
  } else if (paper.doi) {
    work = await client.fetchWorkByDoi(paper.doi)
  } else {
    // D49：没有 DOI 时按标题找回（三条阈值）；仍查不到就留空
    const candidates = await client.searchWorksByTitle(paper.title)
    work = findTitleMatch(
      { title: paper.title, firstAuthor: paper.first_author, year: paper.year },
      candidates
    )
    if (work?.doi) {
      recoveredDoi = work.doi
      db.prepare("UPDATE papers SET doi = ?, doi_match_method = 'openalex_title', updated_at = ? WHERE id = ?").run(
        work.doi,
        new Date().toISOString(),
        paperId
      )
    }
  }
  if (!work) return { workFound: false, wid: null, recoveredDoi, refCount: 0, matchedCount: 0, wroteCount: 0 }

  // 回填 W-ID（按 DOI/标题找回时补记）
  if (work.wid && work.wid !== paper.openalex_wid) {
    db.prepare('UPDATE papers SET openalex_wid = ?, updated_at = ? WHERE id = ?').run(
      work.wid,
      new Date().toISOString(),
      paperId
    )
  }
  if (work.referencedWorks.length === 0) {
    return { workFound: true, wid: work.wid || null, recoveredDoi, refCount: 0, matchedCount: 0, wroteCount: 0 }
  }

  // 2. 库内论文索引（未删除的）
  const all = db
    .prepare('SELECT id, title, first_author AS firstAuthor, year, doi, openalex_wid AS wid FROM papers WHERE deleted_at IS NULL')
    .all() as LibraryPaper[]
  const lib = {
    byWid: new Map(all.filter((p) => p.wid).map((p) => [p.wid!.toUpperCase(), p])),
    byDoi: new Map(all.filter((p) => p.doi).map((p) => [normDoi(p.doi!), p])),
    all
  }

  // 3. 批量取回参考文献元数据并匹配
  const refWorks = await client.fetchWorksByWids(work.referencedWorks)
  const rows: Array<{ ref: OpenAlexWork; matched: number | null }> = refWorks.map((ref) => ({
    ref,
    matched: matchRefToLibrary(ref, lib)
  }))
  // referenced_works 里查不到元数据的（被删/合并的 work）也留一行，title 为空
  const metaByWid = new Map(refWorks.map((r) => [r.wid, r]))
  for (const wid of work.referencedWorks) {
    if (!metaByWid.has(wid)) rows.push({ ref: { wid, doi: null, title: null, publicationYear: null, firstAuthorSurname: null, referencedWorks: [] }, matched: lib.byWid.get(wid)?.id ?? null })
  }

  // 4. 幂等重写本篇的 openalex 引用行（不动 deepseek 兜底行）
  const now = new Date().toISOString()
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM paper_references WHERE paper_id = ? AND source = 'openalex'").run(paperId)
    const ins = db.prepare(
      `INSERT INTO paper_references (paper_id, openalex_wid, doi, title, year, matched_paper_id, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'openalex', ?)`
    )
    for (const { ref, matched } of rows) {
      ins.run(paperId, ref.wid || null, ref.doi, ref.title, ref.publicationYear, matched, now)
    }
  })
  tx()
  // uat4-fix1 D173（M2）：引用数据写入后重算相关「基于/改进」边的 no_ref_basis（允许 1→0）
  recalcNoRefBasis(db, paperId)

  return {
    workFound: true,
    wid: work.wid || null,
    recoveredDoi,
    refCount: work.referencedWorks.length,
    matchedCount: rows.filter((r) => r.matched != null).length,
    wroteCount: rows.length
  }
}
