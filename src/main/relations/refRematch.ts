import type Database from 'better-sqlite3'
import { titleSim } from '../openalex/match'
import { matchRefToLibrary, normDoi } from '../openalex/references'
import { arxivIdOf } from './referencesExtract'
import { computeAutoTypes, recalcNoRefBasis } from './autoTypes'
import type { RelationType } from '../../shared/relationTypes'

/**
 * uat6 M2：已有 paper_references 行的幂等重匹配（迁移 086）。
 *
 * 背景：matched_paper_id 原本只在 INSERT 时写一次（openalex/references.ts、
 * referencesExtract.ts）——D165 修好匹配逻辑后，旧行（matched_paper_id 全 NULL）
 * 永远不会被重新匹配，引用边（cites）补不上、no_ref_basis 停在过期值。
 *
 * 口径（任务书/uat6）：
 * - 只重匹配 **matched_paper_id IS NULL** 的行；原已非空的行一律不动（默认不清空
 *   已有非空值，即使按现行规则判不匹配——避免旧数据来回抖动）；
 * - 匹配逻辑**复用 D165 修好的同一套函数**（不复制新逻辑）：
 *   W-ID → DOI（normDoi）→ 标题三条阈值 = openalex/references.ts 的
 *   matchRefToLibrary；arXiv 径（arxivIdOf 归一 + byArxiv 索引）同
 *   referencesExtract.ts 的 deepseek 写库路径；顺序 W-ID → DOI → arXiv → 标题；
 * - 只用库内 papers 元数据（deleted_at IS NULL），**不联网、不调任何付费 API**；
 * - 只更新 matched_paper_id 列；随后按 **D174** 对受影响论文重算 **AI 自动边**
 *   （source_type='job'）的 auto_types（引用 cites，复用 computeAutoTypes，同
 *   generator 附加口径；不改 src_paper 方向、不写 statement_text、不改 updated_at，
 *   与 084 口径一致）并复用 recalcNoRefBasis 重算 no_ref_basis（1→0 / 0→1 都允许；
 *   两端无 paper_references 行的保持现值）。手工 / session 边完全不动。
 * - 幂等：第二遍只剩「匹配不上」的 NULL 行，无任何写库（测试锁定表级快照一致）。
 */

interface LibPaper {
  id: number
  title: string
  firstAuthor: string | null
  year: number | null
  doi: string | null
  wid: string | null
  arxivId: string | null
}

interface RefRow {
  id: number
  paper_id: number
  openalex_wid: string | null
  doi: string | null
  title: string | null
  year: number | null
  matched_paper_id: number | null
}

export interface RematchResult {
  /** 本次填上 matched_paper_id 的行数 */
  filled: number
  /** 受影响（有行被填上）的论文 id（去重） */
  papersTouched: number[]
}

/** 库内论文匹配索引（未删除；口径同 referencesExtract 写库路径 + matchRefToLibrary） */
function buildLibraryIndex(db: Database.Database): {
  byWid: Map<string, LibPaper>
  byDoi: Map<string, LibPaper>
  byArxiv: Map<string, number>
  all: LibPaper[]
} {
  const all = db
    .prepare('SELECT id, title, first_author AS firstAuthor, year, doi, openalex_wid AS wid, arxiv_id AS arxivId FROM papers WHERE deleted_at IS NULL')
    .all() as LibPaper[]
  const byWid = new Map(all.filter((p) => p.wid).map((p) => [p.wid!.toUpperCase(), p]))
  const byDoi = new Map(all.filter((p) => p.doi).map((p) => [normDoi(p.doi!), p]))
  // arXiv 径索引：与 referencesExtract.ts 的 deepseek 写库路径同口径
  const byArxiv = new Map<string, number>()
  for (const p of all) {
    const a = arxivIdOf(p.arxivId) ?? arxivIdOf(p.doi)
    if (a && !byArxiv.has(a)) byArxiv.set(a, p.id)
  }
  return { byWid, byDoi, byArxiv, all }
}

