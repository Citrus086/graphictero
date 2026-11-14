import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import {
  createAnnotation,
  deleteAnnotation,
  listAnnotations,
  updateAnnotation
} from './annotations'
import type { AnnotationInput } from '../../shared/ipc/pdf'

/** 阅读器标注（高亮/笔记）存取测试（D27；表在 001，quads/note 列在 004 迁移） */

let dir: string
let db: Database.Database
let pid: number
let now: Date

const BASE: AnnotationInput = {
  page: 2,
  type: 'highlight',
  text: 'Smoke Reader Fixture Line One',
  color: 'yellow',
  bbox: [72, 60, 300, 24],
  quads: [
    [72, 60, 300, 24],
    [72, 88, 260, 24]
  ]
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-ann-'))
  db = openDatabase(join(dir, 'graphictero.db'))
  runMigrations(db, MIGRATIONS) // 004 迁移：annotations 加 quads/note 列
  now = new Date('2026-10-26T12:00:00Z')
  const r = db
    .prepare("INSERT INTO papers (title, source, created_at, updated_at) VALUES ('T', 'zotero', ?, ?)")
    .run(now.toISOString(), now.toISOString())
  pid = Number(r.lastInsertRowid)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('阅读器标注存取（D27）', () => {
  it('迁移 004 已生效：annotations 有 quads / note 列', () => {
    const cols = (db.pragma('table_info(annotations)') as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toContain('quads')
    expect(cols).toContain('note')
  })

  it('新建高亮：落库并可读回（文字 / 颜色 / bbox / quads / 页码）', () => {
    const a = createAnnotation(db, pid, BASE, () => now)
    expect(a.id).toBeGreaterThan(0)
    expect(a.paperId).toBe(pid)
    expect(a.page).toBe(2)
    expect(a.type).toBe('highlight')
    expect(a.text).toContain('Line One')
    expect(a.color).toBe('yellow')
    expect(a.bbox).toEqual([72, 60, 300, 24])
    expect(a.quads).toHaveLength(2)
    expect(a.note).toBeNull()

    const list = listAnnotations(db, pid)
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(a.id)
  })

  it('高亮加笔记：updateAnnotation 更新 note，其余字段不动', () => {
    const a = createAnnotation(db, pid, BASE, () => now)
    const b = updateAnnotation(db, a.id, { note: '和 CAS 的阈值对比：τ 是手动的吗？' }, () => now)
    expect(b.note).toContain('τ')
    expect(b.text).toBe(a.text)
    expect(b.color).toBe('yellow')
    // 再读仍是持久化的值
    expect(listAnnotations(db, pid)[0].note).toContain('τ')
  })

  it('改颜色：updateAnnotation 更新 color', () => {
    const a = createAnnotation(db, pid, BASE, () => now)
    const b = updateAnnotation(db, a.id, { color: 'green' }, () => now)
    expect(b.color).toBe('green')
  })

  it('删除高亮：deleteAnnotation 后列表为空', () => {
    const a = createAnnotation(db, pid, BASE, () => now)
    deleteAnnotation(db, a.id)
    expect(listAnnotations(db, pid)).toHaveLength(0)
  })

  it('同篇多篇按页码排序；其他论文的标注不串', () => {
    createAnnotation(db, pid, { ...BASE, page: 5 }, () => now)
    createAnnotation(db, pid, { ...BASE, page: 1 }, () => now)
    const r2 = db
      .prepare("INSERT INTO papers (title, source, created_at, updated_at) VALUES ('T2', 'zotero', ?, ?)")
      .run(now.toISOString(), now.toISOString())
    createAnnotation(db, Number(r2.lastInsertRowid), BASE, () => now)
    const list = listAnnotations(db, pid)
    expect(list.map((a) => a.page)).toEqual([1, 5])
  })

  it('入参校验：坏颜色 / 坏类型 / 坏坐标 / 不存在论文都抛错不写库', () => {
    expect(() => createAnnotation(db, pid, { ...BASE, color: 'red' as never }, () => now)).toThrow('颜色')
    expect(() => createAnnotation(db, pid, { ...BASE, type: 'ink' as never }, () => now)).toThrow('类型')
    expect(() => createAnnotation(db, pid, { ...BASE, page: -1 }, () => now)).toThrow('页码')
    expect(() =>
      createAnnotation(db, pid, { ...BASE, quads: [[1, 2, 'x' as never, 4]] }, () => now)
    ).toThrow('坐标')
    expect(() => createAnnotation(db, 99999, BASE, () => now)).toThrow('不存在')
    expect(listAnnotations(db, pid)).toHaveLength(0)
  })

  it('坏 JSON 坐标兜底：损坏的 quads/bbox 读为空数组 / null，不炸列表', () => {
    const a = createAnnotation(db, pid, BASE, () => now)
    db.prepare("UPDATE annotations SET quads = '{bad', bbox = '[1,2' WHERE id = ?").run(a.id)
    const list = listAnnotations(db, pid)
    expect(list).toHaveLength(1)
    expect(list[0].quads).toEqual([])
    expect(list[0].bbox).toBeNull()
  })

  it('评审建 1：长度上限与类型校验——超限/类型错抛中文错误，不写库', () => {
    expect(() => createAnnotation(db, pid, { ...BASE, text: 'x'.repeat(20001) }, () => now)).toThrow('标注文字过长')
    expect(() =>
      createAnnotation(db, pid, { ...BASE, note: 'n'.repeat(20001) }, () => now)
    ).toThrow('笔记过长')
    expect(() =>
      createAnnotation(db, pid, { ...BASE, quads: Array.from({ length: 2001 }, () => [0, 0, 1, 1]) }, () => now)
    ).toThrow('标注坐标过多')
    const a = createAnnotation(db, pid, BASE, () => now)
    // patch.note 类型：数字/对象拒（旧实现 TEXT 亲和静默存 '123'）
    expect(() => updateAnnotation(db, a.id, { note: 123 as never }, () => now)).toThrow('笔记必须是字符串')
    expect(() => updateAnnotation(db, a.id, { note: { x: 1 } as never }, () => now)).toThrow('笔记必须是字符串')
    expect(() => updateAnnotation(db, a.id, { note: 'y'.repeat(20001) }, () => now)).toThrow('笔记过长')
    expect(() => updateAnnotation(db, a.id, null as never, () => now)).toThrow('更新参数必须是对象')
    expect(listAnnotations(db, pid)).toHaveLength(1) // 负例都没写进去
    expect(listAnnotations(db, pid)[0].note).toBeNull()
  })
})
