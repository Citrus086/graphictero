import type Database from 'better-sqlite3'
import type {
  ChatMessageView,
  CreateSessionInput,
  SessionCostBreakdown,
  SessionEntryType,
  SessionSummary
} from '../../shared/ipc/agent'
import type { DetailPart, TracePart } from '../../shared/parts'

/**
 * M5 lane/agent：会话存储（表 001/002 已建，本模块首次接线；041 补 error 列）。
 *
 * - 会话属图谱、挂入口对象（D7）；CRUD 里删除按 D122：物理删除 + 级联
 *   （消息 / trace / 观察日志 / archives 一并删；usage_records 保留，仅 session_id 置空）；
 * - 消息按 (session_id, seq) 保序写入（UNIQUE 约束），界面始终显示完整历史（D28）；
 * - trace = D8 灰色读取记录，写入 session_traces（读类工具每次读取落一行）；
 * - 费用不落会话表：按 D96-② 每次调用实时写 usage_records（category='chat'），
 *   会话/回合费用都是对该表的 SUM 查询（sessionCost / turnCost）。
 */

const nowIso = (): string => new Date().toISOString()

interface SessionRow {
  id: number
  graph_id: number
  entry_type: SessionEntryType
  entry_id: number | null
  name: string
  updated_at: string
}

function toSummary(r: SessionRow): SessionSummary {
  return {
    id: r.id,
    graphId: r.graph_id,
    entryType: r.entry_type,
    entryId: r.entry_id,
    name: r.name,
    updatedAt: r.updated_at
  }
}

export function getSession(
  db: Database.Database,
  sessionId: number
): { id: number; graphId: number; entryType: SessionEntryType; entryId: number | null; name: string } | null {
  const r = db
    .prepare('SELECT id, graph_id, entry_type, entry_id, name FROM sessions WHERE id = ?')
    .get(sessionId) as SessionRow | undefined
  if (!r) return null
  return { id: r.id, graphId: r.graph_id, entryType: r.entry_type, entryId: r.entry_id, name: r.name }
}

/** 某图谱某入口对象的会话列表（updatedAt 倒序，会话下拉，D30）。 */
export function listSessions(
  db: Database.Database,
  graphId: number,
  entryType: SessionEntryType,
  entryId: number | null
): SessionSummary[] {
  const rows = db
    .prepare(
      `SELECT * FROM sessions
       WHERE graph_id = ? AND entry_type = ? AND entry_id IS ?
       ORDER BY updated_at DESC, id DESC`
    )
    .all(graphId, entryType, entryId) as unknown as SessionRow[]
  return rows.map(toSummary)
}

/** 默认会话名：按入口对象生成（createSession 未传 name 时用）。 */
function defaultSessionName(db: Database.Database, input: CreateSessionInput): string {
  if (input.entryType === 'paper' && input.entryId != null) {
    const p = db.prepare('SELECT title FROM papers WHERE id = ?').get(input.entryId) as { title: string } | undefined
    // uat10：超过 30 字截断时加省略号（不再无提示硬截断）；完整名经渲染层 title tooltip 展示
    if (p) return `论文对话 · ${p.title.length > 30 ? `${p.title.slice(0, 30)}…` : p.title}`
  }
  if (input.entryType === 'relation') return `关系对话 #${input.entryId ?? ''}`
  const g = db.prepare('SELECT name FROM graphs WHERE id = ?').get(input.graphId) as { name: string } | undefined
  return `图谱对话 · ${g?.name ?? input.graphId}`
}

