import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { upsertRelation, deleteRelation } from '../db/relations'
import { restoreRelation, relationDetail } from './restore'
import { createRelation } from '../appService'

/**
 * restoreRelation（⌘Z 快照恢复）与 relationDetail（来源字段）测试。
 */

let dir: string
let db: Database.Database
let graphId: number
let paperA: number
let paperB: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-rel-restore-'))
  const dataDir = join(dir, 'Graphictero')
  mkdirSync(dataDir, { recursive: true })
  db = new Database(join(dataDir, 'graphictero.db'))
  runMigrations(db, MIGRATIONS)
  const now = new Date().toISOString()
  graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('撤销图', now, now).lastInsertRowid)
  const ins = db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES (?, 'zotero', 1, ?, ?)")
  paperA = Number(ins.run('Alpha', now, now).lastInsertRowid)
  paperB = Number(ins.run('Beta', now, now).lastInsertRowid)
  db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)').run(graphId, paperA, now)
  db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)').run(graphId, paperB, now)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('restoreRelation（⌘Z 撤销 / 重做）', () => {
  it('恢复被删除的边：含自动类型，来源记 session（D88）', () => {
    const id = upsertRelation(db, {
      graphId,
      srcPaperId: paperA,
      dstPaperId: paperB,
      statement: 'B 基于 A。',
      llmTypes: ['based_on'],
      autoTypes: ['cites'],
      sourceType: 'job',
      model: 'deepseek-flash'
    })
    deleteRelation(db, id)

    const restoredId = restoreRelation(db, {
      graphId,
      srcPaperId: paperA,
      dstPaperId: paperB,
      statement: 'B 基于 A。',
      llmTypes: ['based_on'],
      autoTypes: ['cites']
    })
    expect(restoredId).not.toBe(id) // 软删的行不回写，插新行（D37：可再写回）
    const d = relationDetail(db, restoredId)
    expect(d.llmTypes).toEqual(['based_on'])
    expect(d.autoTypes).toEqual(['cites'])
    expect(d.sourceType).toBe('session')
    expect(d.model).toBeNull()
  })

  it('uat2b c)：带原行 id 的快照撤销删除 → 原地复活同一 id，完整行 provenance 原样写回', () => {
    const jobId = Number(db.prepare("INSERT INTO jobs (kind, graph_id, paper_id, status, created_at, updated_at) VALUES ('relation_gen', ?, NULL, 'succeeded', ?, ?)").run(graphId, new Date().toISOString(), new Date().toISOString()).lastInsertRowid)
    const id = upsertRelation(db, {
      graphId,
      srcPaperId: paperA,
      dstPaperId: paperB,
      statement: 'B 基于 A。',
      llmTypes: ['based_on'],
      autoTypes: ['cites'],
      sourceType: 'job',
      sourceJobId: jobId,
      model: 'deepseek-flash',
      promptVersion: 'relation-gen-v1'
    })
    const before = relationDetail(db, id)
    deleteRelation(db, id)

    const restoredId = restoreRelation(db, {
      graphId,
      id, // uat2b c)：完整行快照带原 id
      srcPaperId: paperA,
      dstPaperId: paperB,
      statement: before.statement,
      llmTypes: [...before.llmTypes],
      autoTypes: [...before.autoTypes],
      sourceType: before.sourceType,
      sourceJobId: before.sourceJobId,
      model: before.model,
      promptVersion: before.promptVersion
    })
    expect(restoredId).toBe(id) // 同一 id 复活，不新建行
    const after = relationDetail(db, restoredId)
    expect(after.sourceType).toBe('job') // provenance 原样：不从 job 掉成 session
    expect(after.sourceJobId).toBe(jobId)
    expect(after.model).toBe('deepseek-flash')
    expect(after.promptVersion).toBe('relation-gen-v1')
    expect(after.autoTypes).toEqual(['cites'])
  })

  it('uat2b c)：带 id 快照撤销「编辑」→ 同一行原样写回（来源/模型/任务 id 不变）', () => {
    const jobId = Number(db.prepare("INSERT INTO jobs (kind, graph_id, paper_id, status, created_at, updated_at) VALUES ('relation_gen', ?, NULL, 'succeeded', ?, ?)").run(graphId, new Date().toISOString(), new Date().toISOString()).lastInsertRowid)
    const id = upsertRelation(db, {
      graphId,
      srcPaperId: paperA,
      dstPaperId: paperB,
      statement: '生成时的陈述',
      llmTypes: ['based_on'],
      autoTypes: ['cites'],
      sourceType: 'job',
      sourceJobId: jobId,
      model: 'deepseek-flash',
      promptVersion: 'relation-gen-v1'
    })
    // 用户编辑后（来源曾被错改成 session——uat2b 前的 bug 场景）
    upsertRelation(db, {
      graphId,
      srcPaperId: paperA,
      dstPaperId: paperB,
      statement: '用户改过的陈述',
      llmTypes: ['based_on', 'compares'],
      sourceType: 'session'
    })
    restoreRelation(db, {
      graphId,
      id,
      srcPaperId: paperA,
      dstPaperId: paperB,
      statement: '生成时的陈述',
      llmTypes: ['based_on'],
      autoTypes: ['cites'],
      sourceType: 'job',
      sourceJobId: jobId,
      model: 'deepseek-flash',
      promptVersion: 'relation-gen-v1'
    })
    const d = relationDetail(db, id)
    expect(d.id).toBe(id)
    expect(d.statement).toBe('生成时的陈述')
    expect(d.llmTypes).toEqual(['based_on'])
    expect(d.sourceType).toBe('job')
    expect(d.sourceJobId).toBe(jobId)
    expect(d.model).toBe('deepseek-flash')
  })

  it('uat4 建议修11（D148/D164 原样恢复）：带 id 复活写回快照的原 updated_at，不盖成撤销时刻；重复撤销/重做不回退', () => {
    const id = upsertRelation(db, {
      graphId,
      srcPaperId: paperA,
      dstPaperId: paperB,
      statement: 'B 基于 A。',
      llmTypes: ['based_on'],
      sourceType: 'job',
      model: 'deepseek-flash'
    })
    const original = '2026-10-20T08:00:00.000Z' // 固定原时间戳（与撤销时刻可区分）
    db.prepare('UPDATE relations SET updated_at = ? WHERE id = ?').run(original, id)

    deleteRelation(db, id)
    restoreRelation(db, {
      graphId,
      id,
      srcPaperId: paperA,
      dstPaperId: paperB,
      statement: 'B 基于 A。',
      llmTypes: ['based_on'],
      updatedAt: original // 快照带原值（snapshots.ts 从库里读出）
    })
    expect(relationDetail(db, id).updatedAt).toBe(original) // 不是撤销时刻

    // 重复撤销 / 重做一轮：仍然等于原值，不回退
    deleteRelation(db, id)
    restoreRelation(db, { graphId, id, srcPaperId: paperA, dstPaperId: paperB, statement: 'B 基于 A。', llmTypes: ['based_on'], updatedAt: original })
    expect(relationDetail(db, id).updatedAt).toBe(original)
  })

  it('uat4 建议修11：老快照/手动恢复不带 updatedAt 时仍记当前时刻（缺省口径不变）', () => {
    const id = upsertRelation(db, {
      graphId, srcPaperId: paperA, dstPaperId: paperB, statement: 's', llmTypes: ['compares'], sourceType: 'session'
    })
    deleteRelation(db, id)
    restoreRelation(db, { graphId, id, srcPaperId: paperA, dstPaperId: paperB, statement: 's', llmTypes: ['compares'] })
    const d = relationDetail(db, id)
    expect(d.updatedAt).toBeTruthy()
    expect(Date.parse(d.updatedAt)).toBeGreaterThan(Date.parse('2026-10-20T08:00:00.000Z'))
  })

  it('uat2b D149：手动编辑 AI 生成的边 → source_type 不变（仍 job）、记 edited_at，来源行仍显示「自动生成 · 模型」', () => {
    const jobId = Number(db.prepare("INSERT INTO jobs (kind, graph_id, paper_id, status, created_at, updated_at) VALUES ('relation_gen', ?, NULL, 'succeeded', ?, ?)").run(graphId, new Date().toISOString(), new Date().toISOString()).lastInsertRowid)
    upsertRelation(db, {
      graphId,
      srcPaperId: paperA,
      dstPaperId: paperB,
      statement: '生成时的陈述',
      llmTypes: ['based_on'],
      autoTypes: ['cites'],
      sourceType: 'job',
      sourceJobId: jobId,
      model: 'deepseek-flash',
      promptVersion: 'relation-gen-v1'
    })
    // 画布关系面板保存（appService.createRelation，markEdited）
    createRelation(db, { graphId, srcPaperId: paperA, dstPaperId: paperB, statement: '用户编辑后的陈述', types: ['based_on', 'compares'] })
    const rid = (db.prepare('SELECT id FROM relations WHERE graph_id = ?').get(graphId) as { id: number }).id
    const d = relationDetail(db, rid)
    expect(d.sourceType).toBe('job') // 不改成手动（session）
    expect(d.sourceJobId).toBe(jobId) // 任务 id 保留
    expect(d.model).toBe('deepseek-flash')
    expect(d.statement).toBe('用户编辑后的陈述')
    expect(d.llmTypes).toEqual(['based_on', 'compares'])
    expect(d.editedAt).not.toBeNull() // 已编辑标记
  })

  it('uat2-fix1 建议修 3：类型不再含「基于/改进」时清掉 no_ref_basis', () => {
    upsertRelation(db, {
      graphId, srcPaperId: paperA, dstPaperId: paperB, statement: '生成的',
      llmTypes: ['based_on'], sourceType: 'job', sourceJobId: null, model: 'deepseek-flash', promptVersion: 'relation-gen-v3',
      noRefBasis: true
    })
    let id = (db.prepare('SELECT id FROM relations WHERE graph_id = ?').get(graphId) as { id: number }).id
    expect(relationDetail(db, id).noRefBasis).toBe(true)
    // 画布保存：类型改成「对比」（createRelation 不传 noRefBasis）→ 标志被清
    createRelation(db, { graphId, srcPaperId: paperA, dstPaperId: paperB, statement: '其实是对比', types: ['compares'] })
    id = (db.prepare('SELECT id FROM relations WHERE graph_id = ?').get(graphId) as { id: number }).id
    expect(relationDetail(db, id).noRefBasis).toBe(false)
    expect(relationDetail(db, id).llmTypes).toEqual(['compares'])
  })

  it('uat2b D149：新建手工边 edited_at 为空；LLM 重写后旧 edited_at 被清掉', () => {
    // 手工新边
    createRelation(db, { graphId, srcPaperId: paperA, dstPaperId: paperB, statement: '手工边', types: ['compares'] })
    let id = (db.prepare('SELECT id FROM relations WHERE graph_id = ?').get(graphId) as { id: number }).id
    expect(relationDetail(db, id).editedAt).toBeNull()
    expect(relationDetail(db, id).sourceType).toBe('session')
    // 编辑一条 job 边（先造）
    upsertRelation(db, {
      graphId, srcPaperId: paperA, dstPaperId: paperB, statement: '生成的', llmTypes: ['based_on'],
      sourceType: 'job', sourceJobId: null, model: 'deepseek-flash', promptVersion: 'relation-gen-v1'
    })
    id = (db.prepare('SELECT id FROM relations WHERE graph_id = ?').get(graphId) as { id: number }).id
    createRelation(db, { graphId, srcPaperId: paperA, dstPaperId: paperB, statement: '编辑过', types: ['based_on'] })
    expect(relationDetail(db, id).editedAt).not.toBeNull()
    // LLM（重新生成）重写同一条边 → edited_at 清零
    upsertRelation(db, {
      graphId, srcPaperId: paperA, dstPaperId: paperB, statement: '重新生成的', llmTypes: ['based_on'],
      sourceType: 'job', sourceJobId: null, model: 'deepseek-flash', promptVersion: 'relation-gen-v2'
    })
    const d = relationDetail(db, id)
    expect(d.editedAt).toBeNull()
    expect(d.statement).toBe('重新生成的')
  })

  it('uat2-fix1 建议修 4：会话边撤销删除复活时保留 source_session_id', () => {
    const now = new Date().toISOString()
    const sid = Number(
      db.prepare("INSERT INTO sessions (graph_id, entry_type, entry_id, name, created_at, updated_at) VALUES (?, 'graph', NULL, '会话', ?, ?)").run(graphId, now, now).lastInsertRowid
    )
    const id = upsertRelation(db, {
      graphId, srcPaperId: paperA, dstPaperId: paperB, statement: '会话建的边',
      llmTypes: ['compares'], sourceType: 'session', sourceSessionId: sid
    })
    deleteRelation(db, id)
    restoreRelation(db, {
      graphId,
      id,
      srcPaperId: paperA,
      dstPaperId: paperB,
      statement: '会话建的边',
      llmTypes: ['compares'],
      sourceType: 'session',
      sourceSessionId: sid
    })
    const row = db.prepare('SELECT source_session_id FROM relations WHERE id = ?').get(id) as { source_session_id: number | null }
    expect(row.source_session_id).toBe(sid) // 不再被清成 NULL
  })

  it('编辑撤销：不传 autoTypes 时保留库中现值（D89 自动类型只读）', () => {
    const id = upsertRelation(db, {
      graphId,
      srcPaperId: paperA,
      dstPaperId: paperB,
      statement: '旧陈述',
      llmTypes: ['based_on'],
      autoTypes: ['same_author'],
      sourceType: 'session'
    })
    restoreRelation(db, { graphId, srcPaperId: paperA, dstPaperId: paperB, statement: '新陈述', llmTypes: ['compares'] })
    const d = relationDetail(db, id)
    expect(d.statement).toBe('新陈述')
    expect(d.llmTypes).toEqual(['compares'])
    expect(d.autoTypes).toEqual(['same_author']) // 未被抹掉
  })

  it('校验：自环 / 空类型 / 自动类型混入 llmTypes 均拒绝', () => {
    expect(() =>
      restoreRelation(db, { graphId, srcPaperId: paperA, dstPaperId: paperA, statement: '', llmTypes: ['based_on'] })
    ).toThrow('自环')
    expect(() =>
      restoreRelation(db, { graphId, srcPaperId: paperA, dstPaperId: paperB, statement: '', llmTypes: [] })
    ).toThrow('不能为空')
    expect(() =>
      restoreRelation(db, { graphId, srcPaperId: paperA, dstPaperId: paperB, statement: '', llmTypes: ['cites'] })
    ).toThrow('D89')
    expect(() =>
      restoreRelation(db, { graphId, srcPaperId: paperA, dstPaperId: paperB, statement: '', llmTypes: ['based_on'], autoTypes: ['based_on'] })
    ).toThrow('D89')
  })

  it('评审建议修 5：端点论文已「从图谱移除」时拒绝恢复（不造幽灵边）', () => {
    // 建边 → 删边（⌘Z 快照）→ 模拟 B 被「从图谱移除」（D75：本身不可撤销、不清 undo 栈）
    const id = upsertRelation(db, {
      graphId,
      srcPaperId: paperA,
      dstPaperId: paperB,
      statement: 'B 基于 A。',
      llmTypes: ['based_on'],
      sourceType: 'session'
    })
    deleteRelation(db, id)
    db.prepare('DELETE FROM graph_members WHERE graph_id = ? AND paper_id = ?').run(graphId, paperB)

    expect(() =>
      restoreRelation(db, { graphId, srcPaperId: paperA, dstPaperId: paperB, statement: 'B 基于 A。', llmTypes: ['based_on'] })
    ).toThrow('都必须在本图谱中')
    // 两端都在图里 / 论文在库里但从没进过图：同样拒绝
    const paperC = Number(
      db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES ('Gamma', 'zotero', 1, ?, ?)")
        .run(new Date().toISOString(), new Date().toISOString()).lastInsertRowid
    )
    expect(() =>
      restoreRelation(db, { graphId, srcPaperId: paperA, dstPaperId: paperC, statement: '', llmTypes: ['based_on'] })
    ).toThrow('都必须在本图谱中')
    // 拒绝后库里没有活的关系行（没造出幽灵边）
    const n = (db.prepare('SELECT COUNT(*) AS n FROM relations WHERE graph_id = ? AND deleted_at IS NULL').get(graphId) as { n: number }).n
    expect(n).toBe(0)
  })
})

