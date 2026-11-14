import { describe, expect, it } from 'vitest'
import { DETAIL_PART_TYPES, DetailPartSchema, InteractivePartSchema, isDetailPartType } from './parts'
import { MATH_FORBIDDEN_VARIABLE_NAMES } from './mathExpr'

const interactivePart = {
  type: 'data-interactive',
  id: 'power-law',
  status: 'done',
  title: '幂律误差探索',
  params: [
    { id: 'a', label: '收敛指数 a', control: 'slider', min: 0.2, max: 3, step: 0.1, default: 1 },
    {
      id: 'C',
      label: '尺度 C',
      control: 'select',
      default: 1,
      options: [
        { label: '标准', value: 1 },
        { label: '双倍', value: 2 }
      ]
    },
    { id: 'n', label: '迭代次数 n', control: 'number', min: 1, max: 1000, step: 1, default: 10 },
    { id: 'enabled', label: '计入误差', control: 'toggle', default: 1 }
  ],
  expressions: [
    { id: 'err', label: '误差', expr: 'enabled * C * n^(-a)' }
  ],
  plot: {
    x: { xVar: 'n', from: 1, to: 1000, samples: 120 },
    series: [{ expr: 'err', label: '误差曲线' }],
    xLabel: 'n',
    yLabel: '误差',
    kind: 'line'
  },
  caption: '调整参数观察误差变化。',
  sourceNote: '自造 fixture：式 (1)'
}

