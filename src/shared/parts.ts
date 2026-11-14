import { z } from 'zod'
import { compileMathExpression, MATH_FORBIDDEN_VARIABLE_NAMES, MATH_FUNCTION_NAMES } from './mathExpr'

/**
 * 共享契约：详情 / 富文本 / 会话消息的 parts（D19/D20，渲染层见设计文档「富文本输出与渲染层」）。
 *
 * M5 车道期间冻结：lane/agent 产出与存储、lane/chat
 * 渲染都以本文件为准；改字段走维护者，两车道同步（M4 先例：`DetailPart` 导出名不变，
 * 避免 M4 详情代码 churn）。
 *
 * - 每个 part 有 `type`；data part 另带 `id` + `status`（D20）。详情是后台生成完才入库，
 *   status 恒为 'done'；会话（M5）流式期间为 'streaming'，出错为 'error'。
 * - data-figure 只存引用（图号 + 可选图注快照）；路径/页码/bbox 渲染时经 `pdf:listFigures`
 *   解析（单一事实来源，Q6 坐标口径）。
 * - data-image 来源必填（D20）；M4 只渲染本地缓存，不发网络请求（D109）。
 * - M5 会话新增三类（D32/D8/D30）：data-paper-card（候选卡片）、data-graph-change（改图
 *   小结）、data-trace（灰色读取记录行，平面无 id/status，同 text）。详情生成不产出这三类，
 *   仅会话消费；渲染组件归 lane/chat（落地前 PartsView 对合法新 part 走降级块，不崩）。
 */

export const PART_STATUS = ['streaming', 'done', 'error'] as const
export type PartStatus = (typeof PART_STATUS)[number]

const dataBase = { id: z.string().min(1).max(200), status: z.enum(PART_STATUS) }

export const TextPartSchema = z.object({ type: z.literal('text'), text: z.string() })
export const SourcePartSchema = z.object({
  type: z.literal('source'),
  paperId: z.number().int().positive().optional(),
  section: z.string().max(500).optional(),
  quote: z.string().max(5000).optional()
})
export const FigurePartSchema = z.object({
  type: z.literal('data-figure'),
  ...dataBase,
  figureNo: z.number().int().positive(),
  caption: z.string().max(5000).optional()
})
export const ImagePartSchema = z.object({
  type: z.literal('data-image'),
  ...dataBase,
  url: z.string().max(2000),
  /** D115：数据目录内相对路径（如 papers/7/web/x.png），经 gt-asset:// 加载；不是绝对路径 */
  localPath: z.string().max(2000).optional(),
  alt: z.string().max(1000).optional(),
  sourceUrl: z.string().min(1).max(2000),
  sourceTitle: z.string().max(1000).optional()
})
export const ChartPartSchema = z.object({
  type: z.literal('data-chart'),
  ...dataBase,
  title: z.string().max(500),
  /** ECharts option（待 lane/render 白名单校验后渲染，不 eval） */
  option: z.unknown(),
  dataSource: z.string().min(1).max(2000)
})
export const MermaidPartSchema = z.object({
  type: z.literal('data-mermaid'),
  ...dataBase,
  title: z.string().max(500),
  code: z.string().max(50000)
})

// ── D211 交互讲解：只保存结构化数学规格，渲染端用安全求值器计算，不执行模型代码 ──

const INTERACTIVE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const INTERACTIVE_RESERVED = new Set([
  ...MATH_FUNCTION_NAMES,
  'pi',
  'e',
  ...MATH_FORBIDDEN_VARIABLE_NAMES
])
const interactiveIdentifier = z
  .string()
  .min(1)
  .max(64)
  .regex(INTERACTIVE_IDENTIFIER)
  .refine((id) => !INTERACTIVE_RESERVED.has(id), '标识符与函数、常量或保留字冲突')
const finiteNumber = z.number().finite()
const interactiveLabel = z.string().min(1).max(80)
const interactiveUnit = z.string().max(20).optional()

export const InteractiveParamSchema = z
  .object({
    id: interactiveIdentifier,
    label: interactiveLabel,
    control: z.enum(['slider', 'number', 'select', 'toggle']),
    min: finiteNumber.optional(),
    max: finiteNumber.optional(),
    step: finiteNumber.optional(),
    default: finiteNumber,
    options: z
      .array(z.object({ label: interactiveLabel, value: finiteNumber }))
      .min(1)
      .max(12)
      .optional(),
    unit: interactiveUnit
  })
  .superRefine((param, ctx) => {
    if (param.min !== undefined && param.max !== undefined && param.min >= param.max) {
      ctx.addIssue({ code: 'custom', message: 'min 必须小于 max', path: ['min'] })
    }
    if (param.step !== undefined && param.step <= 0) {
      ctx.addIssue({ code: 'custom', message: 'step 必须大于 0', path: ['step'] })
    }
    if (param.control === 'slider' || param.control === 'number') {
      if (param.min === undefined || param.max === undefined || param.step === undefined) {
        ctx.addIssue({ code: 'custom', message: 'slider/number 必须提供 min、max、step' })
      } else if (param.default < param.min || param.default > param.max) {
        ctx.addIssue({ code: 'custom', message: 'default 必须在 min/max 范围内', path: ['default'] })
      }
    } else if (param.control === 'select') {
      if (!param.options?.length) {
        ctx.addIssue({ code: 'custom', message: 'select 必须提供 options', path: ['options'] })
      } else {
        if (!param.options.some((option) => option.value === param.default)) {
          ctx.addIssue({ code: 'custom', message: 'default 必须是 options 中的一个值', path: ['default'] })
        }
        if (new Set(param.options.map((option) => option.value)).size !== param.options.length) {
          ctx.addIssue({ code: 'custom', message: 'options 的 value 不得重复', path: ['options'] })
        }
      }
    } else if (param.default !== 0 && param.default !== 1) {
      ctx.addIssue({ code: 'custom', message: 'toggle 的 default 只能为 0 或 1', path: ['default'] })
    }
  })

