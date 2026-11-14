import { createContext, useContext } from 'react'
import { assetUrl } from '../../../../shared/assetUrl'
import type { CardLiveState } from '../../../../shared/ipc/agent'
import type { GraphChangePart, PaperCardPart } from '../../../../shared/parts'

/**
 * M4 lane/render：PartsView 的宿主环境上下文。
 *
 * PartsView props 冻结（{ parts, onOpenFigure? }），但图块解析（pdf:listFigures）
 * 需要 paperId——这不是「内容」，而是宿主页面环境，经本 Context 注入（详情页由
 * lane/detail 包 Provider；smoke 经 smokeEntry 挂载）。不包 Provider 时所有能力优雅
 * 降级（图块只显示图注快照、图片块只显示 alt + 来源），不崩。
 *
 * D115：本地图片一律走 gt-asset://（主进程 realpath 校验在数据目录内），渲染层
 * 不再持有数据目录绝对路径——宿主只给 paperId。
 */
export interface PartsHost {
  /** 当前详情所属论文 id：data-figure 经 window.graphictero.listFigures(paperId) 解析 */
  paperId?: number
  /** M5 会话宿主注入（可选，D32/D117）：data-paper-card 确认/加入图谱/忽略。
   *  uat6b S4(a)：返回 Promise 时卡片把 busy 守到它 settle（挡住同 tick 双击与慢 IPC） */
  onCandidateAction?: (part: PaperCardPart, action: 'confirm' | 'ignore') => void | Promise<void>
  /** 卡片业务态实时覆写（按候选最新状态；无匹配返回 null 用 part.cardStatus） */
  candidateStatusOf?: (part: PaperCardPart) => 'candidate' | 'confirmed' | 'ignored' | null
  /**
   * uat8b D191：按当前库刷新旧卡片。null / unknown 不在这里出现——宿主查不到时不传，
   * 卡片保持消息快照（uat6b/uat6c「已在本图谱中」、D182 去重卡片不回退）。
   */
  cardLiveOf?: (part: PaperCardPart) => CardLiveState | null
  /** M5 会话宿主注入（可选，D32）：data-graph-change 行内「定位」→ 画布 flash */
  onLocateGraphChange?: (part: GraphChangePart) => void
  /** D182（uat6b）：「已在待确认候选中」卡片「定位」→ 画布高亮候选虚线节点（或其在图谱中的论文节点）。
   *  D191：已在本图谱时附上当前 paperId，画布优先高亮论文节点。 */
  onLocateCandidate?: (part: PaperCardPart, paperId?: number | null) => void
  /** M5 会话宿主注入（可选，D119）：data-graph-change 行内「撤销本轮改动」。返回 false 表示没撤销成。 */
  onUndoGraphChange?: (part: GraphChangePart) => void | Promise<boolean | void>
  /** Agent 运行中（D77/D88）：撤销组入口禁用 */
  undoDisabled?: boolean
  /** uat5 建议修 5：P0x 显示层替换（改图小结 / 回复文本展示前过一遍；只展示不写库） */
  replaceShortIdsForDisplay?: (text: string) => string
}

export const PartsHostContext = createContext<PartsHost>({})

export function usePartsHost(): PartsHost {
  return useContext(PartsHostContext)
}

/**
 * 数据目录内相对缓存路径 → gt-asset:// URL（D115）。词法防穿越（拒绝绝对、..、
 * 反斜杠、空段）+ 每段百分号编码（评审建 2：空格/#/?/%）；主进程再做 realpath
 * 校验（symlink 外指在主进程拦截）。不合法 → null。
 */
export function cacheAssetUrl(relPath: string): string | null {
  return assetUrl(relPath)
}
