/**
 * lane/pdf 车道的 IPC 契约。
 *
 * 通道名一律用 `pdf:` 前缀（核心契约已占用 graphs:/graph:/library:/relation:/data:/
 * zotero:/settings:/jobs: 与 event: 前缀；REL 车道用 `rel:`）；进度推送事件沿用
 * `event:` 前缀 + 车道前缀（`event:pdf:parseProgress` / `event:pdf:sidecar`）。
 * PdfApi 的方法名若与 RelApi 撞名，会在 GraphicteroApi 组合处编译报错，改名即可。
 */

export const IPC_PDF = {
  /** MinerU sidecar 状态查询 */
  sidecarStatus: 'pdf:sidecarStatus',
  /** 启动 sidecar（未安装则先安装，D57 首启安装） */
  sidecarStart: 'pdf:sidecarStart',
  /** uat1/uat1-fix1：安装并重试到可用——内部走 sidecar.start()（未安装先 install，
   *  再拉服务到 ready）。首启界面「重试」与状态点弹层 install_failed「重试」走这里；
   *  成功后经 ready 事件触发 D95 补排（设置页「重试安装/重新安装」同样到 ready）。 */
  sidecarInstall: 'pdf:sidecarInstall',
  /** 停止 sidecar */
  sidecarStop: 'pdf:sidecarStop',
  /** 重新安装 sidecar（删 venv + 重装 + 重下模型，D57 设置页「重新安装」） */
  sidecarReinstall: 'pdf:sidecarReinstall',
  /** 论文处理状态（失败标记数据通路：图谱节点 / 库列表读失败状态与原因） */
  papersStatus: 'pdf:papersStatus',
  /** 阅读器：取论文 PDF 字节（EmbedPDF 打开用） */
  getDocument: 'pdf:getDocument',
  /** 阅读器：列一篇论文的标注（高亮/笔记，D27） */
  listAnnotations: 'pdf:listAnnotations',
  /** 阅读器：新建标注 */
  createAnnotation: 'pdf:createAnnotation',
  /** 阅读器：更新标注（笔记内容 / 颜色） */
  updateAnnotation: 'pdf:updateAnnotation',
  /** 阅读器：删除标注 */
  deleteAnnotation: 'pdf:deleteAnnotation',
  /** 阅读器：图块列表（D27 按 bbox 跳图；无 structured_content 缓存返回空） */
  listFigures: 'pdf:listFigures',
  /** uat8a D189：多面板图卡按并集从 PDF 裁图。单面板 / 失败返回 mineru，不抛到 UI */
  figureCrop: 'pdf:figureCrop',
  /** 设置页「最近一次解析」（只读；从未结束为 null） */
  lastParse: 'pdf:lastParse',
  /** uat8c：App MinerU home 模型目录大小（异步、只读，不碰 ~/.mineru） */
  modelSize: 'pdf:modelSize',
  /** uat1b D144：等待解析组件的论文数（有 PDF、未处理且未入队；顶栏弹层「影响 N 篇」的 N） */
  waitingCount: 'pdf:waitingCount',
  /** sidecar 状态/安装进度推送（D82 简单进度条数据源） */
  eventSidecar: 'event:pdf:sidecar',
  /** 解析进度推送（event:pdf:parseProgress） */
  eventParseProgress: 'event:pdf:parseProgress',
  /** uat2：Zotero 重新导入（D75）补齐 PDF 后推送——渲染层即时刷新「无 PDF」标记 */
  eventLibraryChanged: 'event:pdf:libraryChanged'
} as const