export const InteractiveExpressionSchema = z.object({
  id: interactiveIdentifier,
  label: interactiveLabel,
  expr: z.string().min(1).max(300),
  unit: interactiveUnit,
  precision: z.number().int().min(0).max(8).optional(),
  format: z.enum(['fixed', 'sci', 'percent']).optional()
})

const InteractivePlotXSchema = z.union([
  interactiveIdentifier,
  z
    .object({
      xVar: interactiveIdentifier,
      from: finiteNumber,
      to: finiteNumber,
      samples: z.number().int().min(2).max(400).optional()
    })
    .refine((x) => x.from < x.to, { message: 'plot.x.from 必须小于 to' })
])

export const InteractivePlotSchema = z.object({
  x: InteractivePlotXSchema,
  series: z
    .array(z.object({ expr: z.string().min(1).max(300), label: interactiveLabel }))
    .min(1)
    .max(4),
  xLabel: z.string().max(80).optional(),
  yLabel: z.string().max(80).optional(),
  kind: z.enum(['line', 'scatter']).default('line')
})

export const InteractivePartSchema = z
  .object({
    type: z.literal('data-interactive'),
    ...dataBase,
    title: interactiveLabel,
    params: z.array(InteractiveParamSchema).min(1).max(8),
    expressions: z.array(InteractiveExpressionSchema).min(1).max(8),
    plot: InteractivePlotSchema.optional(),
    caption: z.string().max(600).optional(),
    sourceNote: z.string().min(1).max(600)
  })
  .superRefine((part, ctx) => {
    const paramIds = new Set<string>()
    const expressionIds = new Set<string>()
    for (const [index, param] of part.params.entries()) {
      if (paramIds.has(param.id)) {
        ctx.addIssue({ code: 'custom', message: `参数 id 重复：${param.id}`, path: ['params', index, 'id'] })
      }
      paramIds.add(param.id)
    }
    for (const [index, expression] of part.expressions.entries()) {
      if (paramIds.has(expression.id) || expressionIds.has(expression.id)) {
        ctx.addIssue({ code: 'custom', message: `表达式 id 重复或与参数冲突：${expression.id}`, path: ['expressions', index, 'id'] })
      }
      expressionIds.add(expression.id)
      try {
        const compiled = compileMathExpression(expression.expr)
        const available = new Set([...paramIds, ...part.expressions.slice(0, index).map((item) => item.id)])
        for (const variable of compiled.variables) {
          if (!available.has(variable)) {
            ctx.addIssue({
              code: 'custom',
              message: `表达式只能引用参数与前面的表达式：${variable}`,
              path: ['expressions', index, 'expr']
            })
          }
        }
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          message: error instanceof Error ? error.message : '表达式无效',
          path: ['expressions', index, 'expr']
        })
      }
    }
    if (!part.plot) return
    const xVar = typeof part.plot.x === 'string' ? part.plot.x : part.plot.x.xVar
    if (typeof part.plot.x === 'string') {
      const xParam = part.params.find((param) => param.id === part.plot?.x)
      if (!xParam) {
        ctx.addIssue({ code: 'custom', message: 'plot.x 必须引用参数 id', path: ['plot', 'x'] })
      } else if ((xParam.control !== 'slider' && xParam.control !== 'number') || xParam.min === undefined || xParam.max === undefined) {
        ctx.addIssue({ code: 'custom', message: '字符串 plot.x 必须引用带 min/max 的数值参数', path: ['plot', 'x'] })
      }
    }
    if (typeof part.plot.x !== 'string' && expressionIds.has(xVar) && !paramIds.has(xVar)) {
      ctx.addIssue({ code: 'custom', message: 'plot.x.xVar 与表达式 id 冲突', path: ['plot', 'x', 'xVar'] })
    }
    const available = new Set([...paramIds, ...expressionIds, xVar])
    for (const [index, series] of part.plot.series.entries()) {
      if (expressionIds.has(series.expr)) continue
      try {
        const compiled = compileMathExpression(series.expr)
        for (const variable of compiled.variables) {
          if (!available.has(variable)) {
            ctx.addIssue({ code: 'custom', message: `曲线引用了未知变量：${variable}`, path: ['plot', 'series', index, 'expr'] })
          }
        }
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          message: error instanceof Error ? error.message : '曲线表达式无效',
          path: ['plot', 'series', index, 'expr']
        })
      }
    }
  })

