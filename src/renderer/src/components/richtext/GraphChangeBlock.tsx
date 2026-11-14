import { useState } from 'react'
import type { GraphChangePart } from '../../../../shared/parts'
import { usePartsHost } from './PartsHostContext'
import { Ic } from '../../lib/icons'

/** 改图类型中文标签（D32） */
const CHANGE_LABELS: Record<GraphChangePart['changeType'], string> = {
  addRelation: '新增关系',
  updateRelation: '修改关系',
  deleteRelation: '删除关系',
  addCandidate: '新增候选'
}

/**
 * M5 lane/chat 批 3：data-graph-change 改图小结行（D32/D30）。
 *
 * 一句话说明本轮改了什么；行内「定位」→ 画布 flash 高亮（宿主注入 onLocateGraphChange），
 * 「撤销本轮改动」→ 撤销组（D119，宿主注入 onUndoGraphChange；Agent 运行中禁用，
 * D77/D88）。详情页不传回调即纯展示。
 */
export function GraphChangeBlock({ part }: { part: GraphChangePart }): React.JSX.Element {
  const host = usePartsHost()
  const [undone, setUndone] = useState(false)
  // uat5 建议修 5：小结里的 P0x 内部编号显示时换成《短标题》（只展示，不写库）
  const summary = host.replaceShortIdsForDisplay ? host.replaceShortIdsForDisplay(part.summary) : part.summary
  return (
    <div className="gt-part-gchange" data-testid="part-graph-change" data-change={part.changeType}>
      <span className="gt-gchange-tag">{CHANGE_LABELS[part.changeType]}</span>
      <span className="gt-gchange-summary">{summary}</span>
      <span className="grow" />
      {host.onLocateGraphChange && (
        <button type="button" className="btn bordered sm" data-testid="gchange-locate" onClick={() => host.onLocateGraphChange?.(part)}>
          定位
        </button>
      )}
      {host.onUndoGraphChange && (
        <button
          type="button"
          className="btn bordered sm"
          data-testid="gchange-undo"
          disabled={host.undoDisabled || undone}
          title={host.undoDisabled ? 'Agent 运行中，暂不能撤销（D77）' : '撤销本轮改动'}
          onClick={() => {
            if (undone || host.undoDisabled) return
            const ret = host.onUndoGraphChange?.(part)
            void Promise.resolve(ret).then(
              (ok) => {
                if (ok !== false) setUndone(true)
              },
              () => {}
            )
          }}
        >
          {undone ? '已撤销' : '撤销本轮改动'}
        </button>
      )}
    </div>
  )
}
