import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { deleteRelation, upsertRelation } from '../db/relations'
import { getGraphDetail, listRelations } from '../appService'
import { loadExportGraph, buildMarkdown } from '../export/markdown'
import { snapshotRelation, restoreSnapshot } from "../relations/snapshots"
import { createAgentTools, type ToolContext } from './tools'

/**
 * uat3b D158：Agent 新增的关系被撤销后软删除留库可接受，但界面（画布/关系面板/
 * 顶栏计数）、导出和所有 Agent 工具（含 listRelations）都不得看到这条边。
 * 排查结论（本测试锁定）：主进程所有读出口的 SQL 均已带 `deleted_at IS NULL`
 * （appService.listRelations / getGraphDetail、export/markdown、agent tools、
 * relations/generator/snapshots/context）；restoreRelationSnapshot 按 id 查行是
 * 复活路径，有意不带过滤。
 */

let dir: string
let db: Database.Database
let dataDir: string
let graphId: number
let paperA: number
let paperB: number
let sessionId: number

const now = (): string => new Date().toISOString()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-d158-'))
  dataDir = join(dir, 'data')
  mkdirSync(join(dataDir, 'papers'), { recursive: true })
  db = openDatabase(join(dir, 't.db'))
  runMigrations(db, MIGRATIONS)
  graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('D158图', now(), now()).lastInsertRowid)
  sessionId = Number(db.prepare("INSERT INTO sessions (graph_id, entry_type, entry_id, name, created_at, updated_at) VALUES (?, 'graph', NULL, 's', ?, ?)").run(graphId, now(), now()).lastInsertRowid)
  const ins = db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES (?, 'zotero', 1, ?, ?)")
  paperA = Number(ins.run('甲', now(), now()).lastInsertRowid)
  paperB = Number(ins.run('乙', now(), now()).lastInsertRowid)
  const insM = db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)')
  insM.run(graphId, paperA, now())
  insM.run(graphId, paperB, now())
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function makeCtx(): ToolContext {
  return {
    db,
    dataDir,
    sessionId,
    graphId,
    turnId: 'turn-d158',
    model: 'deepseek-flash',
    promptVersion: 'agent-v7',
    emitTrace: () => {},
    onGraphChange: () => {},
    onPaperCard: () => {}
  }
}

describe('D158：软删除的关系（撤销后留库）各出口都不可见', () => {
  it('deleteRelation 软删后：画布/关系面板/顶栏计数、导出、Agent listRelations 全部看不到；行仍留库', async () => {
    const rid = upsertRelation(db, {
      graphId,
      srcPaperId: paperA,
      dstPaperId: paperB,
      statement: '乙基于甲',
      llmTypes: ['based_on'] as import('../../shared/relationTypes').RelationType[],
      sourceType: 'session',
      sourceSessionId: sessionId,
      model: 'deepseek-flash',
      promptVersion: 'agent-v7'
    })
    // 撤销路径：改动前快照 + 软删（等价 graphChangeUndo 对 addRelation 的删除撤销）
    const snapshotId = snapshotRelation(db, { sessionId, turnId: 'turn-d158', relationId: rid, op: 'delete' })
    deleteRelation(db, rid)

    // 行仍留库（软删，D158 可接受）
    expect(db.prepare('SELECT COUNT(*) AS n FROM relations WHERE id = ?').get(rid)).toEqual({ n: 1 })
    expect(db.prepare('SELECT deleted_at IS NOT NULL AS d FROM relations WHERE id = ?').get(rid)).toEqual({ d: 1 })

    // 界面数据出口：getGraphDetail（画布 + 关系面板 + 顶栏计数同一数据源）
    const detail = getGraphDetail(db, graphId)
    expect(detail.relations).toHaveLength(0)
    expect(listRelations(db, graphId)).toHaveLength(0)

    // 导出口：图数据与 Markdown 都不含这条边
    const exportGraph = loadExportGraph(db, graphId)!
    expect(exportGraph.edges).toHaveLength(0)
    const md = buildMarkdown(exportGraph, { overview: false, details: false, relationTypes: ['based_on'], references: false }, { exportedAt: new Date(), overviewText: null })
    expect(md).not.toContain('乙基于甲')

    // Agent 工具出口：listRelations（getPapers 不附邻居；其它读工具不列关系）
    const tools = createAgentTools(makeCtx())
    const r = (await tools.listRelations.execute!({ limit: 50 } as never, {} as never)) as { relations: unknown[]; total: number }
    expect(r.total).toBe(0)
    expect(r.relations).toHaveLength(0)

    // 复活路径：快照还原后重新可见（原地复活，保 id）
    restoreSnapshot(db, snapshotId)
    expect(getGraphDetail(db, graphId).relations).toHaveLength(1)
    const r2 = (await tools.listRelations.execute!({ limit: 50 } as never, {} as never)) as { total: number }
    expect(r2.total).toBe(1)
  })
})
