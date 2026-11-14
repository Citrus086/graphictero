import type Database from 'better-sqlite3'
import type { AnnotationColor, AnnotationInput, AnnotationView } from '../../shared/ipc/pdf'
import { ANNOTATION_COLORS } from '../../shared/ipc/pdf'

/**
 * 阅读器标注（高亮/笔记）的 SQLite 存取（D27）。
 *
 * 表是 001 里的 annotations（lane/pdf 004 迁移加 quads/note 两列）：
 * 高亮 type='highlight'，text=选中文字，note=挂在高亮上的笔记（可空）；
 * bbox=并集矩形、quads=行级矩形，均为页面坐标（PDF 点，左上原点）的 JSON。
 * 这里只做参数校验 + CRUD，不碰 PDF 渲染。
 */

type Quad = [number, number, number, number]

interface AnnotationRow {
  id: number
  paper_id: number
  page: number
  bbox: string | null
  type: string
  text: string
  color: string | null
  quads: string | null
  note: string | null
  created_at: string
  updated_at: string
}

function parseQuadArr(json: string | null): Quad[] {
  if (!json) return []
  try {
    const arr = JSON.parse(json) as unknown
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (q): q is Quad =>
        Array.isArray(q) && q.length === 4 && q.every((n) => typeof n === 'number' && Number.isFinite(n))
    )
  } catch {
    return []
  }
}

function parseBbox(json: string | null): Quad | null {
  if (!json) return null
  try {
    const arr = JSON.parse(json) as unknown
    if (Array.isArray(arr) && arr.length === 4 && arr.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      return arr as Quad
    }
    return null
  } catch {
    return null
  }
}

function isColor(c: unknown): c is AnnotationColor {
  return typeof c === 'string' && (ANNOTATION_COLORS as string[]).includes(c)
}

/** 评审建 1：长度上限（textarea 不限长，IPC 边界兜住超大写入） */
const TEXT_MAX = 20000
const QUADS_MAX = 2000

function checkTextLen(v: string, what: string): void {
  if (v.length > TEXT_MAX) throw new Error(`${what}过长（上限 ${TEXT_MAX} 字）`)
}

function toView(row: AnnotationRow): AnnotationView {
  return {
    id: row.id,
    paperId: row.paper_id,
    page: row.page,
    type: row.type === 'note' ? 'note' : 'highlight',
    text: row.text,
    note: row.note,
    color: isColor(row.color) ? row.color : 'yellow',
    bbox: parseBbox(row.bbox),
    quads: parseQuadArr(row.quads),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** 入参校验（IPC 边界）：不合法直接抛错给 renderer，不写库 */
function validateInput(input: AnnotationInput): { bbox: string | null; quads: string } {
  if (!input || typeof input !== 'object') throw new Error('标注参数缺失')
  if (!Number.isInteger(input.page) || input.page < 0) throw new Error('标注页码不合法')
  if (input.type !== 'highlight' && input.type !== 'note') throw new Error('标注类型不合法')
  if (!isColor(input.color)) throw new Error('标注颜色不合法')
  if (typeof input.text !== 'string') throw new Error('标注文字必须是字符串')
  checkTextLen(input.text, '标注文字')
  if (input.note != null) {
    if (typeof input.note !== 'string') throw new Error('笔记必须是字符串')
    checkTextLen(input.note, '笔记')
  }
  const quads = Array.isArray(input.quads) ? input.quads : []
  if (quads.length > QUADS_MAX) throw new Error(`标注坐标过多（上限 ${QUADS_MAX} 个矩形）`)
  if (
    !quads.every(
      (q) => Array.isArray(q) && q.length === 4 && q.every((n) => typeof n === 'number' && Number.isFinite(n))
    )
  ) {
    throw new Error('标注坐标不合法')
  }
  const bbox =
    Array.isArray(input.bbox) &&
    input.bbox.length === 4 &&
    input.bbox.every((n) => typeof n === 'number' && Number.isFinite(n))
      ? (input.bbox as Quad)
      : null
  return { bbox: bbox ? JSON.stringify(bbox) : null, quads: JSON.stringify(quads) }
}

export function listAnnotations(db: Database.Database, paperId: number): AnnotationView[] {
  const rows = db
    .prepare('SELECT * FROM annotations WHERE paper_id = ? ORDER BY page, id')
    .all(paperId) as AnnotationRow[]
  return rows.map(toView)
}

export function createAnnotation(
  db: Database.Database,
  paperId: number,
  input: AnnotationInput,
  now: () => Date = () => new Date()
): AnnotationView {
  const paper = db.prepare('SELECT id FROM papers WHERE id = ? AND deleted_at IS NULL').get(paperId)
  if (!paper) throw new Error(`论文 ${paperId} 不存在或已删除`)
  const { bbox, quads } = validateInput(input)
  const iso = now().toISOString()
  const r = db
    .prepare(
      `INSERT INTO annotations (paper_id, page, bbox, type, text, color, quads, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(paperId, input.page, bbox, input.type, input.text, input.color, quads, input.note ?? null, iso, iso)
  return toView(db.prepare('SELECT * FROM annotations WHERE id = ?').get(Number(r.lastInsertRowid)) as AnnotationRow)
}

/** 部分更新：笔记内容 / 颜色（编辑高亮笔记、改色用） */
export function updateAnnotation(
  db: Database.Database,
  id: number,
  patch: { note?: string | null; color?: AnnotationColor },
  now: () => Date = () => new Date()
): AnnotationView {
  const row = db.prepare('SELECT * FROM annotations WHERE id = ?').get(id) as AnnotationRow | undefined
  if (!row) throw new Error(`标注 ${id} 不存在`)
  if (!patch || typeof patch !== 'object') throw new Error('更新参数必须是对象')
  // 评审建 1：patch.note 必须 string|null（否则 TEXT 亲和会把数字静默存成字符串）
  if (patch.note !== undefined && patch.note !== null && typeof patch.note !== 'string') {
    throw new Error('笔记必须是字符串')
  }
  if (typeof patch.note === 'string') checkTextLen(patch.note, '笔记')
  if (patch.color !== undefined && !isColor(patch.color)) throw new Error('标注颜色不合法')
  const note = patch.note === undefined ? row.note : patch.note
  const color = patch.color ?? row.color
  db.prepare('UPDATE annotations SET note = ?, color = ?, updated_at = ? WHERE id = ?').run(
    note,
    color,
    now().toISOString(),
    id
  )
  return toView(db.prepare('SELECT * FROM annotations WHERE id = ?').get(id) as AnnotationRow)
}

export function deleteAnnotation(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM annotations WHERE id = ?').run(id)
}
