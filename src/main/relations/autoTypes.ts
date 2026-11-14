import type Database from 'better-sqlite3'
import type { RelationType } from '../../shared/relationTypes'

/**
 * 自动类型（D84/D89/D93）：程序只在 LLM 建的边上附加「引用」「同一作者」，
 * 标「自动」、只读；只有引用关系而 LLM 没连的论文对不单独建边（D89）。
 *
 * - 引用：paper_references（openalex 与 deepseek 兜底都算）里 A 的参考文献匹配到
 *   B，则 A 引用了 B；D89 方向以引用数据为准：被引方 → 引用方（B → A，
 *   即「dst 基于/针对 src」里 A 是被引的早期工作）；
 * - 同一作者（D93）：paper_authors 规范化名精确相等的共同作者，不做模糊匹配
 *   与缩写推断。
 */

export interface AutoTypeResult {
  autoTypes: RelationType[]
  /** 引用数据推定的方向（被引方 → 引用方）；无引用信号时保持 LLM 原方向 */
  srcPaperId: number
  dstPaperId: number
}

function refsMatching(db: Database.Database, paperId: number): Set<number> {
  const rows = db
    .prepare('SELECT matched_paper_id FROM paper_references WHERE paper_id = ? AND matched_paper_id IS NOT NULL')
    .all(paperId) as Array<{ matched_paper_id: number }>
  return new Set(rows.map((r) => r.matched_paper_id))
}

export function hasCommonAuthor(db: Database.Database, paperA: number, paperB: number): boolean {
  const names = (pid: number): Set<string> => {
    const rows = db.prepare('SELECT normalized FROM paper_authors WHERE paper_id = ?').all(pid) as Array<{ normalized: string }>
    return new Set(rows.map((r) => r.normalized))
  }
  const a = names(paperA)
  if (a.size === 0) return false
  for (const n of names(paperB)) if (a.has(n)) return true
  return false
}

/** 计算一条 LLM 边的自动附加类型与引用推定方向。只查库，不写库。 */
export function computeAutoTypes(
  db: Database.Database,
  graphId: number,
  srcPaperId: number,
  dstPaperId: number
): AutoTypeResult {
  const autoTypes: RelationType[] = []

  // 引用信号（只看本图谱内的引用：边属于图谱，D5）
  const members = new Set(
    (db.prepare('SELECT paper_id FROM graph_members WHERE graph_id = ?').all(graphId) as Array<{ paper_id: number }>).map(
      (r) => r.paper_id
    )
  )
  const inGraph = (pid: number): boolean => members.has(pid)
  const srcRefs = refsMatching(db, srcPaperId)
  const dstRefs = refsMatching(db, dstPaperId)
  // src 引用了 dst → dst 是被引方 → 方向 dst → src
  const srcCitesDst = inGraph(dstPaperId) && srcRefs.has(dstPaperId)
  const dstCitesSrc = inGraph(srcPaperId) && dstRefs.has(srcPaperId)
  let outSrc = srcPaperId
  let outDst = dstPaperId
  if (dstCitesSrc && !srcCitesDst) {
    autoTypes.push('cites')
    outSrc = srcPaperId // src 是被引方
    outDst = dstPaperId // dst 是引用方
  } else if (srcCitesDst && !dstCitesSrc) {
    autoTypes.push('cites')
    outSrc = dstPaperId // dst 是被引方
    outDst = srcPaperId // src 是引用方
  } else if (srcCitesDst && dstCitesSrc) {
    autoTypes.push('cites') // 互相引用：加类型但方向维持 LLM 判断
  }

  if (hasCommonAuthor(db, srcPaperId, dstPaperId)) autoTypes.push('same_author')

  return { autoTypes, srcPaperId: outSrc, dstPaperId: outDst }
}

/** 该论文是否已有引用数据（paper_references 任意来源的行）。 */
export function hasReferenceData(db: Database.Database, paperId: number): boolean {
  return !!db.prepare('SELECT 1 AS ok FROM paper_references WHERE paper_id = ? LIMIT 1').get(paperId)
}

/**
 * uat4-fix1 D173（M2）+ uat4-fix2 D174：paper_references 写入后重算相关「基于/改进」边的
 * no_ref_basis。
 *
 * D174（维护者决定）：**只处理 AI 自动边**（source_type='job'，与迁移 084
 * 及 D104 的「auto 边」同一判定）——手工 / session 边不打「AI 推断 · 无引用依据」。
 * 与 084 同口径：关系两端都没有 paper_references 行（引用匹配尚未对该论文对跑过）时
 * **保持现值不动**（0 = 还没核过，不标 1）；核过才按 computeAutoTypes 的 cites 重算，
 * 允许 1→0 与 0→1。由 openalex/references.ts 与 referencesExtract.ts 的写库路径在
 * 事务提交后调用。
 */
export function recalcNoRefBasis(db: Database.Database, paperId: number): void {
  const rows = db
    .prepare(
      `SELECT id, graph_id, paper_low, paper_high, src_paper, llm_types
       FROM relations
       WHERE deleted_at IS NULL AND source_type = 'job' AND (paper_low = ? OR paper_high = ?)`
    )
    .all(paperId, paperId) as Array<{ id: number; graph_id: number; paper_low: number; paper_high: number; src_paper: number; llm_types: string }>
  const upd = db.prepare('UPDATE relations SET no_ref_basis = ? WHERE id = ?')
  for (const r of rows) {
    let llmTypes: RelationType[] = []
    try {
      llmTypes = JSON.parse(r.llm_types) as RelationType[]
    } catch {
      continue
    }
    if (!llmTypes.includes('based_on')) continue // 只重算「基于/改进」边（D150 口径）
    const dst = r.paper_low === r.src_paper ? r.paper_high : r.paper_low
    // D174/084 同口径：引用证据尚未核过（两端都无 paper_references 行）→ 保持现值
    if (!hasReferenceData(db, r.src_paper) && !hasReferenceData(db, dst)) continue
    const auto = computeAutoTypes(db, r.graph_id, r.src_paper, dst)
    upd.run(auto.autoTypes.includes('cites') ? 0 : 1, r.id)
  }
}
