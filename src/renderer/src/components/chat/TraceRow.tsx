import { useState } from 'react'
import type { TracePart } from '../../../../shared/parts'
import { Ic } from '../../lib/icons'

/**
 * M5 lane/chat 批 1：data-trace 灰色读取记录行（D8/D30）。
 *
 * 每次工具读取产生一行：工具名 + 一句话摘要；有 excerpt 时可点击展开原文。
 * 被 richtext/PartsView 白名单分发引用（D19 会话与详情共用渲染器），也归本车道所有。
 */
const TRACE_TOOL_LABELS: Record<string, string> = {
  webSearch: '联网搜索',
  webFetch: '抓取网页',
  searchPapers: '检索论文',
  getPapers: '查看论文',
  readPaper: '读原文',
  searchLibrary: '检索文库',
  getFigure: '查看插图',
  addRelation: '新增关系',
  updateRelation: '修改关系',
  deleteRelation: '删除关系',
  listRelations: '查看关系',
  recallHistory: '回查历史',
  proposeCandidate: '提议候选',
  searchImages: '检索图片'
}

export function TraceRow({ part }: { part: TracePart }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const expandable = !!part.excerpt
  const label = TRACE_TOOL_LABELS[part.toolName] ?? part.toolName
  return (
    <div className="gt-part-trace" data-testid="part-trace" data-tool={part.toolName}>
      <button
        type="button"
        className="gt-trace-head"
        disabled={!expandable}
        title={expandable ? (open ? '收起原文' : '展开原文') : undefined}
        onClick={() => {
          if (expandable) setOpen((v) => !v)
        }}
      >
        <Ic name="search" size={12} />
        <span className="gt-trace-tool">{label}</span>
        <span className="gt-trace-summary">{part.summary}</span>
        {expandable && <span className="gt-trace-toggle">{open ? '收起' : '展开原文'}</span>}
      </button>
      {open && part.excerpt && <pre className="gt-trace-excerpt">{part.excerpt}</pre>}
    </div>
  )
}
