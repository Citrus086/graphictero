import type { OpenAlexWork } from './client'

/**
 * D71 按标题找回的三条阈值（与 probes/openalex-probe.mjs 同一实现，逐行移植）：
 * ① 规范化标题相似度 ≥ 0.95（bigram Dice）；
 * ② 第一作者姓一致（papers.first_author 是姓；OpenAlex 取 display_name 末词）；
 * ③ 年份 ±1（任一为 null 则放行）。
 * 达不到就留空（D49：只少引用一路信号）；找回的 DOI 记 doi_match_method='openalex_title'，
 * 且不参与自动去重（D71）。
 */

/** 规范化：小写 → NFD 去重音 → 非字母数字（保留 CJK）转空格（probe 同口径） */
export function normTitle(t: string): string {
  return t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9一-鿿]+/gi, ' ')
    .trim()
}

/** bigram Dice 相似度（probe 同口径；词长 <2 的单词取整词作一个 gram） */
export function titleSim(a: string, b: string): number {
  const A = normTitle(a)
  const B = normTitle(b)
  if (!A || !B) return 0
  const big = (s: string): Set<string> =>
    new Set(
      s
        .split(' ')
        .flatMap((w) => (w.length < 2 ? [w] : Array.from({ length: w.length - 1 }, (_, i) => w.slice(i, i + 2))))
    )
  const X = big(A)
  const Y = big(B)
  let inter = 0
  for (const g of X) if (Y.has(g)) inter++
  return (2 * inter) / (X.size + Y.size)
}

export interface TitleMatchCandidate {
  title: string | null
  publicationYear: number | null
  firstAuthorSurname: string | null
}

export interface PaperForTitleMatch {
  title: string
  /** 第一作者姓（papers.first_author 列） */
  firstAuthor: string | null
  year: number | null
}

/** 应用 D71 三条阈值，返回唯一命中（多条命中取相似度最高且达阈值的）；无命中返回 null */
export function findTitleMatch(paper: PaperForTitleMatch, candidates: OpenAlexWork[]): OpenAlexWork | null {
  let best: { work: OpenAlexWork; sim: number } | null = null
  for (const c of candidates) {
    if (!c.title) continue
    const sim = titleSim(paper.title, c.title)
    if (sim < 0.95) continue // 阈值①
    // 阈值②：第一作者姓一致（本方无姓信息时放行）
    const surnameOk = paper.firstAuthor
      ? (c.firstAuthorSurname ?? null) === paper.firstAuthor.toLowerCase()
      : true
    if (!surnameOk) continue
    // 阈值③：年份 ±1（任一为 null 放行）
    const yearOk = paper.year == null || c.publicationYear == null || Math.abs(c.publicationYear - paper.year) <= 1
    if (!yearOk) continue
    if (!best || sim > best.sim) best = { work: c, sim }
  }
  return best?.work ?? null
}
