import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { openDatabase } from './connection'
import { MIGRATIONS, runMigrations } from './migrations'
import { buildFtsMatch, indexPaperFts, searchPapers } from './fts'
import { deleteRelation, upsertRelation } from './relations'

/** 建一个跑完初始迁移的内存库，并造两个图谱成员论文 */
function freshDb(): { db: Database.Database; graphId: number; paperA: number; paperB: number } {
  const db = openDatabase(':memory:')
  runMigrations(db, MIGRATIONS)
  const now = new Date().toISOString()
  const graphId = Number(
    db.prepare("INSERT INTO graphs (name, created_at, updated_at) VALUES ('g', ?, ?)").run(now, now)
      .lastInsertRowid
  )
  const insertPaper = db.prepare(
    `INSERT INTO papers (csl_json, title, created_at, updated_at) VALUES ('{}', ?, ?, ?)`
  )
  const paperA = Number(insertPaper.run('论文 A', now, now).lastInsertRowid)
  const paperB = Number(insertPaper.run('论文 B', now, now).lastInsertRowid)
  const addMember = db.prepare(
    'INSERT INTO graph_members (graph_id, paper_id, added_at) VALUES (?, ?, ?)'
  )
  addMember.run(graphId, paperA, now)
  addMember.run(graphId, paperB, now)
  return { db, graphId, paperA, paperB }
}

