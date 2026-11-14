import { describe, expect, it } from 'vitest'
import { AUTO_RELATION_TYPES, RELATION_TYPES, isRelationType, relationTypeLabel } from './relationTypes'

/** 边上显示的类型组合短标签（D84：如「基于 · 对比」，不显示陈述）。 */
describe('relationTypeLabel（D84 类型组合短标签）', () => {
  it('单类型', () => {
    expect(relationTypeLabel(['based_on'])).toBe('基于/改进')
    expect(relationTypeLabel(['same_author'])).toBe('同一作者')
  })

  it('多类型按固定顺序输出，与传入顺序无关', () => {
    expect(relationTypeLabel(['compares', 'based_on'])).toBe('基于/改进 · 对比')
    expect(relationTypeLabel(['cites', 'compares', 'based_on'])).toBe('基于/改进 · 对比 · 引用')
    expect(relationTypeLabel(['same_author', 'cites'])).toBe('引用 · 同一作者')
  })

  it('空数组返回空串；未知类型被忽略', () => {
    expect(relationTypeLabel([])).toBe('')
    expect(relationTypeLabel(['based_on', 'nope' as never])).toBe('基于/改进')
  })

  it('五种原子类型集合与自动类型（D89）', () => {
    expect(RELATION_TYPES).toHaveLength(5)
    expect(AUTO_RELATION_TYPES).toEqual(['cites', 'same_author'])
    expect(isRelationType('compares')).toBe(true)
    expect(isRelationType('comparison')).toBe(false)
  })
})