export function createSession(db: Database.Database, input: CreateSessionInput): SessionSummary {
  const g = db.prepare('SELECT id FROM graphs WHERE id = ?').get(input.graphId)
  if (!g) throw new Error(`图谱 ${input.graphId} 不存在`)
  if (input.entryType !== 'graph' && input.entryId == null) {
    throw new Error(`${input.entryType} 入口会话需要 entryId`)
  }
  const now = nowIso()
  const name = input.name?.trim() || defaultSessionName(db, input)
  const r = db
    .prepare('INSERT INTO sessions (graph_id, entry_type, entry_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(input.graphId, input.entryType, input.entryId, name, now, now)
  const id = Number(r.lastInsertRowid)
  return { id, graphId: input.graphId, entryType: input.entryType, entryId: input.entryId, name, updatedAt: now }
}

export function renameSession(db: Database.Database, sessionId: number, name: string): void {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('会话名不能为空')
  if (trimmed.length > 200) throw new Error('会话名过长（最多 200 字）')
  const r = db.prepare('UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?').run(trimmed, nowIso(), sessionId)
  if (r.changes === 0) throw new Error(`会话 ${sessionId} 不存在`)
}

/**
 * D122：物理删除 + 级联。session_traces 有 ON DELETE CASCADE（002），其余三表
 * （001 建的 messages / observations / archives）无外键级联，手动删；
 * usage_records 保留，仅 session_id 置空。
 */
export function deleteSession(db: Database.Database, sessionId: number): void {
  const s = getSession(db, sessionId)
  if (!s) throw new Error(`会话 ${sessionId} 不存在`)
  const tx = db.transaction(() => {
    db.prepare('UPDATE usage_records SET session_id = NULL WHERE session_id = ?').run(sessionId)
    db.prepare('UPDATE graph_candidates SET session_id = NULL WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM session_messages WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM session_observations WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM session_archives WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM session_traces WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
  })
  tx()
}

/** 新消息 seq = 会话内 max+1（保序；UNIQUE(session_id, seq) 兜底并发）。 */
export function appendMessage(
  db: Database.Database,
  sessionId: number,
  role: 'user' | 'assistant' | 'system',
  parts: DetailPart[],
  error?: string | null
): { id: number; seq: number } {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM session_messages WHERE session_id = ?').get(sessionId) as {
    max_seq: number
  }
  const seq = row.max_seq + 1
  const r = db
    .prepare('INSERT INTO session_messages (session_id, seq, role, parts, error, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sessionId, seq, role, JSON.stringify(parts), error ?? null, nowIso())
  touchSession(db, sessionId)
  return { id: Number(r.lastInsertRowid), seq }
}

export function updateMessage(
  db: Database.Database,
  messageId: number,
  parts: DetailPart[],
  error?: string | null
): void {
  db.prepare('UPDATE session_messages SET parts = ?, error = ? WHERE id = ?').run(
    JSON.stringify(parts),
    error === undefined ? null : error,
    messageId
  )
}

/** B6（D96-②）：把本回合费用写进 assistant 消息（重开会话仍可见每回合 ¥）。 */
export function setMessageCost(db: Database.Database, messageId: number, costCny: number): void {
  db.prepare('UPDATE session_messages SET cost_cny = ? WHERE id = ?').run(costCny, messageId)
}

export function getMessages(db: Database.Database, sessionId: number): ChatMessageView[] {
  const rows = db
    .prepare('SELECT id, seq, role, parts, error, cost_cny, created_at FROM session_messages WHERE session_id = ? ORDER BY seq')
    .all(sessionId) as Array<{ id: number; seq: number; role: string; parts: string; error: string | null; cost_cny: number | null; created_at: string }>
  return rows.map((r) => ({
    id: r.id,
    // uat5 D172：system = 系统记录（撤销通知等），界面灰行展示、不作用户消息
    role: r.role === 'assistant' ? 'assistant' : r.role === 'system' ? 'system' : 'user',
    parts: JSON.parse(r.parts) as DetailPart[],
    createdAt: r.created_at,
    ...(r.error ? { error: r.error } : {}),
    ...(r.cost_cny != null ? { costCny: r.cost_cny } : {})
  }))
}

/** uat5 D172：撤销本轮改动等系统记录——落库即入下轮上下文（getMessageEntries 同表） */
export function appendSystemMessage(db: Database.Database, sessionId: number, text: string): ChatMessageView {
  const { id } = appendMessage(db, sessionId, 'system', [{ type: 'text', text }])
  return getMessages(db, sessionId).find((m) => m.id === id)!
}

export interface HistoryEntry {
  seq: number
  role: 'user' | 'assistant' | 'system'
  text: string
}

/**
 * 压缩用历史条目：真实 DB seq + 纯文本（空文本消息跳过，data part 不进模型上下文）。
 * D28 高水位（archives.seq_to）按这里的 seq 计，跨回合只归档增量。
 */
export function getMessageEntries(db: Database.Database, sessionId: number): HistoryEntry[] {
  const rows = db
    .prepare('SELECT seq, role, parts FROM session_messages WHERE session_id = ? ORDER BY seq')
    .all(sessionId) as Array<{ seq: number; role: string; parts: string }>
  const out: HistoryEntry[] = []
  for (const r of rows) {
    // uat5 D172：system 记录进上下文（撤销通知等，模型下一轮可见）
    if (r.role !== 'user' && r.role !== 'assistant' && r.role !== 'system') continue
    const parts = JSON.parse(r.parts) as DetailPart[]
    const text = parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n')
      .trim()
    if (!text) continue
    out.push({ seq: r.seq, role: r.role === 'assistant' ? 'assistant' : r.role === 'system' ? 'system' : 'user', text })
  }
  return out
}

export function touchSession(db: Database.Database, sessionId: number): void {
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(nowIso(), sessionId)
}

/** 物理删除一条消息（03f 重试：删掉失败的 assistant 消息后重跑回合，D53 ⑧-4）。 */
export function deleteMessage(db: Database.Database, messageId: number): void {
  db.prepare('DELETE FROM session_messages WHERE id = ?').run(messageId)
}

/** D8：一次工具读取落一行 trace（灰色读取记录的数据源），返回展示用 TracePart。 */
export function addTrace(
  db: Database.Database,
  sessionId: number,
  t: { toolName: string; paperId?: number | null; summary: string; excerpt?: string }
): TracePart {
  db.prepare(
    'INSERT INTO session_traces (session_id, created_at, tool_name, paper_id, summary, excerpt) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(sessionId, nowIso(), t.toolName, t.paperId ?? null, t.summary, t.excerpt ?? null)
  return { type: 'data-trace', toolName: t.toolName, paperId: t.paperId ?? undefined, summary: t.summary, excerpt: t.excerpt }
}

export function listTraces(db: Database.Database, sessionId: number): TracePart[] {
  const rows = db
    .prepare('SELECT tool_name, paper_id, summary, excerpt FROM session_traces WHERE session_id = ? ORDER BY id')
    .all(sessionId) as Array<{ tool_name: string; paper_id: number | null; summary: string; excerpt: string | null }>
  return rows.map((r) => ({
    type: 'data-trace',
    toolName: r.tool_name,
    paperId: r.paper_id ?? undefined,
    summary: r.summary,
    excerpt: r.excerpt ?? undefined
  }))
}

/** 本会话累计费用（usage_records 汇总，D96-②；人民币）。 */
export function sessionCost(db: Database.Database, sessionId: number): number {
  const r = db.prepare('SELECT COALESCE(SUM(cost_cny), 0) AS cost FROM usage_records WHERE session_id = ?').get(sessionId) as {
    cost: number
  }
  return r.cost
}

/** D142/D160：对话 = chat + web；后台 = card + detail + overview + relation。total 仍是全部类别合计。 */
const CHAT_COST_CATEGORIES = new Set(['chat', 'web'])
const BACKGROUND_COST_CATEGORIES = new Set(['card', 'detail', 'overview', 'relation'])

export function sessionCostBreakdown(db: Database.Database, sessionId: number): SessionCostBreakdown {
  const rows = db
    .prepare('SELECT category, COALESCE(SUM(cost_cny), 0) AS cost FROM usage_records WHERE session_id = ? GROUP BY category')
    .all(sessionId) as Array<{ category: string; cost: number }>
  let chat = 0
  let background = 0
  let total = 0
  for (const row of rows) {
    total += row.cost
    if (CHAT_COST_CATEGORIES.has(row.category)) chat += row.cost
    else if (BACKGROUND_COST_CATEGORIES.has(row.category)) background += row.cost
  }
  return { chat, background, total }
}

/** 本回合费用：turn 开始时刻之后的 usage_records 合计（turn-end 事件载荷）。 */
export function turnCost(db: Database.Database, sessionId: number, sinceIso: string): number {
  const r = db
    .prepare('SELECT COALESCE(SUM(cost_cny), 0) AS cost FROM usage_records WHERE session_id = ? AND occurred_at >= ?')
    .get(sessionId, sinceIso) as { cost: number }
  return r.cost
}

/** D28 观察日志：追加一条要点（importance 默认 0）。 */
export function addObservation(db: Database.Database, sessionId: number, content: string, importance = 0): void {
  db.prepare('INSERT INTO session_observations (session_id, content, importance, logged_at) VALUES (?, ?, ?, ?)').run(
    sessionId,
    content,
    importance,
    nowIso()
  )
}

export function listObservations(
  db: Database.Database,
  sessionId: number
): Array<{ content: string; importance: number; loggedAt: string }> {
  return (
    db.prepare('SELECT content, importance, logged_at FROM session_observations WHERE session_id = ? ORDER BY id').all(sessionId) as Array<{
      content: string
      importance: number
      logged_at: string
    }>
  ).map((r) => ({ content: r.content, importance: r.importance, loggedAt: r.logged_at }))
}

/** D28 反思压缩：清空观察日志（调用方随后写入浓缩后的一条）。 */
export function deleteAllObservations(db: Database.Database, sessionId: number): void {
  db.prepare('DELETE FROM session_observations WHERE session_id = ?').run(sessionId)
}
