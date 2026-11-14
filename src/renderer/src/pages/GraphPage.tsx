import { preserveMeasured, paperNodeDeclarative } from '../lib/flowNodes'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type OnNodeDrag,
  type ReactFlowInstance,
  type Viewport
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { GraphDetail, PaperSummary, RelationView } from '../../../shared/ipc'
import type { CandidateView } from '../../../shared/ipc/agent'
import type { CandProgressEvent } from '../../../shared/ipc/cand'
import type { GraphChangePart } from '../../../shared/parts'
import { displayCandidateReason } from '../../../shared/candidateReason'
import type { RelationDetailView } from '../../../shared/ipc/relations'
import { RELATION_TYPE_LABELS, relationTypeLabel, type RelationType } from '../../../shared/relationTypes'
import { computeElkLayout } from '../../../shared/layout/elk'
import { shortIdReplaceForDisplay } from '../lib/shortIds'

// uat5：实现抽到 lib/shortIds.ts（对话抽屉复用），此处再导出保持既有引用/测试不变
export { shortIdReplaceForDisplay }
import { canvasCandidates, candidatePositions } from '../lib/candidateLayout'
import { AddPapersModal } from '../components/AddPapersModal'
import { ConfirmDialog } from '../components/Modal'
import { MotionPresence } from '../components/MotionPresence'
import { PaperNode } from '../components/PaperNode'
import { paperMeta } from '../lib/format'
import { Ic } from '../lib/icons'
import { useNotify } from '../lib/notify'
import { ipcErrorMessage } from '../lib/ipcError'
import { UndoStack, type UndoEntry } from '../lib/undo'
import { StatusDot } from '../components/StatusDot'
import { failTitle, usePapersStatus } from '../lib/usePapersStatus'
import { mineruUnavailableReason } from '../lib/mineruStatus'
import { PaperProcessPanel } from '../components/PaperProcessPanel'
import { useMineruStatus } from '../lib/useMineruStatus'
import { agentApi, type ChatEntry } from '../lib/useAgentSession'
import { CAND_IMPORTING_PHASES, CAND_PHASE_LABEL, candApi } from '../lib/candProgress'
import {
  CAND_CONFIRM_ROLLBACK,
  CAND_CONFIRM_START,
  dispatchCandConfirmRollback,
  dispatchCandConfirmStart,
  optimisticPaperOf,
  pruneCandOptimistic,
  withCandConfirmRollback,
  withCandConfirmStart,
  type CandOptimisticEntry
} from '../lib/candOptimistic'
import { ExportDialog } from '../components/export/ExportDialog'
import {
  canvasEscAction,
  filterCanvasNodeChanges,
  isChatDrawerPoint,
  isSubgraphDimEdge,
  isSubgraphDimNode,
  movedPaperPositions,
  paperNodeId,
  prunePaperSelection,
  pruneSubgraphSelection,
  samePaperIdSet,
  selectionAfterPaneClick,
  togglePaperSelection,
  removalRelationSnapshots,
  subgraphRelationIds,
  withPaperSelection
} from '../lib/canvasSelection'
import { saveCanvasFocus, saveCanvasView, takeCanvasFocus, takeCanvasView } from '../lib/subgraphRestore'
import { currentReloadResult } from '../lib/reloadGuard'
import {
  createInterruptibleAnimation,
  currentMotionDisabled,
  interpolatePosition,
  MOTION_BASE_MS,
  MOTION_FAST_MS,
  planNodeTransitions,
  shouldAnimateNodePositions,
  shouldRunPositionTween,
  type InterruptibleAnimation,
  type NodePositionMove
} from '../lib/motion'
import { consumePaperLocateNonce, decidePaperLocate, type PaperLocateRequest } from '../lib/paperLocate'
import {
  buildRelationAdjacency,
  focusNeighborhood,
  neighborhoodEmphasis,
  readSessionTypeFilter,
  relationTypeCounts,
  shouldRunFocusShortcut,
  toggleHiddenRelationType,
  visibleRelationsByType,
  writeSessionTypeFilter,
  type EmphasisState
} from '../lib/canvasFocus'
import {
  SIDEBAR_BODY_MIN_CHARS,
  SIDEBAR_SEARCH_DEBOUNCE_MS,
  applySidebarHits,
  sidebarQueryChars,
  type SidebarHit
} from '../../../shared/sidebarSearch'

const api = window.graphictero

const NW = 200
const NH = 64

/** D200：smoke / e2e / reduced-motion 由统一开关判定；正常视口过渡 200ms。 */
const FIT_ANIMATION_MS = MOTION_BASE_MS
const viewportMotionMs = (): number => (currentMotionDisabled() ? 0 : FIT_ANIMATION_MS)
const DND_MIME = 'application/x-graphictero-paper'

function flowClass(...names: Array<string | false | null | undefined>): string | undefined {
  const value = names.filter(Boolean).join(' ')
  return value || undefined
}

/** D212：hover/选择强调只改 DOM 类，不为每次 hover 重建 nodes/edges。 */
function syncNeighborEmphasisClasses(root: ParentNode | null, emphasis: EmphasisState | null): void {
  if (!root) return
  for (const el of root.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')) {
    const id = paperNodeId(el.dataset.id ?? '')
    const hi = emphasis?.active === true && id != null && emphasis.paperIds.has(id)
    el.classList.toggle('gt-neighbor-hi', hi)
    el.classList.toggle('gt-neighbor-dim', emphasis?.active === true && !hi)
  }
  for (const el of root.querySelectorAll<HTMLElement>('.react-flow__edge[data-id]')) {
    const id = Number(el.dataset.id)
    const hi = emphasis?.active === true && Number.isSafeInteger(id) && emphasis.relationIds.has(id)
    el.classList.toggle('gt-neighbor-hi', hi)
    el.classList.toggle('gt-neighbor-dim', emphasis?.active === true && !hi)
  }
}

type CanvasMenu =
  | { kind: 'paper'; paper: PaperSummary; x: number; y: number }
  | { kind: 'selection'; papers: PaperSummary[]; x: number; y: number }
  | { kind: 'library'; paper: PaperSummary; x: number; y: number }

/** 手工可选的 LLM 关系类型（D89/评审建 3）：「引用」「同一作者」只由程序自动附加、只读 */
const MANUAL_RELATION_TYPES: RelationType[] = ['based_on', 'implements', 'compares']

/** 按关系类型筛选（D84）：勾选 = 显示；全部类型都被隐藏的连线不再渲染 */
const ALL_RELATION_TYPES: RelationType[] = ['based_on', 'implements', 'compares', 'cites', 'same_author']

const GEN_PHASE_LABEL: Record<string, string> = { references: '获取引用', generate: '生成关系' }

/** 方向另一端：src → dst 表示「dst 基于 / 针对 src」（D75） */
function dstOf(r: RelationView): number {
  return r.srcPaper === r.paperLow ? r.paperHigh : r.paperLow
}

/** ⌘Z 快照（D88；uat2b c)：存**完整行**——方向/说明/类型 + autoTypes + provenance
 * （source_type/模型/任务 id/prompt 版本），撤销编辑原样写回、撤销删除按原 id 原地复活
 * （不新建行）。恢复走 rel:restore（带 id 时原地复活；否则 upsert，无序对幂等）。 */
export function snapshotOf(rel: RelationView) {
  return {
    id: rel.id,
    srcPaperId: rel.srcPaper,
    dstPaperId: dstOf(rel),
    statement: rel.statement,
    llmTypes: [...rel.llmTypes],
    autoTypes: [...rel.autoTypes],
    sourceType: rel.sourceType,
    sourceJobId: rel.sourceJobId,
    sourceSessionId: rel.sourceSessionId,
    model: rel.model,
    promptVersion: rel.promptVersion,
    editedAt: rel.editedAt,
    noRefBasis: rel.noRefBasis,
    // uat4-fix1 S2：快照带原 updated_at——⌘Z 恢复写回原时间戳，不盖成撤销时刻（D148/D164）
    updatedAt: rel.updatedAt
  }
}

/** 整理布局撤销组（uat6 S5）里的一条坐标快照 */
export interface LayoutPos {
  paperId: number
  x: number
  y: number
}

/**
 * uat6 S5：「整理」布局的撤销组条目（D119 撤销组口径，纯函数导出单测）。
 * undo = 把整理**前**坐标写回库（runUndo 随后 reload，画布随之恢复）；
 * redo = 再应用整理**后**坐标。只收录坐标真正变化的成员——ELK 结果与现状一致
 * 时整组为空，pushGroup 自动忽略，不产生噪音条目。
 */
export function layoutUndoEntries(graphId: number, before: LayoutPos[], after: LayoutPos[]): UndoEntry[] {
  const afterById = new Map(after.map((p) => [p.paperId, p]))
  const entries: UndoEntry[] = []
  for (const b of before) {
    const a = afterById.get(b.paperId)
    if (!a || (a.x === b.x && a.y === b.y)) continue
    entries.push({
      label: '整理布局',
      undo: async () => {
        await api.setNodePosition(graphId, b.paperId, b.x, b.y) // 恢复整理前坐标（写库，不止画布）
      },
      redo: async () => {
        await api.setNodePosition(graphId, a.paperId, a.x, a.y) // 再应用整理后坐标
      }
    })
  }
  return entries
}

/** 建议修13：画布边标签——类型组合短标签；noRefBasis 低调后缀（灰度由边 labelStyle 承担，与面板同口径）。 */
export function edgeLabelOf(r: RelationView): string {
  const types = [...r.llmTypes, ...r.autoTypes]
  const base = types.length ? relationTypeLabel(types) : '未定类型'
  return r.noRefBasis ? `${base} · 无引用依据` : base
}

/**
 * 建议修14a：界面显示层把旧陈述残留的内部编号（P01…）换成《短标题》/「作者, 年份」。
 * 口径与主进程 text/graphShortIds 一致：图内成员按论文 id 升序编 P01…，对不上 / 越界
 * 的编号剔除，NEW / #N 一并剔除；数据库不改。渲染层不触 db，映射用 getGraph 已返回的
 * 成员现算（纯函数，导出单测）。
 */
/** uat2b d)：弹层定位夹紧——靠近右/下边缘时往左/上翻，完整留在视口内（纯函数，导出单测） */
export function clampMenuPos(
  x: number,
  y: number,
  menuW: number,
  menuH: number,
  vw: number,
  vh: number,
  margin = 8
): { x: number; y: number } {
  return {
    x: Math.max(margin, Math.min(x, vw - menuW - margin)),
    y: Math.max(margin, Math.min(y, vh - menuH - margin))
  }
}

/** uat4 建议修12：placeNewNode 实现抽到 shared/layout/placeNewNode.ts（uat5 建议修 7 主进程候选落位复用），此处再导出保持引用/测试不变 */
import { placeNewNode } from '../../../shared/layout/placeNewNode'
export { placeNewNode }


/**
 * 建议修10：冷启动边渲染兜底的触发判定（纯函数，导出单测）。
 * 「关系非空 && 节点已就绪 && 当前 edges 为空 && 尚未重试过」才触发一次重算——
 * 正常冷启动路径组装 effect 一跑 edges 即等于关系数，该判定恒为 false、零开销。
 */
export function shouldRetryColdStartEdges(
  relationsCount: number,
  edgeCount: number,
  nodeCount: number,
  retried: boolean
): boolean {
  return !retried && relationsCount > 0 && nodeCount > 0 && edgeCount === 0
}

/** uat2-fix1 建议修 2：这个事件该不该关掉弹层（右键菜单/更多/筛选层共用）。
 *  keydown 只响应 Escape（此前任意键都关）；click 落在 .menu/.fpop 内部不关；
 *  blur 等其它事件一律关。 */
export function shouldCloseLayerOn(e: Event): boolean {
  if (e.type === 'keydown') return (e as KeyboardEvent).key === 'Escape'
  if (e.type === 'click') return !(e.target as HTMLElement | null)?.closest?.('.menu, .fpop')
  return true
}

/** D151：0 条关系时图谱上的「生成关系」入口（无危险样式、无替换确认） */
export function GenerateRelationsEntry({
  visible,
  running,
  onGenerate
}: {
  visible: boolean
  running: boolean
  onGenerate: () => void
}): React.JSX.Element | null {
  if (!visible) return null
  return (
    <button
      className="btn bordered"
      data-testid="gen-relations-entry"
      disabled={running}
      title={running ? '关系生成进行中' : '为本图生成关系'}
      onClick={onGenerate}
    >
      <Ic name="rewrite" size={15} />
      生成关系
    </button>
  )
}

