import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from './db/connection'
import { MIGRATIONS, runMigrations } from './db/migrations'
import {
  addPapersToGraph,
  createGraph,
  createRelation,
  deleteRelationById,
  getGraphDetail,
  listGraphs,
  listLibrary,
  removePaperFromGraph,
  setNodePosition,
  softDeletePaper
} from './appService'

/**
 * M1 第三批数据操作单测：图谱 CRUD、论文库分组（D90）、
 * 坐标持久化、「从图谱移除」与软删除分开（D75）、手工连边（D84/D89）。
 */

let dir: string
let db: Database.Database
let graphId: number

function insertPaper(title: string): number {
  const now = new Date().toISOString()
  const r = db
    .prepare(
      "INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES (?, 'zotero', 1, ?, ?)"
    )
    .run(title, now, now)
  return Number(r.lastInsertRowid)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-graphops-'))
  mkdirSync(join(dir, 'Graphictero'), { recursive: true })
  db = openDatabase(join(dir, 'Graphictero', 'graphictero.db'))
  runMigrations(db, MIGRATIONS)
  graphId = createGraph(db, '测试图谱').id
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('图谱与论文库（D90 分组数据源）', () => {
  it('createGraph 空名称报错；listGraphs 带论文/关系统计', () => {
    expect(() => createGraph(db, '   ')).toThrow('图谱名称不能为空')
    const p = insertPaper('Paper A')
    addPapersToGraph(db, graphId, [p])
    const graphs = listGraphs(db)
    expect(graphs).toHaveLength(1)
    expect(graphs[0]).toMatchObject({ name: '测试图谱', paperCount: 1, relationCount: 0 })
  })

  it('listLibrary 标注 inGraph：本图谱 / 论文库 · 其他 两组的数据源', () => {
    const a = insertPaper('Paper A')
    const b = insertPaper('Paper B')
    addPapersToGraph(db, graphId, [a])
    const lib = listLibrary(db, graphId)
    const byId = new Map(lib.map((p) => [p.id, p.inGraph]))
    expect(byId.get(a)).toBe(true)
    expect(byId.get(b)).toBe(false)
    // 不传 graphId 时全部 inGraph=false（纯论文库列表）
    expect(listLibrary(db).every((p) => !p.inGraph)).toBe(true)
    // 软删除的论文不出现在论文库
    db.prepare("UPDATE papers SET deleted_at = 'x' WHERE id = ?").run(b)
    expect(listLibrary(db, graphId).map((p) => p.id)).toEqual([a])
  })

  it('uat6c S1：relation_count 只计两端都是本图成员（未软删）的关系——与 listRelations / 画布同口径', () => {
    const a = insertPaper('Paper A')
    const b = insertPaper('Paper B')
    const c = insertPaper('Paper C') // 非成员（库外端点）
    addPapersToGraph(db, graphId, [a, b])
    createRelation(db, { graphId, srcPaperId: a, dstPaperId: b, statement: '成员间', types: ['based_on'] })
    createRelation(db, { graphId, srcPaperId: a, dstPaperId: c, statement: '指向非成员', types: ['compares'] })
    // 成员间关系计入；非成员端点的不计入（库行仍在，不删）
    expect(listGraphs(db)[0]).toMatchObject({ relationCount: 1 })
    const detail = getGraphDetail(db, graphId)
    expect(detail.graph.relationCount).toBe(1)
    expect(detail.relations).toHaveLength(1)
    expect(detail.relations[0].statement).toBe('成员间')
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM relations WHERE graph_id = ? AND deleted_at IS NULL').get(graphId) as { n: number }).n
    ).toBe(2)

    // 端点论文软删后其关系也不计入（成员行可能还在，但论文已删）
    db.prepare("UPDATE papers SET deleted_at = 'x' WHERE id = ?").run(b)
    expect(listGraphs(db)[0].relationCount).toBe(0)
    expect(getGraphDetail(db, graphId).relations).toHaveLength(0)
  })
})

