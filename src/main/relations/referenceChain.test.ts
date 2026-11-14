import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { startStubLlm, type StubLlm } from '../llm/stubServer'
import { createOpenAlexClient } from '../openalex/client'
import { fetchOpenAlexReferences } from '../openalex/references'
import { makeFakeOpenAlex } from '../openalex/testing'
import { startFixtureHttp, type FixtureHttp } from '../testing/fixtureHttp'
import { extractReferencesSection, extractReferencesWithLlm, arxivIdOf } from './referencesExtract'
import { fetchReferencesView } from './refsFetch'
import { computeAutoTypes } from './autoTypes'

/**
 * uat4 D165：UAT 实测 8 篇论文之间 0 条引用匹配——引用匹配全链路逐环诊断（离线 fixture，
 * 零外网：OpenAlex 走本地 fixtureHttp，LLM 走 stubServer）。链路边界：
 *
 *   full.md ─环0→ References 段切分 ─环1→ OpenAlex referenced_works 匹配（openalex/references.ts）
 *           ─环2→ DeepSeek 兜底抽取匹配（referencesExtract.ts）→ paper_references
 *           ─环3→ autoTypes cites（autoTypes.ts）
 *
 * 诊断结论（各环节命中数见各用例断言）：
 * - 环0：段切分只认整词完全相等，`## 7 参考文献` / `**References:**` 切不到 → 已修
 *   （referencesExtract.extractReferencesSection 容忍编号/冒号尾）。
 * - 环1：W-ID / DOI / 标题三径本身可用（fixture 下 3 条全中）；但库内论文 first_author
 *   为 NULL 时标题全同也被阈值②拒（matchRefToLibrary，openalex/references.ts——
 *   **不在本批文件名单内**，此处用例钉住现状作证据，修法归维护者）。
 * - 环2（根因①，已修）：arXiv 条目 `arXiv:1706.03762v3` 与库内 DOI `10.48550/arxiv.1706.03762`
 *   字符串不相等、版本号 vN 未剥、papers.arxiv_id 列未用 → DOI 径落空；LLM 标题带
 *   后缀时标题径也过不了 0.95 → 双径落空。修：arxivIdOf 归一 + byArxiv 索引。
 * - 触发门（根因②，refsFetch.ts 已修；engine.ts 同款一行不在文件名单内，见汇报）：
 *   原只在「查不到本篇 / referenced_works 为空」时兜底，「有引用数据但 0 条匹配进库」
 *   不再兜底，全链直接以 0 收场。
 */

let dir: string
let dataDir: string
let db: Database.Database
let stub: StubLlm
let fx: FixtureHttp
let graphId: number
let meId: number
let pAttention: number
let pFewShot: number
let pEmergent: number

/** 引用论文 Me 的 full.md 参考文献段：DOI / arXiv 带版本号 / 纯标题 三种条目 */
const MD_REFS = `# Me Paper

## 7 References

[1] A. Vaswani et al. Attention is all you need. arXiv:1706.03762v3, 2017.
[2] T. Brown et al. Language models are few-shot learners. https://doi.org/10.48550/arXiv.2005.14165, 2020.
[3] J. Wei et al. Emergent abilities of large language models. 2022.

## Appendix

附录不该进参考文献段。
`

/** stub LLM 按真实兜底输出返回：arXiv 条目标题带后缀（标题径过不了 0.95，只能靠 arXiv 径） */
const LLM_REFS_JSON = JSON.stringify([
  { title: 'Attention is all you need (arXiv preprint)', year: 2017, doi: 'arXiv:1706.03762v3' },
  { title: 'Language models are few-shot learners', year: 2020, doi: 'https://doi.org/10.48550/arXiv.2005.14165' },
  { title: 'Emergent abilities of large language models', year: 2022 }
])

function writeMeMd(md: string): void {
  const d = join(dataDir, 'papers', String(meId), 'mineru')
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'full.md'), md, 'utf8')
}