/** 重匹配单条引用行；返回匹配到的库内论文 id（匹配不上返回 null）。 */
function matchRow(
  row: RefRow,
  lib: ReturnType<typeof buildLibraryIndex>
): number | null {
  // W-ID → DOI → 标题三条阈值：直接复用 D165 修好的 matchRefToLibrary
  const viaOpenAlex = matchRefToLibrary(
    {
      wid: row.openalex_wid ?? '',
      doi: row.doi,
      title: row.title,
      publicationYear: row.year,
      firstAuthorSurname: null,
      referencedWorks: []
    },
    { byWid: lib.byWid, byDoi: lib.byDoi, all: lib.all }
  )
  if (viaOpenAlex != null) return viaOpenAlex
  // arXiv 径（D165）：与 referencesExtract 的 deepseek 写库路径同顺序、同归一
  const arxiv = arxivIdOf(row.doi)
  if (arxiv && lib.byArxiv.has(arxiv)) return lib.byArxiv.get(arxiv)!
  // 标题三条阈值兜底（matchRefToLibrary 已含 0.95 / 姓 / 年份 ±1；行内无姓信息自动放行）
  if (row.title) {
    let best: { id: number; sim: number } | null = null
    for (const p of lib.all) {
      const sim = titleSim(row.title, p.title)
      if (sim < 0.95) continue
      const yearOk = row.year == null || p.year == null || Math.abs(p.year - row.year) <= 1
      if (!yearOk) continue
      if (!best || sim > best.sim) best = { id: p.id, sim }
    }
    if (best) return best.id
  }
  return null
}

/**
 * 幂等重匹配全部 matched_paper_id IS NULL 的引用行，并按 D174 重算受影响 AI 边的
 * auto_types（cites）与 no_ref_basis。离线（只读本地表），可在迁移里安全调用。
 */
export function rematchPaperReferences(db: Database.Database): RematchResult {
  const rows = db
    .prepare('SELECT id, paper_id, openalex_wid, doi, title, year, matched_paper_id FROM paper_references WHERE matched_paper_id IS NULL')
    .all() as RefRow[]
  const lib = buildLibraryIndex(db)
  const upd = db.prepare('UPDATE paper_references SET matched_paper_id = ? WHERE id = ?')
  const filled: number[] = []
  for (const row of rows) {
    const matched = matchRow(row, lib)
    if (matched == null) continue
    upd.run(matched, row.id)
    filled.push(row.paper_id)
  }
  const papersTouched = [...new Set(filled)]
  if (papersTouched.length === 0) return { filled: filled.length, papersTouched }

  // D174 重算：只处理 AI 自动边（source_type='job'），手工 / session 边不动。
  // 只写 auto_types 与 no_ref_basis；不改方向、不写 statement_text、不改 updated_at。
  const autoTypesOf = (json: string): RelationType[] => {
    try {
      return JSON.parse(json) as RelationType[]
    } catch {
      return []
    }
  }
  const sameTypes = (a: RelationType[], b: RelationType[]): boolean =>
    a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|')
  const updAuto = db.prepare('UPDATE relations SET auto_types = ? WHERE id = ?')
  const affected = db.prepare(
    `SELECT id, graph_id, paper_low, paper_high, src_paper, auto_types
     FROM relations
     WHERE deleted_at IS NULL AND source_type = 'job' AND (paper_low = ? OR paper_high = ?)`
  )
  for (const pid of papersTouched) {
    for (const r of affected.all(pid, pid) as Array<{ id: number; graph_id: number; paper_low: number; paper_high: number; src_paper: number; auto_types: string }>) {
      const dst = r.paper_low === r.src_paper ? r.paper_high : r.paper_low
      const auto = computeAutoTypes(db, r.graph_id, r.src_paper, dst)
      if (!sameTypes(autoTypesOf(r.auto_types), auto.autoTypes)) {
        updAuto.run(JSON.stringify(auto.autoTypes), r.id)
      }
    }
    // no_ref_basis 重算复用既有函数（D174/084 同口径：只动 job 边、两端无行保持现值）
    recalcNoRefBasis(db, pid)
  }
  return { filled: filled.length, papersTouched }
}