/** MinerU sidecar 状态机（D73 健康监测 + D57 安装） */
export type MineruSidecarState =
  | 'unavailable' // 本进程未管理 sidecar（UI 冒烟 / 测试模式的占位解析器）
  | 'not_installed' // 未安装（venv/模型不在；从未装过或重装前）
  | 'installing' // uv sync 依赖 + 模型下载中（D82 简单进度条）
  /** uat1：安装失败持久态（依赖或模型下载失败）。与 not_installed 区分——失败原因
   *  要一直可见、可重试，不能退化成单纯「未安装」。error 为开发者原文（退出码/stderr
   *  末行），用户文案由渲染层按 error 归类生成。 */
  | 'install_failed'
  | 'stopped' // 已安装未运行
  | 'starting' // 进程已拉起，等 /v1/health 就绪（受总超时约束，D73）
  | 'ready' // 健康检查通过，可解析
  | 'restarting' // 崩溃后自动重启中（D73：自动重启一次）
  | 'crashed' // 重启一次后仍失败 / 启动总超时

export interface MineruStatusView {
  state: MineruSidecarState
  /** /v1/health 报告的 MinerU 版本 */
  version: string | null
  /** 随机端口（D73） */
  port: number | null
  /** sidecar 子进程 pid（pidfile 内容） */
  pid: number | null
  /** 进入 crashed / restarting 的原因（给用户看，03d 失败原因数据通路） */
  error: string | null
  /** 安装阶段简单进度（D82 + D145 reuse）：依赖安装 / 模型下载 / 复用已下载模型 + 最后一行输出 */
  installProgress: { phase: 'deps' | 'models' | 'reuse'; detail: string } | null
  /** 解析环境（D137，只读）：venv 位置。模型本体在数据目录 sidecar/mineru-home/models（D145），不在这一行 */
  modelsPath: string | null
  /** 模型是否已就绪 = 安装标记在（依赖 + 模型下载都成功才写标记，D57） */
  modelsReady: boolean
}

/** 最近一次解析结束（设置页「最近一次解析」，只读；成功或失败都算） */
export interface LastParseView {
  /** 结束时间（ISO） */
  at: string
  /** 解析耗时（秒；缺起止时间为 null） */
  durationSec: number | null
  /** uat8c：succeeded 为 true，failed 为 false */
  ok: boolean
}

/** App MinerU 模型目录体积（只读；未下载 bytes=null） */
export interface ModelDirSizeView {
  bytes: number | null
  label: string
}

/** 解析进度事件（event:pdf:parseProgress 的负载；主进程解析步骤推送） */
export type ParseStage = 'upload' | 'parse' | 'download'

export interface ParseProgressView {
  stage: ParseStage
  /** 服务端文件级进度（D72：API 只有文件级，无页级） */
  completedFiles: number
  totalFiles: number
  /** 从 sidecar 输出 best-effort 解析出的页码进度；拿不到为 null（回退阶段+已用时长估算） */
  pagesDone: number | null
  pagesTotal: number | null
  /** 已用秒数 */
  elapsedSec: number
}

export interface ParseProgressEvent extends ParseProgressView {
  paperId: number
}

/** uat2：重新导入补 PDF 完成事件（event:pdf:libraryChanged 负载） */
export interface LibraryChangedEvent {
  /** 本次补齐了 PDF 的论文 id（has_pdf 0→1） */
  pdfAddedIds: number[]
}

/**
 * 论文处理状态视图（失败标记数据通路，D48/D85；03d 界面数据源）：
 * 由最新 process_paper 任务派生——未处理（D95，从未入队）/ 排队 / 运行中 /
 * 等待（联网、Key）/ 成功 / 失败（含失败步骤与原因）。
 */
export type PaperProcessState = 'unprocessed' | 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed'

export interface PaperProcessStatusView {
  paperId: number
  /** 最新一条 process_paper 任务 id（未入队为 null；03d 手动重试用） */
  jobId: number | null
  state: PaperProcessState
  /** 当前进行到的步骤（parse/card/detail；排队/未处理为 null） */
  currentStep: string | null
  /** 失败步骤（parse/card/detail），未失败为 null */
  failedStep: string | null
  /** 失败原因（给用户看），无 null */
  error: string | null
  /** 最近一次状态变化时间（ISO） */
  updatedAt: string | null
  /** 最新一条 detail_regen（手动重新生成，D42/D108）的进行态：排队/运行/等待中，
   *  无任务或已终结为 null。与 state 相互独立——regen 期间 process 状态保持
   *  succeeded，两个状态并存互不覆盖（M5 前置 2a） */
  detailRegen: 'queued' | 'running' | 'waiting_network' | 'waiting_key' | null
}