function insPaper(title: string, extra: Partial<{ doi: string; arxiv: string; author: string | null; year: number; wid: string }> = {}): number {
  const now = new Date().toISOString()
  return Number(
    db
      .prepare(
        `INSERT INTO papers (title, source, has_pdf, doi, arxiv_id, first_author, year, openalex_wid, created_at, updated_at)
         VALUES (?, 'zotero', 1, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(title, extra.doi ?? null, extra.arxiv ?? null, extra.author ?? null, extra.year ?? null, extra.wid ?? null, now, now).lastInsertRowid
  )
}

const llm = () => ({ baseUrl: stub.baseUrl, apiKey: 'k', model: 'deepseek-flash' })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gt-refchain-'))
  dataDir = join(dir, 'Graphictero')
  mkdirSync(dataDir, { recursive: true })
  db = new Database(join(dataDir, 'graphictero.db'))
  runMigrations(db, MIGRATIONS)
  const now = new Date().toISOString()
  graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('引用诊断图', now, now).lastInsertRowid)
  meId = insPaper('Me Paper')
  pAttention = insPaper('Attention Is All You Need', { doi: '10.48550/arxiv.1706.03762', arxiv: '1706.03762', author: 'Vaswani', year: 2017 })
  pFewShot = insPaper('Language Models are Few-Shot Learners', { doi: '10.48550/arXiv.2005.14165', author: 'Brown', year: 2020, wid: 'W3' })
  // D165 根因B 的复现条件：库内论文 first_author 为 NULL（导入缺姓）
  pEmergent = insPaper('Emergent Abilities of Large Language Models', { arxiv: '2206.07682', author: null, year: 2022 })
  const ins = db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)')
  for (const pid of [meId, pAttention, pFewShot, pEmergent]) ins.run(graphId, pid, now)
  stub = await startStubLlm([{ kind: 'ok', text: LLM_REFS_JSON }])
  fx = await startFixtureHttp({
    works: [
      { wid: 'W1', title: 'Me Paper', year: 2023, referencedWorks: ['W2', 'W3', 'W4'] },
      // W2：OpenAlex 的 doi 是全 URL、大小写与库内不同——parseWork/normDoi 归一后应命中 DOI 径
      { wid: 'W2', doi: 'https://doi.org/10.48550/arXiv.1706.03762', title: 'Attention Is All You Need', year: 2017, authors: ['Ashish Vaswani'] },
      // W3：无 DOI，靠 openalex_wid 精确命中
      { wid: 'W3', title: 'Language Models are Few-Shot Learners', year: 2020, authors: ['Tom B. Brown'] },
      // W4：无 DOI 无 W-ID，标题与库内全同，但库内 first_author 为 NULL → 阈值②拒（根因B）
      { wid: 'W4', title: 'Emergent Abilities of Large Language Models', year: 2022, authors: ['Jason Wei'] }
    ]
  })
})

afterEach(async () => {
  await stub.close()
  await fx.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function oaClient() {
  return createOpenAlexClient({ baseUrl: fx.baseUrl, minIntervalMs: 0, maxRetries: 0, sleep: async () => {} })
}

describe('环0：References 段切分（referencesExtract.extractReferencesSection）', () => {
  it('编号标题 / 冒号尾 / 加粗都能切到，下一个标题截止', () => {
    const body = extractReferencesSection(MD_REFS)
    expect(body).not.toBeNull()
    expect(body).toContain('[1] A. Vaswani')
    expect(body).toContain('[3] J. Wei')
    expect(body).not.toContain('Appendix') // 下一个小标题截止
    expect(extractReferencesSection('# P\n\n## **References:**\n\n[1] x\n')).toContain('[1] x')
    expect(extractReferencesSection('# P\n\n参 考 文 献\n\n[1] x\n')).toContain('[1] x')
    expect(extractReferencesSection('# P\n\n正文，没有参考文献段。\n')).toBeNull()
  })
})

describe('环1：OpenAlex referenced_works 匹配（openalex/references.ts）', () => {
  it('逐条命中数：DOI 径 1、W-ID 径 1、标题径 1（uat4 已修阈值②：库内 first_author NULL 不再拒标题强匹配）', async () => {
    const r = await fetchOpenAlexReferences(db, oaClient(), meId)
    expect(r.workFound).toBe(true)
    expect(r.refCount).toBe(3) // referenced_works 三条元数据全取回
    expect(r.wroteCount).toBe(3)
    expect(r.matchedCount).toBe(3) // ← 逐环诊断数字：OpenAlex 一路 3/3（修复前 2/3，标题径被阈值②误拒）
    const rows = db
      .prepare("SELECT openalex_wid, matched_paper_id FROM paper_references WHERE paper_id = ? AND source = 'openalex' ORDER BY openalex_wid")
      .all(meId) as Array<{ openalex_wid: string; matched_paper_id: number | null }>
    const byWid = new Map(rows.map((x) => [x.openalex_wid, x.matched_paper_id]))
    expect(byWid.get('W2')).toBe(pAttention) // DOI 径（URL/大小写归一）
    expect(byWid.get('W3')).toBe(pFewShot) // W-ID 径
    expect(byWid.get('W4')).toBe(pEmergent) // 标题全同、库内无姓：uat4 阈值②放行（0.95 强标题匹配不凭 NULL 姓误拒）
  })

  it('姓氏冲突仍拒（阈值②只对「库内缺姓」放行，不对「姓不同」放行）', async () => {
    db.prepare("UPDATE papers SET first_author = 'Wang' WHERE id = ?").run(pEmergent)
    db.prepare('DELETE FROM paper_references WHERE paper_id = ?').run(meId)
    const r = await fetchOpenAlexReferences(db, oaClient(), meId)
    expect(r.matchedCount).toBe(2)
  })
})

describe('环2：DeepSeek 兜底抽取匹配（referencesExtract，D165 根因①修复验证）', () => {
  it('arxivIdOf 归一：版本号 / 前缀 / arXiv-DOI 全剥掉', () => {
    expect(arxivIdOf('arXiv:1706.03762v3')).toBe('1706.03762')
    expect(arxivIdOf('https://arxiv.org/abs/1706.03762')).toBe('1706.03762')
    expect(arxivIdOf('10.48550/arXiv.2005.14165')).toBe('2005.14165')
    expect(arxivIdOf('cs/9901001v2')).toBe('cs/9901001')
    expect(arxivIdOf('10.1000/xyz')).toBeNull()
    expect(arxivIdOf(null)).toBeNull()
  })

  it('三种条目全匹配：arXiv 带版本号走 arXiv 径、URL DOI 走 DOI 径、纯标题走标题径', async () => {
    writeMeMd(MD_REFS)
    const r = await extractReferencesWithLlm({ db, dataDir, paperId: meId, llm })
    expect(r.sectionFound).toBe(true)
    expect(r.wroteCount).toBe(3) // 解析出 3 条参考文献
    expect(r.matchedCount).toBe(3) // 修复后 3/3（修复前：arXiv 条目双径落空，2/3）
    const rows = db
      .prepare("SELECT title, matched_paper_id FROM paper_references WHERE paper_id = ? AND source = 'deepseek' ORDER BY year")
      .all(meId) as Array<{ title: string; matched_paper_id: number | null }>
    expect(rows).toHaveLength(3)
    expect(rows[0].matched_paper_id).toBe(pAttention) // arXiv:1706.03762v3 → 1706.03762
    expect(rows[1].matched_paper_id).toBe(pFewShot) // https://doi.org/10.48550/arXiv.2005.14165
    expect(rows[2].matched_paper_id).toBe(pEmergent) // 纯标题（库内无姓，兜底标题径不放行姓阈值）
  })
})

describe('触发门：matchedCount=0 也走兜底（refsFetch.ts，D165 根因②修复验证）', () => {
  it('OpenAlex 有引用数据但 0 条匹配进库 → fellBackToLlm=true，两路计数互补累计', async () => {
    writeMeMd(MD_REFS)
    // 本篇按标题找回、referenced_works 非空，但参考方的元数据与库全不相干 → matchedCount=0
    const client = makeFakeOpenAlex({
      async searchWorksByTitle(title: string) {
        return [{ wid: 'W1', doi: null, title, publicationYear: 2023, firstAuthorSurname: null, referencedWorks: ['W9'] }]
      },
      async fetchWorksByWids(wids) {
        return wids.map((w) => ({ wid: w, doi: null, title: `Totally Unrelated ${w}`, publicationYear: 1999, firstAuthorSurname: 'zzz', referencedWorks: [] }))
      }
    })
    const v = await fetchReferencesView({ db, dataDir, paperId: meId, client, llm })
    expect(v.workFound).toBe(true)
    expect(v.fellBackToLlm).toBe(true) // 修复前：matchedCount=0 不兜底，全链以 0 收场
    expect(v.matchedCount).toBe(3) // openalex 0 + deepseek 3
    expect(v.refCount).toBe(4) // openalex 写了 1 行 + deepseek 3 行
    expect(v.refsTruncated).toBe(false)
  })
})

describe('环3：autoTypes cites（引用数据 → 自动类型与方向）', () => {
  it('Me 引了 Attention → cites 附加，方向被引方 → 引用方', async () => {
    writeMeMd(MD_REFS)
    await extractReferencesWithLlm({ db, dataDir, paperId: meId, llm })
    // 生成器语义：LLM 草稿 src/dst 任意方向，autoTypes 以引用数据为准纠正
    const r1 = computeAutoTypes(db, graphId, pAttention, meId)
    expect(r1.autoTypes).toContain('cites')
    expect(r1.srcPaperId).toBe(pAttention) // 被引方 → src
    expect(r1.dstPaperId).toBe(meId)
    const r2 = computeAutoTypes(db, graphId, meId, pAttention) // 反着传也得同样结论
    expect(r2.autoTypes).toContain('cites')
    expect(r2.srcPaperId).toBe(pAttention)
  })
})

describe('uat4-fix2 D174：引用写入触发 recalcNoRefBasis（fetchOpenAlexReferences 集成）', () => {
  function insBasedOn(src: number, dst: number, sourceType: 'job' | 'session', noRefBasis: number): number {
    const now = new Date().toISOString()
    return Number(
      db
        .prepare(
          `INSERT INTO relations (graph_id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types,
             source_type, no_ref_basis, created_at, updated_at)
           VALUES (?, ?, ?, ?, 's', '["based_on"]', '[]', ?, ?, ?, ?)`
        )
        .run(graphId, Math.min(src, dst), Math.max(src, dst), src, sourceType, noRefBasis, now, now).lastInsertRowid
    )
  }
  const flag = (rid: number): number =>
    (db.prepare('SELECT no_ref_basis AS v FROM relations WHERE id = ?').get(rid) as { v: number }).v

  it('AI 边（job）按 cites 重算 1→0；手工边（session）不被打标——写库路径事务提交后自动触发', async () => {
    // Me 引了 Attention / Few-shot / Emergent（fixture 3/3 命中）
    const aiEdge = insBasedOn(meId, pAttention, 'job', 1) // 旧误标 1
    const manualEdge = insBasedOn(meId, pEmergent, 'session', 0) // 有证据也不该被打标
    const r = await fetchOpenAlexReferences(db, oaClient(), meId) // 写库 → 事务内触发 recalc
    expect(r.matchedCount).toBe(3)
    expect(flag(aiEdge)).toBe(0) // cites 证据 → 1 改回 0（AI 边重算）
    expect(flag(manualEdge)).toBe(0) // D174：手工边不动（即便 Me↔Emergent 有 cites 证据）
  })

  // 注：「两端都无引用行保持 0」的单元口径在 084_no_ref_basis_backfill.test.ts（D174 用例）。
})
