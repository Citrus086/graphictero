import { describe, expect, it } from 'vitest'
import {
  SIDEBAR_BODY_MIN_CHARS,
  applySidebarHits,
  mergeSidebarHits,
  sidebarQueryChars,
  sidebarTitleMatches,
  type SidebarPaperRef
} from './sidebarSearch'

/**
 * uat8a D188：渲染层与主进程共用的合并 / 去重 / 排序。纯函数，不碰库。
 */

const papers: SidebarPaperRef[] = [
  { id: 1, title: 'Alpha Methods', firstAuthor: 'Wei Zhang' },
  { id: 2, title: 'Beta Survey', firstAuthor: 'Li Wang' },
  { id: 3, title: 'Gamma Notes', firstAuthor: 'Na Liu' }
]

describe('sidebarQueryChars（D188 阈值）', () => {
  it('trim 后按 Unicode 码位计数，中文单字算 1', () => {
    expect(sidebarQueryChars('')).toBe(0)
    expect(sidebarQueryChars('  a  ')).toBe(1)
    expect(sidebarQueryChars('图')).toBe(1)
    expect(sidebarQueryChars('机器')).toBe(2)
    expect(sidebarQueryChars('  图 ')).toBe(1)
    expect(SIDEBAR_BODY_MIN_CHARS).toBe(2)
  })
})

describe('mergeSidebarHits（标题在前、正文在后、去重、截断）', () => {
  it('标题命中保持原序在前；只在正文命中的按 rank 升序接在后面', () => {
    const hits = mergeSidebarHits(papers, 'alpha', [
      { paperId: 3, rank: 0.2 },
      { paperId: 2, rank: 0.9 },
      { paperId: 1, rank: 0.1 }
    ])
    expect(hits.map((h) => [h.paperId, h.via])).toEqual([
      [1, 'title'],
      [3, 'body'],
      [2, 'body']
    ])
  })

  it('同一篇标题与正文都命中只保留标题命中，且不带正文', () => {
    const hits = mergeSidebarHits(papers, 'Alpha', [
      { paperId: 1, rank: 0.01 },
      { paperId: 2, rank: 0.5 }
    ])
    expect(hits).toEqual([
      { paperId: 1, via: 'title' },
      { paperId: 2, via: 'body' }
    ])
  })

  it('正文 rank 相同则保持 papers 原序；不在本段的 id 丢掉', () => {
    const hits = mergeSidebarHits(papers, 'zzz', [
      { paperId: 99, rank: 0.01 },
      { paperId: 3, rank: 0.4 },
      { paperId: 1, rank: 0.4 }
    ])
    expect(hits.map((h) => h.paperId)).toEqual([1, 3])
  })

  it('标题先占满 limit，正文不再挤进来', () => {
    const hits = mergeSidebarHits(papers, 'note', [{ paperId: 1, rank: 0.1 }, { paperId: 2, rank: 0.2 }], 1)
    expect(hits).toEqual([{ paperId: 3, via: 'title' }])
  })

  it('标题未占满时正文按 rank 补到 limit', () => {
    const hits = mergeSidebarHits(papers, 'Beta', [
      { paperId: 3, rank: 0.2 },
      { paperId: 1, rank: 0.8 }
    ], 2)
    expect(hits).toEqual([
      { paperId: 2, via: 'title' },
      { paperId: 3, via: 'body' }
    ])
  })

  it('空查询返回全部，via=title，不截断', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, title: `P${i}` }))
    expect(mergeSidebarHits(many, '   ', [], 2)).toHaveLength(5)
  })

  it('作者子串也算标题命中（沿用改前侧栏口径）', () => {
    expect(sidebarTitleMatches(papers[0]!, 'zhang')).toBe(true)
    expect(mergeSidebarHits(papers, 'zhang', [{ paperId: 2, rank: 0.1 }])[0]).toEqual({
      paperId: 1,
      via: 'title'
    })
  })
})

describe('applySidebarHits（渲染层套用）', () => {
  it('空查询忽略服务端结果，原样全列', () => {
    const rows = applySidebarHits(papers, '', [{ paperId: 2, via: 'body' }])
    expect(rows.map((r) => r.paper.id)).toEqual([1, 2, 3])
    expect(rows.every((r) => r.via === 'title')).toBe(true)
  })

  it('服务端未回时只做本地标题过滤', () => {
    const rows = applySidebarHits(papers, 'Beta', null)
    expect(rows.map((r) => [r.paper.id, r.via])).toEqual([[2, 'title']])
  })

  it('服务端结果去重后套回论文对象，丢掉已不在列表里的 id', () => {
    const rows = applySidebarHits(papers, 'token', [
      { paperId: 9, via: 'body' },
      { paperId: 3, via: 'body' },
      { paperId: 1, via: 'title' }
    ])
    expect(rows.map((r) => [r.paper.id, r.via])).toEqual([
      [3, 'body'],
      [1, 'title']
    ])
  })
})