describe('relationDetail（来源字段，D75）', () => {
  it('返回 provenance：job 来源含 model，session 来源 model 为 null', () => {
    const now = new Date().toISOString()
    const jobId = Number(
      db.prepare("INSERT INTO jobs (kind, graph_id, status, created_at, updated_at) VALUES ('relation_gen', ?, 'succeeded', ?, ?)").run(graphId, now, now).lastInsertRowid
    )
    const jobRel = upsertRelation(db, {
      graphId,
      srcPaperId: paperA,
      dstPaperId: paperB,
      statement: 's',
      llmTypes: ['implements'],
      sourceType: 'job',
      sourceJobId: jobId,
      model: 'deepseek-flash',
      promptVersion: 'rel-v1'
    })
    const d = relationDetail(db, jobRel)
    expect(d.sourceType).toBe('job')
    expect(d.sourceJobId).toBe(jobId)
    expect(d.model).toBe('deepseek-flash')
    expect(d.promptVersion).toBe('rel-v1')
    expect(d.graphId).toBe(graphId)
    expect(d.updatedAt).toBeTruthy()
  })

  it('已删除 / 不存在的关系抛错', () => {
    const id = upsertRelation(db, {
      graphId,
      srcPaperId: paperA,
      dstPaperId: paperB,
      statement: 's',
      llmTypes: ['compares'],
      sourceType: 'session'
    })
    deleteRelation(db, id)
    expect(() => relationDetail(db, id)).toThrow('不存在或已删除')
    expect(() => relationDetail(db, 99999)).toThrow('不存在或已删除')
  })
})