// ── M5 会话扩展（D32/D8/D30；详情不产出，仅会话消费）──────────────────

/** D32 候选论文卡片。cardStatus 是卡片业务态（区别于 part 的流式 status）。 */
export const PaperCardPartSchema = z.object({
  type: z.literal('data-paper-card'),
  ...dataBase,
  title: z.string().min(1).max(2000),
  authors: z.array(z.string().max(500)).max(50),
  year: z.number().int().positive().optional(),
  venue: z.string().max(1000).optional(),
  doi: z.string().max(500).optional(),
  arxivId: z.string().max(200).optional(),
  /** 推荐理由（一句话） */
  reason: z.string().min(1).max(2000),
  cardStatus: z.enum(['candidate', 'confirmed', 'ignored']),
  /** D55 去重命中：已在库中的论文 id（「已在论文库中」） */
  existingPaperId: z.number().int().positive().optional(),
  /** 开放获取落地链接（https） */
  oaUrl: z.string().max(2000).optional(),
  /** D159：只有标题对上库中论文 */
  titleDup: z.boolean().optional(),
  /** D161：已在本图谱，卡片不出「确认加入」 */
  inGraph: z.boolean().optional(),
  /** uat5 D168/必须修 2：OpenAlex 回填未通过核对（卡片低调提示） */
  unverified: z.boolean().optional(),
  /** D182（uat6b）：重复提议命中本图谱已有的 pending 候选——卡片提示「已在待确认候选中」
   *  （按钮：定位 / 确认加入；不新建重复候选行） */
  pendingDup: z.boolean().optional()
})

/** M5 改图类型（D32）。新增类型走维护者扩枚举（契约冻结）。 */
export const GRAPH_CHANGE_TYPES = ['addRelation', 'updateRelation', 'deleteRelation', 'addCandidate'] as const
export type GraphChangeType = (typeof GRAPH_CHANGE_TYPES)[number]

/** D32 改图小结行：定位（画布 flash）+「撤销本轮改动」（D119）。 */
export const GraphChangePartSchema = z.object({
  type: z.literal('data-graph-change'),
  ...dataBase,
  changeType: z.enum(GRAPH_CHANGE_TYPES),
  /** 涉及的关系边 id（addRelation/deleteRelation 等） */
  relationIds: z.array(z.number().int().positive()).max(100),
  /** 涉及的论文节点 id（addCandidate 的候选、边的两端等） */
  paperIds: z.array(z.number().int().positive()).max(100),
  /** 一句话说明改了什么 */
  summary: z.string().min(1).max(2000),
  /** M6 前置 2a（D129）：改动前快照 id（relation_snapshots，修改/删除时写入）；
   *  旧数据无快照 → 撤销如实拒绝。可选字段，不改既有数据 */
  snapshotIds: z.array(z.number().int().positive()).max(100).optional()
})

/** D8/D30 灰色读取记录行：每次工具读取一行、可展开原文（存 session_traces）。 */
export const TracePartSchema = z.object({
  type: z.literal('data-trace'),
  toolName: z.string().min(1).max(200),
  paperId: z.number().int().positive().optional(),
  summary: z.string().min(1).max(2000),
  excerpt: z.string().max(50000).optional()
})

export const DetailPartSchema = z.discriminatedUnion('type', [
  TextPartSchema,
  SourcePartSchema,
  FigurePartSchema,
  ImagePartSchema,
  ChartPartSchema,
  MermaidPartSchema,
  InteractivePartSchema,
  PaperCardPartSchema,
  GraphChangePartSchema,
  TracePartSchema
])

export type TextPart = z.infer<typeof TextPartSchema>
export type SourcePart = z.infer<typeof SourcePartSchema>
export type FigurePart = z.infer<typeof FigurePartSchema>
export type ImagePart = z.infer<typeof ImagePartSchema>
export type ChartPart = z.infer<typeof ChartPartSchema>
export type MermaidPart = z.infer<typeof MermaidPartSchema>
export type InteractivePart = z.infer<typeof InteractivePartSchema>
export type InteractiveParam = z.infer<typeof InteractiveParamSchema>
export type InteractiveExpression = z.infer<typeof InteractiveExpressionSchema>
export type PaperCardPart = z.infer<typeof PaperCardPartSchema>
export type GraphChangePart = z.infer<typeof GraphChangePartSchema>
export type TracePart = z.infer<typeof TracePartSchema>
export type DetailPart = z.infer<typeof DetailPartSchema>

/** 适配层白名单（D19/D20）：不在此列的 type 渲染降级块 */
export const DETAIL_PART_TYPES = [
  'text',
  'source',
  'data-figure',
  'data-image',
  'data-chart',
  'data-mermaid',
  'data-interactive',
  'data-paper-card',
  'data-graph-change',
  'data-trace'
] as const
export type DetailPartType = (typeof DETAIL_PART_TYPES)[number]

export function isDetailPartType(t: unknown): t is DetailPartType {
  return typeof t === 'string' && (DETAIL_PART_TYPES as readonly string[]).includes(t)
}
