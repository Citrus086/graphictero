import { spawn as nodeSpawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { MineruStatusView } from '../../shared/ipc/pdf'
import { SidecarLogFile } from './sidecarLogFile'
import {
  assertNotRealMineruInTest,
  hasReusableModels,
  hasTierModels,
  modelsDirOf,
  plainCopyDiskWarning,
  quarantineIncompleteModels,
  reuseModels,
  type CloneExec
} from './modelReuse'
import { groupAlive, terminateGroupsSync } from './processGroup'
import { augmentPath, findUv, uvFallbackDirs } from './uvPath'
import { UV_NOT_FOUND_MESSAGE } from '../../shared/uvHint'

/**
 * MinerU sidecar 管理（D57 安装/重装、D73 健康监测、D21 本机 sidecar）。
 *
 * - 安装：`uv sync --project <sidecarDir>` 装依赖 + `uv run mineru-models-download`
 *   下载模型（几 GB），venv 放 <stateDir>/venv（打包后 .app 内只读，不能建在源码
 *   目录；D57「在 App 数据目录装」）。装完写 install-marker.json。
 * - 启动：自 fork `uv run mineru-api --host 127.0.0.1 --port <随机> --concurrency 1
 *   --upload-dir <stateDir>/uploads`（4.0.12 的 `mineru server start` 无 host/port
 *   参数且自带守护，不满足 D73 随机端口/pidfile，故用 mineru-api 前台进程自己管）。
 * - D145/D190：App 的 MinerU home 在数据目录内（<stateDir>/mineru-home），安装
 *   （mineru-models-download）与服务（mineru-api）两处 spawn 都设同一个
 *   MINERU_HOME（mineru 4.0.12 config.py `_mineru_home()` 读 MINERU_HOME，未设回退
 *   ~/.mineru；models.base_dir = <MINERU_HOME>/models）。配置优先级（config.py
 *   `_resolve_config_file`）：MINERU_CONFIG 若设置则必须指向已存在文件，否则
 *   FileNotFoundError；未设置时路径是 <MINERU_HOME>/config.yaml，文件不存在则全默认
 *   （`update_config_file` 也写这个路径）。因此子进程环境**删除继承的 MINERU_CONFIG**
 *   （父 shell 可能导出 ~/.mineru/config.yaml），不另写配置文件，从而不读/不写
 *   ~/.mineru。首次需要模型时若全局 ~/.mineru/models 已有本档模型则复制（macOS
 *   `cp -c` 退出码 0 才算克隆，否则普通复制并写明约占多少额外磁盘，modelReuse.ts）
 *   而非移动，绝不删除/改动 ~/.mineru。
 * - D73/D99：pidfile 启动时清孤儿；运行时每 5 秒轮询 /v1/health；监听子进程 exit；
 *   启动有总超时；崩溃（exit 或健康检查连续失败）自动重启一次（D99：每次崩溃
 *   一次——重启成功 /v1/health 通过后计数清零，下次崩溃可再自动重启一次；重启
 *   本身失败或重启后未健康就再崩 → 不再自动重启，进入 crashed）。
 * - 页级进度（D72 best-effort）：捕获子进程 stdout/stderr，正则解析 MinerU 的
 *   window 行（`window a/b: pages x-y/total`），供解析进度事件取用；解析不到则
 *   由调用方回退「阶段 + 已用时长」估算。
 *
 * 全部外部交互（spawn/fetch/端口/时钟）可注入，单测用假实现，不真起 uv。
 */

/**
 * MinerU 档位常量（uat1）：下载（mineru-models-download --tier）与服务
 * （mineru-api --tier）必须同档，保证「下载的模型」=「服务用的档」。
 * 依据 mineru 4.0.12 源码（sidecar/mineru/uv.lock 锁定 4.0.12）：
 * - mineru-api 的 --tier 默认 _DEFAULT_API_SERVER_TIER = "standard"
 *   （mineru/parser/api_server.py:83、2891 行起；服务端档位 flash/basic/standard，
 *   standard 覆盖 flash/basic/standard/advanced 四种质量档）；
 * - mineru-models-download 的 repo 与 --tier 二选一必给其一，否则报错退出
 *   （mineru/kit/commands/models.py `_select_target_repos`：都不给报
 *   「请传入模型仓库名或 --tier」——uat1 之前安装失败即此原因）；
 * - standard 档在本机（Apple Silicon，后端 auto → torch、VLM auto → llama-cpp）
 *   解析为 MinerU-4_models_torch + MinerU2.5-Pro-2605-1.2B-GGUF，与 M0 探针
 *   「Hybrid processing window」日志（Hybrid：小模型 + 本地 VLM）一致。
 * --small-backend / --vlm-engine / --source 保持 auto 默认不写死，让 mineru 按机器解析。
 */
export const MINERU_TIER = 'standard' as const

/**
 * pidfile 的 startedAt 与 `ps -o lstart=` 的容差。
 * lstart 只有 1 秒分辨率，pidfile 在 spawn 之后才写；15 秒够覆盖这个差，
 * 又挡得住几分钟后被复用的 pid。
 */
export const ORPHAN_START_TOLERANCE_MS = 15_000

/**
 * 本 App 的服务进程：`uv run … mineru-api`。
 * 路径里的 uv、或任意出现 mineru/uv 子串，都不算。
 */
export function commandIsOurMineruApi(command: string): boolean {
  return /(?:^|[/\s])uv(?:\s|$)[\s\S]*\brun\b[\s\S]*\bmineru-api\b/.test(command)
}

/** `ps -o lstart=`（LC_ALL=C）→ epoch ms。解析不了就返回 null（调用方不杀）。 */
export function parsePsLstart(raw: string): number | null {
  const text = raw.trim()
  if (!text) return null
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? ms : null
}

/** recordedIso 与进程 lstart 的绝对差在容差内才算同一次启动。 */
export function startedAtMatches(recordedIso: string, lstartMs: number, toleranceMs = ORPHAN_START_TOLERANCE_MS): boolean {
  const recorded = Date.parse(recordedIso)
  if (!Number.isFinite(recorded) || !Number.isFinite(lstartMs)) return false
  return Math.abs(recorded - lstartMs) <= toleranceMs
}

function readProcessLstart(pid: number): number | null {
  const out = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' }
  })
  if (out.status !== 0) return null
  return parsePsLstart(String(out.stdout ?? ''))
}

