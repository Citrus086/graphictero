import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { PaperSummary } from '../../../shared/ipc'
import { paperMeta } from '../lib/format'

export type PaperNodeType = Node<
  {
    paper: PaperSummary
    waitParse?: string | null
    /** uat2：处理中状态（queued/running/waiting）——画布蓝点 + 「处理中」标记（原型 v45_02） */
    proc?: 'queued' | 'running' | 'waiting' | null
    /** uat2 建议修 1：解析/详情失败红点 tooltip 文案 */
    failTitle?: string | null
  } & Record<string, unknown>,
  'paper'
>

/** 画布论文节点（仿原型 .node：白底圆角阴影，标题两行截断 + 元信息行）。
 *  uat7b D184-②：子图里选中描边由数据层 subSelected 驱动——xyflow 点空白会清它
 *  内部 store 的 selected（视觉上丢 .pnode.sel），而我们的选择状态在子图里冻结，
 *  选中圈必须以我们的状态为准。 */
export function PaperNode({ data, selected }: NodeProps<PaperNodeType>): React.JSX.Element {
  const p = data.paper
  const sel = selected || data.subSelected === true
  return (
    <div className={`pnode ${sel ? 'sel' : ''}`}>
      <Handle type="target" position={Position.Top} className="pnode-handle" />
      {/* uat2：处理中蓝点（原型 .edot.pr，右上角）/ 失败红点（原型 .edot） */}
      {data.proc && (
        <span
          className="procdot"
          data-testid="node-proc"
          title={data.proc === 'queued' ? '排队中 · 完成后自动补关系' : '处理中 · 完成后自动补关系'}
        />
      )}
      {!data.proc && data.failTitle && (
        <span className="faildot" data-testid="node-fail" style={{ position: 'absolute', right: 9, top: 10 }} title={data.failTitle} />
      )}
      <div className="t">{p.title}</div>
      <div className="m">
        {paperMeta(p)}
        {!p.hasPdf && <span className="npt">无 PDF</span>}
        {data.proc && (
          <span className="npt" data-testid="node-proc-tag" title={data.proc === 'queued' ? '排队中 · 完成后自动补关系' : '处理中 · 完成后自动补关系'}>
            {data.proc === 'queued' ? '排队中' : '处理中'}
          </span>
        )}
        {/* uat1b D144：MinerU 不可用、有 PDF 未处理 → 节点标「等待解析组件」，原因在 tooltip */}
        {p.hasPdf && data.waitParse && (
          <span className="npt" title={data.waitParse} data-testid="node-wait-parse">
            等待解析组件
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="pnode-handle" />
    </div>
  )
}
