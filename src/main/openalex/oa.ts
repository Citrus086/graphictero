import { widOf } from './client'

/**
 * lane/fetch 批 1：OpenAlex work 富视图解析（m6_plan §3.1）——searchPapers 需要
 * 标题/作者全名/期刊/被引数/摘要/best_oa_location，比既有薄视图 OpenAlexWork 宽。
 * 纯函数，fixture 快照测试锁定字段口径。
 */

export interface OpenAlexWorkFull {
  /** 裸 W-ID（如 W2962883861） */
  wid: string
  /** 归一化 DOI（小写、无 https://doi.org/ 前缀）；没有为 null */
  doi: string | null
  title: string | null
  year: number | null
  /** 作者 display_name 全名列表（保持 OpenAlex 顺序） */
  authors: string[]
  /** 期刊/会议名（primary_location.source.display_name） */
  venue: string | null
  /** 摘要正文（abstract_inverted_index 重建） */
  abstract: string | null
  citedBy: number | null
  /** best_oa_location 的 PDF 直链（没有为 null） */
  oaUrl: string | null
  /** 归一化 arXiv ID（从 doi 10.48550/arXiv.xxxx 派生；没有为 null） */
  arxivId: string | null
  referencedWorks: string[]
}

/** abstract_inverted_index（词 → 位置数组）→ 正文；空/坏形状返回 null */
export function abstractFromInvertedIndex(inv: unknown): string | null {
  if (inv == null || typeof inv !== 'object') return null
  const words = Object.entries(inv as Record<string, unknown>)
  if (words.length === 0) return null
  const positions: Array<{ word: string; pos: number }> = []
  for (const [word, arr] of words) {
    if (!Array.isArray(arr)) continue
    for (const p of arr) {
      if (typeof p === 'number' && Number.isFinite(p)) positions.push({ word, pos: p })
    }
  }
  if (positions.length === 0) return null
  positions.sort((a, b) => a.pos - b.pos)
  return positions.map((p) => p.word).join(' ')
}

/** 从 DOI 派生 arXiv ID（OpenAlex 不直接给；10.48550/arXiv.2501.12345 → 2501.12345） */
export function arxivIdFromDoi(doi: string | null): string | null {
  if (!doi) return null
  const m = /10\.48550\/arxiv\.(\d{4}\.\d{4,5}|\d{7})(v\d+)?$/i.exec(doi.trim())
  return m ? m[1] : null
}

/** OpenAlex work JSON → 富视图（probe/fixture 同口径；纯函数） */
export function parseWorkFull(raw: Record<string, unknown>): OpenAlexWorkFull {
  const authorships = (raw.authorships as Array<Record<string, unknown>> | undefined) ?? []
  const authors = authorships
    .map((a) => a.author as Record<string, unknown> | undefined)
    .map((a) => (typeof a?.display_name === 'string' ? a.display_name : null))
    .filter((a): a is string => a != null && a !== '')
  const primary = raw.primary_location as Record<string, unknown> | undefined
  const source = primary?.source as Record<string, unknown> | undefined
  const venue = typeof source?.display_name === 'string' ? source.display_name : null
  const doi = typeof raw.doi === 'string' ? raw.doi.replace(/^https?:\/\/doi\.org\//i, '').toLowerCase() : null
  const best = raw.best_oa_location as Record<string, unknown> | null | undefined
  const oaUrl =
    typeof best?.pdf_url === 'string' && best.pdf_url ? best.pdf_url : typeof best?.url === 'string' && best.url ? best.url : null
  return {
    wid: widOf(raw.id as string | null) ?? '',
    doi,
    title: (raw.title as string | null) ?? (raw.display_name as string | null) ?? null,
    year: (raw.publication_year as number | null) ?? null,
    authors,
    venue,
    abstract: abstractFromInvertedIndex(raw.abstract_inverted_index),
    citedBy: typeof raw.cited_by_count === 'number' ? raw.cited_by_count : null,
    oaUrl,
    arxivId: arxivIdFromDoi(doi),
    referencedWorks: ((raw.referenced_works as string[] | undefined) ?? [])
      .map((u) => widOf(u))
      .filter((w): w is string => w != null)
  }
}