export interface MineruSidecarOptions {
  /** sidecar/mineru 源码目录（uv.lock / pyproject.toml 所在；打包产物里在 resources） */
  sidecarDir: string
  /** 可写状态目录（<数据目录>/sidecar）：venv / pidfile / uploads / 安装标记 */
  stateDir: string
  /** 显式指定 uv 路径（不再自动查找） */
  uvBin?: string
  /** 测试注入：查找 uv（默认 findUv：现有 PATH → Homebrew / ~/.local/bin / ~/.cargo/bin） */
  findUvBin?: () => string | null
  fetchImpl?: typeof fetch
  spawnFn?: SpawnLike
  randomPort?: () => number
  now?: () => number
  /** 运行时健康轮询间隔（D73：5 秒） */
  healthPollMs?: number
  /** 启动后就绪轮询间隔 */
  readyPollMs?: number
  /** 启动总超时（D73 总超时），默认 3 分钟（首次含模型加载） */
  startTimeoutMs?: number
  /** 健康检查连续失败次数上限（默认 3 次 ≈ 15 秒无响应判崩溃） */
  healthFailLimit?: number
  /** D73/D99：每个崩溃回合自动重启一次（重启成功后计数清零，见类注释） */
  maxRestarts?: number
  /** 单次健康检查 fetch 超时（默认 3 秒；超时计入失败次数） */
  healthFetchTimeoutMs?: number
  /** sidecar 状态目录下的 MinerU home（D145：<stateDir>/mineru-home） */
  mineruHomeDir?: string
  /** 全局 MinerU home（D145 复用源；默认 ~/.mineru，测试必须注入临时目录） */
  globalMineruHome?: string
  /** D145/D190 复用进度回调（设置页/日志提示「正在复用已下载的模型」等） */
  onReuseProgress?: (msg: string) => void
  /** 测试注入：`cp -c` 退出码。不传时 darwin 用真实 cp，其它平台直接普通复制。 */
  cloneExec?: CloneExec
  /** 测试注入：pidfile 孤儿身份校验的命令行读取（默认 ps） */
  processInfo?: (pid: number) => string
  /** 测试注入：进程启动时间（ms，对照 pidfile startedAt）。默认 `ps -o lstart=`。 */
  processStartedAt?: (pid: number) => number | null
  /** SIGTERM 之后的 SIGKILL 宽限（默认 3 秒；测试可缩短） */
  sigkillGraceMs?: number
  log?: (msg: string) => void
  /** 状态/安装进度推送（IPC 层广播 event:pdf:sidecar） */
  onEvent?: (v: MineruStatusView) => void
}

/** 结构化的 spawn 签名：Node ChildProcess 兼容，测试可用 EventEmitter 假实现 */
export type SpawnLike = (
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; detached?: boolean }
) => ChildProcess

/** window 行：`Hybrid processing window 1/1: pages 1-2/2 (2 pages)` */
const WINDOW_RE = /window\s+\d+\/(\d+):\s*pages\s+\d+-(\d+)\/(\d+)/
/** 汇总行：`page_count=2, window_size=64, total_windows=1` */
const PAGE_COUNT_RE = /page_count=(\d+)/

export interface PageProgress {
  pagesDone: number | null
  pagesTotal: number | null
}

export class MineruSidecar {
  private view: MineruStatusView
  private child: ChildProcess | null = null
  private healthTimer: ReturnType<typeof setInterval> | null = null
  private stopRequested = false
  private restarts = 0
  private healthFails = 0
  private healthFailLimit: number
  private healthFetchTimeoutMs: number
  /** 启动中 spawnAndWaitReady 的 pending promise（被 stop/崩溃接管时显式 settle，防悬挂） */
  private starterReject: ((err: Error) => void) | null = null
  /** 安装期 uv 子进程：stop() 时一并终止（GB 级下载不能继续跑） */
  private installChild: ChildProcess | null = null
  /** stop() 之后、进程实际退出之前还要能杀掉的 pid → SIGKILL 定时器 */
  private lingering = new Map<number, ReturnType<typeof setTimeout>>()
  private installBuf = ''
  private lastInstallEmit = 0
  private maxRestarts: number
  private startTimeoutMs: number
  private page: PageProgress = { pagesDone: null, pagesTotal: null }
  /** uat13（D207-②）：sidecar stdout/stderr 落盘日志（<数据目录>/logs/mineru-sidecar.log，滚动截断） */
  private sidecarLog: SidecarLogFile | null = null
  private installPhase: 'deps' | 'models' | 'reuse' | null = null
  private installDetail = ''