/** D151：有关系时「重新生成关系…」（moreMenu 项，带替换确认；确认逻辑内聚，导出单测） */
export function RegenRelationsItem({ running, onRegenerate }: { running: boolean; onRegenerate: () => void }): React.JSX.Element {
  const [confirm, setConfirm] = useState(false)
  return (
    <>
      <div
        className="mi"
        data-testid="menu-regen-relations"
        style={running ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
        title={running ? '关系生成进行中，完成后再重新生成' : undefined}
        onClick={() => {
          if (running) return // 评审建议修 3a：生成进行中禁用入口
          setConfirm(true)
        }}
      >
        <Ic name="rewrite" size={15} />
        重新生成关系…
        <span className="kb">替换自动生成</span>
      </div>
      {/* uat2-fix1 建议修 1：确认框 portal 到 document.body——此前渲染在 .menu 里，
          遮罩只盖住菜单一小块且被 padding-top 顶出；portal 后位于视口中央。 */}
      {createPortal(
        <MotionPresence open={confirm} kind="modal">
          {confirm ? (
          <ConfirmDialog
            title="重新生成本图的关系？"
            okText="重新生成"
            danger
            onOk={() => {
              setConfirm(false)
              onRegenerate()
            }}
            onClose={() => setConfirm(false)}
          >
            {/* D164 如实说明：手动创建的始终保留；AI 自动生成的（即使编辑过）会被替换 */}
            手动创建的关系始终保留；AI 自动生成的关系（即使你编辑过）会被重新生成替换。
            <div className="t3" style={{ fontSize: 11.5, lineHeight: '17px', marginTop: 8 }}>
              按当前论文的详情重新生成；详情未就绪的论文（无 PDF、解析 / 详情处理中）仍不参与。不能用 ⌘Z 撤销。
            </div>
          </ConfirmDialog>
          ) : null}
        </MotionPresence>,
        document.body
      )}
    </>
  )
}

/** 手工连边对话框：src 是拖出的起点 */
function ConnectDialog({
  src,
  dst,
  saving,
  onSave,
  onClose
}: {
  src: PaperSummary
  dst: PaperSummary
  saving: boolean
  onSave: (types: RelationType[], statement: string) => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const [types, setTypes] = useState<Set<RelationType>>(new Set())
  const [statement, setStatement] = useState('')
  const toggle = (t: RelationType): void => {
    setTypes((s) => {
      const n = new Set(s)
      if (n.has(t)) n.delete(t)
      else n.add(t)
      return n
    })
  }
  return (
    <div className="ov" style={{ paddingTop: 120 }}>
      <div className="modal cfm" style={{ width: 420 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>创建关系</div>
        <div className="dirl" style={{ marginTop: 8 }}>
          「<b>{dst.title}</b>」基于 / 针对「<b>{src.title}</b>」
        </div>
        <div className="t3" style={{ fontSize: 11.5, lineHeight: '17px', marginTop: 4 }}>
          箭头从先出现的论文指向后来的论文：A → B 表示「B 基于 / 针对 A」。
        </div>
        <div className="secth" style={{ marginTop: 14 }}>
          <b>关系类型</b>
          <span className="tagtxt">必填 · 可多选</span>
        </div>
        <div className="tags" style={{ marginTop: 6 }}>
          {MANUAL_RELATION_TYPES.map((t) => (
            <span key={t} className={`tag ${types.has(t) ? 'on' : ''}`} onClick={() => toggle(t)}>
              {RELATION_TYPE_LABELS[t]}
            </span>
          ))}
        </div>
        <div className="t3" style={{ fontSize: 11.5, lineHeight: '17px', marginTop: 6 }}>
          「引用」「同一作者」由程序根据引用数据和作者信息自动填写，不能手动选择。
        </div>
        <textarea
          className="ta"
          style={{ marginTop: 12, minHeight: 60 }}
          placeholder="关系说明（选填）"
          value={statement}
          onChange={(e) => setStatement(e.target.value)}
        />
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button className="btn bordered" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={types.size === 0 || saving}
            onClick={() => void onSave([...types], statement)}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

export function GraphPage({
  graphId,
  openAdd,
  onHome,
  onOpenSettings,
  onOpenParseSettings,
  onOpenPaper,
  chatOpen,
  onToggleChat,
  agentRunning,
  locateRequest,
  locateCandidateRequest,
  paperLocateRequest,
  onAddPaperChips,
  onChatDragHover
}: {
  graphId: number
  openAdd?: boolean
  onHome: () => void
  onOpenSettings: () => void
  /** uat1b D144：直达 设置 → PDF 解析（状态点「解析组件不可用 · 去设置」） */
  onOpenParseSettings: () => void
  /** M4 lane/detail：节点点击 → 论文详情页 */
  onOpenPaper: (paperId: number) => void
  /** M5 lane/chat：对话抽屉开合（02 顶栏 = graph 入口；06 关系面板 = relation 入口） */
  chatOpen?: boolean
  onToggleChat?: (entry: ChatEntry) => void
  /** M5 lane/chat 批 3：Agent 运行中禁 ⌘Z/撤销（D77/D88；运行态来自 App 级 hook） */
  agentRunning?: boolean
  /** 改图小结「定位」→ flash 高亮涉及的节点/边 */
  locateRequest?: { part: GraphChangePart; nonce: number } | null
  /** D182（uat6b）：「已在待确认候选中」卡片「定位」→ flash 候选虚线节点（或其在图谱中的论文节点） */
  locateCandidateRequest?: { candidateId: number; paperId?: number | null; nonce: number } | null
  /** D201（uat12）：详情页「定位」→ 画布就绪后平滑 / 瞬时居中该节点并 flash（nonce 消费一次） */
  paperLocateRequest?: PaperLocateRequest | null
  /** D176：把已选论文注入 App 级 pendingChips，复用对话 chip */
  onAddPaperChips?: (paperIds: number[]) => void
  /** D176：xyflow pointer 拖拽悬停对话抽屉时的投放高亮 */
  onChatDragHover?: (active: boolean) => void
}): React.JSX.Element {
  const notify = useNotify()
  const [detail, setDetail] = useState<GraphDetail | null>(null)
  const [library, setLibrary] = useState<PaperSummary[]>([])
  const [sideFilter, setSideFilter] = useState('')
  /** D188：最近一次正文查询结果。query 与当前输入不一致时渲染层不用它（避免乱序覆盖）。 */
  const [sidebarServer, setSidebarServer] = useState<{ query: string; members: SidebarHit[]; others: SidebarHit[] } | null>(null)
  const sidebarSeq = useRef(0)
  const sidebarMemberKey = (detail?.members ?? []).map((m) => m.paper.id).join(',')
  const sidebarOtherKey = library
    .filter((p) => !p.inGraph)
    .map((p) => p.id)
    .join(',')
  useEffect(() => {
    if (sidebarQueryChars(sideFilter) < SIDEBAR_BODY_MIN_CHARS) {
      setSidebarServer(null)
      return
    }
    const search = api.searchSidebar
    if (typeof search !== 'function') return
    const seq = ++sidebarSeq.current
    const q = sideFilter
    const timer = window.setTimeout(() => {
      void search(graphId, q)
        .then((res) => {
          if (seq !== sidebarSeq.current) return
          setSidebarServer({ query: q.trim(), members: res.members, others: res.others })
        })
        .catch(() => {
          if (seq !== sidebarSeq.current) return
          setSidebarServer(null)
        })
    }, SIDEBAR_SEARCH_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      sidebarSeq.current += 1
    }
  }, [sideFilter, graphId, sidebarMemberKey, sidebarOtherKey])
  const [selectedRelId, setSelectedRelId] = useState<number | null>(null)
  const [connect, setConnect] = useState<{ src: PaperSummary; dst: PaperSummary } | null>(null)
  const [savingRel, setSavingRel] = useState(false)
  const [menu, setMenu] = useState<CanvasMenu | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<PaperSummary | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [showAdd, setShowAdd] = useState(!!openAdd)
  const [rf, setRf] = useState<ReactFlowInstance | null>(null)
  const [nodes, setNodes] = useState<Node[]>([])
  const nodesRef = useRef<Node[]>([])
  nodesRef.current = nodes
  /** D200：显示层动画不写 detail / IPC；布局 key 相同的状态刷新不重启 tween。 */
  const positionAnimation = useRef<InterruptibleAnimation | null>(null)
  positionAnimation.current ??= createInterruptibleAnimation()
  const draggingNodeIds = useRef<Set<string>>(new Set())
  const enteringNodeIds = useRef<Set<string>>(new Set())
  const enterTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const exitTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const motionLayoutKey = useRef<string | null>(null)
  const motionTargets = useRef<Map<string, { x: number; y: number }>>(new Map())
  const motionTargetIds = useRef<string[]>([])
  const fitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fitFrame = useRef<number | null>(null)
  const [edges, setEdges] = useState<Edge[]>([])
  /** D176：选择唯一事实源；xyflow 的 select 变化（含框选）同步到这里 */
  const [selectedPaperIds, setSelectedPaperIds] = useState<Set<number>>(new Set())
  // 节点组装 effect 不能依赖这个 state：依赖它就会整批换节点，双击两击之间 DOM 被换掉。
  const selectedPaperIdsRef = useRef(selectedPaperIds)
  selectedPaperIdsRef.current = selectedPaperIds
  /** D176：子图冻结集合；null = 普通画布。纯视图状态，不写库、不进撤销栈 */
  const [subgraphIds, setSubgraphIds] = useState<Set<number> | null>(null)
  /** D212：普通画布 hover 优先于选择；聚焦与旧所选子图互斥。 */
  const [hoveredPaperId, setHoveredPaperId] = useState<number | null>(null)
  const [focusMode, setFocusMode] = useState<{ root: number; depth: 1 | 2 } | null>(null)
  const focusModeRef = useRef(focusMode)
  focusModeRef.current = focusMode
  const focusOriginViewport = useRef<Viewport | null>(null)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const dragOrigin = useRef<Map<string, { x: number; y: number }>>(new Map())
  const dragSelection = useRef<ReadonlySet<number>>(new Set())
  const dragNodeWasSelected = useRef(false)
  const chatDropCandidate = useRef(false)
  /** 松手在抽屉上时要加的 chip：已选节点拖动 = 整组选择；未选节点 = 只这一篇。 */
  const chatDropIds = useRef<number[]>([])
  const chatDropHover = useRef(false)
  /** 建议修10：冷启动边渲染兜底重算次数（至多 1 次，见下方 watchdog effect） */
  const [edgesRetry, setEdgesRetry] = useState(0)
  const didFit = useRef(false)
  /** 按关系类型筛选（D84）：被隐藏的类型集合 */
  const [hiddenTypes, setHiddenTypes] = useState<Set<RelationType>>(() => readSessionTypeFilter(graphId))
  const [showFilter, setShowFilter] = useState(false)
  /** 工具栏「更多」菜单（D151：重新生成关系的确认内聚在 RegenRelationsItem） */
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null)
  /** M6 lane/ui 批 2：导出 Markdown 弹窗（原型 08，D31/D60/D132） */
  const [showExport, setShowExport] = useState(false)
  /** 关系生成进度（首建/补齐/重新生成，订阅 event:rel:generateProgress + 轮询 rel:status）
   *  uat13（D207-⑤）：status = 活动任务状态（waiting_key 时显示等待态，不算「正在运行」样式） */
  const [gen, setGen] = useState<{ running: boolean; phase: string; processed: number; total: number; error: string | null; status: string | null } | null>(null)
  /** uat13（D207-⑤）：当前 LLM 提供方显示名（等待 API Key 文案用；只读设置） */
  const [llmLabel, setLlmLabel] = useState('DeepSeek')
  /** ⌘Z 撤销栈（D77/D88：只记手动增删改，历史仅本次运行期间保留） */
  const undoStack = useRef(new UndoStack())
  /** uat8b B5：撤销「从图谱移除」跳过软删论文时，用这条替换默认「已撤销：…」 */
  const undoNote = useRef<string | null>(null)

  const nodeTypes = useMemo(() => ({ paper: PaperNode, candidate: CandidateNode }), [])

  const animatePositionMoves = useCallback((moves: NodePositionMove[]): void => {
    const animator = positionAnimation.current!
    // uat12（review_uat11 建议修 1）：动效关闭时只取消不启动 tween，瞬时路径已直接落位。
    if (!shouldRunPositionTween(moves.length, currentMotionDisabled())) {
      animator.cancel()
      return
    }
    animator.run(MOTION_BASE_MS, (t) => {
      const positions = new Map(moves.map((m) => [m.id, interpolatePosition(m.from, m.to, t)]))
      // 只改当前帧的 position；选择、data、measured 与新到的候选进度不被旧闭包覆盖。
      setNodes((current) => {
        const updated = current.map((n) => {
          const p = positions.get(n.id)
          return p ? { ...n, position: p } : n
        })
        nodesRef.current = updated
        return updated
      })
    })
  }, [])

  const resetNodeMotion = useCallback((): void => {
    positionAnimation.current?.cancel()
    for (const t of enterTimers.current.values()) clearTimeout(t)
    for (const t of exitTimers.current.values()) clearTimeout(t)
    enterTimers.current.clear()
    exitTimers.current.clear()
    enteringNodeIds.current.clear()
    draggingNodeIds.current.clear()
    motionLayoutKey.current = null
    motionTargets.current = new Map()
    motionTargetIds.current = []
    if (fitTimer.current != null) clearTimeout(fitTimer.current)
    if (fitFrame.current != null) cancelAnimationFrame(fitFrame.current)
    fitTimer.current = null
    fitFrame.current = null
  }, [])

  const fitGraphView = useCallback(
    (nodeIds?: string[], padding = 0.15): void => {
      if (nodeIds && nodeIds.length === 0) return
      if (fitTimer.current != null) clearTimeout(fitTimer.current)
      if (fitFrame.current != null) cancelAnimationFrame(fitFrame.current)
      fitTimer.current = null
      fitFrame.current = null
      const run = (): void => {
        fitTimer.current = null
        fitFrame.current = requestAnimationFrame(() => {
          fitFrame.current = null
          const ids = nodeIds ?? motionTargetIds.current
          void rf?.fitView({
            ...(ids.length > 0 ? { nodes: ids.map((id) => ({ id })) } : {}),
            padding,
            duration: viewportMotionMs(),
            maxZoom: 1
          })
        })
      }
      // 整理 / 新增时按最终落位取景，而不是 tween 的中间 bounds；新 fit 会替换旧调度。
      if (positionAnimation.current?.isActive() && !currentMotionDisabled()) {
        fitTimer.current = setTimeout(run, MOTION_BASE_MS)
      } else {
        run()
      }
    },
    [rf]
  )

  /** D200：GraphDetail 目标节点 → enter/exit + 可打断的受控位置 tween。 */
  const commitNodes = useCallback(
    (next: Node[]): void => {
      const previous = nodesRef.current
      const targets = new Map(next.map((n) => [n.id, { ...n.position }]))
      motionTargets.current = targets
      motionTargetIds.current = next.map((n) => n.id)
      const layoutKey = JSON.stringify([...targets].sort(([a], [b]) => a.localeCompare(b)))
      const sameLayout = motionLayoutKey.current === layoutKey
      motionLayoutKey.current = layoutKey

      if (currentMotionDisabled()) {
        positionAnimation.current?.cancel()
        for (const t of enterTimers.current.values()) clearTimeout(t)
        for (const t of exitTimers.current.values()) clearTimeout(t)
        enterTimers.current.clear()
        exitTimers.current.clear()
        enteringNodeIds.current.clear()
        // off / reduced 也遵守拖拽真源：后台状态刷新不能把正在拖的坐标打回旧 detail。
        const before = new Map(previous.map((n) => [n.id, n]))
        const settled = next.map((n) => {
          const old = before.get(n.id)
          return old && draggingNodeIds.current.has(n.id) ? { ...n, position: { ...old.position } } : n
        })
        nodesRef.current = settled
        setNodes(settled)
        return
      }

      for (const id of targets.keys()) {
        const timer = exitTimers.current.get(id)
        if (timer != null) clearTimeout(timer)
        exitTimers.current.delete(id)
      }
      // 新增后的 placeNew 二次定位仍属 enter，不在两个目标间额外飞一次。
      const skipMoves = new Set([...draggingNodeIds.current, ...enteringNodeIds.current])
      const plan = planNodeTransitions(previous, next, skipMoves)
      for (const id of plan.entering) {
        enteringNodeIds.current.add(id)
        const oldTimer = enterTimers.current.get(id)
        if (oldTimer != null) clearTimeout(oldTimer)
        enterTimers.current.set(
          id,
          setTimeout(() => {
            enteringNodeIds.current.delete(id)
            enterTimers.current.delete(id)
          }, MOTION_BASE_MS)
        )
      }

      const positionMoves = !sameLayout && shouldAnimateNodePositions(next.length, currentMotionDisabled()) ? plan.moves : []
      const moveIds = new Set(positionMoves.map((m) => m.id))
      const before = new Map(previous.map((n) => [n.id, n]))
      const displayed = next.map((node) => {
        const old = before.get(node.id)
        const keepCurrent =
          old != null &&
          (draggingNodeIds.current.has(node.id) || moveIds.has(node.id) || (sameLayout && positionAnimation.current?.isActive() === true))
        const entering = enteringNodeIds.current.has(node.id)
        if (!keepCurrent && !entering) return node
        return {
          ...node,
          position: keepCurrent ? { ...old.position } : node.position,
          className: flowClass(node.className, entering && 'gt-node-enter')
        }
      })

      const ghosts = plan.exiting.map((node) => {
        if (!exitTimers.current.has(node.id)) {
          exitTimers.current.set(
            node.id,
            setTimeout(() => {
              exitTimers.current.delete(node.id)
              if (motionTargetIds.current.includes(node.id)) return // 撤销 / 重建已让它复活
              setNodes((current) => {
                const updated = current.filter((n) => n.id !== node.id)
                nodesRef.current = updated
                return updated
              })
            }, MOTION_FAST_MS)
          )
        }
        return {
          ...node,
          selected: false,
          selectable: false,
          draggable: false,
          connectable: false,
          focusable: false,
          className: flowClass(node.className?.replace(/\bgt-node-(?:enter|exit)\b/g, ''), 'gt-node-exit')
        }
      })
      const output = [...displayed, ...ghosts]
      nodesRef.current = output
      setNodes(output)

      if (!sameLayout) {
        // 新布局请求打断旧 fit；调用方在新目标提交后重新调度。
        if (fitTimer.current != null) clearTimeout(fitTimer.current)
        if (fitFrame.current != null) cancelAnimationFrame(fitFrame.current)
        fitTimer.current = null
        fitFrame.current = null
        animatePositionMoves(positionMoves)
      }
    },
    [animatePositionMoves]
  )

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      focusArmed.current = true
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  const paperById = useMemo(() => {
    const m = new Map<number, PaperSummary>()
    for (const mem of detail?.members ?? []) m.set(mem.paper.id, mem.paper)
    return m
  }, [detail])

  /** D212：类型过滤后的关系是强调与聚焦的共同数据源；邻接表只在关系/过滤变化时重算。 */
  const visibleRelations = useMemo(
    () => visibleRelationsByType(detail?.relations ?? [], hiddenTypes),
    [detail?.relations, hiddenTypes]
  )
  const relationCounts = useMemo(() => relationTypeCounts(detail?.relations ?? []), [detail?.relations])
  const relationAdjacency = useMemo(() => buildRelationAdjacency(visibleRelations), [visibleRelations])
  const focusIds = useMemo(
    () => (focusMode ? focusNeighborhood(visibleRelations, focusMode.root, focusMode.depth, relationAdjacency) : null),
    [focusMode, visibleRelations, relationAdjacency]
  )
  const emphasis = useMemo(
    () => neighborhoodEmphasis(visibleRelations, hoveredPaperId, selectedPaperIds),
    [visibleRelations, hoveredPaperId, selectedPaperIds]
  )

  const exitFocus = useCallback(
    (restoreViewport = true): void => {
      const origin = focusOriginViewport.current
      focusModeRef.current = null
      focusOriginViewport.current = null
      setFocusMode(null)
      if (!restoreViewport || !origin || !rf) return
      // 取消进入/切跳数时未执行的 fit，保证原视口是最后一个视口写入。
      if (fitTimer.current != null) clearTimeout(fitTimer.current)
      if (fitFrame.current != null) cancelAnimationFrame(fitFrame.current)
      fitTimer.current = null
      fitFrame.current = requestAnimationFrame(() => {
        fitFrame.current = null
        void rf.setViewport(origin, { duration: viewportMotionMs() })
      })
    },
    [rf]
  )

  const activateFocus = useCallback(
    (root: number, depth: 1 | 2 = 1): void => {
      if (!paperById.has(root)) return
      if (focusModeRef.current == null && rf) focusOriginViewport.current = rf.getViewport()
      const next = { root, depth }
      focusModeRef.current = next
      setFocusMode(next)
      setSubgraphIds(null)
      setHoveredPaperId(null)
      setMenu(null)
      setMoreMenu(null)
      setShowFilter(false)
      setSelectedRelId(null)
      setProcPaper(null)
      const ids = focusNeighborhood(visibleRelations, root, depth, relationAdjacency).paperIds
      fitGraphView([...ids].map(String), 0.2)
    },
    [paperById, rf, visibleRelations, relationAdjacency, fitGraphView]
  )

  // 失败标记数据通路（D48 最小接线）：本图谱成员 + 侧栏论文库的处理状态
  const papersStatus = usePapersStatus(library.map((p) => p.id))
  // 03d 失败原因区需要 sidecar 状态（未处理时提示是否等自动开始，D95）
  const sidecar = useMineruStatus()
  // uat1b D144：MinerU 不可用原因（节点/侧栏「等待解析组件」标签）
  const mineruReason = mineruUnavailableReason(sidecar?.state)
  const waitParseOf = (paperId: number, hasPdf: boolean): string | null =>
    hasPdf && mineruReason && papersStatus.get(paperId)?.state === 'unprocessed' ? mineruReason : null
  /** uat2：处理中口径（queued/running/waiting → 节点/库行「处理中」蓝点；queued 显示「排队中」） */
  const procOf = (paperId: number): 'queued' | 'running' | 'waiting' | null => {
    const s = papersStatus.get(paperId)?.state
    return s === 'queued' || s === 'running' || s === 'waiting' ? s : null
  }
  const [procPaper, setProcPaper] = useState<PaperSummary | null>(null)
  /** M5 lane/chat 批 3：候选（虚线节点，D117；状态经 event:agent:candidates 与卡片同步） */
  const [candidates, setCandidates] = useState<CandidateView[]>([])
  /** M6 lane/ui 批 1：候选入库/查 PDF 进度（event:cand:progress，卡片与画布共用通道） */
  const [candProg, setCandProg] = useState<Map<number, CandProgressEvent>>(new Map())
  /** uat5 必须修 4：候选确认乐观更新（同一 tick 转正式节点、计数 +1，失败回滚） */
  const [optimistic, setOptimistic] = useState<Map<number, CandOptimisticEntry>>(new Map())
  useEffect(() => {
    const onStart = (e: Event): void => {
      const entry = (e as CustomEvent<CandOptimisticEntry>).detail
      setOptimistic((m) => withCandConfirmStart(m, entry))
    }
    const onRollback = (e: Event): void => {
      setOptimistic((m) => withCandConfirmRollback(m, (e as CustomEvent<number>).detail))
    }
    window.addEventListener(CAND_CONFIRM_START, onStart)
    window.addEventListener(CAND_CONFIRM_ROLLBACK, onRollback)
    return () => {
      window.removeEventListener(CAND_CONFIRM_START, onStart)
      window.removeEventListener(CAND_CONFIRM_ROLLBACK, onRollback)
    }
  }, [])
  /** 「定位」flash：高亮涉及的论文节点/关系边/候选节点（约 1.8s 自动消失） */
  const [flash, setFlash] = useState<{ papers: Set<number>; relations: Set<number>; candidates: Set<number>; key: number } | null>(null)
  // D200：App 保留最近定位请求；画布首帧只恢复旧 flash，不用旧请求再次移动视口。
  const focusArmed = useRef(false)

  // 后发起的 reload 才写 state。撤销与改图回合的 getGraph 会交错：
  // 先发出的请求可能后返回，把画布盖回改图前的详情。
  const reloadSeq = useRef(0)
  const reload = useCallback(async (): Promise<GraphDetail | null> => {
    const seq = ++reloadSeq.current
    try {
      const [d, lib] = await Promise.all([api.getGraph(graphId), api.listLibrary(graphId)])
      const current = currentReloadResult(seq, reloadSeq.current, d)
      if (!current) return null
      // uat4-fix1 M1/D173：库内原文（RelationView.statement）一律不在这里改写——
      // P0x→简称只是显示层替换（面板经 displayStatement 展示），快照 / 保存 / 调换方向 /
      // ⌘Z 恢复全部用原文，保证绝不把《短标题》写回 statement_text。
      setDetail(current)
      setLibrary(lib)
      return current
    } catch {
      if (seq !== reloadSeq.current) return null
      notify('加载图谱失败')
      return null
    }
  }, [graphId, notify])

  useEffect(() => {
    didFit.current = false
    resetNodeMotion()
    nodesRef.current = []
    setNodes([])
    setEdges([])
    setSelectedRelId(null)
    setProcPaper(null)
    setMenu(null)
    setDeleteTarget(null)
    setSelectedPaperIds(new Set())
    setSubgraphIds(null)
    focusModeRef.current = null
    focusOriginViewport.current = null
    setFocusMode(null)
    setHoveredPaperId(null)
    setHiddenTypes(readSessionTypeFilter(graphId))
    onChatDragHover?.(false)
    chatDropHover.current = false
    setShowAdd(!!openAdd)
    setShowFilter(false)
    setMoreMenu(null)
    undoStack.current.clear()
    // uat5-fix1 M2：切图谱（graphId 变化，组件不卸载）清空乐观确认占位
    setOptimistic(new Map())
    // uat7b M1：从子图进详情再返回同图谱 → 恢复子图与选择（消费一次；
    // 已由 saveCanvasView 保证只在开过子图时暂存；成员剔除交给 detail effect）
    const restored = takeCanvasView(graphId)
    if (restored) {
      if (restored.selected.length > 0) setSelectedPaperIds(new Set(restored.selected))
      const sub = restored.subgraph != null ? new Set(restored.subgraph) : null
      setSubgraphIds(sub != null && sub.size >= 2 ? sub : null)
    }
    // uat17b 建议修 5：聚焦中进详情再返回 → 恢复聚焦（消费一次；根被删由
    // 下面 detail effect 退出聚焦，与切图谱 / 进子图口径一致）；已 Esc 退出的不暂存
    const restoredFocus = takeCanvasFocus(graphId)
    if (restoredFocus) {
      const focus = { root: restoredFocus.root, depth: restoredFocus.depth }
      focusModeRef.current = focus
      focusOriginViewport.current = restoredFocus.originViewport
      setFocusMode(focus)
    }
    void reload()
  }, [graphId, openAdd, reload, onChatDragHover, resetNodeMotion])

  useEffect(() => () => resetNodeMotion(), [resetNodeMotion])

  // uat7b M1：卸载时（路由离开画布，如进详情页）若子图开着，暂存子图与选择，
  // 返回同图谱时由上面的挂载 effect 消费恢复。读 ref 拿最新值。
  // uat17b 建议修 5：聚焦开着也同样暂存（根 / 跳数 / 进入聚焦前视口），
  // 已 Esc 退出的不暂存，返回后仍是全图。
  useEffect(() => {
    return () => {
      saveCanvasView(graphId, { subgraph: subgraphIdsRef.current, selected: selectedPaperIdsRef.current })
      const focus = focusModeRef.current
      saveCanvasFocus(graphId, focus ? { ...focus, originViewport: focusOriginViewport.current } : null)
    }
  }, [graphId])

  // uat2：重新导入（D75）补齐 PDF → 即时刷新侧栏与节点，「无 PDF」标记立即消失
  useEffect(() => {
    const off = api.onLibraryChanged?.(() => void reload())
    return () => off?.()
  }, [reload])

  // 候选虚线节点：已在本图谱 / 已乐观确认的不出节点；缺坐标的堆在左下方
  const positionedCandidates = useMemo(() => {
    const pend = canvasCandidates(candidates).filter((c) => !optimistic.has(c.id))
    const pos = candidatePositions(
      (detail?.members ?? []).map((m) => ({ x: m.x, y: m.y })),
      pend
    )
    return pend.map((c) => ({ c, pos: pos.get(c.id) ?? { x: c.x, y: c.y } }))
  }, [candidates, detail, optimistic])

  // reload / gt:graph-changed 后选择保留；已移除成员自动出选择。子图冻结集合同步收缩，
  // 不足两篇即退出子图（选择本身仍保留剩余成员）。
  useEffect(() => {
    if (!detail) return
    const memberIds = new Set(detail.members.map((m) => m.paper.id))
    setSelectedPaperIds((prev) => prunePaperSelection(prev, memberIds))
    setSubgraphIds((prev) => pruneSubgraphSelection(prev, memberIds))
    if (focusModeRef.current && !memberIds.has(focusModeRef.current.root)) exitFocus(false)
  }, [detail, exitFocus])

  // GraphDetail → React Flow 节点/边
  useEffect(() => {
    if (!detail) return
    // 选择不进依赖：只读 ref。整批重建留给成员/状态/子图开关；选中描边由下面的小 effect 翻。
    const selectedIds = selectedPaperIdsRef.current
    // uat3b 4.1：candProg / papersStatus 每次变化都整批重建节点会丢 xyflow measured
    // （节点 visibility:hidden、确认入库后画布全空的根因）——按 id 保留旧节点测量运行态
    const next = preserveMeasured(
      nodesRef.current,
      [
      ...detail.members.map((m) => {
        // uat7b M1：子图里暗化节点在数据层就不可交互（xyflow 内联 pointer-events 会
        // 盖掉 CSS），单击/双击/右键/拖动 handler 另有守卫；高亮节点保持可拖。
        const dim = subgraphIds != null && !selectedIds.has(m.paper.id)
        const focusHidden = focusIds != null && !focusIds.paperIds.has(m.paper.id)
        return {
        id: String(m.paper.id),
        type: 'paper' as const,
        position: { x: m.x, y: m.y },
        hidden: focusHidden,
        // uat6 M1 根因修复：声明式尺寸 + 连接点——边锚点由数据决定，不依赖 xyflow
        // 异步 DOM 测量（测量静默丢失时画布 0 边且无法自愈，见 lib/flowNodes.ts）
        ...paperNodeDeclarative(String(m.paper.id)),
        // uat1b D144：MinerU 不可用时把原因挂进节点数据，PaperNode 显示「等待解析组件」
        data: {
          paper: m.paper,
          waitParse: waitParseOf(m.paper.id, m.paper.hasPdf),
          // uat2：处理中蓝点/失败红点（数据通路同侧栏 papersStatus）
          proc: procOf(m.paper.id),
          failTitle: papersStatus.get(m.paper.id)?.state === 'failed' ? failTitle(papersStatus.get(m.paper.id)!) : null,
          // uat7b D184-②：子图选中描边的数据层真源（xyflow 点空白清内部 selected 时圈仍在）
          subSelected: subgraphIds != null && selectedIds.has(m.paper.id)
        },
        selected: selectedIds.has(m.paper.id),
        selectable: !dim,
        draggable: !dim,
        connectable: !dim,
        focusable: !dim,
        className: flowClass(
          flash?.papers.has(m.paper.id) && 'gt-flash',
          subgraphIds && (selectedIds.has(m.paper.id) ? 'gt-sub-hi' : 'gt-sub-dim'),
          focusHidden && 'gt-focus-hidden'
        )
        }
      }),
      ...positionedCandidates.map(({ c, pos }) => ({
        id: `cand-${c.id}`,
        type: 'candidate' as const,
        position: { x: Math.round(pos.x), y: Math.round(pos.y) },
        data: { candidate: c, progress: candProg.get(c.id) ?? null },
        selected: false,
        selectable: false,
        draggable: subgraphIds == null,
        connectable: false,
        focusable: false,
        hidden: focusMode != null,
        className: flowClass('gt-cand-node', flash?.candidates.has(c.id) && 'gt-flash', subgraphIds && 'gt-sub-dim', focusMode && 'gt-focus-hidden')
      })),
      // uat5 必须修 4：乐观确认的候选立即以正式论文节点样式出现（计数同步 +1）
      ...Array.from(optimistic.values()).map((o) => {
        const paper = optimisticPaperOf(o)
        const id = o.paperId != null && o.paperId > 0 ? String(o.paperId) : `tmp-cand-${o.candidateId}`
        return {
          id,
          type: 'paper' as const,
          position: { x: Math.round(o.x), y: Math.round(o.y) },
          ...paperNodeDeclarative(id),
          data: { paper, waitParse: null, proc: null, failTitle: null },
          selected: false,
          selectable: false,
          draggable: subgraphIds == null,
          connectable: false,
          focusable: false,
          hidden: focusMode != null,
          className: flowClass('gt-cand-optimistic', subgraphIds && 'gt-sub-dim', focusMode && 'gt-focus-hidden')
        }
      })
      ] as Node[]
    )
    commitNodes(next)
    setEdges(
      visibleRelations.map((r) => {
          const dst = dstOf(r)
          const types = [...r.llmTypes, ...r.autoTypes]
          const sel = r.id === selectedRelId
          const subHi = subgraphIds != null && selectedIds.has(r.paperLow) && selectedIds.has(r.paperHigh)
          const color = sel ? 'var(--accent)' : subHi ? 'var(--edgeHi)' : 'var(--edge)'
          // 建议修 3：对称关系（对比/同一作者）方向无意义，不画箭头
          const symmetricOnly = types.length > 0 && types.every((t) => t === 'compares' || t === 'same_author')
          return {
            id: String(r.id),
            source: String(r.srcPaper),
            target: String(dst),
            selected: sel,
            selectable: subgraphIds == null || subHi,
            hidden: focusIds != null && !focusIds.relationIds.has(r.id),
            className: flowClass(
              flash?.relations.has(r.id) && 'gt-flash',
              subgraphIds && (subHi ? 'gt-sub-hi' : 'gt-sub-dim'),
              focusIds != null && !focusIds.relationIds.has(r.id) && 'gt-focus-hidden'
            ),
            label: edgeLabelOf(r),
            labelStyle: { fontSize: 11, fill: sel ? 'var(--accent)' : 'var(--text2)' },
            labelBgStyle: { fill: 'var(--canvas)' },
            labelBgPadding: [5, 3] as [number, number],
            labelBgBorderRadius: 4,
            style: { stroke: color, strokeWidth: sel ? 1.75 : subHi ? 2.25 : 1.25 },
            markerEnd: symmetricOnly ? undefined : { type: MarkerType.ArrowClosed, width: 12, height: 12, color }
          }
        })
    )
  }, [detail, selectedRelId, visibleRelations, focusIds, focusMode, positionedCandidates, flash, candProg, papersStatus, mineruReason, edgesRetry, optimistic, subgraphIds, commitNodes])

  // D176：选择变化只翻 selected。整批 setNodes 会换掉节点 DOM，双击的第二击落到别的论文上。
  useEffect(() => {
    setNodes((prev) => {
      const next = withPaperSelection(prev, selectedPaperIds) as Node[]
      nodesRef.current = next
      return next
    })
  }, [selectedPaperIds])

  // D212：rAF 合批 hover；只翻 DOM 类，不让位置 tween / 拖动帧触发全画布查询。
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      syncNeighborEmphasisClasses(canvasRef.current, focusMode || subgraphIds ? null : emphasis)
    })
    return () => cancelAnimationFrame(frame)
  }, [emphasis, focusMode, subgraphIds, detail, selectedRelId, flash, positionedCandidates, optimistic])

  // 建议修10：冷启动边渲染兜底（uat2 复测偶发一次「迁移后首启：顶栏 18 条关系、
  // 画布 0 条边」，之后 3 次未复现）。uat6 M1 已修真正根因：xyflow 只在两端节点
  // 「初始化」（handleBounds+尺寸，均来自异步 DOM 测量）后渲染边，测量静默丢失时
  // 边永久为 0 且 state 更新无法恢复（见 lib/flowNodes.ts paperNodeDeclarative 与
  // 开发记录证据链）——现已用声明式尺寸/连接点使边锚点不依赖
  // 测量。此 watchdog 仅保留为廉价保险：首挂载后若「关系非空 && 节点就绪 && edges
  // 为空」，下一帧重跑一次组装，仅一次；正常路径判定恒 false、零开销。
  useEffect(() => {
    if (!shouldRetryColdStartEdges(detail?.relations.length ?? 0, edges.length, nodes.length, edgesRetry > 0)) return
    const t = requestAnimationFrame(() => setEdgesRetry((n) => n + 1))
    return () => cancelAnimationFrame(t)
  }, [detail, edges, nodes, edgesRetry])

  // 首次加载 fitView（D200 同样走 reduced/off 与 tween 完成后的统一调度）。
  // uat17b 建议修 5：从详情返回恢复的聚焦取景邻域（与 activateFocus 同口径），
  // 不退回全图。
  useEffect(() => {
    if (detail && rf && !didFit.current) {
      didFit.current = true
      const focus = focusModeRef.current
      if (focus) {
        const ids = focusNeighborhood(visibleRelations, focus.root, focus.depth, relationAdjacency).paperIds
        fitGraphView([...ids].map(String), 0.2)
      } else {
        fitGraphView()
      }
    }
  }, [detail, rf, fitGraphView, visibleRelations, relationAdjacency])

  // 候选：列表 + 事件同步（卡片与画布两处一致，D117）
  useEffect(() => {
    let disposed = false
    agentApi()
      .listCandidates(graphId)
      .then((cs) => !disposed && setCandidates(cs))
      .catch(() => {})
    const unsub = agentApi().onAgentCandidates((e) => {
      if (e.graphId !== graphId) return
      setCandidates(e.candidates)
    })
    return () => {
      disposed = true
      unsub()
    }
  }, [graphId])

  // 候选入库/查 PDF 进度 → 画布虚线节点徽标（卡片与画布共用通道）；done / no_pdf 派发
  // gt:graph-changed 让 reload 拉最新成员——入库完成的候选换成实线论文节点（评审必须修 1）
  useEffect(
    () =>
      candApi().onCandProgress((e) => {
        const id = e.candidateId
        if (id == null) return
        setCandProg((m) => new Map(m).set(id, e))
        if (e.phase === 'done' || e.phase === 'no_pdf') {
          window.dispatchEvent(new CustomEvent('gt:graph-changed'))
        }
      }),
    []
  )

  // 外部图变化（候选「加入图谱」/ 撤销组执行）→ 重载画布与候选
  useEffect(() => {
    const onChanged = (): void => {
      void agentApi()
        .listCandidates(graphId)
        .then((cs) => {
          setCandidates(cs)
          // uat5-fix1 M2：重载完成后撤掉已不再是 pending 的乐观占位（确认成功）——
          // 否则真实成员节点与乐观节点同 id 两套、顶栏/侧栏计数一直多 1
          setOptimistic((m) => pruneCandOptimistic(m, new Set(canvasCandidates(cs).map((c) => c.id))))
        })
        .catch(() => {})
      void reload()
    }
    window.addEventListener('gt:graph-changed', onChanged)
    return () => window.removeEventListener('gt:graph-changed', onChanged)
  }, [graphId, reload])

  // 改图小结「定位」→ flash 高亮（nonce 区分连续点击）
  useEffect(() => {
    if (!locateRequest) return
    setFlash({
      papers: new Set(locateRequest.part.paperIds),
      relations: new Set(locateRequest.part.relationIds),
      candidates: new Set(),
      key: locateRequest.nonce
    })
    if (focusArmed.current) fitGraphView(locateRequest.part.paperIds.map(String), 0.25)
    const t = setTimeout(() => setFlash(null), 1800)
    return () => clearTimeout(t)
  }, [locateRequest, fitGraphView])

  // D182（uat6b）：「已在待确认候选中」卡片「定位」→ 候选在画布（pending 且未在本图谱）
  // 高亮其虚线节点；in_graph 的候选画布无节点 → 高亮其在图谱中的论文节点
  useEffect(() => {
    if (!locateCandidateRequest) return
    const cid = locateCandidateRequest.candidateId
    const cand = candidates.find((c) => c.id === cid)
    const papers = new Set<number>()
    const cands = new Set<number>()
    if (locateCandidateRequest.paperId != null && locateCandidateRequest.paperId > 0) {
      papers.add(locateCandidateRequest.paperId)
    } else if (cand && !cand.inGraph) cands.add(cid)
    else if (cand?.existingPaperId) papers.add(cand.existingPaperId)
    setFlash({ papers, relations: new Set(), candidates: cands, key: locateCandidateRequest.nonce })
    if (focusArmed.current) fitGraphView(papers.size > 0 ? [...papers].map(String) : [...cands].map((id) => `cand-${id}`), 0.25)
    const t = setTimeout(() => setFlash(null), 1800)
    return () => clearTimeout(t)
  }, [locateCandidateRequest, candidates, fitGraphView])

  // D201（uat12）：详情页「定位」→ 等画布 / 节点挂载且测量完成（rf 就绪 + measured 尺寸）
  // 后，用 D200 平滑视口过渡居中该节点并照现有方式 flash。nonce 在挂载生命周期之外
  // 消费：同一请求只移动一次，已消费的请求之后回到画布不再拽视口；不在当前图谱 →
  // 不移动、不报错（保持现有行为）。动效关闭 / reduce 时 fitGraphView duration = 0（瞬时）。
  useEffect(() => {
    const req = paperLocateRequest
    if (!req) return
    const decision = decidePaperLocate({
      graphLoaded: detail != null,
      rfReady: rf != null,
      isMember: (detail?.members ?? []).some((m) => m.paper.id === req.paperId),
      nodeMeasured: nodes.some((n) => n.id === String(req.paperId) && n.measured?.width != null)
    })
    if (decision === 'wait') return
    if (!consumePaperLocateNonce(req.nonce)) return
    if (decision === 'move') {
      setFlash({ papers: new Set([req.paperId]), relations: new Set(), candidates: new Set(), key: req.nonce })
      fitGraphView([String(req.paperId)], 0.25)
      const t = setTimeout(() => setFlash(null), 1800)
      return () => clearTimeout(t)
    }
  }, [paperLocateRequest, rf, detail, nodes, fitGraphView])

  // 节点 / 侧栏右键菜单、「更多」、筛选弹层：点别处关闭。Escape 统一走下方 D176
  // 层级处理器，避免这个旧监听器越级把同一次 Esc 继续传到选择 / 子图。
  useEffect(() => {
    if (!menu && !moreMenu && !showFilter) return
    const close = (e: Event): void => {
      if (!shouldCloseLayerOn(e) || e.type === 'keydown') return
      setMenu(null)
      setMoreMenu(null)
      setShowFilter(false)
    }
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
    }
  }, [menu, moreMenu, showFilter])

  // D176 Esc 层级（capture 集中判定，一次只处理一层）：输入控件 → 模态 →
  // 画布弹层 → 外部弹层（状态点 / 对话菜单自己关）→ 聚焦 → 子图 → 选择。uat5 笔记
  // 与 uat6 状态弹层的语义不由本监听器改写。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const eventTarget = e.target instanceof HTMLElement ? e.target : null
      const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const isInput = (el: HTMLElement | null): boolean =>
        !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
      // Electron 可信 Esc 的 target 偶发是 body/window；activeElement 仍是对话输入框。
      // 目标解析与 blur 共用同一元素，避免第一下 Esc 越级退子图。
      const inputTarget = isInput(eventTarget) ? eventTarget : isInput(activeElement) ? activeElement : null
      const inputFocused = inputTarget != null
      // AddPapersModal 自己处理 Esc（导入中忽略）；其余自有模态在这里统一关闭。
      const ownModal = showExport || deleteTarget != null || connect != null
      const activeLayer = (selector: string): boolean =>
        [...document.querySelectorAll(selector)].some((el) => el.closest('.gt-motion')?.getAttribute('data-motion-state') !== 'exiting')
      // D200：退出中的旧层不再参与 Esc 分层，也不会挡住下一次按键。
      const externalModal = activeLayer('.ov, .gt-exp-ov, .gt-reader-mask')
      const ownMenu = menu != null || moreMenu != null || showFilter
      const externalLayer = activeLayer('[data-esc-popover]')
      const action = canvasEscAction({
        inputFocused,
        modalOpen: ownModal || externalModal,
        menuOpen: ownMenu,
        externalLayerOpen: externalLayer,
        focusOpen: focusMode != null,
        subgraphOpen: subgraphIds != null,
        hasSelection: selectedPaperIds.size > 0
      })
      if (action === 'input') {
        // D184：输入框 Esc 先 blur 保留草稿（不清空、不发送），子图 / 选择不动；
        // 下一次 Esc 才按层级继续（子图 → 清空选择）。阅读器笔记 / 自带 Esc 的
        // 弹层（data-esc-popover）等控件维持原有自行处理口径，不在此抢。
        const ownEsc = inputTarget?.closest?.('.gt-reader-mask, [data-esc-popover], .ov, .modal')
        if (!ownEsc && inputTarget) {
          inputTarget.blur()
          e.preventDefault()
          e.stopImmediatePropagation()
        }
        return
      }
      if (action === 'external-layer' || action === 'none') return
      if (action === 'modal') {
        if (!ownModal) return // ConfirmDialog / 阅读器自己处理；不继续碰画布选择
        setShowAdd(false)
        setShowExport(false)
        setDeleteTarget(null)
        setConnect(null)
      } else if (action === 'menu') {
        setMenu(null)
        setMoreMenu(null)
        setShowFilter(false)
      } else if (action === 'focus') {
        exitFocus() // D212：恢复原视口，保留选择；上层弹层已由前面分支先处理
      } else if (action === 'subgraph') {
        setSubgraphIds(null) // 保留选择
      } else if (action === 'clear-selection') {
        setSelectedPaperIds(new Set())
      }
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [showAdd, showExport, deleteTarget, connect, menu, moreMenu, showFilter, focusMode, subgraphIds, selectedPaperIds, exitFocus])

  // D212：仅单选时的裸 F 进入 1 跳聚焦；输入、IME、修饰键和已打开的层均不触发。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target instanceof HTMLElement ? e.target : null
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const isInput = (el: HTMLElement | null): boolean =>
        !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
      const inputFocused = isInput(target) || isInput(active)
      if (
        !shouldRunFocusShortcut({
          key: e.key,
          inputFocused,
          selectedCount: selectedPaperIds.size,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          altKey: e.altKey,
          shiftKey: e.shiftKey,
          isComposing: e.isComposing
        })
      ) {
        return
      }
      if (showAdd || showExport || deleteTarget || connect || menu || moreMenu || showFilter) return
      const root = [...selectedPaperIds][0]
      e.preventDefault()
      activateFocus(root, 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedPaperIds, showAdd, showExport, deleteTarget, connect, menu, moreMenu, showFilter, activateFocus])

  /** ⌘Z 撤销 / ⌘⇧Z 重做（D77/D88）：只作用于手动增删改；输入框里不抢系统撤销 */
  const runUndo = useCallback(
    async (redo: boolean): Promise<void> => {
      undoNote.current = null
      try {
        const label = redo ? await undoStack.current.redo() : await undoStack.current.undo()
        if (label == null) {
          notify(redo ? '没有可重做的操作' : '没有可撤销的操作')
          return
        }
        await reload()
        window.dispatchEvent(new CustomEvent('gt:graph-changed'))
        const note = redo ? null : undoNote.current
        undoNote.current = null
        notify(note ?? `${redo ? '已重做' : '已撤销'}：${label}`)
      } catch {
        notify(redo ? '重做失败，请重试' : '撤销失败，请重试')
      }
    },
    [reload, notify]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      e.preventDefault()
      // D77/D88：Agent 运行中禁用撤销/重做（运行态来自 App 级会话 hook）
      if (agentRunning) {
        notify('Agent 运行中，暂不能撤销')
        return
      }
      void runUndo(e.shiftKey)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [runUndo, agentRunning, notify])

  // 关系生成进度：订阅推送 + 轮询兜底（首建 / 补齐 / 重新生成共用一个横幅）
  const lastDoneNotify = useRef<{ graphId: number; at: number } | null>(null)
  useEffect(() => {
    let disposed = false
    const unsub = api.onGenerateProgress((p) => {
      if (p.graphId !== graphId) return
      if (p.phase === 'done') {
        setGen(null)
        void reload()
        // uat1b：一次生成最多一条提示；空跑（addedCount=0，如论文都还没解析）不弹
        // 「关系生成完成」；非空跑弹一条带条数。1 秒内的重复 done（重复推送）去重。
        const n = p.addedCount
        const now = Date.now()
        const dup = lastDoneNotify.current?.graphId === graphId && now - lastDoneNotify.current.at < 1000
        lastDoneNotify.current = { graphId, at: now }
        if (dup) return
        if (n == null) notify('关系生成完成')
        else if (n > 0) notify(`关系生成完成 · 新增 ${n} 条`)
      } else if (p.phase === 'error') {
        // 评审建议修 4：终态失败（重试耗尽 / failed_action）不静默消失
        setGen(null)
        notify(`关系生成失败：${p.error ?? '未知错误'}`)
      } else {
        setGen((g) => ({
          running: true,
          phase: p.phase,
          processed: g?.processed ?? 0,
          total: g?.total ?? 0,
          error: null,
          status: g?.status ?? null
        }))
      }
    })
    const poll = async (): Promise<void> => {
      try {
        const s = await api.relationsStatus(graphId)
        if (disposed) return
        setGen(
          s.running
            ? {
                running: true,
                phase: s.activeJob?.currentStep === 'references' ? 'references' : 'generate',
                processed: s.processedCount,
                total: s.totalCount,
                error: s.activeJob?.error ?? null,
                status: s.activeJob?.status ?? null
              }
            : null
        )
      } catch {
        // 轮询失败忽略，下一轮再试
      }
    }
    const timer = setInterval(() => void poll(), 2000)
    void poll()
    return () => {
      disposed = true
      clearInterval(timer)
      unsub()
    }
  }, [graphId, reload, notify])

  // uat13（D207-⑤）：读取当前 LLM 提供方显示名（等待 API Key 的胶囊文案）；测试 mock 可能缺该方法，兜底默认值
  useEffect(() => {
    const load = api.getLlmSettings?.bind(api)
    if (!load) return
    void load()
      .then((s) => setLlmLabel(s.provider === 'deepseek' ? 'DeepSeek' : s.provider))
      .catch(() => {
        // 读不到就用默认显示名
      })
  }, [])

  /** 整理：ELK layered → 更新全部节点位置并逐个落库 */
  const arrange = useCallback(
    async (gd: GraphDetail): Promise<void> => {
      try {
        const { positions } = await computeElkLayout(
          gd.members.map((m) => ({ id: String(m.paper.id), width: NW, height: NH })),
          gd.relations.map((r) => ({ id: String(r.id), source: String(r.srcPaper), target: String(dstOf(r)) }))
        )
        const members = gd.members.map((m) => ({
          ...m,
          x: Math.round(positions.get(String(m.paper.id))?.x ?? m.x),
          y: Math.round(positions.get(String(m.paper.id))?.y ?? m.y)
        }))
        setDetail({ ...gd, members })
        await Promise.all(members.map((m) => api.setNodePosition(graphId, m.paper.id, m.x, m.y)))
        // uat6 S5：整理前快照压入撤销栈（D119 撤销组，一组 N 条按逆序恢复）——⌘Z 一次
        // 把全部节点坐标写回库（runUndo 随后 reload，画布同步回整理前），⌘⇧Z 再应用整理后坐标。
        // 快照取写库前的 gd.members（旧坐标）与算好的 members（新坐标）。
        undoStack.current.pushGroup(
          '整理布局',
          layoutUndoEntries(
            graphId,
            gd.members.map((m) => ({ paperId: m.paper.id, x: m.x, y: m.y })),
            members.map((m) => ({ paperId: m.paper.id, x: m.x, y: m.y }))
          )
        )
        fitGraphView() // 建议修 9：适配缩放上限 1.0；D200 等位置 tween 完成后取景
        notify('已按关系重新整理')
      } catch {
        notify('整理失败，请重试')
      }
    },
    [graphId, rf, notify, fitGraphView]
  )

  /**
   * 加论文后只为新节点找位置（M1 终审建议修 1）：建议修12 改为围绕既有节点簇的
   * 黄金角螺旋找互不重叠的位置（placeNewNode），落在既有布局附近；已有节点坐标
   * 一律不动（不再全图 ELK 覆盖手工布局，也不再排到很远的右侧空白区）。
   * 全图重排仍是工具栏「整理」（arrange，D80 不变）。
   */
  const placeNew = useCallback(
    async (gd: GraphDetail, addedIds: number[]): Promise<void> => {
      const added = new Set(addedIds.map(String))
      const obstacles = gd.members.filter((m) => !added.has(String(m.paper.id))).map((m) => ({ x: m.x, y: m.y }))
      const positions = new Map<string, { x: number; y: number }>()
      for (const id of [...added]) {
        const p = placeNewNode(obstacles, NW, NH)
        positions.set(id, p)
        obstacles.push(p) // 连续多个新节点：后续节点避开已放置的
      }
      const members = gd.members.map((m) => {
        const p = positions.get(String(m.paper.id))
        return p ? { ...m, x: Math.round(p.x), y: Math.round(p.y) } : m
      })
      setDetail({ ...gd, members })
      await Promise.all(
        [...positions].map(([id, p]) => api.setNodePosition(graphId, Number(id), Math.round(p.x), Math.round(p.y)))
      )
      // 新节点可能排在当前视口外（已有节点右侧），收敛视野让用户看到它落在哪
      fitGraphView()
    },
    [graphId, rf, fitGraphView]
  )

  /** 加论文后自动排关系生成（D88）：入队幂等；详情未就绪的论文由引擎跳过保持「未处理」，
   * 之后由 startRelationsBackground 的补排扫描接上（D62 已接线：补排扫描范围是「有成员的图」，
   * 主进程 startRelationsBackground 每 30s 扫一次，见 src/main/relations/background.ts，uat2 e） */
  const autoGenerateRelations = useCallback(
    (paperIds: number[]): void => {
      void api.generateRelations(graphId, paperIds).catch(() => {
        // 排队失败不阻断添加流程，但不再静默（评审建议修 8）
        notify('自动关系生成排队失败，可稍后重试或手动「重新生成关系」')
      })
    },
    [graphId, notify]
  )

  /** 添加论文：服务层返回真正新增的 paperIds（建 6），有新增才做增量定位 */
  const addToGraph = useCallback(
    async (ids: number[]): Promise<void> => {
      if (ids.length === 0) return
      try {
        const added = await api.addPapersToGraph(graphId, ids)
        if (added.length === 0) {
          notify('所选论文均已在图谱中')
          return
        }
        notify(`已添加 ${added.length} 篇到图谱`)
        const fresh = await reload()
        if (fresh) await placeNew(fresh, added)
        autoGenerateRelations(added)
      } catch {
        notify('添加失败，请重试')
      }
    },
    [graphId, reload, placeNew, notify, autoGenerateRelations]
  )

  const saveRelation = useCallback(
    async (rel: RelationView, types: RelationType[], statement: string): Promise<boolean> => {
      if (types.length === 0) {
        notify('至少选择一种关系类型')
        return false
      }
      const prev = { graphId, ...snapshotOf(rel) }
      // uat2b c)：redo 回到「编辑后」状态——同一行，provenance 沿用原边（编辑不改来源，D149 起带已编辑标记）
      const next = {
        graphId,
        id: rel.id,
        srcPaperId: rel.srcPaper,
        dstPaperId: dstOf(rel),
        statement,
        llmTypes: types,
        autoTypes: [...rel.autoTypes],
        sourceType: rel.sourceType,
        sourceJobId: rel.sourceJobId,
        sourceSessionId: rel.sourceSessionId,
        model: rel.model,
        promptVersion: rel.promptVersion,
        editedAt: new Date().toISOString(), // 编辑后状态（D149：已编辑标记）
        noRefBasis: rel.noRefBasis
      }
      setSavingRel(true)
      try {
        await api.createRelation({
          graphId,
          srcPaperId: rel.srcPaper,
          dstPaperId: dstOf(rel),
          statement,
          types
        })
        undoStack.current.push({
          label: '编辑关系',
          undo: async () => {
            await api.restoreRelation(prev)
          },
          redo: async () => {
            await api.restoreRelation(next)
          }
        })
        await reload()
        return true
      } catch {
        notify('保存失败，请重试')
        return false
      } finally {
        setSavingRel(false)
      }
    },
    [graphId, reload, notify]
  )

  /** 删除关系（软删）+ ⌘Z 撤销（D88）：完整行快照，撤销按原 id 原地复活（uat2b c） */
  const deleteRelation = useCallback(
    async (rel: RelationView): Promise<void> => {
      const snap = { graphId, ...snapshotOf(rel) }
      try {
        await api.deleteRelation(rel.id)
        undoStack.current.push({
          label: '删除关系',
          undo: async () => {
            await api.restoreRelation(snap) // 原 id 复活（restore.ts 带 id 分支）
          },
          redo: async () => {
            await api.deleteRelation(rel.id) // id 不变，重删同一行
          }
        })
        notify('已删除关系 · 可用 ⌘Z 撤销')
        setSelectedRelId(null)
        await reload()
      } catch {
        notify('删除失败，请重试')
      }
    },
    [graphId, reload, notify]
  )

  /** 建议修 3：关系面板「调换方向」——保存走 createRelation（markEdited 保 provenance），可 ⌘Z */
  const swapRelationDirection = useCallback(
    async (rel: RelationView): Promise<void> => {
      const prev = { graphId, ...snapshotOf(rel) }
      const next = {
        graphId,
        id: rel.id,
        srcPaperId: dstOf(rel),
        dstPaperId: rel.srcPaper,
        statement: rel.statement,
        llmTypes: [...rel.llmTypes],
        autoTypes: [...rel.autoTypes],
        sourceType: rel.sourceType,
        sourceJobId: rel.sourceJobId,
        sourceSessionId: rel.sourceSessionId,
        model: rel.model,
        promptVersion: rel.promptVersion,
        editedAt: new Date().toISOString(),
        noRefBasis: rel.noRefBasis
      }
      try {
        await api.createRelation({
          graphId,
          srcPaperId: dstOf(rel),
          dstPaperId: rel.srcPaper,
          statement: rel.statement,
          types: [...rel.llmTypes]
        })
        undoStack.current.push({
          label: '调换方向',
          undo: async () => {
            await api.restoreRelation(prev)
          },
          redo: async () => {
            await api.restoreRelation(next)
          }
        })
        await reload()
        notify('已调换方向 · 可用 ⌘Z 撤销')
      } catch {
        notify('调换失败，请重试')
      }
    },
    [graphId, reload, notify]
  )

  const toggleFilterType = (t: RelationType): void => {
    const next = toggleHiddenRelationType(hiddenTypes, t)
    writeSessionTypeFilter(graphId, next)
    setHiddenTypes(next)
  }

  const resetFilterTypes = (): void => {
    writeSessionTypeFilter(graphId, new Set())
    setHiddenTypes(new Set())
  }

  /** 「重新生成关系」（D88）：二次确认后清「已处理」标记重新排队，不进 ⌘Z。
   * 引擎侧在同图有活动任务时拒绝；catch 展示引擎给出的明确原因（评审建议修 3a）。 */
  const doRegenerate = async (): Promise<void> => {
    try {
      await api.regenerateRelations(graphId)
      notify('已排队重新生成关系')
    } catch (e) {
      notify(ipcErrorMessage(e, '排队失败，请重试'))
    }
  }

  const onNodesChange = useCallback((changes: NodeChange<Node>[]) => {
    // deleteKeyCode=null 之外的第二道防线：remove 不改图数据；子图里也拒绝 xyflow
    // pane click 产生的 select:false，避免受控选择互踢成 React #185。
    setNodes((ns) => {
      const next = applyNodeChanges(filterCanvasNodeChanges(changes, subgraphIdsRef.current != null), ns)
      nodesRef.current = next
      return next
    })
  }, [])

  // xyflow 的 SelectionListener 把回调放进 effect 依赖。内联函数每次渲染都是新引用，
  // 会把上一帧的选择写回 selectedPaperIds，再被节点 effect 刷回去，空转到 React #185。
  // 回调保持稳定，只在 store 里的选中集合真正变化时同步；子图冻结读 ref。
  const subgraphIdsRef = useRef(subgraphIds)
  subgraphIdsRef.current = subgraphIds
  // xyflow 把 Shift 同时当作框选键：在节点上 Shift+pointerdown 会 preventDefault，单击到不了节点。
  // 框选仍从空白处按下；落在论文节点上且几乎没移动的 Shift 单击在这里切换选择。
  useEffect(() => {
    let down: { id: number; x: number; y: number } | null = null
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0 || !e.shiftKey || e.metaKey || e.ctrlKey || subgraphIdsRef.current) {
        down = null
        return
      }
      const target = e.target as Element | null
      // 菜单、弹层、按钮上的 Shift 单击不是画布选节点。
      if (target?.closest?.('.menu, .fpop, .ov, .modal, button')) {
        down = null
        return
      }
      const el = target?.closest?.('.react-flow__node')
      const id = el ? paperNodeId(el.getAttribute('data-id') ?? '') : null
      if (id == null) {
        down = null
        return
      }
      down = { id, x: e.clientX, y: e.clientY }
      e.preventDefault()
      e.stopPropagation()
    }
    const onUp = (e: PointerEvent): void => {
      const start = down
      down = null
      if (!start || !e.shiftKey || e.metaKey || e.ctrlKey || subgraphIdsRef.current) return
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) return
      setSelectedPaperIds((prev) => togglePaperSelection(prev, start.id))
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointerup', onUp, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointerup', onUp, true)
    }
  }, [])
  const onCanvasSelectionChange = useCallback(({ nodes: chosen }: { nodes: Node[] }) => {
    if (subgraphIdsRef.current) return
    const next = new Set(chosen.map((n) => paperNodeId(n.id)).filter((id): id is number => id != null))
    setSelectedPaperIds((prev) => (samePaperIdSet(prev, next) ? prev : next))
  }, [])

  const setChatHover = useCallback(
    (active: boolean) => {
      if (chatDropHover.current === active) return
      chatDropHover.current = active
      onChatDragHover?.(active)
    },
    [onChatDragHover]
  )

  const onNodeDragStart = useCallback<OnNodeDrag<Node>>(
    (_e, node, dragged) => {
      // uat7b M1：子图里暗化节点（含候选 / 乐观节点）拒绝拖动——含拖入对话的判定起点。
      if (isSubgraphDimNode(subgraphIdsRef.current, node.id)) return
      draggingNodeIds.current = new Set([node.id, ...dragged.map((n) => n.id)])
      // D200：拖起的集合立即交还 xyflow；其余仍在 tween 的节点从当前显示位置接续。
      const moves: NodePositionMove[] = []
      for (const n of nodes) {
        if (draggingNodeIds.current.has(n.id)) continue
        const to = motionTargets.current.get(n.id)
        if (to && (to.x !== n.position.x || to.y !== n.position.y)) {
          moves.push({ id: n.id, from: { ...n.position }, to: { ...to } })
        }
      }
      animatePositionMoves(moves)
      dragOrigin.current = new Map(nodes.map((n) => [n.id, { x: n.position.x, y: n.position.y }]))
      const id = paperNodeId(node.id)
      dragSelection.current = new Set(selectedPaperIds)
      // B3：对话开着时，拖任何论文节点都按「拖入对话」准备（未选中的也算）。
      // 已选节点仍带上整组选择；未选节点只带自己。候选节点不进这条路径。
      const selectedDrag = id != null && selectedPaperIds.has(id)
      dragNodeWasSelected.current = selectedDrag
      chatDropCandidate.current = chatOpen === true && id != null
      chatDropIds.current = chatDropCandidate.current && id != null ? (selectedDrag ? [...selectedPaperIds] : [id]) : []
      setChatHover(false)
      // dragged 参数在此显式读取，固定 xyflow 三参契约（多选拖动集合由 stop 使用）。
      void dragged
    },
    [nodes, chatOpen, selectedPaperIds, setChatHover, animatePositionMoves]
  )

  const onNodeDrag = useCallback<OnNodeDrag<Node>>(
    (e) => {
      if (!chatDropCandidate.current) return
      setChatHover(isChatDrawerPoint(e))
    },
    [setChatHover]
  )

  const onNodeDragStop = useCallback<OnNodeDrag<Node>>(
    (e, node, dragged) => {
      const wasChatCandidate = chatDropCandidate.current
      draggingNodeIds.current.clear()
      chatDropCandidate.current = false
      setChatHover(false)
      if (node.id.startsWith('cand-')) {
        const id = Number(node.id.slice('cand-'.length))
        if (!Number.isInteger(id) || id <= 0) return
        agentApi()
          .moveCandidate(id, node.position.x, node.position.y)
          .then(() => {
            setCandidates((prev) => prev.map((c) => (c.id === id ? { ...c, x: node.position.x, y: node.position.y } : c)))
          })
          .catch(() => notify('保存位置失败'))
        return
      }

      const origin = dragOrigin.current
      const draggedPaperId = paperNodeId(node.id)
      const overDrawer = isChatDrawerPoint(e)
      if (overDrawer && !node.id.startsWith('cand-')) {
        // D176 / B3：松手在抽屉上 = chip，坐标一律不写库。已选拖动带整组，未选只带这一篇。
        const ids = chatDropIds.current.filter((id) => paperById.has(id))
        setNodes((prev) => {
          const next = prev.map((n) => {
            const p = origin.get(n.id)
            return p ? { ...n, position: { ...p } } : n
          })
          nodesRef.current = next
          return next
        })
        if (wasChatCandidate && ids.length > 0) onAddPaperChips?.(ids)
        // xyflow 默认会在拖起时选中未选节点；落入抽屉只是添 chip，恢复原选择集合。
        if (wasChatCandidate && draggedPaperId != null && !dragNodeWasSelected.current) {
          setSelectedPaperIds(new Set(dragSelection.current))
        }
        chatDropIds.current = []
        dragOrigin.current = new Map()
        return
      }

      // 普通移动：xyflow 第三参是本次一起拖动的节点；只写坐标真正变化的论文，
      // 多选拖动因此全部落库（与起点一致，不进撤销栈）。候选在上面单独处理。
      const moved = movedPaperPositions(origin, dragged)
      if (moved.length > 0) {
        const byId = new Map(moved.map((n) => [n.id, n.position]))
        setDetail((prev) =>
          prev
            ? {
                ...prev,
                members: prev.members.map((m) => {
                  const p = byId.get(String(m.paper.id))
                  return p ? { ...m, x: p.x, y: p.y } : m
                })
              }
            : prev
        )
        for (const n of moved) {
          const id = paperNodeId(n.id)!
          api.setNodePosition(graphId, id, n.position.x, n.position.y).catch(() => notify('保存位置失败'))
        }
      }
      dragOrigin.current = new Map()
    },
    [graphId, notify, paperById, selectedPaperIds, onAddPaperChips, setChatHover]
  )

  const onConnect = useCallback(
    (c: Connection) => {
      const srcId = Number(c.source)
      const dstId = Number(c.target)
      // uat7b M1：子图里不允许从暗化节点拉新边（暗化节点 connectable=false 的第二道守卫）。
      if (subgraphIds && (!subgraphIds.has(srcId) || !subgraphIds.has(dstId))) return
      const src = paperById.get(srcId)
      const dst = paperById.get(dstId)
      if (!src || !dst) return
      // 评审建 4：这对论文已有边时不要静默覆盖（upsert 后写为准），直接打开关系面板
      const lo = Math.min(srcId, dstId)
      const hi = Math.max(srcId, dstId)
      const existing = detail?.relations.find((r) => r.paperLow === lo && r.paperHigh === hi)
      if (existing) {
        setProcPaper(null)
        setSelectedRelId(existing.id)
        notify('这两篇论文之间已有关系，已打开关系面板')
      } else {
        setConnect({ src, dst })
      }
    },
    [paperById, detail, notify, subgraphIds]
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const pid = e.dataTransfer.getData(DND_MIME)
      if (!pid || !rf) return
      const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
      void (async () => {
        try {
          await api.addPapersToGraph(graphId, [Number(pid)])
          await api.setNodePosition(graphId, Number(pid), Math.round(pos.x), Math.round(pos.y))
          notify('已添加 1 篇到图谱')
          await reload()
          autoGenerateRelations([Number(pid)])
        } catch {
          notify('添加失败，请重试')
        }
      })()
    },
    [graphId, rf, reload, notify, autoGenerateRelations]
  )

  /** D148/D179：单个与批量共用一条路径。撤销栈只压一条；共享边按 id 去重，
   * 一次 ⌘Z 恢复整批（成员 → 原坐标 → 边 → 原有进度行），⌘⇧Z 整批重做。 */
  const removeFromGraph = async (papers: PaperSummary[]): Promise<void> => {
    const unique = [...new Map(papers.map((p) => [p.id, p])).values()]
    if (unique.length === 0 || !detail) return
    const ids = new Set(unique.map((p) => p.id))
    const members = new Map(detail.members.filter((m) => ids.has(m.paper.id)).map((m) => [m.paper.id, m]))
    const relSnaps = removalRelationSnapshots(detail.relations, ids).map((r) => ({ graphId, ...snapshotOf(r) }))
    // uat7b S1：移除前快照原时间戳（added_at / done_at / graphs.updated_at），
    // 撤销时原样写回，不盖成撤销时刻（单个与批量同一路径）。
    const succeeded: Array<{ paper: PaperSummary; addedAt: string; doneAt: string | null }> = []
    let graphUpdatedAt: string | null = null
    for (const paper of unique) {
      try {
        const removed = await api.removePaperFromGraph(graphId, paper.id)
        succeeded.push({ paper, addedAt: removed.addedAt, doneAt: removed.doneAt })
        graphUpdatedAt ??= removed.graphUpdatedAt // 一批取第一次移除前的值（后续移除已 bump）
      } catch {
        // 部分失败：已成功的仍形成一个完整可撤销批次，不留无法回滚的半截状态。
      }
    }
    if (succeeded.length === 0) {
      notify('移除失败，请重试')
      return
    }
    const succeededIds = succeeded.map((s) => s.paper.id)
    const succeededSet = new Set(succeededIds)
    const snaps = relSnaps.filter((s) => succeededSet.has(s.srcPaperId) || succeededSet.has(s.dstPaperId))
    const label = succeeded.length === 1 ? '从图谱移除' : `从图谱移除 ${succeeded.length} 篇`
    // uat8b B5：重做只再移除真正恢复回去的论文。全跳过时 restoredIds 为空，重做不调用
    // removePaperFromGraph（该函数即使成员已不在也会 bump graphs.updated_at）。
    let restoredIds = succeededIds
    undoStack.current.push({
      label,
      undo: async () => {
        // uat7b-fix1 M1：不再先 addPapersToGraph（它会把 added_at 写成撤销时刻）。
        // uat8b B5：一次 IPC。已从库软删（D75）的论文跳过，不恢复成员与其关系；
        // 全跳过时主进程不写库。坐标 / added_at / 进度 / graphs.updated_at 仍按 D164② 原样。
        if (graphUpdatedAt == null) return
        const result = await api.undoGraphRemoval({
          graphId,
          graphUpdatedAt,
          papers: succeeded.map(({ paper, addedAt, doneAt }) => {
            const member = members.get(paper.id)
            return { paperId: paper.id, x: member?.x ?? 0, y: member?.y ?? 0, addedAt, doneAt }
          }),
          relations: snaps
        })
        restoredIds = result.restoredIds
        if (!result.applied) undoNote.current = '论文已从论文库删除，无法恢复'
        else if (result.skipped > 0) undoNote.current = `已恢复 ${result.restored} 篇，${result.skipped} 篇已从论文库删除`
        else undoNote.current = null
      },
      redo: async () => {
        for (const id of restoredIds) await api.removePaperFromGraph(graphId, id)
      }
    })
    notify(
      succeeded.length === unique.length
        ? succeeded.length === 1
          ? '已从图谱移除 · 可用 ⌘Z 撤销'
          : `已从图谱移除 ${succeeded.length} 篇 · 可用 ⌘Z 撤销`
        : `已移除 ${succeeded.length} / ${unique.length} 篇，其余失败 · 可用 ⌘Z 撤销`
    )
    setMenu(null)
    setSelectedRelId(null)
    setProcPaper(null)
    setSelectedPaperIds((prev) => new Set([...prev].filter((id) => !succeededSet.has(id))))
    setSubgraphIds((prev) => {
      if (!prev) return null
      const next = new Set([...prev].filter((id) => !succeededSet.has(id)))
      return next.size >= 2 ? next : null
    })
    await reload()
    window.dispatchEvent(new CustomEvent('gt:graph-changed'))
  }

  const deleteFromLibrary = async (): Promise<void> => {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    try {
      await api.deletePaperFromLibrary(deleteTarget.id)
      notify('已从论文库删除')
      setDeleteTarget(null)
      setSelectedRelId(null)
      setProcPaper(null)
      setSelectedPaperIds((prev) => {
        const next = new Set(prev)
        next.delete(deleteTarget.id)
        return next
      })
      setSubgraphIds((prev) => {
        if (!prev) return null
        const next = new Set(prev)
        next.delete(deleteTarget.id)
        return next.size >= 2 ? next : null
      })
      await reload()
      window.dispatchEvent(new CustomEvent('gt:graph-changed'))
    } catch {
      notify('删除失败，请重试')
    } finally {
      setDeleting(false)
    }
  }

  const sideMemberRows = applySidebarHits(
    (detail?.members ?? []).map((m) => m.paper),
    sideFilter,
    sidebarServer != null && sidebarServer.query === sideFilter.trim() ? sidebarServer.members : null
  )
  const sideOtherRows = applySidebarHits(
    library.filter((p) => !p.inGraph),
    sideFilter,
    sidebarServer != null && sidebarServer.query === sideFilter.trim() ? sidebarServer.others : null
  )

  const selectedPapers = (detail?.members ?? []).filter((m) => selectedPaperIds.has(m.paper.id)).map((m) => m.paper)
  const subgraphRelCount = subgraphIds ? subgraphRelationIds(detail?.relations ?? [], subgraphIds).size : 0
  const selectedRel = detail?.relations.find((r) => r.id === selectedRelId) ?? null
  // uat7b S2：从库删除确认框显示**所有图谱**的有效关系数（涉及图谱数）；
  // 「从图谱移除」建议只在论文是当前图谱成员时出现。
  const [deleteStats, setDeleteStats] = useState<{ count: number; graphCount: number } | null>(null)
  useEffect(() => {
    if (!deleteTarget) return
    let on = true
    setDeleteStats(null)
    api
      .paperRelationStats(deleteTarget.id)
      .then((s) => {
        if (on) setDeleteStats(s)
      })
      .catch(() => {
        if (on) setDeleteStats({ count: 0, graphCount: 0 })
      })
    return () => {
      on = false
    }
  }, [deleteTarget])
  const deleteTargetIsMember = deleteTarget != null && (detail?.members.some((m) => m.paper.id === deleteTarget.id) ?? false)

  return (
    <>
      <div className="sidebar">
        <div className="tlspace" />
        <div className="sbody">
          <div className="field" style={{ margin: '4px 0 6px' }}>
            <Ic name="search" size={14} />
            <input
              data-testid="sidebar-search"
              placeholder="搜索论文库"
              value={sideFilter}
              onChange={(e) => setSideFilter(e.target.value)}
            />
          </div>
          <div className="shead" style={{ paddingTop: 8 }}>
            <span className="cap">本图谱 · {(detail?.members.length ?? 0) + optimistic.size}</span>
          </div>
          {sideMemberRows.map(({ paper, via }) => (
            <div
              key={paper.id}
              className="prow"
              style={{ cursor: 'default' }}
              data-testid="side-member-row"
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                const p = clampMenuPos(e.clientX, e.clientY, 230, 48, window.innerWidth, window.innerHeight)
                setMenu({ kind: 'library', paper, x: p.x, y: p.y })
              }}
            >
              <div className="t">{paper.title}</div>
              <div className="m">
                <span>
                  {paperMeta(paper)}
                  {via === 'body' && (
                    <span className="nptag0" data-testid="side-body-tag">
                      {' '}
                      正文
                    </span>
                  )}
                  {!paper.hasPdf && <span className="nptag0"> 无 PDF</span>}
                  {/* uat1b D144：MinerU 不可用期间，有 PDF 未处理的论文标「等待解析组件」 */}
                  {waitParseOf(paper.id, paper.hasPdf) && (
                    <span className="nptag0" title={waitParseOf(paper.id, paper.hasPdf)!} data-testid="row-wait-parse">
                      等待解析组件
                    </span>
                  )}
                  {/* uat2：处理中蓝点（原型库行「处理中 + 蓝点」）；queued 口径 = 排队中 */}
                  {procOf(paper.id) && (
                    <span
                      className="nptag0"
                      data-testid="row-proc"
                      title={procOf(paper.id) === 'queued' ? '排队中 · 完成后自动补关系' : '处理中 · 完成后自动补关系'}
                    >
                      <span className="procdot" style={{ marginRight: 3, marginLeft: 0 }} />
                      {procOf(paper.id) === 'queued' ? '排队中' : '处理中'}
                    </span>
                  )}
                  {papersStatus.get(paper.id)?.state === 'failed' && (
                    <span
                      className="faildot"
                      style={{ cursor: 'pointer' }}
                      title={`${failTitle(papersStatus.get(paper.id)!)}（点击查看处理状态）`}
                      onClick={(e) => {
                        e.stopPropagation()
                        setSelectedRelId(null)
                        setProcPaper(paper)
                      }}
                    />
                  )}
                </span>
                <Ic name="check" size={12} />
              </div>
            </div>
          ))}
          <div className="shead" style={{ marginTop: 4 }}>
            <span className="cap">论文库 · 其他</span>
          </div>
          {sideOtherRows.map(({ paper: p, via }) => (
            <div
              key={p.id}
              className="prow"
              draggable
              data-testid="side-library-row"
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                const pos = clampMenuPos(e.clientX, e.clientY, 230, 48, window.innerWidth, window.innerHeight)
                setMenu({ kind: 'library', paper: p, x: pos.x, y: pos.y })
              }}
              onDragStart={(e) => {
                e.dataTransfer.setData(DND_MIME, String(p.id))
                e.dataTransfer.effectAllowed = 'move'
              }}
            >
              <div className="t">{p.title}</div>
              <div className="m">
                <span>
                  {paperMeta(p)}
                  {via === 'body' && (
                    <span className="nptag0" data-testid="side-body-tag">
                      {' '}
                      正文
                    </span>
                  )}
                  {!p.hasPdf && <span className="nptag0"> 无 PDF</span>}
                  {/* uat1b D144：MinerU 不可用期间，有 PDF 未处理的论文标「等待解析组件」 */}
                  {waitParseOf(p.id, p.hasPdf) && (
                    <span className="nptag0" title={waitParseOf(p.id, p.hasPdf)!} data-testid="row-wait-parse">
                      等待解析组件
                    </span>
                  )}
                  {/* uat2：处理中蓝点；queued 口径 = 排队中 */}
                  {procOf(p.id) && (
                    <span
                      className="nptag0"
                      data-testid="row-proc"
                      title={procOf(p.id) === 'queued' ? '排队中 · 完成后自动补关系' : '处理中 · 完成后自动补关系'}
                    >
                      <span className="procdot" style={{ marginRight: 3, marginLeft: 0 }} />
                      {procOf(p.id) === 'queued' ? '排队中' : '处理中'}
                    </span>
                  )}
                  {papersStatus.get(p.id)?.state === 'failed' && (
                    <span
                      className="faildot"
                      style={{ cursor: 'pointer' }}
                      title={`${failTitle(papersStatus.get(p.id)!)}（点击查看处理状态）`}
                      onClick={(e) => {
                        e.stopPropagation()
                        setSelectedRelId(null)
                        setProcPaper(p)
                      }}
                    />
                  )}
                </span>
                <span className="add" title="加入图谱" onClick={() => void addToGraph([p.id])}>
                  <Ic name="plus" size={13} w={1.6} />
                </span>
              </div>
            </div>
          ))}
          <div className="grow" />
          <div className="t3" style={{ fontSize: 11.5, padding: 8, lineHeight: '17px' }}>
            拖到画布加入图谱
          </div>
        </div>
      </div>

      <div className="maincol">
        <div className="toolbar">
          <button className="btn" style={{ color: 'var(--text2)', paddingLeft: 6 }} onClick={onHome}>
            <Ic name="back" size={15} />
            我的图谱
          </button>
          <span className="t3">/</span>
          <span className="ttl">{detail?.graph.name ?? ''}</span>
          <span className="t3" style={{ fontSize: 12, marginLeft: 8, flex: 'none' }}>
            {(detail?.members.length ?? 0) + optimistic.size} 篇 · {detail?.relations.length ?? 0} 条关系
          </span>
          <div className="grow" />
          <button
            className={`btn ${showFilter ? 'primary' : ''}`}
            style={showFilter ? undefined : { color: 'var(--text2)' }}
            title="按关系类型筛选"
            data-testid="relation-filter"
            data-filtered={hiddenTypes.size > 0 ? 'true' : 'false'}
            onClick={(e) => {
              e.stopPropagation() // uat2b：阻止冒泡到 window，刚挂的关闭监听不会吃掉这次点击
              setShowFilter((v) => !v)
            }}
          >
            <Ic name="sliders" size={15} />
            筛选{hiddenTypes.size > 0 && <span className="t3" data-testid="filter-active"> · 已过滤</span>}
          </button>
          <GenerateRelationsEntry
            visible={!!detail && detail.members.length > 0 && detail.relations.length === 0}
            running={gen?.running ?? false}
            onGenerate={() => {
              void api
                .generateRelations(graphId)
                .then(() => notify('已排队生成关系'))
                .catch(() => notify('排队失败，请重试'))
            }}
          />
          <button className="btn" style={{ color: 'var(--text2)' }} disabled={!detail || detail.members.length === 0} onClick={() => detail && void arrange(detail)}>
            <Ic name="tree" size={15} />
            整理
          </button>
          <button
            className={`btn ${chatOpen ? 'primary' : ''}`}
            style={chatOpen ? undefined : { color: 'var(--text2)' }}
            title="对话"
            data-testid="chat-toggle"
            onClick={() => onToggleChat?.({ type: 'graph' })}
          >
            <Ic name="chat" size={15} />
            对话
          </button>
          <button
            className="btn icon"
            title="更多"
            onClick={(e) => {
              e.stopPropagation() // uat2b：阻止冒泡到 window（同「筛选」）
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              const p = clampMenuPos(r.right - 230, r.bottom + 6, 230, 80, window.innerWidth, window.innerHeight)
              setMoreMenu(p)
            }}
          >
            <Ic name="more" size={15} />
          </button>
          <div className="sep" />
          <button className="btn primary" onClick={() => setShowAdd(true)}>
            <Ic name="plus" size={15} w={1.6} />
            添加论文
          </button>
          <StatusDot onOpenSettings={onOpenSettings} onOpenParseSettings={onOpenParseSettings} />
          <button className="btn icon" title="设置" onClick={onOpenSettings}>
            <Ic name="sliders" size={15} />
          </button>
        </div>
        <div className="ws">
          <div
            ref={canvasRef}
            className="canvas-wrap"
            onDrop={onDrop}
            onDragOver={(e) => e.preventDefault()}
            // uat7b D184-②：子图里点空白必须在 xyflow 之前拦住——xyflow 的 pane click
            // 会 resetSelectedElements（triggerNodeChanges select:false），受控同步下与
            // 应用侧 selectedPaperIds（子图里冻结不动）互踢，真实浏览器里触发 React #185
            // 整树卸载。拦截后选择集合不动，关面板语义与 onPaneClick 保持一致。
            onClickCapture={(e) => {
              if (!subgraphIds) return
              const t = e.target as HTMLElement
              if (t.closest('.react-flow__node, .react-flow__edge, .gt-subgraph-banner, .menu, .fpop, .legend, button, input, textarea, select')) return
              setSelectedRelId(null)
              setProcPaper(null)
              // uat7b-fix1 S-a：点空白同时关掉挂在 window 上的浮层关闭监听所负责的
              // 右键菜单 / 筛选 /「更多」——capture 的 stopPropagation 会挡住那条 window
              // 监听（评审建议修 5），这里在拦截点自己关（D184-② 不清选择不变）。
              setMenu(null)
              setMoreMenu(null)
              setShowFilter(false)
              e.stopPropagation()
            }}
          >
            {focusMode && (
              <div className="gt-subgraph-banner gt-focus-banner" data-testid="focus-banner">
                <span className="gt-focus-title" title={paperById.get(focusMode.root)?.title}>
                  聚焦：{paperById.get(focusMode.root)?.title ?? `论文 ${focusMode.root}`}
                </span>
                <span className="gt-focus-depth" aria-label="聚焦邻域深度">
                  <button
                    className={`btn sm ${focusMode.depth === 1 ? 'primary' : 'bordered'}`}
                    data-testid="focus-depth-1"
                    aria-pressed={focusMode.depth === 1}
                    onClick={() => activateFocus(focusMode.root, 1)}
                  >
                    1跳
                  </button>
                  <button
                    className={`btn sm ${focusMode.depth === 2 ? 'primary' : 'bordered'}`}
                    data-testid="focus-depth-2"
                    aria-pressed={focusMode.depth === 2}
                    onClick={() => activateFocus(focusMode.root, 2)}
                  >
                    2跳
                  </button>
                </span>
                <button className="btn bordered sm" data-testid="focus-exit" onClick={() => exitFocus()}>
                  退出
                </button>
              </div>
            )}
            {subgraphIds && (
              <div className="gt-subgraph-banner" data-testid="subgraph-banner">
                <span>子图 · {subgraphIds.size} 篇 · {subgraphRelCount} 条关系 · Esc 退出</span>
                <button className="btn bordered sm" data-testid="subgraph-exit" onClick={() => setSubgraphIds(null)}>
                  退出
                </button>
              </div>
            )}
            <MotionPresence open={showFilter} kind="pop">
              {showFilter ? (
              <div className="fpop" onClick={(e) => e.stopPropagation()}>
                <div className="secth">
                  <b>按关系类型筛选</b>
                </div>
                <div className="frows">
                  {ALL_RELATION_TYPES.map((t) => (
                    <label key={t} className="frow">
                      <input type="checkbox" checked={!hiddenTypes.has(t)} onChange={() => toggleFilterType(t)} />
                      <span>{RELATION_TYPE_LABELS[t]}</span>
                      <span className="fcount" data-testid={`filter-count-${t}`}>{relationCounts[t]}</span>
                    </label>
                  ))}
                </div>
                <div className="t3" style={{ fontSize: 11, lineHeight: '16px' }}>
                  取消勾选后，只含该类型的连线不再显示；多种类型的连线只要有一种可见就保留。
                </div>
                <button className="btn bordered sm" style={{ alignSelf: 'flex-start' }} disabled={hiddenTypes.size === 0} title="重置关系类型筛选" onClick={resetFilterTypes}>
                  全部显示
                </button>
              </div>
              ) : null}
            </MotionPresence>
            {gen?.running &&
              (gen.status === 'waiting_key' || (gen.error ?? '').includes('API Key') ? (
                // uat13（D207-⑤）：waiting_key 是明确的等待态——中性点、不显示「正在生成」
                <div className="relgen waiting" data-testid="relgen-waiting">
                  <span className="reldot" />
                  生成关系 · 等待 {llmLabel} API Key
                </div>
              ) : (
                <div className="relgen">
                  <span className="reldot" />
                  正在生成关系 · {GEN_PHASE_LABEL[gen.phase] ?? '生成关系'}
                  {gen.total > 0 && ` · ${gen.processed}/${gen.total}`}
                  {gen.error && ` · ${gen.error}`}
                </div>
              ))}
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onSelectionChange={onCanvasSelectionChange}
              onNodeDragStart={onNodeDragStart}
              onNodeDrag={onNodeDrag}
              onNodeDragStop={onNodeDragStop}
              onNodeMouseEnter={(_e, node) => {
                const id = paperNodeId(node.id)
                if (id != null) setHoveredPaperId(id)
              }}
              onNodeMouseLeave={(_e, node) => {
                const id = paperNodeId(node.id)
                if (id != null) setHoveredPaperId((current) => (current === id ? null : current))
              }}
              onConnect={onConnect}
              onEdgeClick={(_e, edge) => {
                // uat7b M1：暗化边不可开关系面板——按子图成员判定，不依赖 CSS className。
                if (isSubgraphDimEdge(subgraphIds, edge)) return
                setProcPaper(null)
                setSelectedRelId(Number(edge.id))
              }}
              onPaneClick={() => {
                setSelectedRelId(null)
                setProcPaper(null)
                setSelectedPaperIds((prev) => selectionAfterPaneClick(prev, subgraphIds != null))
              }}
              onNodeClick={(_e, node) => {
                if (node.type === 'candidate') return // 候选虚线节点：操作在节点卡片按钮上
                // uat7b M1：子图里暗化节点全部交互在 handler 层拒绝（不靠 CSS pointer-events）。
                if (isSubgraphDimNode(subgraphIds, node.id)) return
                // D176：单击只由 xyflow 选择，不开详情；关闭既有两类面板。
                setProcPaper(null)
                setSelectedRelId(null)
              }}
              onNodeDoubleClick={(_e, node) => {
                // uat7b M1：暗化节点双击不开详情（此前只防单击，双击直接跳详情、返回丢子图）。
                if (isSubgraphDimNode(subgraphIds, node.id)) return
                const id = paperNodeId(node.id)
                if (id == null) return
                onOpenPaper(id) // 含失败节点：详情 03d 数据通路不变；子图状态由 subgraphRestore 暂存恢复
              }}
              onNodeContextMenu={(e, node) => {
                e.preventDefault()
                // uat7b M1：暗化节点不出右键菜单（高亮已选节点菜单不变，D179）。
                if (isSubgraphDimNode(subgraphIds, node.id)) return
                const id = paperNodeId(node.id)
                if (id == null) return
                const paper = paperById.get(id)
                if (!paper) return
                const multi = selectedPaperIds.has(id) && selectedPaperIds.size >= 2
                if (!multi) setSelectedPaperIds(new Set([id]))
                const height = multi ? 150 : 140
                const p = clampMenuPos(e.clientX, e.clientY, 260, height, window.innerWidth, window.innerHeight)
                setMenu(multi ? { kind: 'selection', papers: selectedPapers, x: p.x, y: p.y } : { kind: 'paper', paper, x: p.x, y: p.y })
              }}
              onInit={setRf}
              nodesConnectable
              deleteKeyCode={null}
              // uat7b M3：拖到对话抽屉 / 画布外时禁止边缘自动平移（拖入对话节点回原位、
              // 视口不跑）；画布内拖动写位置等其余行为不变（D176）。
              autoPanOnNodeDrag={false}
              multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
              selectionKeyCode={subgraphIds ? null : 'Shift'}
              selectionOnDrag={false}
              zoomOnDoubleClick={false}
              proOptions={{ hideAttribution: true }}
              minZoom={0.1}
              maxZoom={2.5}
            >
              <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--dot)" />
              <Controls showInteractive={false} fitViewOptions={{ padding: 0.15, duration: viewportMotionMs(), maxZoom: 1 }} />
            </ReactFlow>
            <div className="legend">
              <span>
                <i className="sw n" />
                论文
              </span>
              <span>
                <i className="sw e" />
                关系
              </span>
              {positionedCandidates.length > 0 && (
                <span>
                  <i className="sw c" />
                  候选
                </span>
              )}
            </div>
            {detail && detail.members.length === 0 && (
              <div className="emptyc">
                <div className="t3" style={{ fontSize: 13 }}>
                  这张图谱还没有论文
                </div>
                <button className="btn primary" onClick={() => setShowAdd(true)}>
                  <Ic name="plus" size={15} w={1.6} />
                  添加论文
                </button>
              </div>
            )}
          </div>

          {selectedRel && (
            <RelationPanel
              rel={selectedRel}
              paperById={paperById}
              saving={savingRel}
              onToggleType={(types) => void saveRelation(selectedRel, types, selectedRel.statement)}
              onSaveStatement={(statement) => void saveRelation(selectedRel, [...selectedRel.llmTypes], statement)}
              onSwapDirection={() => void swapRelationDirection(selectedRel)}
              onDelete={() => void deleteRelation(selectedRel)}
              onOpenChat={onToggleChat ? () => onToggleChat({ type: 'relation', relationId: selectedRel.id }) : undefined}
              onOpenPaper={onOpenPaper}
              onClose={() => setSelectedRelId(null)}
              // uat4-fix1 M1/D173：只读展示替换（P0x→《短标题》）；保存/快照/⌘Z 全走原文
              displayStatement={shortIdReplaceForDisplay(detail?.members ?? [])(selectedRel.statement)}
            />
          )}

          {procPaper && (
            <PaperProcessPanel
              paper={procPaper}
              status={papersStatus.get(procPaper.id)}
              sidecar={sidecar}
              onClose={() => setProcPaper(null)}
            />
          )}
        </div>
      </div>

      <MotionPresence open={showAdd} kind="modal">
        {showAdd ? (
        <AddPapersModal
          graphId={graphId}
          onClose={() => setShowAdd(false)}
          onChanged={async (addedIds) => {
            if (addedIds.length === 0) return // 建 6：只有真正新增才需要定位
            const fresh = await reload()
            if (fresh) await placeNew(fresh, addedIds) // 终审建议修 1：增量定位，不动旧节点
            autoGenerateRelations(addedIds) // D88：新增论文自动生成关系
          }}
        />
        ) : null}
      </MotionPresence>

      <MotionPresence open={moreMenu != null} kind="pop">
        {moreMenu ? (
        <div className="menu" style={{ left: moreMenu.x, top: moreMenu.y }} onClick={(e) => e.stopPropagation()}>
          <div
            className="mi"
            data-testid="menu-export-md"
            onClick={() => {
              setMoreMenu(null)
              setShowExport(true)
            }}
          >
            <Ic name="export" size={15} />
            导出 Markdown…
          </div>
          <RegenRelationsItem running={gen?.running ?? false} onRegenerate={() => void doRegenerate()} />
        </div>
        ) : null}
      </MotionPresence>

      <MotionPresence open={showExport && detail != null} kind="modal">
        {showExport && detail ? (
        <ExportDialog
          graphId={graphId}
          graphName={detail.graph.name}
          memberCount={detail.members.length}
          onClose={() => setShowExport(false)}
        />
        ) : null}
      </MotionPresence>

      <MotionPresence open={menu != null} kind="pop">
        {menu ? (
        <div className="menu" data-testid={`${menu.kind}-menu`} style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <div className="cap" style={{ padding: '6px 10px 4px', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {menu.kind === 'selection' ? `已选 ${menu.papers.length} 篇` : menu.paper.title}
          </div>
          {menu.kind === 'selection' && (
            <div
              className="mi"
              data-testid="menu-subgraph"
              onClick={() => {
                const ids = new Set(menu.papers.map((p) => p.id))
                setMenu(null)
                setSelectedRelId(null)
                setProcPaper(null)
                exitFocus(false) // D212：切到所选子图时自动退聚焦，但不回拽视口
                setSubgraphIds(ids)
                fitGraphView([...ids].map((id) => String(id)), 0.2)
              }}
            >
              <Ic name="tree" size={15} />
              查看所选子图
            </div>
          )}
          {menu.kind === 'paper' && (
            <div
              className="mi"
              data-testid="menu-focus-paper"
              onClick={() => activateFocus(menu.paper.id, 1)}
            >
              <Ic name="tree" size={15} />
              聚焦此论文
              <span className="kb">F</span>
            </div>
          )}
          {menu.kind !== 'library' && (
            <div
              className="mi"
              data-testid="menu-add-chat"
              onClick={() => {
                onAddPaperChips?.(menu.kind === 'selection' ? menu.papers.map((p) => p.id) : [menu.paper.id])
                setMenu(null)
              }}
            >
              <Ic name="chat" size={15} />
              添加到对话上下文
            </div>
          )}
          {menu.kind !== 'library' && (
            <div className="mi" data-testid="menu-remove-graph" onClick={() => void removeFromGraph(menu.kind === 'selection' ? menu.papers : [menu.paper])}>
              <Ic name="close" size={15} />
              {menu.kind === 'selection' ? `从图谱移除所选 ${menu.papers.length} 篇` : '从图谱移除'}
              <span className="kb">仍在论文库</span>
            </div>
          )}
          {menu.kind === 'library' && (
            <div
              className="mi danger"
              data-testid="menu-delete-library"
              onClick={() => {
                setDeleteTarget(menu.paper)
                setMenu(null)
              }}
            >
              <Ic name="trash" size={15} />
              从库删除…
            </div>
          )}
        </div>
        ) : null}
      </MotionPresence>

      <MotionPresence open={deleteTarget != null} kind="modal">
        {deleteTarget ? (
        <ConfirmDialog
          title={`从论文库删除「${shortTitle(deleteTarget.title)}」？`}
          okText={deleting ? '删除中…' : '从库删除'}
          danger
          okDisabled={deleting}
          onOk={() => void deleteFromLibrary()}
          onClose={() => setDeleteTarget(null)}
        >
          <>
            这篇论文会从论文库和所有图谱中移除，所有图谱里和它相连的 {deleteStats?.count ?? '…'} 条关系
            {deleteStats != null && deleteStats.graphCount > 0 && <>（涉及 {deleteStats.graphCount} 个图谱）</>}也会一并移除。
            {deleteTargetIsMember && (
              <div className="t3" style={{ fontSize: 11.5, lineHeight: '17px', marginTop: 8 }}>
                只想从这张图谱里拿掉？用「从图谱移除」，论文仍留在论文库。
              </div>
            )}
          </>
        </ConfirmDialog>
        ) : null}
      </MotionPresence>

      <MotionPresence open={connect != null} kind="modal">
        {connect ? (
        <ConnectDialog
          src={connect.src}
          dst={connect.dst}
          saving={savingRel}
          onClose={() => setConnect(null)}
          onSave={async (types, statement) => {
            setSavingRel(true)
            try {
              const snap = { graphId, srcPaperId: connect.src.id, dstPaperId: connect.dst.id, statement: statement.trim(), llmTypes: types }
              let currentId = await api.createRelation({
                graphId,
                srcPaperId: connect.src.id,
                dstPaperId: connect.dst.id,
                statement,
                types
              })
              undoStack.current.push({
                label: '创建关系',
                undo: async () => {
                  await api.deleteRelation(currentId)
                },
                redo: async () => {
                  currentId = await api.restoreRelation(snap)
                }
              })
              notify('已创建关系')
              setConnect(null)
              await reload()
            } catch {
              notify('保存失败，请重试')
            } finally {
              setSavingRel(false)
            }
          }}
        />
        ) : null}
      </MotionPresence>
    </>
  )
}