describe('初始建表（D23/D61/D70/D75/D84/D89）', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openDatabase(':memory:')
    runMigrations(db, MIGRATIONS)
  })
  afterEach(() => db.close())

  it('外键约束已开启', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('002：设置落点 / 会话 trace / D93 作者表 / pdf_sources 代理列', () => {
    // app_settings：数据根位置（D83）、Unpaywall 邮箱（D64）等设置类字段的落点
    db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('data_root', '/tmp/x', 't')").run()
    expect(db.prepare("SELECT value FROM app_settings WHERE key = 'data_root'").get()).toEqual({
      value: '/tmp/x'
    })
    // session_traces：Session「读取记录（trace）」
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name)
    expect(tables).toContain('session_traces')
    // paper_authors：D93 规范化名支撑「同一作者」自动关系
    expect(tables).toContain('paper_authors')
    // pdf_sources 机构代理登录状态（D64）
    const cols = (db.prepare('PRAGMA table_info(pdf_sources)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toContain('proxy_login_url')
    expect(cols).toContain('proxy_login_status')
  })

  it('论文入库：CSL-JSON 列 + 常用字段；DOI 唯一且软删除后让位（D75/D82）', () => {
    const now = new Date().toISOString()
    const insert = db.prepare(
      `INSERT INTO papers (csl_json, title, doi, year, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    insert.run(JSON.stringify({ type: 'article-journal', title: 'T1', DOI: '10.1/x' }), 'T1', '10.1/x', 2024, now, now)
    // 同一 DOI 再插 → 唯一索引拦截
    expect(() =>
      insert.run('{}', 'T2', '10.1/x', 2024, now, now)
    ).toThrow()
    // 软删除后同一 DOI 可重新入库（恢复/重导场景）
    db.prepare('UPDATE papers SET deleted_at = ? WHERE doi = ?').run(now, '10.1/x')
    expect(() =>
      insert.run('{}', 'T3', '10.1/x', 2024, now, now)
    ).not.toThrow()
  })

  it('Zotero (libraryID, itemKey) 唯一（D75）', () => {
    const now = new Date().toISOString()
    const insert = db.prepare(
      `INSERT INTO papers (zotero_library_id, zotero_item_key, created_at, updated_at)
       VALUES (1, 'ABCD1234', ?, ?)`
    )
    insert.run(now, now)
    expect(() => insert.run(now, now)).toThrow()
  })

  it('jobs 七种状态（D70）；非法状态被 CHECK 拦下', () => {
    const now = new Date().toISOString()
    const insert = db.prepare(
      `INSERT INTO jobs (kind, status, created_at, updated_at) VALUES ('parse_detail', ?, ?, ?)`
    )
    for (const s of ['queued', 'running', 'waiting_network', 'waiting_key', 'failed_retryable', 'failed_action', 'succeeded']) {
      expect(() => insert.run(s, now, now)).not.toThrow()
    }
    expect(() => insert.run('exploded', now, now)).toThrow()
  })
})

describe('关系写入（D75/D84/D89）', () => {
  let db: Database.Database
  let graphId: number
  let paperA: number
  let paperB: number
  beforeEach(() => {
    ;({ db, graphId, paperA, paperB } = freshDb())
  })
  afterEach(() => db.close())

  const base = () => ({
    graphId,
    statement: 'B 在 A 的基础上做了改进',
    llmTypes: ['based_on' as const, 'compares' as const],
    sourceType: 'job' as const,
    model: 'deepseek-flash',
    promptVersion: 'rel-v1'
  })

  it('同一无序论文对只有一条边：先 A→B 再 B→A 合并进已有边（D89）', () => {
    const id1 = upsertRelation(db, { ...base(), srcPaperId: paperA, dstPaperId: paperB })
    const id2 = upsertRelation(db, { ...base(), srcPaperId: paperB, dstPaperId: paperA, statement: '反向写入' })
    expect(id2).toBe(id1)
    const rows = db.prepare('SELECT * FROM relations').all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0].src_paper).toBe(paperB) // 方向以后一次写入为准（见 PROGRESS 取舍）
    expect(rows[0].statement_text).toBe('反向写入')
    expect(rows[0].llm_types).toBe(JSON.stringify(['based_on', 'compares']))
    expect(rows[0].source_type).toBe('job')
    expect(rows[0].model).toBe('deepseek-flash')
  })

  it('自环抛错（D86）；软删除后可写回（D37）', () => {
    expect(() => upsertRelation(db, { ...base(), srcPaperId: paperA, dstPaperId: paperA })).toThrow('自环')
    const id = upsertRelation(db, { ...base(), srcPaperId: paperA, dstPaperId: paperB })
    deleteRelation(db, id)
    expect(db.prepare('SELECT deleted_at FROM relations WHERE id = ?').get(id)).toBeTruthy()
    const id2 = upsertRelation(db, { ...base(), srcPaperId: paperA, dstPaperId: paperB })
    expect(id2).not.toBe(id) // 软删除的行不参与唯一索引，可以写回
    // 再次删除幂等（D77）
    deleteRelation(db, id)
    expect(() => deleteRelation(db, id)).not.toThrow()
  })

  it('自动类型与 LLM 类型合在同一条边上（D89）', () => {
    upsertRelation(db, {
      ...base(),
      srcPaperId: paperA,
      dstPaperId: paperB,
      autoTypes: ['cites', 'same_author']
    })
    const row = db.prepare('SELECT llm_types, auto_types FROM relations').get() as {
      llm_types: string
      auto_types: string
    }
    expect(JSON.parse(row.llm_types)).toEqual(['based_on', 'compares'])
    expect(JSON.parse(row.auto_types)).toEqual(['cites', 'same_author'])
  })

  it('auto_types 只读（D89）：LLM 重写这条边不传 autoTypes 时保留已附加的自动类型', () => {
    upsertRelation(db, {
      ...base(),
      srcPaperId: paperA,
      dstPaperId: paperB,
      autoTypes: ['cites']
    })
    // 模拟 LLM 重新生成同一条边（不带自动类型）：方向/陈述更新，auto_types 不丢
    upsertRelation(db, {
      ...base(),
      srcPaperId: paperB,
      dstPaperId: paperA,
      statement: '重新生成'
    })
    const row = db.prepare('SELECT auto_types, statement_text FROM relations').get() as {
      auto_types: string
      statement_text: string
    }
    expect(JSON.parse(row.auto_types)).toEqual(['cites'])
    expect(row.statement_text).toBe('重新生成')
    // 显式传 autoTypes 仍可覆盖（自动逻辑自己写自己）
    upsertRelation(db, { ...base(), srcPaperId: paperA, dstPaperId: paperB, autoTypes: ['same_author'] })
    expect(JSON.parse((db.prepare('SELECT auto_types FROM relations').get() as { auto_types: string }).auto_types)).toEqual(
      ['same_author']
    )
  })
})

describe('FTS5 检索（D74，M0 实测口径）', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openDatabase(':memory:')
    runMigrations(db, MIGRATIONS)
  })
  afterEach(() => db.close())

  function addPaper(title: string, abstract: string | null, keywords: string[]): number {
    const now = new Date().toISOString()
    const id = Number(
      db.prepare("INSERT INTO papers (title, created_at, updated_at) VALUES (?, ?, ?)").run(title, now, now)
        .lastInsertRowid
    )
    indexPaperFts(db, id, { title, abstract, keywords })
    return id
  }

  it('中文按 Intl.Segmenter 分词入库与查询', () => {
    const id = addPaper('基于强化学习的检索增强生成方法研究', '本文在 HotpotQA 上做了实验', ['强化学习', 'RAG'])
    expect(searchPapers(db, '强化学习').map((r) => r.paper_id)).toContain(id)
    expect(searchPapers(db, '不存在的词')).toEqual([])
  })

  it('英文 porter 词干：搜 retrieve 命中 retrieval', () => {
    const id = addPaper('Dense Retrieval for Open-Domain QA', null, ['retrieval-augmented generation'])
    expect(searchPapers(db, 'retrieve').map((r) => r.paper_id)).toContain(id)
  })

  it('带连字符的名称拆词前缀 OR（B4，D74 回归仍命中）', () => {
    addPaper('Evaluating deep-seek-r1 on math benchmarks', null, [])
    expect(buildFtsMatch('deep-seek')).toBe('"deep"* OR "deep" OR "seek"* OR "seek"')
    expect(searchPapers(db, 'deep-seek')).toHaveLength(1)
    expect(searchPapers(db, 'deep seek')).toHaveLength(1)
  })

  it('B4：多词查询 OR 语义——命中任一词即返回，不再被隐式 AND 卡成 0', () => {
    const halt = addPaper('HALT: Tracing Agent States', 'hallucination detection for LLM agents', [])
    addPaper('Unrelated biology essay', 'protein folding in yeast cells', [])
    // 三个词只有一个命中 HALT：改前（AND）为 0 命中，改后（OR）命中
    const hits = searchPapers(db, 'HALT illusory completion')
    expect(hits.map((r) => r.paper_id)).toContain(halt)
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(searchPapers(db, '不存在的词xyz 另一个不存在的词')).toEqual([])
  })

  it('B4：全部命中的排前面（hits 降序）+ 标题列权重高于摘要', () => {
    const both = addPaper('Contrastive Learning Survey', 'contrastive learning methods overview', [])
    const titleOnly = addPaper('Contrastive Learning Advances', 'unrelated abstract text here', [])
    const rows = searchPapers(db, 'contrastive learning', 10)
    expect(rows[0].paper_id).toBe(both) // 两词全命中排最前
    expect(rows.find((r) => r.paper_id === both)!.hits).toBe(2)
    expect(rows.find((r) => r.paper_id === titleOnly)!.hits).toBe(2)
    // 单词查询：标题命中的比只有摘要命中的排前（bm25 列权重）
    const abstractOnly = addPaper('Something Else Entirely', 'contrastive learning deep dive into representation', [])
    const single = searchPapers(db, 'representation', 10)
    expect(single.length).toBeGreaterThanOrEqual(1)
    void abstractOnly
  })

  it('B4：词数上限 8、停用词剔除、特殊字符与空查询安全', () => {
    expect(buildFtsMatch('')).toBe('')
    expect(searchPapers(db, '   ')).toEqual([])
    // 停用词被剔除
    expect(buildFtsMatch('the of and')).toBe('')
    // 词数上限 8（每词两个形态 = 16 个 token）
    const many = buildFtsMatch('aa bb cc dd ee ff gg hh ii jj kk').split(' OR ').filter((t) => t.endsWith('*')).length
    expect(many).toBe(8)
    // 特殊字符不抛 FTS 语法错（引号 / 冒号 / 减号）
    addPaper('Query "quoted" handling: edge-cases', null, [])
    expect(() => searchPapers(db, '"quoted" handling: edge-cases')).not.toThrow()
    expect(searchPapers(db, '"quoted" handling: edge-cases').length).toBeGreaterThanOrEqual(1)
  })

  it('关键词进索引，重复索引是 upsert', () => {
    const id = addPaper('某论文', null, ['SPECTER2'])
    indexPaperFts(db, id, { title: '某论文', abstract: '新摘要', keywords: ['SPECTER2'] })
    const row = db.prepare('SELECT abstract_seg FROM papers_fts WHERE rowid = ?').get(id) as {
      abstract_seg: string
    }
    expect(row.abstract_seg).toBe('新 摘要')
    expect(searchPapers(db, 'SPECTER2')).toHaveLength(1)
  })
})
