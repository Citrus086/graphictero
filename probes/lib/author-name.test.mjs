import { describe, expect, it } from 'vitest'
import { hasCommonAuthor, normalizeAuthorName } from './author-name.mjs'

describe('作者姓名规范化（D93）', () => {
  it('转小写、去重音、去标点、合并空格', () => {
    expect(normalizeAuthorName('José  María  García-López')).toBe('josé maría garcía lópez'.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))
    expect(normalizeAuthorName('John H. Smith')).toBe('john h smith')
  })

  it('"姓, 名" 形式统一翻转为「名 姓」', () => {
    expect(normalizeAuthorName('Smith, John')).toBe(normalizeAuthorName('John Smith'))
    expect(normalizeAuthorName('García-López, José María')).toBe(normalizeAuthorName('José María García-López'))
  })

  it('完全一致才算同一人（不做模糊匹配/缩写推断）', () => {
    expect(normalizeAuthorName('John Smith')).not.toBe(normalizeAuthorName('John Smyth'))
    expect(normalizeAuthorName('J Smith')).not.toBe(normalizeAuthorName('John Smith'))
  })

  it('hasCommonAuthor 按规范化比较两组作者', () => {
    expect(hasCommonAuthor(['Smith, John'], ['Jane Doe', 'JOHN SMITH'])).toBe(true)
    expect(hasCommonAuthor(['John Smith'], ['Jane Doe'])).toBe(false)
  })
})