describe('成员与坐标持久化（拖拽重启不丢）', () => {
  it('addPapersToGraph 幂等；setNodePosition 写库可读回', () => {
    const p = insertPaper('Paper A')
    addPapersToGraph(db, graphId, [p, p])
    addPapersToGraph(db, graphId, [p])
    const detail = getGraphDetail(db, graphId)
    expect(detail.members).toHaveLength(1)
    setNodePosition(db, graphId, p, 123.5, -45)
    const after = getGraphDetail(db, graphId)
    expect(after.members[0]).toMatchObject({ x: 123.5, y: -45 })
  })

  it('addPapersToGraph 返回真正新增的 paperIds：已在上图的不重复计数（评审建 6）', () => {
    const a = insertPaper('Paper A')
    const b = insertPaper('Paper B')
    const first = addPapersToGraph(db, graphId, [a, b])
    expect(first.sort()).toEqual([a, b].sort())
    const second = addPapersToGraph(db, graphId, [a]) // 已在图上
    expect(second).toEqual([])
    const c = insertPaper('Paper C')
    const third = addPapersToGraph(db, graphId, [a, c]) // 混合：只报新增的
    expect(third).toEqual([c])
    expect(getGraphDetail(db, graphId).members).toHaveLength(3)
  })

  it('setNodePosition 拒绝非法坐标与不存在成员', () => {
    const p = insertPaper('Paper A')
    addPapersToGraph(db, graphId, [p])
    expect(() => setNodePosition(db, graphId, p, Number.NaN, 0)).toThrow('坐标必须是数字')
    db.prepare('DELETE FROM graph_members WHERE graph_id = ? AND paper_id = ?').run(graphId, p)
    setNodePosition(db, graphId, p, 1, 1) // 静默无更新（成员不存在不报错）
    expect(getGraphDetail(db, graphId).members).toHaveLength(0)
  })
})

describe('「从图谱移除」与软删除分开（D75）', () => {
  it('removePaperFromGraph：删成员 + 软删相关边，论文仍在论文库', () => {
    const a = insertPaper('Paper A')
    const b = insertPaper('Paper B')
    addPapersToGraph(db, graphId, [a, b])
    createRelation(db, { graphId, srcPaperId: a, dstPaperId: b, statement: 's', types: ['based_on'] })
    const relId = (getGraphDetail(db, graphId).relations[0] as { id: number }).id

    removePaperFromGraph(db, graphId, a)
    const detail = getGraphDetail(db, graphId)
    expect(detail.members.map((m) => m.paper.id)).toEqual([b])
    expect(detail.relations).toEqual([]) // 边软删，不出现在图中
    expect(listLibrary(db, graphId).map((p) => p.id).sort()).toEqual([a, b]) // 论文还在库
    // 关系行软删而非物理删（deleted_at 有值）
    const row = db.prepare('SELECT deleted_at FROM relations WHERE id = ?').get(relId) as { deleted_at: string | null }
    expect(row.deleted_at).not.toBeNull()
    // Q8（已决）：移除同时清 (graph, paper) 关系生成进度行——移除再加回才会重新自动生成关系
    db.prepare('INSERT INTO relation_gen_progress (graph_id, paper_id, done_at) VALUES (?, ?, ?)').run(graphId, b, new Date().toISOString())
    removePaperFromGraph(db, graphId, b)
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM relation_gen_progress WHERE graph_id = ? AND paper_id = ?').get(graphId, b) as { n: number }).n
    ).toBe(0)
  })
})

describe('从库删除是软删除（D75），与从图谱移除分开', () => {
  it('softDeletePaper：论文标记删除、移出所有图谱、相关边软删；论文库不再列出', () => {
    const a = insertPaper('Paper A')
    const b = insertPaper('Paper B')
    addPapersToGraph(db, graphId, [a, b])
    createRelation(db, { graphId, srcPaperId: a, dstPaperId: b, statement: 's', types: ['based_on'] })
    softDeletePaper(db, a)
    expect(listLibrary(db).map((p) => p.id)).toEqual([b])
    expect(getGraphDetail(db, graphId).members.map((m) => m.paper.id)).toEqual([b])
    expect(getGraphDetail(db, graphId).relations).toEqual([])
    // 幂等：再删不报错
    softDeletePaper(db, a)
    // 行仍在（软删可恢复），deleted_at 有值
    const row = db.prepare('SELECT deleted_at FROM papers WHERE id = ?').get(a) as { deleted_at: string | null }
    expect(row.deleted_at).not.toBeNull()
  })
})