function shortTitle(t: string): string {
  return t.length > 24 ? `${t.slice(0, 24)}…` : t
}

/** 候选虚线节点（M5 lane/chat 批 3，D117；M6 lane/ui：库外确认 + 入库进度徽标 + 转实线）。
 *  与对话内 PaperCardBlock 两处同步确认/忽略；done / no_pdf 经 gt:graph-changed 重载。
 *  失败且 paperId > 0 走 retryFindPdf（确认本身没入库才再 importConfirm）。
 *  导出供单测：done 不渲染确认按钮，busy 不在终态上盖住进度事件。 */
export function CandidateNode({ data }: NodeProps): React.JSX.Element {
  const c = data.candidate as CandidateView
  const prog = (data.progress as CandProgressEvent | null) ?? null
  const inLibrary = c.existingPaperId != null
  /** 乐观「入库中」。只盖住「还没有进度事件」的空窗。
   *  成功回调里不能立刻 setBusy(false)：importConfirm 立即 resolve，React 18 会把
   *  true/false 合成一次提交，乐观徽标画不出来（smoke「画布确认入库」）。
   *  进度事件到达后清掉，相位交给事件；终态公式也不让残留 busy 再画出转圈。 */
  const [busy, setBusy] = useState(false)
  /** 同一 tick 连点：state 要等重渲染才变成 true，挡不住第二次 importConfirm。 */
  const importGuard = useRef(false)
  const phaseImporting = prog != null && CAND_IMPORTING_PHASES.has(prog.phase)
  const importing = phaseImporting || (busy && prog == null)
  const failed = prog?.phase === 'failed'
  const noPdf = prog?.phase === 'no_pdf'
  const done = prog?.phase === 'done'
  const notify = useNotify()
  useEffect(() => {
    if (prog != null) setBusy(false)
  }, [prog])
  const confirm = (): void => {
    // M6 lane/ui 批 1：库外候选确认 = cand:importConfirm（立即返回，进度走 event:cand:progress，D124）
    if (!inLibrary) {
      // 库外入库是分钟级过程：候选虚线节点**保留**（进度徽标四态照旧、按钮禁用），
      // 不提前换正式节点——done / no_pdf 经 gt:graph-changed 重载才换成实线论文节点。
      // 已入库后的 failed：再 importConfirm 会得到空 jobId，节点停在「正在入库」
      if (failed && (prog?.paperId ?? 0) > 0) {
        retryFindPdf()
        return
      }
      if (importGuard.current || busy) return
      importGuard.current = true
      setBusy(true)
      candApi()
        .importConfirm({ candidateId: c.id })
        .then(() => notify('已确认加入'))
        .catch((e: unknown) => {
          setBusy(false)
          notify(ipcErrorMessage(e, '入库失败，请重试'))
        })
        .finally(() => {
          importGuard.current = false
        })
      return
    }
    // uat5 必须修 4：「已在库中」确认是即时操作——乐观更新，同一 tick 内候选节点
    // 转正式样式、计数 +1；失败回滚（候选节点回来）
    dispatchCandConfirmStart({ candidateId: c.id, paperId: c.existingPaperId, title: c.title, authors: c.authors, year: c.year, x: c.x, y: c.y })
    if (importGuard.current || busy) {
      dispatchCandConfirmRollback(c.id)
      return
    }
    importGuard.current = true
    setBusy(true)
    agentApi()
      .candidateConfirm(c.id)
      .then(() => {
        notify('已确认加入')
        window.dispatchEvent(new CustomEvent('gt:graph-changed'))
      })
      .catch((e: unknown) => {
        dispatchCandConfirmRollback(c.id) // 失败回滚：候选节点回来
        setBusy(false)
        notify(ipcErrorMessage(e, '确认失败，请重试'))
      })
      .finally(() => {
        importGuard.current = false
      })
  }
  const retryFindPdf = (): void => {
    if (prog == null || prog.paperId <= 0) return
    candApi()
      .retryFindPdf({ paperId: prog.paperId })
      .catch((e: unknown) => notify(ipcErrorMessage(e, '查找失败，请重试')))
  }
  return (
    <div className="gt-cand" data-testid="cand-node">
      <div className="gt-cand-tag">候选 · Agent 发现</div>
      <div className="gt-cand-t">{c.title}</div>
      <div className="gt-cand-m">
        {c.authors.slice(0, 2).join(', ')}
        {c.year != null ? ` · ${c.year}` : ''}
        {inLibrary && <span className="gt-cand-in"> 已在库中</span>}
      </div>
      {displayCandidateReason(c.reason) && <div className="gt-cand-reason">{displayCandidateReason(c.reason)}</div>}
      {importing && (
        <div className="gt-cand-prog" data-testid="cand-progress">
          <span className="gt-pd-spin" />
          {busy && prog == null ? '正在入库' : prog ? CAND_PHASE_LABEL[prog.phase] : ''}
        </div>
      )}
      {failed && (
        <div className="gt-cand-prog gt-card-warn" data-testid="cand-failed">
          {prog?.message ?? '入库失败'}
        </div>
      )}
      {done && (
        <div className="gt-cand-prog" data-testid="cand-done">
          已入库
        </div>
      )}
      {noPdf && (
        <div className="gt-cand-prog" data-testid="cand-nopdf">
          已入库 · 未找到 PDF
        </div>
      )}
      <div className="gt-cand-acts">
        {noPdf ? (
          <button
            type="button"
            className="btn bordered sm"
            data-testid="cand-retry-pdf"
            disabled={prog == null || prog.paperId <= 0}
            title="按当前来源顺序再查一次（D133）"
            onClick={(e) => {
              e.stopPropagation()
              retryFindPdf()
            }}
          >
            再试查找
          </button>
        ) : done ? null : (
          <button
            type="button"
            className="btn bordered sm"
            data-testid="cand-confirm"
            disabled={importing}
            title={
              importing
                ? '入库进行中…'
                : inLibrary
                  ? '用库里的这篇论文加入图谱（确认入库）'
                  : failed
                    ? '重试入库（已入库则再查 PDF，否则重新确认）'
                    : '确认后入库到论文库，并自动查找 PDF'
            }
            onClick={(e) => {
              e.stopPropagation()
              confirm()
            }}
          >
            {inLibrary ? '确认加入' : failed ? '重试入库' : '确认加入'}
          </button>
        )}
        {done ? null : (
          <button
            type="button"
            className="btn bordered sm"
            data-testid="cand-ignore"
            disabled={importing}
            onClick={(e) => {
              e.stopPropagation()
              agentApi()
                .candidateIgnore(c.id)
                .then(() => notify('已忽略'))
                .catch(() => notify('忽略失败，请重试'))
            }}
          >
            忽略
          </button>
        )}
      </div>
    </div>
  )
}

