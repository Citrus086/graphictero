import Database from 'better-sqlite3'
import { segmentText } from './db/segment'

export { segmentText }

export interface Fts5ProbeResult {
  ok: boolean
  detail: string
  hitsZh?: number
  hitsEnStem?: number
  results?: Array<{ id: number; title: string }>
}

export function runFts5Probe(dbPath = ':memory:'): Fts5ProbeResult {
  const db = new Database(dbPath)
  try {
    // 验证当前 SQLite 编译进了 FTS5
    const fts5 = db
      .prepare("SELECT compile_options FROM pragma_compile_options WHERE compile_options LIKE 'ENABLE_FTS5'")
      .get()
    if (!fts5) {
      return { ok: false, detail: 'SQLite was built without ENABLE_FTS5' }
    }

    db.exec(`
      CREATE VIRTUAL TABLE papers_fts USING fts5(title_seg, body_seg, tokenize = 'porter unicode61');
      CREATE TABLE papers (id INTEGER PRIMARY KEY, title TEXT, body TEXT);
    `)

    const insertPaper = db.prepare('INSERT INTO papers (title, body) VALUES (?, ?)')
    const insertFts = db.prepare(
      'INSERT INTO papers_fts (rowid, title_seg, body_seg) VALUES (last_insert_rowid(), ?, ?)'
    )
    const docs = [
      {
        title: '基于强化学习的检索增强生成方法研究',
        body: '本文提出一种基于强化学习的 RAG 检索策略，在 HotpotQA 数据集上提升了答案准确率。'
      },
      {
        title: 'Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks',
        body: 'We introduce retrieval-augmented generation (RAG) models, combining a pre-trained retriever with a seq2seq generator.'
      },
      {
        title: 'Reinforcement Learning: An Introduction',
        body: 'Reinforcement learning agents learn policies by interacting with an environment and receiving rewards.'
      }
    ]
    const insertMany = db.transaction((rows: typeof docs) => {
      for (const d of rows) {
        insertPaper.run(d.title, d.body)
        insertFts.run(segmentText(d.title), segmentText(d.body))
      }
    })
    insertMany(docs)

    // 中文词查询：用户输入同样先过 segmentText 分词（'强化学习' -> '强化 学习'），
    // 未分词的整串会被 unicode61 当成一个 token 而查不到（M0 实测确认）。
    const zhQuery = segmentText('强化学习')
    const hitsZh = db
      .prepare('SELECT id, title FROM papers WHERE id IN (SELECT rowid FROM papers_fts WHERE papers_fts MATCH ?)')
      .all(zhQuery) as Array<{ id: number; title: string }>

    // 英文 porter 词干：查 "retrieve" 应词干命中 "retrieval"（需显式 tokenize='porter unicode61'，FTS5 默认不是 porter）
    const hitsEnStem = db
      .prepare('SELECT id, title FROM papers WHERE id IN (SELECT rowid FROM papers_fts WHERE papers_fts MATCH ?)')
      .all('retrieve') as Array<{ id: number; title: string }>

    const ok =
      hitsZh.length === 1 && hitsZh[0].id === 1 && hitsEnStem.length >= 1 && hitsEnStem.some((r) => r.id === 2)
    return {
      ok,
      detail: ok ? 'FTS5 + Intl.Segmenter zh segmentation works' : 'unexpected query results',
      hitsZh: hitsZh.length,
      hitsEnStem: hitsEnStem.length,
      results: [...hitsZh, ...hitsEnStem]
    }
  } finally {
    db.close()
  }
}