describe('手工连边（D84 类型必选多选；D89 无序对一条边）', () => {
  it('类型必选：空数组报错；未知类型报错', () => {
    const a = insertPaper('Paper A')
    const b = insertPaper('Paper B')
    expect(() =>
      createRelation(db, { graphId, srcPaperId: a, dstPaperId: b, statement: '', types: [] })
    ).toThrow('关系类型必选')
    expect(() =>
      createRelation(db, { graphId, srcPaperId: a, dstPaperId: b, statement: '', types: ['nope' as never] })
    ).toThrow('未知的关系类型')
  })

  it('自环报错（D86）', () => {
    const a = insertPaper('Paper A')
    expect(() =>
      createRelation(db, { graphId, srcPaperId: a, dstPaperId: a, statement: '', types: ['based_on'] })
    ).toThrow('不能给同一篇论文连边')
  })

  it('同一对论文只有一条边：反向写入合并进已有边（D89）', () => {
    const a = insertPaper('Paper A')
    const b = insertPaper('Paper B')
    addPapersToGraph(db, graphId, [a, b]) // uat6c S1：列表口径只计成员间关系
    const id1 = createRelation(db, {
      graphId,
      srcPaperId: a,
      dstPaperId: b,
      statement: '第一条',
      types: ['based_on']
    })
    const id2 = createRelation(db, {
      graphId,
      srcPaperId: b, // 反向写
      dstPaperId: a,
      statement: '第二条（反向）',
      types: ['compares']
    })
    expect(id2).toBe(id1)
    const rels = getGraphDetail(db, graphId).relations
    expect(rels).toHaveLength(1)
    expect(rels[0]).toMatchObject({
      paperLow: Math.min(a, b),
      paperHigh: Math.max(a, b),
      srcPaper: b, // 方向以后一次写入为准
      statement: '第二条（反向）',
      llmTypes: ['compares']
    })
  })

  it('D89/建3：手工连边拒绝「引用」「同一作者」（含与 LLM 类型混选）', () => {
    const a = insertPaper('Paper A')
    const b = insertPaper('Paper B')
    expect(() =>
      createRelation(db, { graphId, srcPaperId: a, dstPaperId: b, statement: '', types: ['cites'] })
    ).toThrow('不能手动选择')
    expect(() =>
      createRelation(db, { graphId, srcPaperId: a, dstPaperId: b, statement: '', types: ['same_author'] })
    ).toThrow('不能手动选择')
    expect(() =>
      createRelation(db, { graphId, srcPaperId: a, dstPaperId: b, statement: '', types: ['based_on', 'cites'] })
    ).toThrow('不能手动选择')
    // 被拒后库里没有任何边
    expect(getGraphDetail(db, graphId).relations).toEqual([])
  })

  it('deleteRelationById 软删后可再写回同一条边（D37）', () => {
    const a = insertPaper('Paper A')
    const b = insertPaper('Paper B')
    addPapersToGraph(db, graphId, [a, b]) // uat6c S1：列表口径只计成员间关系
    const id = createRelation(db, { graphId, srcPaperId: a, dstPaperId: b, statement: 's', types: ['based_on'] })
    deleteRelationById(db, id)
    expect(getGraphDetail(db, graphId).relations).toEqual([])
    const again = createRelation(db, { graphId, srcPaperId: a, dstPaperId: b, statement: 's2', types: ['compares'] })
    expect(again).not.toBe(id)
    expect(getGraphDetail(db, graphId).relations).toHaveLength(1)
  })
})
