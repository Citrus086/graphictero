import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type Database from 'better-sqlite3'
import type {
  GraphDetail,
  GraphSummary,
  ImportProgress,
  ImportSummary,
  JobsOverview,
  JobActiveItem,
  PaperSummary,
  RelationInput,
  RelationView,
  ZoteroCollectionItemView,
  ZoteroCollectionNode,
  ZoteroSourceStatus
} from '../shared/ipc'
import { AUTO_RELATION_TYPES, isRelationType, RELATION_TYPE_LABELS, type RelationType } from '../shared/relationTypes'
import { deleteRelation, upsertRelation } from './db/relations'
import { removePaperFts } from './db/fts'
import { shortCiteTitle } from './text/internalRefs'
import { removeFullTextFts } from './db/fulltextFts'
import { enqueueJob, getLlmQueuePauseReason, jobGroupSignature, retryJob, type JobRow } from './jobs/store'
import { MEMBER_RELATION_SQL } from './relations/membership'
import type { PaperParser } from './jobs/mineru'
import { LOCAL_API_BASE, ZoteroLocalApi } from './zotero/localApi'
import { attachmentAbsolutePath, listCollections, openZoteroDatabaseCopy, readCollectionItems, type ZoteroSqliteHandle } from './zotero/sqliteReader'
import { buildPaperMeta, importZoteroItems } from './zotero/importer'

/**
 * M1 第三批的应用服务层：图谱 / 论文库 / 成员与坐标 / 关系 / Zotero 导入编排。
 * 全部为「db + 参数进、纯数据出」的函数，不依赖 electron；
 * index.ts 只做 IPC 接线与对话框，便于 vitest 直接覆盖。
 */

const nowIso = (): string => new Date().toISOString()

function toPaperSummary(row: Record<string, unknown>, inGraph: boolean): PaperSummary {
  return {
    id: row.id as number,
    title: (row.title as string) ?? '',
    firstAuthor: (row.first_author as string | null) ?? null,
    year: (row.year as number | null) ?? null,
    hasPdf: row.has_pdf === 1,
    doi: (row.doi as string | null) ?? null,
    arxivId: (row.arxiv_id as string | null) ?? null,
    source: (row.source as string) ?? 'zotero',
    inGraph
  }
}

// ── 图谱 ────────────────────────────────────────────────────────────────

export function listGraphs(db: Database.Database): GraphSummary[] {
  const rows = db
    .prepare(
      `SELECT g.id, g.name, g.created_at, g.updated_at,
              (SELECT COUNT(*) FROM graph_members m WHERE m.graph_id = g.id) AS paper_count,
              (SELECT COUNT(*) FROM relations r WHERE r.graph_id = g.id AND ${MEMBER_RELATION_SQL}) AS relation_count
       FROM graphs g ORDER BY g.updated_at DESC, g.id DESC`
    )
    .all() as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: r.id as number,
    name: r.name as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    paperCount: r.paper_count as number,
    relationCount: r.relation_count as number
  }))
}

export function createGraph(db: Database.Database, name: string): GraphSummary {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('图谱名称不能为空')
  const now = nowIso()
  const r = db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run(trimmed, now, now)
  return {
    id: Number(r.lastInsertRowid),
    name: trimmed,
    createdAt: now,
    updatedAt: now,
    paperCount: 0,
    relationCount: 0
  }
}

export function getGraphDetail(db: Database.Database, graphId: number): GraphDetail {
  const g = db.prepare('SELECT * FROM graphs WHERE id = ?').get(graphId) as Record<string, unknown> | undefined
  if (!g) throw new Error(`图谱 ${graphId} 不存在`)
  const memberRows = db
    .prepare(
      `SELECT p.*, m.x, m.y FROM graph_members m JOIN papers p ON p.id = m.paper_id
       WHERE m.graph_id = ? ORDER BY m.added_at, m.paper_id`
    )
    .all(graphId) as Array<Record<string, unknown>>
  const members = memberRows.map((r) => ({
    paper: toPaperSummary(r, true),
    x: r.x as number,
    y: r.y as number
  }))
  const relations = listRelations(db, graphId)
  return {
    graph: {
      id: g.id as number,
      name: g.name as string,
      createdAt: g.created_at as string,
      updatedAt: g.updated_at as string,
      paperCount: members.length,
      relationCount: relations.length
    },
    members,
    relations
  }
}

// ── 论文库 ──────────────────────────────────────────────────────────────

/** 整个论文库（不含软删除）；传入 graphId 时标注 inGraph，供「本图谱 / 论文库 · 其他」分组（D90）。 */
export function listLibrary(db: Database.Database, graphId?: number): PaperSummary[] {
  const rows = db
    .prepare(
      `SELECT p.*, ${graphId != null ? 'EXISTS(SELECT 1 FROM graph_members m WHERE m.graph_id = ? AND m.paper_id = p.id)' : '0'} AS in_graph
       FROM papers p WHERE p.deleted_at IS NULL ORDER BY p.updated_at DESC, p.id DESC`
    )
    .all(...(graphId != null ? [graphId] : [])) as Array<Record<string, unknown>>
  return rows.map((r) => toPaperSummary(r, r.in_graph === 1))
}

