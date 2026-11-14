import type { OpenAlexClient } from '../openalex/client'
import { isUsablePdfLocation } from './download'

/**
 * lane/fetch 批 1：OpenAlex best_oa_location 来源（D131 内建链第二环）。
 * 优先用检索时缓存的 oa_url（graph_candidates.oa_url，经任务 payload 传来，
 * 免得每篇都再查一次）；没有则按 DOI / W-ID 现查。
 */

export interface OpenAlexOaInput {
  doi?: string | null
  openalexWid?: string | null
  /** 检索时拿到的 best_oa_location（061 列缓存） */
  cachedOaUrl?: string | null
}

export async function openAlexOaUrl(client: OpenAlexClient, input: OpenAlexOaInput): Promise<string | null> {
  // 缓存链接来自 OpenAlex/本应用任务 payload（非用户输入），http(s) 都接受；
  // 真正出站前 download.ts 还会卡一次 https（回环测试地址除外）
  if (input.cachedOaUrl && isUsablePdfLocation(input.cachedOaUrl)) return input.cachedOaUrl
  const work = input.doi
    ? await client.fetchWorkFullByDoi(input.doi)
    : input.openalexWid
      ? await client.fetchWorkFullByWid(input.openalexWid)
      : null
  const oa = work?.oaUrl ?? null
  return oa && isUsablePdfLocation(oa) ? oa : null
}