/** 关系面板（原型 06，320px）；导出供 uat3 D153 渲染层单测 */
export function RelationPanel({
  rel,
  paperById,
  saving,
  onToggleType,
  onSaveStatement,
  onSwapDirection,
  onDelete,
  onOpenChat,
  onOpenPaper,
  onClose,
  displayStatement
}: {
  rel: RelationView
  paperById: Map<number, PaperSummary>
  saving: boolean
  onToggleType: (types: RelationType[]) => void
  onSaveStatement: (statement: string) => void
  /** 建议修 3：调换方向（src/dst 互换，provenance 保留，可 ⌘Z） */
  onSwapDirection?: () => void
  onDelete: () => void
  /** M5 lane/chat 批 2：06 关系面板入口（relation 会话） */
  onOpenChat?: () => void
  /** uat3 D153：论文标题点击 → 进入该论文详情页（导航，不属于 D69 证据回原文） */
  onOpenPaper?: (paperId: number) => void
  onClose: () => void
  /**
   * uat4-fix2 M1/D173：陈述的**只读显示版**（P0x 已换成《短标题》）。可编辑说明框
   * **一律用库内原文 rel.statement**（初值/effect/保存比较基准都是原文）；《短标题》
   * 版只渲染在文本框外的只读行，绝不作为保存值。不传则面板不显示该行。
   */
  displayStatement?: string
}): React.JSX.Element {
  const [statement, setStatement] = useState(rel.statement)
  const [confirmDel, setConfirmDel] = useState(false)
  /** 来源字段（D75）：sourceType / model / updatedAt。
   *  必须修6：保存编辑成功后 rel.editedAt 变化（父组件 reload 带回新值）与
   *  gt:graph-changed（外部改图，如候选入库 / 撤销组）都全量重取 provenance，
   *  面板保持打开——「已编辑」标记不再要重开面板才出现。 */
  const [prov, setProv] = useState<RelationDetailView | null>(null)
  useEffect(() => {
    let on = true
    const load = (): void => {
      setProv(null)
      api.relationDetail(rel.id)
        .then((d) => {
          if (on) setProv(d)
        })
        .catch(() => {})
    }
    load()
    const onChanged = (): void => load()
    window.addEventListener('gt:graph-changed', onChanged)
    return () => {
      on = false
      window.removeEventListener('gt:graph-changed', onChanged)
    }
  }, [rel.id, rel.editedAt])
  useEffect(() => {
    // fix2 M1：种子一律用库内原文（展示版只读，不进可编辑框）
    setStatement(rel.statement)
    setConfirmDel(false)
  }, [rel.id, rel.statement])

  const src = paperById.get(rel.srcPaper)
  const dst = paperById.get(dstOf(rel))
  if (!src || !dst) return <></>

  const allTypes = [...rel.llmTypes, ...rel.autoTypes]
  const autoActive = new Set(rel.autoTypes)
  // D166：对比 / 同一作者为对称关系（口径同画布 symmetricOnly），方向无意义，
  // 面板方向行用「A 与 B 对比」式对称文案，不给调换方向按钮
  const symmetricOnly = allTypes.length > 0 && allTypes.every((t) => t === 'compares' || t === 'same_author')

  const toggle = (t: RelationType): void => {
    const next = new Set(rel.llmTypes)
    if (next.has(t)) next.delete(t)
    else next.add(t)
    onToggleType([...next])
  }

  return (
    <div className="panel" data-testid="relation-panel">
      <div className="ph">
        <b>关系</b>
        {onOpenChat && (
          <button className="btn icon" data-testid="rel-chat" title="关于这条关系对话" onClick={onOpenChat}>
            <Ic name="chat" size={14} />
          </button>
        )}
        <button className="btn icon" onClick={onClose} title="关闭">
          <Ic name="close" size={14} />
        </button>
      </div>
      <div className="pb">
        <div className="sect" style={{ gap: 6 }}>
          <div className="pcard">
            {/* uat3 D153：论文标题可点击进详情（导航） */}
            <div
              className={`t${onOpenPaper ? ' lk' : ''}`}
              title={onOpenPaper ? '进入论文详情' : src.title}
              data-testid="rel-src-title"
              onClick={() => onOpenPaper?.(src.id)}
            >
              {src.title}
            </div>
            <div className="m">{paperMeta(src)}</div>
          </div>
          <div className="row t3" style={{ gap: 6, paddingLeft: 12, fontSize: 11.5 }}>
            <Ic name="arrowD" size={14} />
            <span style={{ color: 'var(--text)' }}>{allTypes.length ? relationTypeLabel(allTypes) : '未定类型'}</span>
          </div>
          <div className="pcard">
            <div
              className={`t${onOpenPaper ? ' lk' : ''}`}
              title={onOpenPaper ? '进入论文详情' : dst.title}
              data-testid="rel-dst-title"
              onClick={() => onOpenPaper?.(dst.id)}
            >
              {dst.title}
            </div>
            <div className="m">{paperMeta(dst)}</div>
          </div>
        </div>

        <div className="sect">
          <div className="secth">
            <b>方向</b>
            <span className="tagtxt">必填</span>
          </div>
          <div className="dirl" data-testid="rel-direction">
            {symmetricOnly
              ? `「${src.title}」与「${dst.title}」${allTypes.includes('compares') ? '对比' : '为同一作者'}`
              : `「${dst.title}」基于 / 针对「${src.title}」`}
          </div>
          <div className="row" style={{ gap: 8, marginTop: 6 }}>
            {onSwapDirection && !symmetricOnly && (
              <button className="btn bordered sm" data-testid="rel-swap" disabled={saving} onClick={onSwapDirection}>
                调换方向
              </button>
            )}
            <span className="t3" style={{ fontSize: 11.5, lineHeight: '17px' }}>
              {symmetricOnly
                ? '「对比」「同一作者」为对称关系，方向不影响含义。'
                : '箭头从先出现的论文指向后来的论文：A → B 表示「B 基于 / 针对 A」。'}
            </span>
          </div>
        </div>

        <div className="sect">
          <div className="secth">
            <b>关系类型</b>
            <span className="tagtxt">必填 · 可多选</span>
          </div>
          <div className="tags">
            {MANUAL_RELATION_TYPES.map((t) => (
              <span key={t} className={`tag ${rel.llmTypes.includes(t) ? 'on' : ''}`} onClick={() => toggle(t)}>
                {RELATION_TYPE_LABELS[t]}
              </span>
            ))}
            {(['cites', 'same_author'] as RelationType[]).map((t) =>
              autoActive.has(t) ? (
                <span key={t} className="tag auto on" title="由程序根据引用数据和作者信息自动填写，不能手动改">
                  {RELATION_TYPE_LABELS[t]}
                  <span className="au">自动</span>
                </span>
              ) : null
            )}
          </div>
          <div className="t3" style={{ fontSize: 11.5, lineHeight: '17px' }}>
            「引用」「同一作者」由程序根据引用数据和作者信息自动填写，只读。
          </div>
        </div>

        <div className="sect">
          <div className="secth">
            <b>关系说明</b>
            <span className="tagtxt">选填</span>
          </div>
          {/* fix2 M1/D173：只读显示版（《短标题》）放在文本框外，绝不作为保存值 */}
          {displayStatement != null && displayStatement !== rel.statement && (
            <div className="t2" data-testid="rel-statement-display" style={{ fontSize: 11.5, lineHeight: '17px', padding: '4px 8px', background: 'var(--hover)', borderRadius: 6 }}>
              显示版（内部编号已替换，仅供阅读）：{displayStatement}
            </div>
          )}
          {/* 可编辑框一律用库内原文：初值/effect/保存比较基准都是 rel.statement（D173） */}
          <textarea className="ta" value={statement} onChange={(e) => setStatement(e.target.value)} placeholder="这篇论文如何基于 / 针对另一篇…" />
          <div className="row" style={{ gap: 8 }}>
            <button
              className="btn bordered sm"
              disabled={saving || statement === rel.statement}
              onClick={() => onSaveStatement(statement)}
            >
              保存
            </button>
          </div>
        </div>

        <div className="sect">
          <div className="secth">
            <b>来源</b>
          </div>
          <div className="t3" style={{ fontSize: 11.5, lineHeight: '17px' }}>
            {prov ? (prov.sourceType === 'job' ? `自动生成${prov.model ? ` · ${prov.model}` : ''}` : '手动 / 会话创建') : '…'}
            {/* uat2b D149：编辑 AI 生成的关系后来源仍「自动生成」，另加「已编辑」标记（不改手动） */}
            {prov?.sourceType === 'job' && prov.editedAt && (
              <span className="nptag0" data-testid="rel-edited-tag" style={{ marginLeft: 6 }} title="这条关系被手动编辑过，内容以编辑为准">
                已编辑
              </span>
            )}
            {/* uat2-fix1 建议修 3：类型不再含「基于/改进」时清标志——面板只在类型仍含时显示 */}
            {prov?.noRefBasis && allTypes.includes('based_on') && (
              <span
                className="nptag0"
                data-testid="rel-noref-tag"
                style={{ marginLeft: 6 }}
                title="两篇论文之间没有检测到引用关系；「基于/改进」是 AI 推断，请自行判断"
              >
                AI 推断 · 无引用依据
              </span>
            )}
          </div>
        </div>

        <div className="row" style={{ gap: 4 }}>
          <div className="grow" />
          <button className="btn danger" onClick={() => setConfirmDel(true)}>
            <Ic name="trash" size={14} />
            删除
          </button>
        </div>
      </div>

      <MotionPresence open={confirmDel} kind="modal">
        {confirmDel ? (
        <ConfirmDialog title="删除这条关系？" okText="删除" danger onOk={onDelete} onClose={() => setConfirmDel(false)}>
          删除后可以用连线重新创建，方向不变。
        </ConfirmDialog>
        ) : null}
      </MotionPresence>
    </div>
  )
}