// ── 图谱成员与坐标（D75：从图谱移除不动论文库）──────────────────────────

/**
 * 添加论文（进图谱，初始坐标 (0,0)）。返回本次真正新增的 paperIds（INSERT OR IGNORE 的
 * changes）——已在上图的论文不重复计数；调用方据此决定是否自动整理
 * （评审建 6：不再用「有 (0,0) 成员」判据，避免用户把节点拖到 (0,0) 后误触发全图重排）。
 */
export function addPapersToGraph(db: Database.Database, graphId: number, paperIds: number[]): number[] {
  const now = nowIso()
  const ins = db.prepare(
    'INSERT OR IGNORE INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)'
  )
  const addedIds: number[] = []
  const tx = db.transaction(() => {
    for (const pid of paperIds) {
      const exists = db.prepare('SELECT 1 FROM papers WHERE id = ? AND deleted_at IS NULL').get(pid)
      if (!exists) throw new Error(`论文 ${pid} 不存在或已删除`)
      if (ins.run(graphId, pid, now).changes > 0) addedIds.push(pid)
    }
    if (addedIds.length > 0) db.prepare('UPDATE graphs SET updated_at = ? WHERE id = ?').run(now, graphId)
  })
  tx()
  return addedIds
}

/** 从图谱移除：只删 graph_members，并把图中与这篇论文相关的边软删除（D75）。
 * Q8（已决：维护者合并时实现）：同时清 (graph, paper) 的 relation_gen_progress 行，
 * 否则移除再加回的论文仍算「已处理」，永远不会再自动生成关系。
 * 返回 hadProgress：移除前该 (graph, paper) 是否有进度行——D148 ⌘Z 撤销凭它决定是否插回
 * （仅当原来有才恢复，不触发重新生成）。
 * uat7b S1：同时返回移除前的原时间戳（成员 added_at、进度 done_at、graphs.updated_at）——
 * 撤销恢复时原样写回，不把这三个时间盖成撤销时刻（D148/D179 同一路径，单个与批量一致）。 */
export function removePaperFromGraph(
  db: Database.Database,
  graphId: number,
  paperId: number
): { hadProgress: boolean; addedAt: string; doneAt: string | null; graphUpdatedAt: string } {
  const now = nowIso()
  const member = db.prepare('SELECT added_at FROM graph_members WHERE graph_id = ? AND paper_id = ?').get(graphId, paperId) as
    | { added_at: string }
    | undefined
  const progress = db
    .prepare('SELECT done_at FROM relation_gen_progress WHERE graph_id = ? AND paper_id = ?')
    .get(graphId, paperId) as { done_at: string } | undefined
  const graph = db.prepare('SELECT updated_at FROM graphs WHERE id = ?').get(graphId) as { updated_at: string }
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM graph_members WHERE graph_id = ? AND paper_id = ?').run(graphId, paperId)
    db.prepare(
      `UPDATE relations SET deleted_at = ?, updated_at = ?
       WHERE graph_id = ? AND deleted_at IS NULL AND (paper_low = ? OR paper_high = ?)`
    ).run(now, now, graphId, paperId, paperId)
    db.prepare('DELETE FROM relation_gen_progress WHERE graph_id = ? AND paper_id = ?').run(graphId, paperId)
    db.prepare('UPDATE graphs SET updated_at = ? WHERE id = ?').run(now, graphId)
  })
  tx()
  return {
    hadProgress: progress != null,
    addedAt: member?.added_at ?? now, // 成员行理论上必在；缺省兜当前时刻，行为同旧实现
    doneAt: progress?.done_at ?? null,
    graphUpdatedAt: graph.updated_at
  }
}

/**
 * uat7b S2：从库删除确认框的跨图谱计数——所有图谱中与这篇论文相连的**有效**关系
 * （deleted_at IS NULL，与 D75 软删除实际会移除的范围同口径；已软删的关系不计）。
 */
