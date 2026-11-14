import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { startStubLlm, type StubLlm } from '../llm/stubServer'
import { makeFakeOpenAlex } from '../openalex/testing'
import type { OpenAlexWork } from '../openalex/client'
import { fetchReferencesView } from './refsFetch'

/**
 * rel:fetchReferences 服务层测试（评审建议修（rel3）2：RefsExtractResult.truncated
 * 的消费方——RefsFetchView.refsTruncated）。本地 stub LLM + 假 OpenAlex 客户端，
 * 不触网。
 */

const MD_WITH_REFS = `# Paper

## References

[1] R. Bommasani et al. "On the Opportunities and Risks of Foundation Models." 2021.
`

let dir: string
let dataDir: string
let db: Database.Database
let stub: StubLlm
let paperId: number

function writeMd(id: number, md: string): void {
  const d = join(dataDir, 'papers', String(id), 'mineru')
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'full.md'), md, 'utf8')
}

const llm = () => ({ baseUrl: stub.baseUrl, apiKey: 'k', model: 'deepseek-flash' })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gt-refsfetch-'))
  dataDir = join(dir, 'Graphictero')
  mkdirSync(dataDir, { recursive: true })
  db = new Database(join(dataDir, 'graphictero.db'))
  runMigrations(db, MIGRATIONS)
  const now = new Date().toISOString()
  paperId = Number(
    db.prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES ('Me', 'zotero', 1, ?, ?)").run(now, now).lastInsertRowid
  )
  stub = await startStubLlm([{ kind: 'ok', text: '[{"title":"Recovered Ref","year":2021}]' }])
})

afterEach(async () => {
  await stub.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('fetchReferencesView（rel:fetchReferences 服务层）', () => {
  it('OpenAlex 查到本篇且有 referenced_works：不走兜底，refsTruncated=false', async () => {
    const client = makeFakeOpenAlex({
      async searchWorksByTitle(title: string) {
        return [{ wid: 'W1', doi: null, title, publicationYear: null, firstAuthorSurname: null, referencedWorks: ['W9'] }]
      },
      async fetchWorksByWids(wids): Promise<OpenAlexWork[]> {
        return wids.map((w) => ({ wid: w, doi: null, title: `T ${w}`, publicationYear: 2020, firstAuthorSurname: null, referencedWorks: [] }))
      }
    })
    const v = await fetchReferencesView({ db, dataDir, paperId, client, llm })
    expect(v.workFound).toBe(true)
    expect(v.refCount).toBe(1)
    expect(v.fellBackToLlm).toBe(false)
    expect(v.refsTruncated).toBe(false)
    expect(stub.requests).toHaveLength(0) // 没调 LLM
  })

  it('OpenAlex 查不到 → LLM 兜底完整输出：fellBackToLlm=true，refsTruncated=false', async () => {
    writeMd(paperId, MD_WITH_REFS)
    const v = await fetchReferencesView({ db, dataDir, paperId, client: makeFakeOpenAlex(), llm })
    expect(v.workFound).toBe(false)
    expect(v.fellBackToLlm).toBe(true)
    expect(v.refCount).toBe(1)
    expect(v.refsTruncated).toBe(false)
  })

  it('OpenAlex 查不到 → LLM 兜底输出被截断：refsTruncated=true（提示「没抽完」）', async () => {
    await stub.close()
    stub = await startStubLlm([{ kind: 'ok', text: '[{"title":"Recovered Ref","year":2021},{"title":"Cut Off' }]) // mid-JSON 截断
    writeMd(paperId, MD_WITH_REFS)
    const v = await fetchReferencesView({ db, dataDir, paperId, client: makeFakeOpenAlex(), llm })
    expect(v.workFound).toBe(false)
    expect(v.fellBackToLlm).toBe(true)
    expect(v.refsTruncated).toBe(true)
    expect(v.refCount).toBe(1) // 捞回 1 条完整对象
  })

  it('OpenAlex 查不到且没有 References 段：不兜底，refsTruncated=false', async () => {
    writeMd(paperId, '# Paper\n\n没有参考文献段。\n')
    const v = await fetchReferencesView({ db, dataDir, paperId, client: makeFakeOpenAlex(), llm })
    expect(v.fellBackToLlm).toBe(false)
    expect(v.refCount).toBe(0)
    expect(v.refsTruncated).toBe(false)
    expect(stub.requests).toHaveLength(0)
  })
})
