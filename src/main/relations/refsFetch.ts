import type Database from 'better-sqlite3'
import type { OpenAlexClient } from '../openalex/client'
import { fetchOpenAlexReferences } from '../openalex/references'
import { extractReferencesWithLlm } from './referencesExtract'
import type { LlmClientDeps } from '../llm/client'
import type { RefsFetchView } from '../../shared/ipc/relations'

/**
 * rel:fetchReferences 的服务层（单篇拉取引用统计，OpenAlex + D40 兜底）。
 * 从 ipc/relations.ts 抽出以便直接单测（评审建议修（rel3）2：RefsExtractResult.truncated
 * 此前没有消费方——视图补 refsTruncated 字段）。
 */

export interface RefsFetchDeps {
  db: Database.Database
  dataDir: string
  paperId: number
  client: OpenAlexClient
  llm: () => LlmClientDeps
}

export async function fetchReferencesView(deps: RefsFetchDeps): Promise<RefsFetchView> {
  const { db, dataDir, paperId, client } = deps
  const r = await fetchOpenAlexReferences(db, client, paperId)
  // uat4 D165：兜底条件扩到「matchedCount === 0」——OpenAlex 本篇查得到、referenced_works
  // 也非空、但一条都没匹配进库（W-ID/DOI/标题三径全落空，UAT 实测 8 篇互引 0 命中的一部分
  // 原因就是落在这里后不再兜底）时，仍用 DeepSeek 从 References 段再试一轮。deepseek 行与
  // openalex 行 source 不同、互不覆盖，两路命中互补累计。
  if (!r.workFound || r.refCount === 0 || r.matchedCount === 0) {
    // D40 兜底：OpenAlex 查不到本篇 / referenced_works 为空（最新预印本常态）/ 全部未匹配进库
    const ex = await extractReferencesWithLlm({ db, dataDir, paperId, llm: deps.llm })
    if (ex.sectionFound) {
      return {
        workFound: r.workFound,
        refCount: r.refCount + ex.wroteCount, // 两路行数累计（openalex 行未被清）
        matchedCount: r.matchedCount + ex.matchedCount,
        fellBackToLlm: true,
        refsTruncated: ex.truncated
      }
    }
    // References 段不存在：维持 OpenAlex 一路的口径
    return { workFound: r.workFound, refCount: r.refCount, matchedCount: r.matchedCount, fellBackToLlm: false, refsTruncated: false }
  }
  return { workFound: true, refCount: r.refCount, matchedCount: r.matchedCount, fellBackToLlm: false, refsTruncated: false }
}