export function paperRelationStats(db: Database.Database, paperId: number): { count: number; graphCount: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, COUNT(DISTINCT graph_id) AS g FROM relations
       WHERE deleted_at IS NULL AND (paper_low = ? OR paper_high = ?)`
    )
    .get(paperId, paperId) as { n: number; g: number }
  return { count: row.n, graphCount: row.g }
}

/**
 * 从库删除（D75 软删除）：记 deleted_at 可恢复；从所有图谱移除、相关边全部软删除。
 * 与「从图谱移除」严格分开：这里论文不再出现在论文库。
 */
export function softDeletePaper(db: Database.Database, paperId: number): void {
  const now = nowIso()
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT deleted_at FROM papers WHERE id = ?').get(paperId) as
      | { deleted_at: string | null }
      | undefined
    if (!row) throw new Error(`论文 ${paperId} 不存在`)
    if (row.deleted_at != null) return // 幂等
    db.prepare('UPDATE papers SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, paperId)
    db.prepare('DELETE FROM graph_members WHERE paper_id = ?').run(paperId)
    db.prepare(
      `UPDATE relations SET deleted_at = ?, updated_at = ?
       WHERE deleted_at IS NULL AND (paper_low = ? OR paper_high = ?)`
    ).run(now, now, paperId, paperId)
    // uat3b：论文软删同步清元数据/全文索引（与 papers_fts 同一口径）
    removePaperFts(db, paperId)
    removeFullTextFts(db, paperId)
  })
  tx()
}

/** 拖拽后的坐标持久化（重启不丢）。 */
export function setNodePosition(
  db: Database.Database,
  graphId: number,
  paperId: number,
  x: number,
  y: number
): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('坐标必须是数字')
  db.prepare('UPDATE graph_members SET x = ?, y = ? WHERE graph_id = ? AND paper_id = ?').run(x, y, graphId, paperId)
}

// ── 关系（D84/D89）─────────────────────────────────────────────────────

export function listRelations(db: Database.Database, graphId: number): RelationView[] {
  const rows = db
    .prepare(
      `SELECT id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types, created_at, updated_at,
              source_type, source_job_id, source_session_id, model, prompt_version, edited_at, no_ref_basis
       FROM relations r WHERE r.graph_id = ? AND ${MEMBER_RELATION_SQL} ORDER BY r.id`
    )
    .all(graphId) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: r.id as number,
    paperLow: r.paper_low as number,
    paperHigh: r.paper_high as number,
    srcPaper: r.src_paper as number,
    statement: r.statement_text as string,
    llmTypes: JSON.parse(r.llm_types as string) as RelationType[],
    autoTypes: JSON.parse(r.auto_types as string) as RelationType[],
    createdAt: r.created_at as string,
    // uat4-fix1 S2：原 updated_at（画布 ⌘Z 快照原样恢复时间戳，D148/D164）
    updatedAt: (r.updated_at as string | null) ?? '',
    // uat2b c)：画布 ⌘Z 快照要完整行 provenance（撤销编辑后来源/模型/任务 id 不变）
    sourceType: r.source_type as 'job' | 'session',
    sourceJobId: (r.source_job_id as number | null) ?? null,
    sourceSessionId: (r.source_session_id as number | null) ?? null,
    model: (r.model as string | null) ?? null,
    promptVersion: (r.prompt_version as string | null) ?? null,
    // uat2b D149/D150：已编辑标记 / 无引用依据标记（关系面板来源行显示）
    editedAt: (r.edited_at as string | null) ?? null,
    noRefBasis: (r.no_ref_basis as number) === 1
  }))
}

/**
 * 手工连边（M1）：类型三种 LLM 类型多选、必填；一对论文一条边（无序对，D89）。
 * 「引用」「同一作者」按 D89 只由程序自动附加、只读，手工选择直接拒绝（评审建 3）：
 * 否则它们进 llm_types 后关系面板不显示、下次保存即丢，数据不一致。
 * 只写 llm_types、不动 auto_types（不传保留原值）。
 */
export function createRelation(db: Database.Database, input: RelationInput): number {
  if (input.types.length === 0) throw new Error('关系类型必选（至少一种）')
  for (const t of input.types) {
    if (!isRelationType(t)) throw new Error(`未知的关系类型：${String(t)}`)
    if ((AUTO_RELATION_TYPES as readonly string[]).includes(t)) {
      throw new Error(`「${RELATION_TYPE_LABELS[t]}」由程序根据引用数据和作者信息自动填写，不能手动选择`)
    }
  }
  if (input.srcPaperId === input.dstPaperId) throw new Error('不能给同一篇论文连边')
  return upsertRelation(db, {
    graphId: input.graphId,
    srcPaperId: input.srcPaperId,
    dstPaperId: input.dstPaperId,
    statement: input.statement.trim(),
    llmTypes: input.types,
    sourceType: 'session',
    model: null,
    promptVersion: null,
    // uat2b D149：手动编辑已有 AI 边时保留 job provenance（不改成手动）并记 edited_at——
    // upsertRelation 内只对 source_type='job' 的已有边生效
    markEdited: true
  })
}

export function deleteRelationById(db: Database.Database, relationId: number): void {
  deleteRelation(db, relationId)
}

// ── 任务（D70/D85；顶栏状态点与手动重试）────────────────────────────────

/** 顶栏全局状态点的汇总（D53/D65 09 弹层：「需要你处理」/「可重试」两组）。
 *  uat6c S2：已被取代的旧失败（superseded_at 非空，同组已有更新成功 / 已被手动重试
 *  收敛）不计入计数与列表——不物理删除。 */
export function jobsOverview(db: Database.Database): JobsOverview {
  const counts = new Map(
    (db.prepare('SELECT status, COUNT(*) AS c FROM jobs WHERE superseded_at IS NULL GROUP BY status').all() as Array<{ status: string; c: number }>).map(
      (r) => [r.status, r.c]
    )
  )
  const pauseReason = getLlmQueuePauseReason(db)
  const waitingKey = counts.get('waiting_key') ?? 0
  const failedRows = db
    .prepare(
      `SELECT j.id AS job_id, j.kind, j.graph_id, j.paper_id, j.failed_step, j.error, j.status, j.payload,
              j.updated_at, COALESCE(p.title, '') AS title
       FROM jobs j LEFT JOIN papers p ON p.id = j.paper_id
       WHERE j.status IN ('failed_retryable', 'failed_action') AND j.superseded_at IS NULL
       ORDER BY j.updated_at DESC, j.id DESC LIMIT 80`
    )
    .all() as Array<{
      job_id: number
      kind: JobRow['kind']
      graph_id: number | null
      paper_id: number | null
      failed_step: string | null
      error: string | null
      status: string
      payload: string
      updated_at: string
      title: string
    }>
  // B2：同一论文 + 同一动作（与 superseded 同一签名）合并成一行。代表行是最新的那条，
  // 重试它会把同组其余失败标成已被取代。原始状态计数仍按行，不按组合并。
  const failedGroups = new Map<string, { row: (typeof failedRows)[number]; count: number }>()
  for (const row of failedRows) {
    let payload: Record<string, unknown> = {}
    try {
      payload = JSON.parse(row.payload || '{}') as Record<string, unknown>
    } catch {
      payload = {}
    }
    const sig = jobGroupSignature({
      id: row.job_id,
      kind: row.kind,
      graphId: row.graph_id,
      paperId: row.paper_id,
      status: row.status as JobRow['status'],
      currentStep: null,
      failedStep: row.failed_step,
      error: row.error,
      retryCount: 0,
      progress: null,
      payload,
      nextRetryAt: null,
      startedAt: null,
      createdAt: row.updated_at,
      updatedAt: row.updated_at
    })
    const key = `${row.kind}|${row.graph_id ?? ''}|${sig}`
    const prev = failedGroups.get(key)
    if (prev) prev.count += 1
    else failedGroups.set(key, { row, count: 1 })
  }
  const failed = [...failedGroups.values()].slice(0, 20)
  return {
    queued: counts.get('queued') ?? 0,
    running: counts.get('running') ?? 0,
    waitingNetwork: counts.get('waiting_network') ?? 0,
    waitingKey,
    failedRetryable: counts.get('failed_retryable') ?? 0,
    failedAction: counts.get('failed_action') ?? 0,
    pauseSummary: pauseReason ? `${pauseReason} · 影响 ${waitingKey} 个任务` : null, // D70 汇总一行
    failed: failed.map(({ row: f, count }) => ({
      jobId: f.job_id,
      paperId: f.paper_id,
      // uat6c-fix1 M1 / D183：relation_gen 失败行不写 paper_id（只有 payload.paperIds），
      // 从 payload 解析标题——单篇用标题、多篇「N 篇论文」、全图任务「整个图谱」；
      // 已软删 / 找不到不报错，退回合理文案，永不露出原始 id 或英文字段名。
      paperTitle: f.title || failureGroupTitle(db, f.payload),
      failedStep: f.failed_step,
      error: f.error,
      status: f.status,
      count
    })),
    // uat4 D167：弹层除计数外列出正在处理 / 排队（含等待联网 / Key）的论文简称；
    // 当前步骤从 job_steps 取（running 优先，其次最早的 pending）
    active: (
      db
        .prepare(
          `SELECT j.id AS job_id, j.paper_id, j.status, j.payload, COALESCE(p.title, '') AS title,
                  (SELECT s.step FROM job_steps s WHERE s.job_id = j.id
                    ORDER BY CASE s.status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, s.step
                    LIMIT 1) AS step
           FROM jobs j LEFT JOIN papers p ON p.id = j.paper_id
           WHERE j.status IN ('running', 'queued', 'waiting_network', 'waiting_key')
           ORDER BY j.updated_at ASC LIMIT 30`
        )
        .all() as Array<{ job_id: number; paper_id: number | null; status: string; step: string | null; title: string; payload: string }>
    ).map((a) => ({
      jobId: a.job_id,
      paperId: a.paper_id,
      // B2：relation_gen 运行中不写 paper_id，标题与失败行同一套 failureGroupTitle。
      paperTitle: a.title ? shortCiteTitle(a.title) : failureGroupTitle(db, a.payload),
      status: a.status as JobActiveItem['status'],
      step: a.step
    }))
  }
}

/** 手动重试（D85：从失败步骤接着跑）；重入队由 IPC 层触发调度器。 */
export function retryJobById(db: Database.Database, jobId: number): void {
  retryJob(db, jobId)
}

/**
 * uat6c-fix1 M1 / D183：失败任务的论文组标题。paper_id 为空（relation_gen 等
 * 只在 payload.paperIds 记论文的任务）时按 payload 解析：单篇 → 该论文标题；
 * 多篇 →「N 篇论文」；paperIds 为空 / 全图任务 →「整个图谱」。已软删 / 找不到的
 * 论文静默跳过（按可解析数量计 N），不报错、不出现原始 id 或英文字段名。
 */
function failureGroupTitle(db: Database.Database, payloadRaw: string): string {
  let ids: number[] = []
  try {
    const p = JSON.parse(payloadRaw || '{}') as { paperIds?: unknown }
    if (Array.isArray(p.paperIds)) ids = p.paperIds.filter((x): x is number => typeof x === 'number' && Number.isInteger(x))
  } catch {
    // 坏 payload 按全图组处理
  }
  if (ids.length === 0) return '整个图谱'
  const titleStmt = db.prepare('SELECT title FROM papers WHERE id = ? AND deleted_at IS NULL')
  const titles = ids.map((id) => (titleStmt.get(id) as { title: string } | undefined)?.title ?? null).filter((t): t is string => !!t)
  if (ids.length === 1) return titles[0] ?? '1 篇论文'
  return `${ids.length} 篇论文`
}

/**
 * D35/D67/D95：导入即在后台开始处理（解析→名片→详情，一篇论文一个任务）。无 PDF 不入队（D62）。
 * D95（补充 D35）：MinerU 解析器不可用（available()=false）期间整批不入队——库里照常
 * 显示「未处理」，不产生失败任务、不点红状态点；MinerU 可用后由 backfillProcessJobs
 * 统一补排。不新增第八种状态。
 * 评审建 2（D67/D29）：已成功处理且 PDF 未变化（pdf_hash 相同）的论文不重复开任务——
 * 重复导入不会覆盖名片/详情，也不双倍计费；PDF 被替换（哈希变化）或上次失败才重新入队。
 */
export function enqueueProcessJobs(
  db: Database.Database,
  dataDir: string,
  paperIds: number[],
  parser: PaperParser,
  sessionId?: number | null
): number[] {
  if (!parser.available()) return [] // D95：解析器不可用时不入队，不产生失败任务
  const ids: number[] = []
  const q = db.prepare('SELECT has_pdf FROM papers WHERE id = ? AND deleted_at IS NULL')
  const done = db.prepare(
    `SELECT 1 FROM jobs j JOIN paper_details d ON d.paper_id = j.paper_id
     WHERE j.kind = 'process_paper' AND j.paper_id = ? AND j.status = 'succeeded' AND d.pdf_hash = ?`
  )
  for (const pid of paperIds) {
    const p = q.get(pid) as { has_pdf: number } | undefined
    if (p?.has_pdf !== 1) continue
    const pdfPath = join(dataDir, 'papers', String(pid), 'paper.pdf')
    if (existsSync(pdfPath)) {
      const hash = createHash('sha256').update(readFileSync(pdfPath)).digest('hex')
      if (done.get(pid, hash)) continue // 已成功且 PDF 未变：不重复开任务
    }
    const payload = sessionId != null && sessionId > 0 ? { sessionId } : undefined
    ids.push(enqueueJob(db, 'process_paper', payload ? { paperId: pid, payload } : { paperId: pid }))
  }
  return ids
}

/** D95/D144：库内（未软删除）有 PDF、未处理且未入队的论文 id（排队/运行/等待/任一终态都排除）。 */
export function unprocessedWithPdfIds(db: Database.Database): number[] {
  return (
    db
      .prepare(
        `SELECT id FROM papers p
         WHERE p.has_pdf = 1 AND p.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM jobs j
             WHERE j.kind = 'process_paper' AND j.paper_id = p.id
               AND j.status IN ('queued', 'running', 'waiting_network', 'waiting_key', 'failed_retryable', 'failed_action', 'succeeded')
           )
         ORDER BY p.id`
      )
      .all() as Array<{ id: number }>
  ).map((r) => r.id)
}

/** D144：等待解析组件的论文数（顶栏弹层「解析组件不可用 · 影响 N 篇」的 N）。 */
export function countWaitingPapers(db: Database.Database): number {
  return unprocessedWithPdfIds(db).length
}

/**
 * D95：MinerU 可用后（启动时检测到）自动为所有「未处理」且有 PDF 的论文补排任务。
 * 「未处理」口径（D95 补充，遵守 D53）：有 PDF、未删除，且**没有任何** process_paper
 * 任务处于 queued / running / waiting_network / waiting_key / failed_retryable /
 * failed_action / succeeded。已成功的论文不在每次 MinerU 启动时重排（D134 bug4）；
 * PDF 被替换后的重新处理由 enqueueProcessJobs 的哈希去重（导入、拖入）或用户手动重试负责。
 * 终态失败（D53「留待手动重试」）的论文不自动重排。
 * 返回本次补排的任务 id。
 */
export function backfillProcessJobs(db: Database.Database, dataDir: string, parser: PaperParser): number[] {
  if (!parser.available()) return []
  return enqueueProcessJobs(db, dataDir, unprocessedWithPdfIds(db), parser)
}

// ── Zotero：来源探测 + 分类导入编排（D26；403 → sqlite 副本兜底）─────────

export const HINT_403 =
  'Zotero 已在运行，但未允许本机通信（Local API 返回 403）。' +
  '请在 Zotero 设置里勾选「允许本机其他应用与 Zotero 通信」后重新导入，本次已改用 zotero.sqlite 只读副本导入。'

/** 常见 Zotero 数据目录下的 zotero.sqlite（第一个存在的为准）。 */
export function findZoteroSqlite(home: string = homedir()): string | null {
  for (const dir of [join(home, 'Zotero'), join(home, 'Library', 'Application Support', 'Zotero')]) {
    const p = join(dir, 'zotero.sqlite')
    if (existsSync(p)) return p
  }
  return null
}

export interface ZoteroProbeOptions {
  fetchImpl?: FetchLike
  /** 测试注入：强制使用这个 zotero.sqlite（跳过常见路径探测） */
  sqlitePath?: string
  /** 测试注入：数据目录探测的 home。缺省是真实 homedir()。 */
  home?: string
}

export interface ZoteroDisplayStatus {
  apiUp: boolean
  endpoint: 'localhost:23119'
  /** 实现里有 sqlite 只读副本兜底（probeZoteroStatus），设置页固定展示这一行 */
  sqliteFallback: true
  /** findZoteroSqlite 命中的目录；没有则为 null（界面不造路径） */
  dataDir: string | null
}

/**
 * 探测 Zotero 来源：Local API 可用走 local_api（返回 403 给中文提示），
 * 否则找 zotero.sqlite 只读副本兜底；都找不到抛错。
 */
export async function probeZoteroStatus(opts: ZoteroProbeOptions = {}): Promise<ZoteroSourceStatus> {
  const fetchImpl = opts.fetchImpl ?? fetch
  let forbidden = false
  try {
    const res = await fetchImpl(`${LOCAL_API_BASE}/users/0/items?limit=1&format=json`)
    if (res.ok) return { kind: 'local_api' }
    forbidden = res.status === 403
  } catch {
    // 未运行或端口不通
  }
  const sqlitePath = opts.sqlitePath ?? findZoteroSqlite(opts.home)
  if (!sqlitePath || !existsSync(sqlitePath)) {
    throw new Error(
      forbidden
        ? 'Zotero Local API 返回 403，且没有找到 zotero.sqlite。请开启「允许本机其他应用与 Zotero 通信」，或确认 Zotero 已安装。'
        : '没有找到在运行的 Zotero（Local API 不可用），也没有找到 zotero.sqlite。请确认 Zotero 已安装。'
    )
  }
  return { kind: 'sqlite', sqlitePath, hint: forbidden ? HINT_403 : null }
}

/**
 * 设置页「导入来源」只展示与检测（D194④）。探测失败不抛错，改成「不可用」。
 * Local API 探测带短超时，避免设置页被挂住的端口拖死。
 */
export async function zoteroDisplayStatus(opts: ZoteroProbeOptions = {}): Promise<ZoteroDisplayStatus> {
  const fetchImpl =
    opts.fetchImpl ??
    ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, signal: AbortSignal.timeout(1500) }))
  let apiUp = false
  try {
    const status = await probeZoteroStatus({ ...opts, fetchImpl })
    apiUp = status.kind === 'local_api'
  } catch {
    apiUp = false
  }
  const sqlitePath = opts.sqlitePath ?? findZoteroSqlite(opts.home)
  return {
    apiUp,
    endpoint: 'localhost:23119',
    sqliteFallback: true,
    dataDir: sqlitePath ? dirname(sqlitePath) : null
  }
}

/** 列分类树（来源自动探测；Local API 优先）。 */
export async function listZoteroCollections(opts: ZoteroProbeOptions = {}): Promise<ZoteroCollectionNode[]> {
  const status = await probeZoteroStatus(opts)
  if (status.kind === 'local_api') {
    const api = new ZoteroLocalApi(LOCAL_API_BASE, opts.fetchImpl ?? fetch)
    // Local API 只查 users/0（个人库）；sqlite 来源带上 libraryID 供 UI 过滤群组库（建 5）
    return (await api.collections()).map((c) => ({ key: c.key, name: c.name, parentKey: c.parentKey }))
  }
  const handle = openZoteroDatabaseCopy(status.sqlitePath)
  try {
    return listCollections(handle.db).map((c) => ({
      key: c.key,
      name: c.name,
      libraryID: c.libraryID,
      parentKey: c.parentKey
    }))
  } finally {
    handle.close()
  }
}

/**
 * uat13（D207-③）：选中分类后的条目预览（标题 + 作者/年份，只读）。
 * 与导入同一来源探测；Local API 走 collectionItems（附件/笔记过滤同导入，
 * localApi.ts 62–72），sqlite 副本走 readCollectionItems。
 */
export async function listZoteroCollectionItems(
  collectionKey: string,
  opts: ZoteroProbeOptions = {},
  /** uat14（D209）：传入本机库 db 时按 Zotero (libraryID, itemKey) 标 alreadyImported */
  db?: Database.Database
): Promise<ZoteroCollectionItemView[]> {
  const status = await probeZoteroStatus(opts)
  const items =
    status.kind === 'local_api'
      ? await new ZoteroLocalApi(LOCAL_API_BASE, opts.fetchImpl ?? fetch).collectionItems(collectionKey)
      : (() => {
          const handle = openZoteroDatabaseCopy(status.sqlitePath)
          try {
            return readCollectionItems(handle.db, collectionKey, join(status.sqlitePath, '..'))
          } finally {
            handle.close()
          }
        })()
  // uat14（D209）：已导入判定 = 本机论文库存在同 (zotero_library_id, zotero_item_key) 的未软删行
  const importedLookup = db
    ? db.prepare(
        'SELECT 1 FROM papers WHERE zotero_library_id = ? AND zotero_item_key = ? AND deleted_at IS NULL LIMIT 1'
      )
    : null
  return items.map((item) => {
    const meta = buildPaperMeta(item)
    const libraryId = item.libraryID ?? 0
    return {
      key: item.key,
      title: meta.title,
      firstAuthor: meta.firstAuthor,
      year: meta.year,
      hasPdf: item.attachments.length > 0,
      alreadyImported: importedLookup ? importedLookup.get(libraryId, item.key) !== undefined : undefined
    }
  })
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** uat1b：关 sqlite 兜底副本（独立函数避免 TS 对闭包赋值的流收窄误判） */
function closeSqliteHandle(handle: ZoteroSqliteHandle | null): void {
  handle?.close()
}

/**
 * 导入整个分类到论文库并加入图谱（第二批导入器 + 进度上报）。
 * 逐个条目导入，每篇经 onProgress 上报（复制 PDF 在主进程内同步做，量小）。
 */
export async function importZoteroCollection(
  db: Database.Database,
  dataDir: string,
  graphId: number,
  collectionKey: string,
  onProgress: (p: ImportProgress) => void,
  opts: ZoteroProbeOptions = {},
  parser: PaperParser,
  /** uat2：本次补齐了 PDF 的论文 id 列表回调（IPC 层广播 event:pdf:libraryChanged） */
  onPdfAdded?: (paperIds: number[]) => void
): Promise<ImportSummary> {
  return importZoteroSelection(db, dataDir, graphId, collectionKey, undefined, onProgress, opts, parser, onPdfAdded)
}

/**
 * uat14（D209）：只导入分类内所选 item keys 到论文库并加入图谱。
 * 与 importZoteroCollection 完全同款编排（同来源探测、同去重、同进度、PDF 处理、入图谱）。
 */
export async function importZoteroItemsByKeys(
  db: Database.Database,
  dataDir: string,
  graphId: number,
  collectionKey: string,
  itemKeys: string[],
  onProgress: (p: ImportProgress) => void,
  opts: ZoteroProbeOptions = {},
  parser: PaperParser,
  onPdfAdded?: (paperIds: number[]) => void
): Promise<ImportSummary> {
  if (itemKeys.length === 0) throw new Error('未选择要导入的 Zotero 条目')
  return importZoteroSelection(db, dataDir, graphId, collectionKey, new Set(itemKeys), onProgress, opts, parser, onPdfAdded)
}

/** 分类导入共享编排；itemKeys 非空时只导入所选条目（D209） */
async function importZoteroSelection(
  db: Database.Database,
  dataDir: string,
  graphId: number,
  collectionKey: string,
  onlyKeys: ReadonlySet<string> | undefined,
  onProgress: (p: ImportProgress) => void,
  opts: ZoteroProbeOptions = {},
  parser: PaperParser,
  onPdfAdded?: (paperIds: number[]) => void
): Promise<ImportSummary> {
  const status = await probeZoteroStatus(opts)
  let allItems: Awaited<ReturnType<typeof readCollectionItems>>
  let libraryId: number
  let resolvePath: ((att: { key: string }) => Promise<string | null>) | undefined
  // uat1b：Local API 来源下某附件取不到路径时，按 zotero.sqlite 只读副本再找一次
  //（副本每批只开一次、用完即关；找不到 zotero.sqlite 就跳过兜底）
  let sqliteHandle: ZoteroSqliteHandle | null = null

  onProgress({ phase: 'reading', done: 0, total: 0 })
  if (status.kind === 'local_api') {
    const api = new ZoteroLocalApi(LOCAL_API_BASE, opts.fetchImpl ?? fetch)
    allItems = await api.collectionItems(collectionKey)
    libraryId = 0
    const sqlitePath = opts.sqlitePath ?? findZoteroSqlite(opts.home)
    const zoteroDataDir = sqlitePath && existsSync(sqlitePath) ? join(sqlitePath, '..') : null
    const sqliteFallback = (attKey: string): string | null => {
      if (!sqlitePath || !zoteroDataDir) return null
      try {
        sqliteHandle ??= openZoteroDatabaseCopy(sqlitePath)
        const row = sqliteHandle.db
          .prepare(
            // uat1 建议 4：按附件 key 兜底时限定个人库——Local API 只查 users/0，
            // 对应 sqlite 里 libraryID=1（个人库）；群组库同 key 附件不得混进来。
            `SELECT a.path FROM itemAttachments a JOIN items i ON i.itemID = a.itemID WHERE i.key = ? AND i.libraryID = 1`
          )
          .get(attKey) as { path: string | null } | undefined
        if (!row) return null
        const abs = attachmentAbsolutePath(row.path, attKey, zoteroDataDir)
        return abs && existsSync(abs) ? abs : null
      } catch {
        return null
      }
    }
    resolvePath = async (att) => {
      const fromApi = await api.attachmentFilePath(att.key)
      if (fromApi && existsSync(fromApi)) return fromApi
      return sqliteFallback(att.key)
    }
  } else {
    const handle = openZoteroDatabaseCopy(status.sqlitePath)
    try {
      allItems = readCollectionItems(handle.db, collectionKey, join(status.sqlitePath, '..'))
    } finally {
      handle.close()
    }
    libraryId = allItems[0]?.libraryID ?? 0
  }
  // uat14（D209）：只导入所选 item keys；key 不在分类里的按「选不到」忽略
  const items = onlyKeys ? allItems.filter((i) => onlyKeys.has(i.key)) : allItems
  if (items.length === 0) {
    return { imported: 0, updated: 0, addedToGraph: 0, addedToGraphIds: [], failed: 0, pdfUnresolved: 0, pdfAdded: 0, hint: status.kind === 'sqlite' ? status.hint : null }
  }

  onProgress({ phase: 'importing', done: 0, total: items.length })
  // importZoteroItems 是一批一个事务；这里逐条调以获得逐篇进度
  let imported = 0
  let updated = 0
  let failed = 0
  let pdfUnresolved = 0
  let pdfAdded = 0
  const pdfAddedIds: number[] = []
  const paperIds: number[] = []
  try {
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      try {
        const [result] = await importZoteroItems(db, dataDir, [item], {
          libraryId,
          resolveAttachmentPath: resolvePath
            ? (att) => resolvePath!({ key: att.key })
            : undefined
        })
        paperIds.push(result.paperId)
        if (result.pdfUnresolved) pdfUnresolved++
        if (result.action === 'created') imported++
        else updated++
        if (result.action !== 'created' && result.pdfAdded) {
          pdfAdded++
          pdfAddedIds.push(result.paperId) // uat2：即时刷新事件的数据源（只算 D75 补齐，新建不算）
        }
      } catch (e) {
        failed++
        console.error(`[graphictero] 导入条目 ${item.key} 失败：`, e)
      }
      onProgress({ phase: 'importing', done: i + 1, total: items.length })
    }
  } finally {
    // uat1b：sqlite 兜底副本每批只开一次，这里统一关（临时副本随 close 删除）
    closeSqliteHandle(sqliteHandle)
    sqliteHandle = null
  }

  // D35/D67/D95：导入即在后台开始处理（解析→名片→详情，一篇一个任务）；
  // 解析器不可用（available()=false，D95）时不入队，MinerU 可用后由启动补排兜底
  enqueueProcessJobs(db, dataDir, paperIds, parser)
  // uat2：补齐 PDF 的论文广播一次（渲染层「无 PDF」标记即时消失）
  if (pdfAddedIds.length > 0) onPdfAdded?.(pdfAddedIds)

  let addedToGraph = 0
  const addedToGraphIds: number[] = []
  if (paperIds.length > 0) {
    const now = nowIso()
    const ins = db.prepare(
      'INSERT OR IGNORE INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)'
    )
    const tx = db.transaction(() => {
      for (const pid of paperIds) {
        if (ins.run(graphId, pid, now).changes > 0) {
          addedToGraph++
          addedToGraphIds.push(pid)
        }
      }
      if (addedToGraph > 0) db.prepare('UPDATE graphs SET updated_at = ? WHERE id = ?').run(now, graphId)
    })
    tx()
  }

  return {
    imported,
    updated,
    addedToGraph,
    addedToGraphIds,
    failed,
    pdfUnresolved,
    pdfAdded,
    hint: status.kind === 'sqlite' ? status.hint : null
  }
}
