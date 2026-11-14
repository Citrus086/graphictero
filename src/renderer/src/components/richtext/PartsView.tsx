import { DetailPartSchema, isDetailPartType, type DetailPart, type InteractivePart } from '../../../../shared/parts'
import { TraceRow } from '../chat/TraceRow'
import { ChartBlock } from './ChartBlock'
import { FallbackBlock } from './FallbackBlock'
import { FigureBlock } from './FigureBlock'
import { GraphChangeBlock } from './GraphChangeBlock'
import { ImageBlock } from './ImageBlock'
import { InteractiveBlock } from './InteractiveBlock'
import { MermaidBlock } from './MermaidBlock'
import { PaperCardBlock } from './PaperCardBlock'
import { SourceBlock } from './SourceBlock'
import { TextBlock } from './TextBlock'
import './richtext.css'

/**
 * M4 渲染 seam（props 冻结）。
 * lane/render 适配层真实现（D19/D20）：
 *
 * - 白名单分发 part（DETAIL_PART_TYPES）；未知 type / zod 校验失败 →
 *   灰色降级块（标类型与原因），不崩、不静默丢弃。
 * - M5 lane/chat 扩展：data-trace → 灰色读取记录行（chat/TraceRow）；data-paper-card →
 *   PaperCardBlock（候选卡片，D117）；data-graph-change → GraphChangeBlock（小结行，
 *   定位/撤销组回调经 PartsHostContext 可选字段注入，批 3 落地）。
 * - D20 同 id 更新语义：带 id 的 data part 按 id 去重，后写覆盖先写，
 *   位置取首次出现处（详情场景无流式，恒为 done，仅防御 M5 会话复用）。
 */
export interface PartsViewProps {
  parts: DetailPart[]
  /** 点击论文原图块 → 跳到 PDF 对应位置（详情页侧接线） */
  onOpenFigure?: (figureNo: number) => void
}

interface NormalizedEntry {
  key: string
  part: DetailPart | null // null = 校验失败，渲染降级块
  typeLabel: string
  reason?: string
  raw?: unknown
}

function normalizeParts(parts: DetailPart[]): NormalizedEntry[] {
  const byId = new Map<string, NormalizedEntry>()
  const out: NormalizedEntry[] = []
  parts.forEach((raw, i) => {
    const typeLabel = raw != null && typeof raw === 'object' && 'type' in raw ? String((raw as { type: unknown }).type) : typeof raw
    const parsed = DetailPartSchema.safeParse(raw)
    if (!parsed.success) {
      const inWhitelist = isDetailPartType(typeLabel)
      out.push({
        key: `bad-${i}`,
        part: null,
        typeLabel,
        reason: inWhitelist ? '字段校验失败' : '不在白名单',
        raw
      })
      return
    }
    const part = parsed.data as DetailPart
    if ('id' in part) {
      const prev = byId.get(part.id)
      if (prev) {
        prev.part = part // 同 id 后写覆盖（D20），位置保持首次出现处
        return
      }
      const entry: NormalizedEntry = { key: part.id, part, typeLabel: part.type }
      byId.set(part.id, entry)
      out.push(entry)
      return
    }
    out.push({ key: `idx-${i}`, part, typeLabel: part.type })
  })
  return out
}

export function PartsView({ parts, onOpenFigure }: PartsViewProps): React.JSX.Element {
  const entries = normalizeParts(parts)
  return (
    <div className="gt-parts" data-testid="parts-view">
      {entries.map((e) => {
        if (!e.part) {
          if (e.typeLabel === 'data-interactive') {
            return <InteractiveBlock key={e.key} part={e.raw as InteractivePart} />
          }
          return <FallbackBlock key={e.key} type={e.typeLabel} reason={e.reason} />
        }
        const p = e.part
        switch (p.type) {
          case 'text':
            return <TextBlock key={e.key} part={p} />
          case 'source':
            return <SourceBlock key={e.key} part={p} />
          case 'data-figure':
            return <FigureBlock key={e.key} part={p} onOpenFigure={onOpenFigure} />
          case 'data-image':
            return <ImageBlock key={e.key} part={p} />
          case 'data-chart':
            return <ChartBlock key={e.key} part={p} />
          case 'data-interactive':
            return <InteractiveBlock key={e.key} part={p} />
          case 'data-mermaid':
            return <MermaidBlock key={e.key} part={p} />
          case 'data-trace':
            return <TraceRow key={e.key} part={p} />
          case 'data-paper-card':
            return <PaperCardBlock key={e.key} part={p} />
          case 'data-graph-change':
            return <GraphChangeBlock key={e.key} part={p} />
          default:
            return <FallbackBlock key={e.key} type={String((p as { type: string }).type)} />
        }
      })}
    </div>
  )
}