describe('parts 契约（D19/D20；M5 扩三类，D211 交互讲解）', () => {
  it('十种 part 均可通过校验', () => {
    const samples = [
      { type: 'text', text: '正文 $x^2$' },
      { type: 'source', paperId: 1, section: '4.1' },
      { type: 'data-figure', id: 'f1', status: 'done', figureNo: 2 },
      { type: 'data-image', id: 'i1', status: 'done', url: 'cache://a.png', sourceUrl: 'https://example.org' },
      { type: 'data-chart', id: 'c1', status: 'done', title: 't', option: { series: [] }, dataSource: 'Table 2' },
      { type: 'data-mermaid', id: 'm1', status: 'done', title: 't', code: 'graph TD; A-->B' },
      interactivePart,
      {
        type: 'data-paper-card',
        id: 'pc1',
        status: 'done',
        title: '候选论文',
        authors: ['张三', '李四'],
        year: 2024,
        doi: '10.1/x',
        reason: '被 2 篇库内论文引用',
        cardStatus: 'candidate',
        existingPaperId: 7
      },
      {
        type: 'data-graph-change',
        id: 'gc1',
        status: 'done',
        changeType: 'addRelation',
        relationIds: [31],
        paperIds: [1, 2],
        summary: '新增了 A 基于 B 的关系'
      },
      { type: 'data-trace', toolName: 'readPaper', paperId: 3, summary: '读了 3.2 方法一节', excerpt: '原文……' }
    ]
    for (const s of samples) expect(DetailPartSchema.safeParse(s).success).toBe(true)
    expect(DETAIL_PART_TYPES).toHaveLength(10)
    for (const t of DETAIL_PART_TYPES) expect(isDetailPartType(t)).toBe(true)
  })
  it('必填字段缺失 / 未知类型被拒', () => {
    // data-image 来源必填
    expect(DetailPartSchema.safeParse({ type: 'data-image', id: 'i', status: 'done', url: 'x' }).success).toBe(false)
    // M5 三类缺必填字段（title/authors/reason/cardStatus 等）不通过
    expect(DetailPartSchema.safeParse({ type: 'data-paper-card', id: 'p', status: 'done' }).success).toBe(false)
    expect(
      DetailPartSchema.safeParse({ type: 'data-graph-change', id: 'g', status: 'done', changeType: 'addRelation' })
        .success
    ).toBe(false)
    expect(DetailPartSchema.safeParse({ type: 'data-trace', toolName: 'readPaper' }).success).toBe(false)
    // changeType 只认枚举
    expect(
      DetailPartSchema.safeParse({
        type: 'data-graph-change',
        id: 'g',
        status: 'done',
        changeType: 'moveNode',
        relationIds: [],
        paperIds: [],
        summary: 'x'
      }).success
    ).toBe(false)
    // 真正的未知类型不在白名单
    expect(isDetailPartType('data-video')).toBe(false)
    expect(isDetailPartType('data-figure')).toBe(true)
    expect(isDetailPartType('data-interactive')).toBe(true)
  })

  it('D211 校验控件边界、标识符、选项与尺寸上限', () => {
    expect(InteractivePartSchema.safeParse(interactivePart).success).toBe(true)
    const badBounds = structuredClone(interactivePart)
    badBounds.params[0].min = 4
    expect(InteractivePartSchema.safeParse(badBounds).success).toBe(false)
    const badStep = structuredClone(interactivePart)
    badStep.params[0].step = 0
    expect(InteractivePartSchema.safeParse(badStep).success).toBe(false)
    const badDefault = structuredClone(interactivePart)
    badDefault.params[0].default = 4
    expect(InteractivePartSchema.safeParse(badDefault).success).toBe(false)
    const noOptions = structuredClone(interactivePart)
    delete (noOptions.params[1] as { options?: unknown }).options
    expect(InteractivePartSchema.safeParse(noOptions).success).toBe(false)
    const badSelectDefault = structuredClone(interactivePart)
    badSelectDefault.params[1].default = 3
    expect(InteractivePartSchema.safeParse(badSelectDefault).success).toBe(false)
    const badToggle = structuredClone(interactivePart)
    badToggle.params[3].default = 2
    expect(InteractivePartSchema.safeParse(badToggle).success).toBe(false)
    const reserved = structuredClone(interactivePart)
    ;(reserved.params[0] as { id: string }).id = 'sin'
    expect(InteractivePartSchema.safeParse(reserved).success).toBe(false)
    for (const id of MATH_FORBIDDEN_VARIABLE_NAMES) {
      const blocked = structuredClone(interactivePart)
      blocked.params[0].id = id
      blocked.expressions[0].expr = `${id} + 1`
      expect(InteractivePartSchema.safeParse(blocked).success).toBe(false)
    }
    const duplicateOptions = structuredClone(interactivePart)
    duplicateOptions.params[1].options = [{ label: '一', value: 1 }, { label: '重复', value: 1 }]
    expect(InteractivePartSchema.safeParse(duplicateOptions).success).toBe(false)
    const duplicate = structuredClone(interactivePart)
    ;(duplicate.params[1] as { id: string }).id = 'a'
    expect(InteractivePartSchema.safeParse(duplicate).success).toBe(false)
    const tooMany = structuredClone(interactivePart)
    tooMany.plot.series = Array.from({ length: 5 }, () => ({ expr: 'err', label: 'x' }))
    expect(InteractivePartSchema.safeParse(tooMany).success).toBe(false)
    const tooManySamples = structuredClone(interactivePart)
    tooManySamples.plot.x.samples = 401
    expect(InteractivePartSchema.safeParse(tooManySamples).success).toBe(false)
    const stringX = structuredClone(interactivePart)
    ;(stringX.plot as { x: unknown }).x = 'n'
    expect(InteractivePartSchema.safeParse(stringX).success).toBe(true)
    const selectX = structuredClone(interactivePart)
    ;(selectX.plot as { x: unknown }).x = 'C'
    expect(InteractivePartSchema.safeParse(selectX).success).toBe(false)
  })

  it('D211 拒绝前向/循环表达式引用与非法曲线变量', () => {
    const forward = structuredClone(interactivePart)
    forward.expressions = [
      { id: 'first', label: '先', expr: 'later + n' },
      { id: 'later', label: '后', expr: 'n + 1' }
    ]
    forward.plot.series = [{ expr: 'first', label: 'x' }]
    expect(InteractivePartSchema.safeParse(forward).success).toBe(false)
    const cycle = structuredClone(interactivePart)
    cycle.expressions = [
      { id: 'first', label: '一', expr: 'second + 1' },
      { id: 'second', label: '二', expr: 'first + 1' }
    ]
    cycle.plot.series = [{ expr: 'first', label: 'x' }]
    expect(InteractivePartSchema.safeParse(cycle).success).toBe(false)
    const self = structuredClone(interactivePart)
    self.expressions[0].expr = 'err + 1'
    expect(InteractivePartSchema.safeParse(self).success).toBe(false)
    const badPlot = structuredClone(interactivePart)
    badPlot.plot.series[0].expr = 'unknown + n'
    expect(InteractivePartSchema.safeParse(badPlot).success).toBe(false)
  })
})
