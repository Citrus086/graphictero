/**
 * lane/relations 车道的 IPC 契约。
 *
 * REL 车道（M3：OpenAlex 引用（W-ID + referenced_works、D71 标题回收）、D40 References
 * 抽取兜底、首建与新论文关系生成、自动 引用/同一作者（D89/D93）、关系详情 UI、
 * 边标签与筛选、⌘Z）新增的通道名、视图类型与 preload API 片段全部定义在本文件；
 * 不改 src/shared/ipc/index.ts，也不改 PDF 车道的文件。
 *
 * 通道名一律用 `rel:` 前缀——核心契约已有 relation:create / relation:delete 两个手工边
 * 通道，车道新增通道不直接挤 `relation:` 前缀，避免与核心契约混淆；进度推送事件沿用
 * `event:` 前缀 + 车道前缀（如 `event:rel:generateProgress`）。
 * RelApi 的方法名若与 PdfApi 撞名，会在 GraphicteroApi 组合处编译报错，改名即可。
 */
import type { RelationType } from '../relationTypes'

export const IPC_REL = {
  /** 排队关系生成（首建整图或逐篇新增），返回 job id */
  generate: 'rel:generate',
  /** 重新生成本图关系（清「已处理」标记后全图重建，D88），返回 job id */
  regenerate: 'rel:regenerate',
  /** 查询某图谱的关系生成状态与进度 */
  status: 'rel:status',
  /** 信号候选（引用 / 文献耦合 / FTS5 关键词 / 名片全量，D40/D102） */
  findRelated: 'rel:findRelated',
  /** 单篇拉取引用数据（OpenAlex + D40 兜底），返回统计 */
  fetchReferences: 'rel:fetchReferences',
  /** 按完整快照恢复关系（⌘Z 撤销删除 / 重做，upsert 语义），返回关系 id */
  restore: 'rel:restore',
  /** M6 前置 2a（D129）：按改动前快照 id 还原（含原 source_type），返回关系 id */
  restoreSnapshot: 'rel:restoreSnapshot',
  /** uat2-fix1 必须修 3：D148 撤销「从图谱移除」恢复原 (graph, paper) 进度行（仅当原来有）
 *  uat7b S1：可传原 doneAt——撤销恢复成移除前的原值，不盖成撤销时刻。 */
  restoreProgress: 'rel:restoreProgress',
  /** uat7b S1：撤销「从图谱移除」恢复成员行的原 added_at 与原进度 doneAt（无进度行不插） */
  restoreRemovedPaper: 'rel:restoreRemovedPaper',
  /** uat7b S1：撤销「从图谱移除」把 graphs.updated_at 写回移除前的原值（一次一批） */
  restoreGraphUpdatedAt: 'rel:restoreGraphUpdatedAt',
  /** uat8b B5：撤销「从图谱移除」一次做完；已从库软删的论文跳过，全跳过则不写库 */
  undoGraphRemoval: 'rel:undoGraphRemoval',
  /** 单条关系详情（含来源 / 模型等 provenance，D75） */
  detail: 'rel:detail',
  /** 关系生成进度推送（event: 前缀约定） */
  eventGenerateProgress: 'event:rel:generateProgress'
} as const

/** 关系生成进度（references 阶段按篇推送，generate 阶段按篇/阶段推送） */
export interface RelGenerateProgress {
  graphId: number
  phase: 'references' | 'generate' | 'done' | 'error'
  /** 当前推进到的论文（阶段级事件不带） */
  paperId?: number
  error?: string
  /** uat1b：done 事件携带本次写入（或合并进已有边）的关系条数；0 = 空跑 */
  addedCount?: number
}

export type RelatedSignal = 'cites' | 'coupling' | 'keywords' | 'cards'

export interface RelatedCandidateView {
  paperId: number
  title: string
  signals: RelatedSignal[]
  /** D102：文献耦合的共享参考文献数（无耦合为 0） */
  couplingCount: number
}

export interface RelStatusView {
  /** 本图是否有活动中的关系生成任务 */
  running: boolean
  activeJob: { id: number; status: string; currentStep: string | null; error: string | null } | null
  /** 已按论文记「已处理」（D86）的数量 / 图谱参与论文总数 */
  processedCount: number
  totalCount: number
}

export type RefsSource = 'openalex' | 'deepseek' | 'none'

export interface RefsFetchView {
  workFound: boolean
  refCount: number
  matchedCount: number
  /** 兜底路径是否实际抽取过（References 段存在且调用了 LLM） */
  fellBackToLlm: boolean
  /** 评审建议修（rel3）2：LLM 抽取输出被截断（只捞回部分条目），提示「没抽完」 */
  refsTruncated: boolean
}