  constructor(private opts: MineruSidecarOptions) {
    this.healthFailLimit = opts.healthFailLimit ?? 3
    this.healthFetchTimeoutMs = opts.healthFetchTimeoutMs ?? 3000
    this.maxRestarts = opts.maxRestarts ?? 1
    this.startTimeoutMs = opts.startTimeoutMs ?? 180_000
    this.view = {
      state: this.installed() ? 'stopped' : 'not_installed',
      version: null,
      port: null,
      pid: null,
      error: null,
      installProgress: null,
      modelsPath: null,
      modelsReady: false
    }
  }

  // ── 路径与查询 ────────────────────────────────────────────────

  private get venvDir(): string {
    return join(this.opts.stateDir, 'venv')
  }

  private get pidfile(): string {
    return join(this.opts.stateDir, 'mineru.pid')
  }

  /** D145：App 的 MinerU home（模型进数据目录，随数据根走） */
  get mineruHome(): string {
    return this.opts.mineruHomeDir ?? join(this.opts.stateDir, 'mineru-home')
  }

  private get modelsDir(): string {
    return modelsDirOf(this.mineruHome)
  }

  /** D145 复用源：全局 MinerU home（默认 ~/.mineru；测试注入临时目录，绝不写） */
  private get globalModelsDir(): string {
    return join(this.opts.globalMineruHome ?? join(homedir(), '.mineru'), 'models')
  }

  /** uat13（D207-②）：sidecar 输出日志路径：<stateDir 的父目录>/logs/mineru-sidecar.log */
  private get sidecarLogPath(): string {
    return join(dirname(this.opts.stateDir), 'logs', 'mineru-sidecar.log')
  }

  private get markerPath(): string {
    return join(this.opts.stateDir, 'install-marker.json')
  }

  /** 已安装 = 安装标记在（venv + 模型下载都成功才写标记） */
  installed(): boolean {
    return existsSync(this.markerPath)
  }

  status(): MineruStatusView {
    // 模型文件两行（原型 05d，只读）：venv 位置 + 安装标记（依赖 + 模型都成才写）
    return { ...this.view, modelsPath: this.venvDir, modelsReady: this.installed() }
  }

  isReady(): boolean {
    return this.view.state === 'ready'
  }

  baseUrl(): string | null {
    return this.view.port != null ? `http://127.0.0.1:${this.view.port}` : null
  }

  /** 解析页码进度（best-effort，D72）；拿不到返回 null 字段 */
  pageProgress(): PageProgress {
    return { ...this.page }
  }

  // ── 安装（D57 首启安装 / D82 简单进度条） ─────────────────────

  async install(): Promise<void> {
    // uat1：install_failed 态允许直接重试（首启界面「重试」/设置页「重试安装」）
    if (this.view.state === 'installing' || this.view.state === 'ready' || this.view.state === 'starting') return
    mkdirSync(this.opts.stateDir, { recursive: true })
    this.setState('installing')
    try {
      this.installPhase = 'deps'
      this.installDetail = ''
      await this.runUv(['sync', '--project', this.opts.sidecarDir])
      this.installPhase = 'models'
      this.installDetail = ''
      this.emit()
      // 模型几 GB，首次下载较久；mineru-models-download 是 4.0.12 的预下载入口。
      // uat1：必须带 --tier（4.0.12 起 repo/--tier 二选一必给其一，缺了直接报错退出），
      // 与服务端 mineru-api --tier 共用 MINERU_TIER，保证下载档 = 服务档。
      // D145：先尝试复用全局已下载模型（克隆/复制），没有才下载到 App 目录。
      await this.ensureModels('install')
      writeFileSync(this.markerPath, JSON.stringify({ installedAt: new Date().toISOString() }), 'utf8')
      this.installPhase = null
      this.setState('stopped', { error: null, installProgress: null })
    } catch (e) {
      // uat1：进入 install_failed 持久态（不再退化成 not_installed），error 带阶段前缀
      // （安装依赖/复用模型文件/下载模型文件），渲染层据此归类出通俗文案；原始退出码/stderr 保留在详情里
      const phase = this.installPhase
      const raw = e instanceof Error ? e.message : String(e)
      this.installPhase = null
      const phaseLabel = phase === 'models' ? '下载模型文件' : phase === 'reuse' ? '复用模型文件' : '安装依赖'
      this.setState('install_failed', {
        error: `MinerU 安装失败（${phaseLabel}）：${raw}`,
        installProgress: null
      })
      throw e
    }
  }