/** 高亮颜色（阅读器固定四色，原型高亮工具口径） */
export type AnnotationColor = 'yellow' | 'green' | 'blue' | 'pink'

export const ANNOTATION_COLORS: AnnotationColor[] = ['yellow', 'green', 'blue', 'pink']

/** 标注视图（D27；高亮选中文字 + 挂在高亮上的笔记） */
export interface AnnotationView {
  id: number
  paperId: number
  /** 页码（0 基；UI 显示 p.N = page + 1） */
  page: number
  type: 'highlight' | 'note'
  /** 高亮选中的文字 */
  text: string
  /** 笔记内容（无笔记为 null） */
  note: string | null
  color: AnnotationColor
  /** 并集矩形 [x,y,w,h]，PDF 页面坐标（PDF 点，1/72 英寸，左上原点；Q6 裁定口径），无坐标为 null */
  bbox: [number, number, number, number] | null
  /** 行级矩形 [[x,y,w,h],...]（同坐标系，高亮按行渲染用） */
  quads: [number, number, number, number][]
  createdAt: string
  updatedAt: string
}

/** 新建标注入参（renderer 经 IPC 传入；主进程校验） */
export interface AnnotationInput {
  page: number
  type: 'highlight' | 'note'
  text: string
  color: AnnotationColor
  bbox: [number, number, number, number] | null
  quads: [number, number, number, number][]
  note?: string | null
}

/** MinerU structured_content 图块坐标：0–1 归一化矩形 [x0,y0,x1,y1]（左上原点）。
 *  用时按页宽/高（EmbedPDF 文档页尺寸，PDF 点）换算成 PDF 页面坐标矩形
 *  [x,y,w,h]（左上原点；Q6 裁定口径，与标注同一坐标系，不另存一套）。 */
export function mineruNormRectToPageRect(
  bbox: [number, number, number, number],
  pageW: number,
  pageH: number
): [number, number, number, number] {
  return [bbox[0] * pageW, bbox[1] * pageH, (bbox[2] - bbox[0]) * pageW, (bbox[3] - bbox[1]) * pageH]
}

/** uat8a D189：详情图卡图片来源。失败与单面板都是 mineru，relPath 为 null。 */
export interface FigureCropView {
  mode: 'mineru' | 'crop'
  relPath: string | null
}

/** 图块视图（D27「按 bbox 跳到图」；由 papers/<id>/mineru/structured_content.json 解析） */
export interface FigureView {
  /** 页码（0 基；UI 显示 p.N = page + 1） */
  page: number
  /** 归一化矩形 [x0,y0,x1,y1]（0–1，左上原点；渲染时用 mineruNormRectToPageRect 换算） */
  bbox: [number, number, number, number]
  /** 图注文字（无 null） */
  caption: string | null
  /** 解析缓存内图片相对路径（images/...；无 null） */
  imageSource: string | null
  /** uat2：论文自身图号（图注解析；无图注/附录图为 null）——data-figure 按它寻址 */
  figureNo: number | null
  /**
   * uat4 建议修 8（多子图合并显示）：兄弟子图块的归一化 bbox 列表（同页、页内块序
   * 紧邻、自身无图注的 image/chart 子块并入带编号图）。阅读器「跳到图」对 bbox 与
   * 全部 subBboxes 取并集高亮；无兄弟子块时该字段不存在。
   */
  subBboxes?: [number, number, number, number][]
  /** uat9：属于本图的纯子图标题 bbox。主图注与正文段落一律不进来。 */
  subCaptionBboxes?: [number, number, number, number][]
}

