import { describe, expect, it } from 'vitest'
import { findTitleMatch, normTitle, titleSim } from './match'
import type { OpenAlexWork } from './client'

/** D71 三条阈值：规范化标题相似度 ≥0.95、第一作者姓一致、年份 ±1。 */

function work(p: Partial<OpenAlexWork>): OpenAlexWork {
  return {
    wid: 'W1',
    doi: '10.1/x',
    title: 'A Test Paper Title',
    publicationYear: 2020,
    firstAuthorSurname: 'zhang',
    referencedWorks: [],
    ...p
  }
}

describe('normTitle / titleSim', () => {
  it('规范化：小写、去重音、标点转空格（与 probe 同口径）', () => {
    expect(normTitle('Hello, World!')).toBe('hello world')
    expect(normTitle('Café')).toBe('cafe')
    expect(normTitle('  多  空格  ')).toBe('多 空格')
  })

  it('相同标题相似度 1；完全不同为 0', () => {
    expect(titleSim('Graph Neural Networks', 'Graph Neural Networks')).toBe(1)
    expect(titleSim('abc', 'xyz')).toBe(0)
  })

  it('阈值边界：≥0.95 过、略低于被拒', () => {
    // 一个词之差的长标题：bigram Dice ≈0.98 ≥ 0.95
    const a = 'Foundation Models for Computer Science'
    const b = 'Foundation Models for Computer Sciences'
    expect(titleSim(a, b)).toBeGreaterThanOrEqual(0.95)
    expect(titleSim('Short Title', 'Completely Different Thing')).toBeLessThan(0.95)
  })
})

describe('findTitleMatch（D71 三条阈值）', () => {
  const paper = { title: 'On the Opportunities and Risks of Foundation Models', firstAuthor: 'Bommasani', year: 2021 }

  it('三条全满足 → 命中；多条命中取相似度最高', () => {
    const hit = findTitleMatch(paper, [
      work({ title: 'Unrelated Work on Frogs', firstAuthorSurname: 'smith', publicationYear: 2019 }),
      work({ title: 'On the Opportunities and Risks of Foundation Models', firstAuthorSurname: 'bommasani', publicationYear: 2021 })
    ])
    expect(hit?.doi).toBe('10.1/x')
  })

  it('阈值②：第一作者姓不一致 → 拒（标题先对齐，单独验姓）', () => {
    expect(findTitleMatch(paper, [work({ title: paper.title, firstAuthorSurname: 'smith' })])).toBeNull()
    expect(findTitleMatch(paper, [work({ title: paper.title, firstAuthorSurname: 'bommasani' })])).not.toBeNull()
  })

  it('阈值③：年份差 2 → 拒；±1 → 收；任一为 null 放行', () => {
    expect(findTitleMatch(paper, [work({ title: paper.title, firstAuthorSurname: 'bommasani', publicationYear: 2023 })])).toBeNull()
    expect(findTitleMatch(paper, [work({ title: paper.title, firstAuthorSurname: 'bommasani', publicationYear: 2022 })])).not.toBeNull()
    expect(findTitleMatch({ ...paper, year: null }, [work({ title: paper.title, firstAuthorSurname: 'bommasani', publicationYear: 1999 })])).not.toBeNull()
  })

  it('阈值①：相似度不足 0.95 → 拒', () => {
    expect(findTitleMatch(paper, [work({ title: 'Foundation Models Are Changing Everything' })])).toBeNull()
  })

  it('本方无姓信息时阈值②放行', () => {
    expect(findTitleMatch({ ...paper, firstAuthor: null }, [work({ title: paper.title, firstAuthorSurname: 'anyone' })])).not.toBeNull()
  })

  it('候选无标题 → 跳过', () => {
    expect(findTitleMatch(paper, [work({ title: null })])).toBeNull()
  })
})