/** ⌘Z 撤销 / 重做用的关系快照（恢复走 upsert，无序对幂等） */
export interface RelationRestoreInput {
  graphId: number
  /** 方向：src → dst 表示「dst 基于 / 针对 src」（D75） */
  srcPaperId: number
  dstPaperId: number
  statement: string
  llmTypes: RelationType[]
  /** 程序自动附加类型（D89）：撤销「删除」时带上；编辑撤销不传，保留库中现值 */
  autoTypes?: RelationType[]
  /** M6 前置 2a：按快照还原时恢复原始 provenance（缺省仍记 session，D88 手动恢复口径） */
  sourceType?: 'job' | 'session'
  sourceJobId?: number | null
  model?: string | null
  promptVersion?: string | null
  /** uat2b c)：原行 id——撤销「删除」时原地复活该行（不新建，id 不变） */
  id?: number
  /** uat2-fix1 建议修 4：会话边复活时保留 source_session_id */
  sourceSessionId?: number | null
  /** uat2b D149/D150：完整行快照一并恢复已编辑 / 无引用依据标记 */
  editedAt?: string | null
  noRefBasis?: boolean
  /** uat4 建议修11（D148/D164 原样恢复）：快照带的原 relations.updated_at——
   * 撤销「删除 / 编辑」时写回原时间戳，不盖成撤销时刻；缺省（老快照）仍记当前时刻 */
  updatedAt?: string | null
}

/** 关系详情（关系面板来源字段，D75）：RelationView 在共享契约（冻结）里，
 * provenance 字段走本车道自己的视图类型补充 */
export interface RelationDetailView {
  id: number
  graphId: number
  paperLow: number
  paperHigh: number
  srcPaper: number
  statement: string
  llmTypes: RelationType[]
  autoTypes: RelationType[]
  /** 来源：job = 自动生成（首建/新论文/重新生成），session = 手动或会话 */
  sourceType: 'job' | 'session'
  sourceJobId: number | null
  model: string | null
  promptVersion: string | null
  /** uat2b D149：手动编辑过（来源仍显示「自动生成 · 模型」+「已编辑」） */
  editedAt: string | null
  /** uat2b D150：基于/改进 无引用依据（AI 推断 · 无引用依据） */
  noRefBasis: boolean
  createdAt: string
  updatedAt: string
}

/** uat8b B5：撤销「从图谱移除」的一篇快照（坐标与原时间戳，D164②） */
export interface UndoGraphRemovalPaper {
  paperId: number
  x: number
  y: number
  addedAt: string
  doneAt: string | null
}

export interface UndoGraphRemovalInput {
  graphId: number
  /** 这一批移除前的 graphs.updated_at；全跳过时不写回 */
  graphUpdatedAt: string
  papers: UndoGraphRemovalPaper[]
  relations: RelationRestoreInput[]
}

export interface UndoGraphRemovalResult {
  restored: number
  skipped: number
  /** false = 一篇都没恢复，库无写入（含 graphs.updated_at） */
  applied: boolean
  restoredIds: number[]
}

/** REL 车道暴露给渲染进程的 API 片段；GraphicteroApi 由 src/shared/ipc/index.ts 组合 */
export interface RelApi {
  /** 排队关系生成；paperIds 省略 = 全图（首建/补齐）。返回 job id。 */
  generateRelations(graphId: number, paperIds?: number[]): Promise<number>
  /** 重新生成本图关系（D88：二次确认后调用，不进 ⌘Z） */
  regenerateRelations(graphId: number): Promise<number>
  relationsStatus(graphId: number): Promise<RelStatusView>
  findRelated(graphId: number, paperId: number): Promise<RelatedCandidateView[]>
  fetchReferences(paperId: number): Promise<RefsFetchView>
  /** ⌘Z：按快照恢复关系（撤销删除 / 重做创建），返回关系 id */
  restoreRelation(input: RelationRestoreInput): Promise<number>
  /** M6 前置 2a（D129）：按 relation_snapshots.id 还原（含原 source_type），返回关系 id */
  restoreRelationSnapshot(snapshotId: number): Promise<number>
  /** uat2-fix1 必须修 3：恢复 (graph, paper) 的 relation_gen_progress 行（D148 撤销移除） */
  restorePaperProgress(graphId: number, paperId: number, doneAt?: string): Promise<void>
  /** uat7b S1：撤销「从图谱移除」恢复成员原 added_at + 原进度 doneAt（无进度行不插） */
  restoreRemovedPaper(graphId: number, paperId: number, meta: { addedAt: string; doneAt: string | null }): Promise<void>
  /** uat7b S1：撤销后把 graphs.updated_at 写回移除前原值（一批一次） */
  restoreGraphUpdatedAt(graphId: number, updatedAt: string): Promise<void>
  /** uat8b B5：一次撤销「从图谱移除」。已软删的论文不恢复；全跳过时 applied=false 且不写库。 */
  undoGraphRemoval(input: UndoGraphRemovalInput): Promise<UndoGraphRemovalResult>
  /** 关系详情（含来源 / 模型，D75） */
  relationDetail(relationId: number): Promise<RelationDetailView>
  /** 订阅进度推送；返回取消订阅函数 */
  onGenerateProgress(cb: (p: RelGenerateProgress) => void): () => void
}