/** 多子图定位 / D189 裁图 = 图块、兄弟子块与纯子图标题的归一化并集（不含主图注）。 */
export function figureNormUnion(
  f: Pick<FigureView, 'bbox' | 'subBboxes' | 'subCaptionBboxes'>
): [number, number, number, number] {
  const boxes = [f.bbox, ...(f.subBboxes ?? []), ...(f.subCaptionBboxes ?? [])]
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3]))
  ]
}

/** 图号 → 图块：按论文自身图号精确匹配（uat2：取代旧的下标映射，详情里引用的
 *  「图 3」一定对应图注写着 Figure 3 的那张图，绝不显示错图；无图注的图块
 *  figureNo=null 不参与寻址）。同一图号多块（Figure 2(a)(b) 拆分）取文档顺序第一块。
 *  uat4 必须修 5：同块多条图注拆分后归属不明的图号不进任何块，这里自然不命中，
 *  渲染层保持既有「图 N 未找到」占位。放 shared：渲染层（FigureBlock/PdfReader）
 *  与主进程（getFigure 工具）共用。 */
export function resolveFigureByNo<T extends { figureNo: number | null }>(figs: T[], figureNo: number): T | null {
  if (!Number.isInteger(figureNo) || figureNo < 1) return null
  return figs.find((f) => f.figureNo === figureNo) ?? null
}

/** PDF 车道暴露给渲染进程的 API 片段；GraphicteroApi 由 src/shared/ipc/index.ts 组合 */
export interface PdfApi {
  getMineruStatus(): Promise<MineruStatusView>
  startMineru(): Promise<MineruStatusView>
  /** uat1-fix1：安装/重试安装并起服务到 ready（内部 start()；首启/弹层重试入口） */
  installMineru(): Promise<MineruStatusView>
  stopMineru(): Promise<MineruStatusView>
  reinstallMineru(): Promise<MineruStatusView>
  getPapersStatus(paperIds: number[]): Promise<PaperProcessStatusView[]>
  /** 阅读器：取论文 PDF 字节（Uint8Array；无 PDF 抛错） */
  getPdfDocument(paperId: number): Promise<Uint8Array>
  /** 阅读器：列标注（D27） */
  listAnnotations(paperId: number): Promise<AnnotationView[]>
  createAnnotation(paperId: number, input: AnnotationInput): Promise<AnnotationView>
  /** 更新笔记内容 / 颜色（部分更新，未传字段不动） */
  updateAnnotation(id: number, patch: { note?: string | null; color?: AnnotationColor }): Promise<AnnotationView>
  deleteAnnotation(id: number): Promise<void>
  /** 阅读器：图块列表（D27） */
  listFigures(paperId: number): Promise<FigureView[]>
  /**
   * uat8a D189：多面板图卡的并集裁图。mode=crop 时 relPath 在数据目录内
   * （cache/figure-crops/...png）；否则渲染层继续用 MinerU 子面板裁图。
   */
  getFigureCrop(paperId: number, figureNo: number): Promise<FigureCropView>
  /** 设置页：最近一次解析结束时间、耗时与成败（只读） */
  getLastParse(): Promise<LastParseView | null>
  /** uat8c：模型目录大小。未下载 label 为「未下载」 */
  getModelDirSize(): Promise<ModelDirSizeView>
  /** uat1b D144：等待解析组件的论文数（只读；sidecar 不可用时顶栏弹层汇总行的 N） */
  getWaitingCount(): Promise<number>
  /** 订阅 sidecar 状态/安装进度推送，返回取消订阅函数 */
  onMineruStatus(cb: (s: MineruStatusView) => void): () => void
  /** 订阅解析进度推送，返回取消订阅函数 */
  onParseProgress(cb: (p: ParseProgressEvent) => void): () => void
  /** uat2：订阅「重新导入补齐 PDF」事件（返回取消订阅函数） */
  onLibraryChanged(cb: (e: LibraryChangedEvent) => void): () => void
}
