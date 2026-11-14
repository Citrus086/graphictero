import { useState } from 'react'
import type { SourcePart } from '../../../../shared/parts'

/**
 * M4 lane/render：source 引用块（D19）——灰色引用行，可展开看引文。
 * paperId 存在时点击跳库（M4 无路由消费方，先展示为文本来源）。
 */
export function SourceBlock({ part }: { part: SourcePart }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const label = part.section ?? (part.paperId != null ? `论文 #${part.paperId}` : '来源')
  return (
    <div className="gt-part-source" data-testid="part-source">
      <button type="button" className="gt-source-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="gt-source-mark">引</span>
        <span className="gt-source-label">{label}</span>
        <span className="gt-source-toggle">{open ? '收起' : '展开'}</span>
      </button>
      {open && part.quote ? <blockquote className="gt-source-quote">{part.quote}</blockquote> : null}
    </div>
  )
}
