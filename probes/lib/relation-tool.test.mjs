import { describe, expect, it } from 'vitest'
import { createAddRelation, LLM_RELATION_TYPES, pairKey } from './relation-tool.mjs'

const KEYS = ['P01', 'P02', 'P03']

describe('addRelation 工具（D84/D86/D89）', () => {
  it('LLM 可选类型只有 基于/改进、具体实现、对比（D89：引用/同一作者是自动只读类型）', () => {
    expect(LLM_RELATION_TYPES).toEqual(['基于/改进', '具体实现', '对比'])
  })

  it('合法写入返回 ok:true 并记录关系', async () => {
    const { addRelation, relations } = createAddRelation(KEYS)
    const out = await addRelation.execute({ src: 'P01', dst: 'P02', types: ['对比'], statement: 's' })
    expect(out.ok).toBe(true)
    expect(relations).toHaveLength(1)
  })

  it('id 无效或自环时把校验错误作为工具结果返回（D86）', async () => {
    const { addRelation, relations } = createAddRelation(KEYS)
    const bad = await addRelation.execute({ src: 'P99', dst: 'P02', types: ['对比'], statement: 's' })
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('id 无效或自环')
    const loop = await addRelation.execute({ src: 'P01', dst: 'P01', types: ['对比'], statement: 's' })
    expect(loop.ok).toBe(false)
    expect(relations).toHaveLength(0)
  })

  it('同一无序论文对重复写入幂等：正反向各写一次只留一条边，内容以后写为准（D86/D89）', async () => {
    const { addRelation, relations } = createAddRelation(KEYS)
    await addRelation.execute({ src: 'P01', dst: 'P02', types: ['对比'], statement: '第一次' })
    const again = await addRelation.execute({ src: 'P02', dst: 'P01', types: ['基于/改进'], statement: '第二次' })
    expect(again.ok).toBe(true)
    expect(again.merged).toBe(true)
    expect(relations).toHaveLength(1)
    expect(relations[0].src).toBe('P02')
    expect(relations[0].statement).toBe('第二次')
    // 不同论文对不受影响
    await addRelation.execute({ src: 'P01', dst: 'P03', types: ['对比'], statement: 's' })
    expect(relations).toHaveLength(2)
  })

  it('pairKey 与方向无关', () => {
    expect(pairKey('P01', 'P02')).toBe(pairKey('P02', 'P01'))
  })

  it('每步软上限：超限的 addRelation 把校验错误作为工具结果返回且不记录（报告 §7）', async () => {
    const keys = ['P01', 'P02', 'P03']
    const { addRelation, relations, resetStepCount } = createAddRelation(keys, { perStepLimit: 2 })
    expect((await addRelation.execute({ src: 'P01', dst: 'P02', types: ['对比'], statement: 'a' })).ok).toBe(true)
    expect((await addRelation.execute({ src: 'P01', dst: 'P03', types: ['对比'], statement: 'b' })).ok).toBe(true)
    const over = await addRelation.execute({ src: 'P02', dst: 'P03', types: ['对比'], statement: 'c' })
    expect(over.ok).toBe(false)
    expect(over.error).toContain('软上限')
    expect(relations).toHaveLength(2) // 超限调用不计入
    // step-start 边界重置计数后可以继续写（「每步」语义）
    resetStepCount()
    expect((await addRelation.execute({ src: 'P02', dst: 'P03', types: ['对比'], statement: 'c' })).ok).toBe(true)
    expect(relations).toHaveLength(3)
  })

  it('默认无每步上限（perStepLimit 不传）', async () => {
    const { addRelation, relations } = createAddRelation(['P01', 'P02', 'P03'])
    for (let i = 0; i < 60; i++) {
      const out = await addRelation.execute({ src: 'P01', dst: 'P02', types: ['对比'], statement: `s${i}` })
      expect(out.ok).toBe(true)
    }
    expect(relations).toHaveLength(1) // 同一无序对只留一条
  })
})