  /** D57 设置页「重新安装」：删 venv + 标记后重装。
   *  uat1-fix1：装完直接走 start() 起服务到 ready——与「重试安装」同终态，
   *  成功即经 ready 事件触发 D95 补排，不再停在 stopped（stopped 是 D144 不可用态）。 */
  async reinstall(): Promise<void> {
    if (this.view.state === 'installing') throw new Error('MinerU 正在安装中，无法重新安装')
    await this.stop()
    rmSync(this.venvDir, { recursive: true, force: true })
    rmSync(this.markerPath, { force: true })
    this.setState('not_installed', { version: null, error: null })
    await this.start()
  }

  /**
   * 跑一条 uv 命令（装依赖 / 下模型），流式把最后一行输出记进安装进度
   * （D82 简单进度条的数据源）；非零退出抛错。UV_PROJECT_ENVIRONMENT 让 venv
   * 落在状态目录（.app 内只读，venv 不能建在源码目录）。
   */
  private runUv(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const uv = this.resolveUv()
      if (uv == null) {
        reject(new Error(UV_NOT_FOUND_MESSAGE))
        return
      }
      const child = (this.opts.spawnFn ?? (nodeSpawn as SpawnLike))(
        uv,
        args,
        // detached 新进程组：stop 时组杀 uv + 孙进程（mineru-api）
        // D145：与 mineru-api 同一 MINERU_HOME，并丢掉继承的 MINERU_CONFIG
        { cwd: this.opts.stateDir, env: this.mineruChildEnv(), detached: true }
      )
      this.installChild = child
      child.stdout?.on('data', (d) => this.tapInstallLine(String(d)))
      child.stderr?.on('data', (d) => this.tapInstallLine(String(d)))
      child.on('error', reject)
      child.on('exit', (code) => {
        this.forgetLingering(child.pid)
        if (this.installChild === child) this.installChild = null
        if (code === 0) resolve()
        else reject(new Error(`uv ${args[0]} 退出码 ${code}${this.installDetail ? `：${this.installDetail}` : ''}`))
      })
    })
  }

  private tapInstallLine(chunk: string): void {
    // 按行缓冲：TCP 可能把一行切成多个 chunk，\r 进度条也要按段取最新
    this.installBuf += chunk
    const parts = this.installBuf.split(/[\r\n]/)
    this.installBuf = parts.pop() ?? ''
    const last = parts.filter((s) => s.trim()).pop()
    if (!last) return
    this.installDetail = last.trim().slice(0, 200)
    if (this.installPhase != null) {
      this.view = { ...this.view, installProgress: { phase: this.installPhase, detail: this.installDetail } }
    }
    // 节流：安装期每行都广播到所有窗口没必要，200ms 最多一次
    const now = this.opts.now?.() ?? Date.now()
    if (now - this.lastInstallEmit >= 200 || this.view.installProgress == null) {
      this.lastInstallEmit = now
      this.emit()
    }
  }

  /** D145：安装与服务共用的子进程环境。覆盖 MINERU_HOME，删除继承的 MINERU_CONFIG。 */
  /** uv 路径：显式 uvBin 优先，否则每次现查（用户装好 uv 后点重试即可生效）；找不到返回 null */
  private resolveUv(): string | null {
    if (this.opts.uvBin) return this.opts.uvBin
    return (this.opts.findUvBin ?? findUv)()
  }

  private mineruChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Finder 启动的最小 PATH 补上 uv 常见位置（uv 自己再找 python 等工具时也要用）
      PATH: augmentPath(process.env.PATH, uvFallbackDirs()),
      UV_PROJECT_ENVIRONMENT: this.venvDir,
      MINERU_HOME: this.mineruHome,
      ...extra
    }
    delete env.MINERU_CONFIG
    return env
  }

  /**
   * D145/D190：确保 App MinerU home 里有本档模型——
   * 已有 → 直接返回；全局 ~/.mineru/models 有完整本档模型 → 克隆/复制复用
   * （阶段文案「正在复用已下载的模型」，失败进 install_failed 可重试）；
   * 都没有 → 照常 mineru-models-download（MINERU_HOME 指到 App 目录，下到里面）。
   */
  private async ensureModels(kind: 'install' | 'upgrade'): Promise<void> {
    if (hasTierModels(this.modelsDir)) return
    // 测试里全局目录必须是临时路径；生产才读真实 ~/.mineru/models（只读复制）
    assertNotRealMineruInTest(this.globalModelsDir)
    // 升级路径（旧版装好、新目录无模型）：先进入 installing，阶段文案在分支里定，
    // 避免「其实要下载」时先闪一帧「正在复用」。
    const prevState = this.view.state
    if (prevState !== 'installing') this.setState('installing')
    let phase: 'reuse' | 'models' = 'reuse'
    try {
      // 空的 / 只有一个档 / 只有杂文件：先在数据根内挪开，重试才不会卡死或跳过
      const parked = quarantineIncompleteModels(this.mineruHome)
      if (parked) this.opts.log?.(`[graphictero] 模型目录不完整，已挪开后继续：${parked}`)
      if (hasReusableModels(this.globalModelsDir)) {
        // 阶段文案「正在复用已下载的模型」（首启与升级路径同文案，D145/D190）
        this.installPhase = 'reuse'
        this.installDetail = '正在复用已下载的模型…'
        this.setState('installing') // setState 才重算 installProgress（emit 只转发当前 view）
        const result = await reuseModels(this.globalModelsDir, this.mineruHome, (msg) => this.reportReuse(msg), {
          cloneExec: this.opts.cloneExec,
          onProgress: (msg) => this.noteReuseProgress(msg)
        })
        if (!result.cloned) {
          // 仍在 installing：emit 不会把 installProgress 清掉。这句是 D190 ② 的明确提示。
          const warn = plainCopyDiskWarning(result.bytes)
          this.installPhase = 'reuse'
          this.installDetail = warn
          this.view = { ...this.view, installProgress: { phase: 'reuse', detail: warn } }
          this.lastInstallEmit = this.opts.now?.() ?? Date.now()
          this.emit()
        }
      } else {
        // 全局没有本档模型：正常下载（下到 App 的 MINERU_HOME）
        phase = 'models'
        this.installPhase = 'models'
        this.installDetail = ''
        this.emit()
        await this.runUv(['run', '--project', this.opts.sidecarDir, 'mineru-models-download', '--tier', MINERU_TIER])
      }
      if (kind === 'upgrade') this.setState(prevState, { error: null, installProgress: null })
    } catch (e) {
      // 复用/下载失败：install_failed 可重试（D57/D144 口径不变），无半成品
      const raw = e instanceof Error ? e.message : String(e)
      this.setState('install_failed', {
        error: `MinerU 安装失败（${phase === 'models' ? '下载模型文件' : '复用模型文件'}）：${raw}`,
        installProgress: null
      })
      this.installPhase = phase // 留给外层 install() catch 归类阶段前缀
      throw e
    } finally {
      if (this.view.state !== 'install_failed') this.installPhase = null
    }
  }

  // ── 生命周期 ──────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.view.state === 'installing') throw new Error('MinerU 正在安装中，请稍候再试')
    if (this.view.state === 'ready' || this.view.state === 'starting') return
    this.stopRequested = false
    this.restarts = 0
    // 未安装或安装失败（install_failed）都先走 install；装好后停在 stopped，再拉服务
    if (!this.installed()) await this.install()
    // D145 升级路径：旧版装的（install-marker 在）但 App 目录里还没有模型 →
    // 先复用/下载，齐了才 spawn mineru-api（否则会去读空目录或触发下载）
    else if (!hasTierModels(this.modelsDir)) await this.ensureModels('upgrade')
    this.cleanupOrphan()
    await this.spawnAndWaitReady()
    this.startHealthMonitor()
  }

  async stop(): Promise<void> {
    this.stopRequested = true
    this.clearHealthMonitor()
    this.settleStarter(new Error('MinerU 已停止（启动被中断）'))
    const child = this.child
    this.child = null
    if (child) {
      // pid 留在 lingering 里，pidfile 留到进程实际退出再删，shutdownSync 仍能组杀
      this.retainUntilExit(child.pid)
      this.killChild(child, 'SIGTERM')
    }
    // 安装中 stop：GB 级下载一并终止
    const installChild = this.installChild
    this.installChild = null
    if (installChild) {
      this.retainUntilExit(installChild.pid)
      this.killChild(installChild, 'SIGTERM')
    }
    this.setState('stopped', { pid: null, error: null })
  }

  /**
   * E2/D190：App 退出（will-quit / 信号 / 崩溃）时的同步收尾——不靠 unref 的
   * SIGKILL 定时器（进程退出后来不及跑）。先 SIGTERM 服务与安装中的进程组，
   * 在短宽限内同步轮询确认组已退出；未退出的同步 SIGKILL 组。调用后进程应尽快 exit。
   */
  shutdownSync(graceMs = 1500): void {
    this.stopRequested = true
    this.clearHealthMonitor()
    this.settleStarter(new Error('MinerU 已停止（App 退出）'))
    const pids: number[] = []
    const add = (pid?: number | null): void => {
      if (pid != null && !pids.includes(pid)) pids.push(pid)
    }
    const child = this.child
    this.child = null
    add(child?.pid)
    const installChild = this.installChild
    this.installChild = null
    add(installChild?.pid)
    for (const [pid, timer] of this.lingering) {
      clearTimeout(timer)
      add(pid)
    }
    this.lingering.clear()
    if (pids.length === 0) {
      rmSync(this.pidfile, { force: true })
      return
    }
    terminateGroupsSync(pids, graceMs)
    rmSync(this.pidfile, { force: true })
  }

  /** 仅测试/内部使用：进程组是否还活着（pgid=pid，detached spawn） */
  static groupAliveFor(pid: number): boolean {
    return groupAlive(pid)
  }

  /**
   * 杀 sidecar 进程组（detached 新组：pgid=pid）。`uv run` 是 wrapper，
   * mineru-api 是孙进程，只杀 wrapper 会把 GB 级进程泄漏给 launchd。
   */
  private killChild(child: ChildProcess, sig: NodeJS.Signals): void {
    const pid = child.pid
    if (pid == null) {
      try {
        child.kill(sig)
      } catch {
        // 已退出
      }
      return
    }
    try {
      process.kill(-pid, sig)
    } catch {
      // 组杀失败（假子进程/已退出）→ 退回单杀
      try {
        child.kill(sig)
      } catch {
        // 已退出
      }
    }
  }

  private killPidGroup(pid: number, sig: NodeJS.Signals): void {
    try {
      process.kill(-pid, sig)
    } catch {
      try {
        process.kill(pid, sig)
      } catch {
        // 已退出
      }
    }
  }

  /**
   * SIGTERM 之后把 pid 留住。宽限到期仍未退出才 SIGKILL；
   * pidfile 要等进程实际退出（exit 事件或轮询确认）才删。
   */
  private retainUntilExit(pid: number | undefined): void {
    if (pid == null || this.lingering.has(pid)) return
    const grace = this.opts.sigkillGraceMs ?? 3000
    const timer = setTimeout(() => {
      if (!this.lingering.has(pid)) return
      this.killPidGroup(pid, 'SIGKILL')
      this.watchUntilGone(pid)
    }, grace)
    timer.unref()
    this.lingering.set(pid, timer)
  }

  /** SIGKILL 之后若没有 exit 事件，轮询到进程消失再清 pidfile。 */
  private watchUntilGone(pid: number): void {
    const tick = (): void => {
      if (!this.lingering.has(pid)) return
      try {
        process.kill(pid, 0)
      } catch {
        this.forgetLingering(pid)
        return
      }
      setTimeout(tick, 50).unref()
    }
    setTimeout(tick, 50).unref()
  }

  /** 进程已退出：取消尚未触发的 SIGKILL，并且只在 pidfile 仍指向这个 pid 时删除。 */
  private forgetLingering(pid: number | undefined): void {
    if (pid == null) return
    const timer = this.lingering.get(pid)
    if (timer) clearTimeout(timer)
    this.lingering.delete(pid)
    this.clearPidfileIfMatches(pid)
  }

  private clearPidfileIfMatches(pid: number): void {
    if (!existsSync(this.pidfile)) return
    try {
      const raw = readFileSync(this.pidfile, 'utf8').trim()
      let filePid: number | null = null
      try {
        const parsed = JSON.parse(raw) as unknown
        if (typeof parsed === 'number') filePid = parsed
        else if (parsed && typeof parsed === 'object' && typeof (parsed as { pid?: unknown }).pid === 'number') {
          filePid = (parsed as { pid: number }).pid
        }
      } catch {
        const n = Number(raw)
        if (Number.isInteger(n)) filePid = n
      }
      if (filePid === pid) rmSync(this.pidfile, { force: true })
    } catch {
      // 读不到就留给下次启动
    }
  }

  /** pidfile 清孤儿（D73/E2/D190）：活着的残留 sidecar 按进程组杀掉，死 pid 只清文件。
   *  必须同时对上 startedAt（对照 ps lstart）和本 App 的 `uv run … mineru-api`。
   *  旧版纯数字、或 JSON 里没有 startedAt：对不上就不杀，只删 pidfile 并记日志。 */
  private cleanupOrphan(): void {
    if (!existsSync(this.pidfile)) return
    let pid: number | null = null
    let pgid: number | null = null
    let startedAt: string | null = null
    let legacy = false
    try {
      const raw = readFileSync(this.pidfile, 'utf8').trim()
      try {
        const parsed = JSON.parse(raw) as unknown
        if (typeof parsed === 'number') {
          pid = parsed
          legacy = true
        } else if (parsed && typeof parsed === 'object') {
          const rec = parsed as { pid?: unknown; pgid?: unknown; startedAt?: unknown }
          if (typeof rec.pid === 'number') pid = rec.pid
          if (typeof rec.pgid === 'number') pgid = rec.pgid
          if (typeof rec.startedAt === 'string' && rec.startedAt.trim() !== '') startedAt = rec.startedAt
          else legacy = true
        }
      } catch {
        const n = Number(raw)
        if (Number.isInteger(n)) {
          pid = n
          legacy = true
        }
      }
    } catch {
      pid = null
    }
    const dropFile = (): void => {
      rmSync(this.pidfile, { force: true })
    }
    if (pid == null || !Number.isInteger(pid) || pid <= 0) {
      dropFile()
      return
    }
    if (legacy || startedAt == null) {
      this.opts.log?.('[graphictero] pidfile 是旧的纯数字或缺少启动时间，对不上就不杀，只删 pidfile')
      dropFile()
      return
    }
    try {
      process.kill(pid, 0)
    } catch {
      dropFile()
      return
    }
    const command = this.opts.processInfo?.(pid) ?? spawnSync('ps', ['-p', String(pid), '-o', 'command=']).stdout.toString()
    if (!commandIsOurMineruApi(command)) {
      this.opts.log?.(
        `[graphictero] pidfile 指向的进程不是本 App 的 mineru-api（${command.trim() || '无命令行'}），只清文件不杀`
      )
      dropFile()
      return
    }
    const lstart = this.opts.processStartedAt ? this.opts.processStartedAt(pid) : readProcessLstart(pid)
    if (lstart == null || !startedAtMatches(startedAt, lstart)) {
      this.opts.log?.('[graphictero] pidfile 的启动时间与进程不符，疑似 pid 复用，只清文件不杀')
      dropFile()
      return
    }
    const group = pgid != null && Number.isInteger(pgid) && pgid > 0 ? pgid : pid
    this.opts.log?.(`[graphictero] 清理孤儿 MinerU 进程组 pgid=${group}`)
    this.killPidGroup(group, 'SIGKILL')
    dropFile()
  }

  private spawnAndWaitReady(): Promise<void> {
    const port = this.opts.randomPort?.() ?? 20_000 + Math.floor(Math.random() * 40_000)
    const uploads = join(this.opts.stateDir, 'uploads')
    mkdirSync(uploads, { recursive: true })
    this.page = { pagesDone: null, pagesTotal: null }
    this.healthFails = 0
    const uv = this.resolveUv()
    if (uv == null) {
      // 已安装但 uv 被删了 / 不在常见位置：直接给出可操作的原因，不进自动重启
      this.settleStarter(new Error(UV_NOT_FOUND_MESSAGE))
      this.setState('crashed', { error: UV_NOT_FOUND_MESSAGE, pid: null })
      return Promise.reject(new Error(UV_NOT_FOUND_MESSAGE))
    }
    this.setState('starting', { port, error: null })

    const env = this.mineruChildEnv({ MINERU_API_RETENTION_SECONDS: '3600' })
    const child = (this.opts.spawnFn ?? (nodeSpawn as SpawnLike))(
      uv,
      [
        'run', '--project', this.opts.sidecarDir, 'mineru-api',
        // uat1：服务端档位显式化（4.0.12 默认即 standard，显式传参与下载档共用常量）
        '--host', '127.0.0.1', '--port', String(port), '--concurrency', '1', '--upload-dir', uploads,
        '--tier', MINERU_TIER
      ],
      // detached 新进程组：所有 kill 路径组杀，wrapper(uv) 与孙进程(mineru-api) 一起终止
      { cwd: this.opts.stateDir, env, detached: true }
    )
    this.child = child
    // E2/D145：pidfile 记 pid + 进程组 + 启动时间（下次启动按组清孤儿并做身份校验）
    if (child.pid != null) {
      writeFileSync(
        this.pidfile,
        JSON.stringify({ pid: child.pid, pgid: child.pid, startedAt: new Date().toISOString() }),
        'utf8'
      )
    }
    this.setState('starting', { pid: child.pid ?? null })

    child.on('exit', (code) => this.handleExit(child, code))
    // spawn 失败（uv 消失 / EMFILE）：无 error 监听会 uncaught → 主进程崩溃
    child.on('error', (err) => this.handleSpawnError(child, err))
    // uat13（D207-②）：输出除页码进度解析外，同时落盘到数据目录日志（滚动截断）
    this.sidecarLog = new SidecarLogFile(this.sidecarLogPath)
    child.stdout?.on('data', (d) => {
      this.tapOutput(String(d))
      this.sidecarLog?.appendChunk(String(d))
    })
    child.stderr?.on('data', (d) => {
      this.tapOutput(String(d))
      this.sidecarLog?.appendChunk(String(d))
    })

    // 总超时内轮询 /v1/health 直到就绪（D73）
    const deadline = (this.opts.now?.() ?? Date.now()) + this.startTimeoutMs
    const pollMs = this.opts.readyPollMs ?? 300
    return new Promise((resolve, reject) => {
      this.starterReject = reject
      const tick = async (): Promise<void> => {
        if (this.child !== child) {
          // 被 stop/崩溃重启接管：显式 settle，禁止 promise 悬挂（IPC 才能回包）
          this.settleStarter(new Error('MinerU 启动被中断'))
          return
        }
        try {
          const version = await this.fetchHealth()
          // 复查身份：等待健康检查期间进程可能已死/被 stop/被重启接管
          if (this.child !== child) {
            this.settleStarter(new Error('MinerU 启动被中断'))
            return
          }
          this.view.version = version
          this.starterReject = null
          this.setState('ready', { error: null })
          resolve()
          return
        } catch {
          // 还没起好，继续等
        }
        if ((this.opts.now?.() ?? Date.now()) > deadline) {
          const reason = `MinerU 启动超过总超时（${Math.round(this.startTimeoutMs / 1000)} 秒）仍未就绪`
          const childNow = this.child
          this.child = null // 阻止 handleExit 重复判崩
          if (childNow) this.killChild(childNow, 'SIGKILL')
          rmSync(this.pidfile, { force: true })
          this.starterReject = null
          this.crash(reason)
          reject(new Error(reason))
          return
        }
        setTimeout(() => void tick(), pollMs).unref()
      }
      void tick()
    })
  }

  /** 被 stop/崩溃/超时接管时，让 pending 的 start() promise 显式 reject */
  private settleStarter(err: Error): void {
    const reject = this.starterReject
    this.starterReject = null
    reject?.(err)
  }

  /** 进程 exit（非主动停止）→ 崩溃处理：自动重启一次，再失败 → crashed */
  private handleExit(child: ChildProcess, code: number | null): void {
    this.childGone(child, `MinerU 进程意外退出（code ${code ?? 'null'}）`)
  }

  /** spawn 本身失败（uv 不存在 / EMFILE 等） */
  private handleSpawnError(child: ChildProcess, err: Error): void {
    this.opts.log?.(`[graphictero] MinerU 进程无法启动：${err.message}`)
    this.childGone(child, `MinerU 进程无法启动：${err.message}`)
  }

  private childGone(child: ChildProcess, reason: string): void {
    // 先销掉这个 pid 的 SIGKILL 定时器。stop() 已经把 this.child 置空时也要做，
    // 否则宽限到期会去杀一个可能已被复用的 pid；pidfile 也只在仍指向它时删除。
    this.forgetLingering(child.pid)
    this.sidecarLog?.flush()
    // 身份校验：stop()/总超时/健康路径可能已接管并拉起了新进程，
    // 迟到（或被杀旧进程）的 exit/error 事件不能误归因给新子进程
    if (this.child !== child) return
    this.child = null
    this.settleStarter(new Error(reason))
    this.clearHealthMonitor()
    rmSync(this.pidfile, { force: true })
    if (this.stopRequested) {
      this.setState('stopped', { pid: null })
      return
    }
    this.crash(reason)
  }

  private crash(reason: string): void {
    // 崩溃时若有 pending 的 start()（启动中死亡），先让它 settle 再拉起新进程
    this.settleStarter(new Error(reason))
    if (this.restarts < this.maxRestarts) {
      this.restarts++
      this.opts.log?.(`[graphictero] ${reason}；自动重启（${this.restarts}/${this.maxRestarts}）`)
      this.setState('restarting', { error: reason, pid: null })
      this.spawnAndWaitReady()
        .then(() => {
          // D99：重启成功（/v1/health 已通过）后计数清零，下次崩溃可再自动重启一次
          this.restarts = 0
          this.startHealthMonitor()
        })
        .catch(() => {
          // 重启失败：crashed 状态与原因已在 crash()/spawnAndWaitReady 里落定，不再自动重启
        })
      return
    }
    this.setState('crashed', { error: reason, pid: null })
  }

  // ── D73 健康监测：5 秒轮询 /v1/health ────────────────────────

  private startHealthMonitor(): void {
    this.clearHealthMonitor()
    this.healthFails = 0
    const pollMs = this.opts.healthPollMs ?? 5000
    this.healthTimer = setInterval(() => {
      void this.fetchHealth()
        .then((version) => {
          this.healthFails = 0
          this.view.version = version
        })
        .catch(() => {
          this.healthFails++
          if (this.healthFails >= this.healthFailLimit && this.child != null) {
            this.opts.log?.(`[graphictero] MinerU 健康检查连续 ${this.healthFails} 次失败`)
            const child = this.child
            this.child = null // 阻止 handleExit 重复判崩
            if (child) this.killChild(child, 'SIGKILL')
            rmSync(this.pidfile, { force: true })
            this.clearHealthMonitor()
            this.crash('MinerU 健康检查连续失败（服务无响应）')
          }
        })
    }, pollMs)
    this.healthTimer.unref()
  }

  private clearHealthMonitor(): void {
    if (this.healthTimer != null) {
      clearInterval(this.healthTimer)
      this.healthTimer = null
    }
  }

  private async fetchHealth(): Promise<string> {
    const base = this.baseUrl()
    if (!base) throw new Error('no baseUrl')
    const res = await (this.opts.fetchImpl ?? fetch)(`${base}/v1/health`, {
      signal: AbortSignal.timeout(this.healthFetchTimeoutMs)
    })
    if (!res.ok) throw new Error(`health ${res.status}`)
    const body = (await res.json()) as { status?: string; version?: string }
    if (body.status !== 'ok') throw new Error(`health status ${body.status}`)
    return body.version ?? 'unknown'
  }

  /** 普通复制期间刷新安装详情（与 tapInstallLine 同一 200ms 节流）。最终警告由调用方强制 emit。 */
  private noteReuseProgress(msg: string): void {
    this.installDetail = msg.trim().slice(0, 200)
    if (this.installPhase != null) {
      this.view = { ...this.view, installProgress: { phase: this.installPhase, detail: this.installDetail } }
    }
    const now = this.opts.now?.() ?? Date.now()
    if (now - this.lastInstallEmit >= 200) {
      this.lastInstallEmit = now
      this.emit()
    }
  }

  /** 复用日志只进一个出口：有进度回调就用它，否则用 log，避免生产里 console.log 打两遍。 */
  private reportReuse(msg: string): void {
    if (this.opts.onReuseProgress) this.opts.onReuseProgress(msg)
    else this.opts.log?.(msg)
  }

  /** 捕获 sidecar 输出：window 行解析页码进度（best-effort，D72） */
  private tapOutput(line: string): void {
    const w = WINDOW_RE.exec(line)
    if (w) {
      this.page = { pagesDone: Number(w[2]), pagesTotal: Number(w[3]) }
      return
    }
    const pc = PAGE_COUNT_RE.exec(line)
    if (pc && this.page.pagesTotal == null) {
      this.page = { pagesDone: this.page.pagesDone, pagesTotal: Number(pc[1]) }
    }
  }

  // ── 内部小工具 ────────────────────────────────────────────────

  private setState(state: MineruStatusView['state'], patch: Partial<MineruStatusView> = {}): void {
    this.view = {
      ...this.view,
      ...patch,
      state,
      installProgress:
        patch.installProgress !== undefined
          ? patch.installProgress
          : this.installPhase != null
            ? { phase: this.installPhase, detail: this.installDetail }
            : this.view.installProgress
    }
    this.emit()
  }

  private emit(): void {
    if (this.view.state !== 'installing' && this.view.installProgress != null) {
      this.view = { ...this.view, installProgress: null }
    }
    this.opts.onEvent?.(this.status())
  }
}
