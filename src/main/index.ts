import { app, dialog } from 'electron'
import { join } from 'node:path'
import { closeSync, fsyncSync, openSync, writeFileSync, writeSync } from 'node:fs'
import { runFts5Probe } from './fts5'
import { dataDirBlockMessage, defaultDataRoot } from './dataDir'
import { readRootOverride } from './rootSetting'
import { DataDirBlockedError, initDataLayer } from './dataLayer'
import { msUntilNextUtcDay, runDailySnapshotTick } from './db/backup'
import { registerIpc, type AppState } from './ipc'
import { runUiSmoke, seedSyntheticPapers } from './smokeUi'
import { runAgentE2e, seedAgentE2e } from './agentE2e'
import { JobRunner } from './jobs/runner'
import { UnavailableParser, type PaperParser } from './jobs/mineru'
import { failStaleRunningJobs } from './jobs/store'
import { MineruSidecar } from './sidecar/mineruSidecar'
import { installExitSignalHandlers } from './sidecar/processGroup'
import { MineruParser } from './parser/mineruParser'
import { IPC_PDF } from '../shared/ipc/pdf'
import { IPC_DETAIL } from '../shared/ipc/detail'
import { backfillProcessJobs } from './appService'
import { backfillFullTextFts } from './db/fulltextFts'
import { startRelationsBackground } from './relations/background'
import { getLlmSettings, providerBaseUrl, readApiKey } from './llm/config'
import { writeThemePref } from './theme'
import { installTheme, windowBackgroundFor } from './themeInstall'
import { MissingKeyError } from './llm/errors'
import { registerAssetProtocol } from './assetProtocol'
import { appIndexUrl, registerAppProtocol, registerAppSchemesPrivileged } from './appProtocol'
import type Database from 'better-sqlite3'

/**
 * 数据层初始化（M1）+ 失败兜底：任何一步出错都弹窗并退出，不能静默挂着
 * 一个没初始化好的 App（评审建议修 7）。
 * IPC 接线见 ipc.ts；UI 冒烟入口见 smokeUi.ts（--smoke-ui <结果.json>）。
 */
function initDataLayerOrExit(): AppState {
  // 根位置优先级：GRAPHICTERO_DATA_ROOT 环境变量 > userData/data-root.json（设置页
  // 「更改…」/恢复备份的落点，见 rootSetting.ts）> 默认 ~/Library/Application Support
  //（其下固定 Graphictero/，D83/D91）
  const root =
    process.env.GRAPHICTERO_DATA_ROOT ?? readRootOverrideSafe() ?? defaultDataRoot()
  try {
    const { db, dataDir, backupDir } = initDataLayer(root)
    const state: AppState = { db, dataDir, backupDir, root }
    scheduleDailySnapshot(() => state.db, backupDir) // D59：每日自动备份在后台进行
    return state
  } catch (e) {
    const msg =
      e instanceof DataDirBlockedError
        ? dataDirBlockMessage(e.reason)
        : `Graphictero 初始化失败：${e instanceof Error ? e.message : String(e)}`
    dialog.showErrorBox('Graphictero 数据目录', msg)
    app.exit(1)
    throw e
  }
}

// rootSetting 只依赖 node 内置模块，无循环依赖，静态引入即可（打包后运行时
// require('./rootSetting') 会找不到模块，dev/prod 均启动失败）
function readRootOverrideSafe(): string | null {
  return readRootOverride(app.getPath('userData'))
}

/** 向所有窗口广播事件（解析进度 / sidecar 状态） */
function broadcast(channel: string, payload: unknown): void {
  const { BrowserWindow } = require('electron') as typeof import('electron')
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/**
 * M2 第一批：任务调度器接线；lane/pdf 批接真 MinerU（onParseProgress 广播
 * event:pdf:parseProgress）。离线判定用 electron net.isOnline()（D70）；
 * 2 秒轮询驱动调度循环 + 事件触发（导入完成 / 保存 Key / 手动重试时即时 drain）。
 */
function createRunner(state: AppState, parser: PaperParser): JobRunner {
  const { net } = require('electron') as typeof import('electron')
  return new JobRunner({
    onParseProgress: (paperId, p) => broadcast(IPC_PDF.eventParseProgress, { paperId, ...p }),
    // M4 合并批：详情生成/重生成成功后广播（覆盖 process_paper 与 detail_regen）
    onDetailUpdated: (paperId) => broadcast(IPC_DETAIL.eventUpdated, paperId),
    db: () => state.db, // 建 3：迁移/恢复失败重开库后调度器自动用新库
    dataDir: state.dataDir,
    parser,
    hasLlmKey: () => readApiKey(state.dataDir, getLlmSettings(state.db, state.dataDir).provider) != null,
    llmClient: () => {
      const s = getLlmSettings(state.db, state.dataDir)
      const key = readApiKey(state.dataDir, s.provider)
      if (!key) throw new MissingKeyError()
      return { baseUrl: providerBaseUrl(s.provider), apiKey: key, model: s.model }
    },
    isOnline: () => net.isOnline()
  })
}

/** D59「每日自动备份在后台进行」：挂一个到下一个 UTC 日零点的定时器，滚动打快照。
 *  快照与清理统一走 backup.ts 的 runDailySnapshotTick（评审复核建议修 6：消除双实现）。
 *  db 经由 state 读取：数据目录迁移/恢复失败重开库后定时器不需要重建。 */
function scheduleDailySnapshot(getDb: () => Database.Database, backupDir: string): void {
  const tick = (): void => {
    let delay: number
    try {
      delay = runDailySnapshotTick(getDb(), backupDir)
    } catch (e) {
      console.error('[graphictero] 每日快照失败：', e)
      delay = msUntilNextUtcDay() // 失败也不断链：仍对齐下一个 UTC 日零点重试
    }
    setTimeout(tick, delay).unref()
  }
  setTimeout(tick, msUntilNextUtcDay()).unref()
}

/**
 * M0 探针入口（无窗口）：
 *   检测到 --probe-fts5 <结果JSON路径>（或 GRAPHICTERO_FTS5_PROBE=1，结果写到
 *   GRAPHICTERO_FTS5_OUT，默认 probes/results/fts5-probe.json）时，不创建
 *   BrowserWindow，直接跑 FTS5 + Intl.Segmenter 测试，把结果写进 JSON 后 app.exit。
 * 正常 `pnpm dev` 不受影响。
 * UI 冒烟入口：--smoke-ui <结果JSON路径>（有窗口真实走 UI，见 smokeUi.ts）。
 */
function probeArgValue(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]
  const eq = process.argv.find((a) => a.startsWith(flag + '='))
  return eq ? eq.slice(flag.length + 1) : null
}

const probeOut =
  probeArgValue('--probe-fts5') ??
  (process.env.GRAPHICTERO_FTS5_PROBE === '1'
    ? (process.env.GRAPHICTERO_FTS5_OUT ?? join(process.cwd(), 'probes/results/fts5-probe.json'))
    : null)
const smokeOut = probeArgValue('--smoke-ui')
// chat→main 合并批清单①：真实 IPC 端到端（窗口不带 smoke=1，渲染层走真实 preload 桥，
// LLM 经 GRAPHICTERO_LLM_BASE_URL 指到主进程内 stubServer；驱动见 agentE2e.ts）
const agentE2eOut = probeArgValue('--agent-e2e')

// uat13b / D208：smoke / agent e2e 在用户正在用电脑时跑，不得在屏幕上弹窗、抢焦点、
// 出现在 Dock。测试窗口一律 headless（show:false + 关节流保证 rAF/定时器/动画不中断）；
// GRAPHICTERO_TEST_SHOW=1 可临时打开可见窗口调试。正常启动行为完全不变。
const headlessTest =
  Boolean(smokeOut || agentE2eOut) && process.env.GRAPHICTERO_TEST_SHOW !== '1'

/** 结果先 fsync。app.exit / process.exit 在跟随系统主题时不返回，改 SIGKILL。 */
function exitAgentE2e(outPath: string, body: string): void {
  const fd = openSync(outPath, 'w')
  try {
    writeSync(fd, body)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  process.kill(process.pid, 'SIGKILL')
}

// uat1 隔离验证：冒烟 / e2e / 探针脚本传 --user-data-dir 时，确认 Electron 在
// app.ready 前确实采纳了该目录（不一致直接退出，不能带病跑下去）；正常 `pnpm dev`
// 不传此参数，不受影响。macOS /var 是指向 /private/var 的符号链接，按 realpath 比较
//（目录可能尚未创建：自下而上找存在的祖先解析，再拼回不存在的尾部）。
const userDataDirArg = process.argv.find((a) => a.startsWith('--user-data-dir='))
if (userDataDirArg) {
  const { realpathSync } = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  const resolveExisting = (p: string): string => {
    const parts = p.split('/')
    for (let i = parts.length; i > 0; i--) {
      const head = parts.slice(0, i).join('/') || '/'
      try {
        return join(realpathSync(head), ...parts.slice(i))
      } catch {
        // 该级不存在，继续向上找
      }
    }
    return p
  }
  const expected = userDataDirArg.slice('--user-data-dir='.length)
  const applied = app.getPath('userData')
  if (resolveExisting(expected) !== resolveExisting(applied)) {
    console.error(`[graphictero] userData 隔离失败：期望 ${expected}，实际 ${applied}`)
    app.exit(1)
  } else {
    console.log(`[graphictero] userData 隔离：${applied}`)
  }
}

if (probeOut) {
  app.whenReady().then(() => {
    const result = runFts5Probe()
    writeFileSync(probeOut, JSON.stringify(result, null, 2))
    app.exit(result.ok ? 0 : 1)
  })
} else {
  // D115/D116：gt-asset:// 与 gt-app:// 必须在 app ready 之前注册为特权 scheme
  //（registerSchemesAsPrivileged 全进程只能调一次，两个 scheme 一起注册，见 appProtocol.ts）
  registerAppSchemesPrivileged()
  const { BrowserWindow } = require('electron') as typeof import('electron')
  // 首帧背景。whenReady 里按偏好（冒烟强制浅色）赋成 --bg，避免深色系统闪白。
  let windowBackground = '#FFFFFF'
  const createWindow = (): Electron.BrowserWindow => {
    const win = new BrowserWindow({
      width: 1280,
      height: 840,
      minWidth: 960,
      minHeight: 600,
      title: 'Graphictero',
      backgroundColor: windowBackground,
      // D208：测试窗口 headless，不弹窗不抢焦点
      show: !headlessTest,
      ...(headlessTest ? { paintWhenInitiallyHidden: true } : {}),
      // 隐藏系统标题栏，红绿灯嵌入侧栏顶部留白（与渲染层 .tlspace 对齐）
      ...(process.platform === 'darwin'
        ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 20 } }
        : {}),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        // 评审建 9：preload 只用 ipcRenderer/contextBridge，沙箱内可用，收紧 sandbox
        sandbox: true,
        // D208：隐藏窗口不被节流（sendInputEvent / 动画 / 定时器照常驱动）
        ...(headlessTest ? { backgroundThrottling: false } : {})
      }
    })
    // 评审建 9：不允许任何 window.open 新窗口（本应用无外链需求）
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    if (headlessTest) console.log(`[graphictero] 测试窗口 headless：isVisible=${win.isVisible()}`)
    // D200：smoke / agent e2e 都带 motion=off（e2e 仍不带 smoke=1，继续走真实 preload 桥）。
    const query = new URLSearchParams()
    if (smokeOut) query.set('smoke', '1')
    if (smokeOut || agentE2eOut) query.set('motion', 'off')
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl) {
      void win.loadURL(`${devUrl}${suffix ? `${devUrl.includes('?') ? '&' : '?'}${query.toString()}` : ''}`)
    } else {
      // D116：整页经 gt-app:// 加载（不再是 file://；解析与安全校验见 appProtocol.ts），
      // CSP 的 'self' 从此只指 gt-app 自身，file:// 资源不再被 'self' 覆盖
      void win.loadURL(appIndexUrl(Object.fromEntries(query)))
    }
    return win
  }
  app.whenReady().then(() => {
    // D208：测试模式隐藏 Dock 图标（smoke / e2e 在后台跑，不在用户的 Dock 里出现）
    if (headlessTest && process.platform === 'darwin') app.dock?.hide()
    const state = initDataLayerOrExit()
    console.log(`[graphictero] 数据目录：${state.dataDir}`)
    // D115：详情页本地图片经 gt-asset://（realpath 校验在数据目录内；数据目录迁移后跟随 state）
    registerAssetProtocol(() => state.dataDir)
    // D116：应用页面资源经 gt-app://（out/renderer；loadURL 在 createWindow 里）
    registerAppProtocol(join(__dirname, '../renderer'))
    // MinerU sidecar（lane/pdf）：冒烟 / GRAPHICTERO_SIDECAR=off 时用占位解析器（available()=false）
    let parser: PaperParser
    if (smokeOut || agentE2eOut || process.env.GRAPHICTERO_SIDECAR === 'off') {
      parser = new UnavailableParser()
    } else {
      const sidecarDir = app.isPackaged
        ? join(process.resourcesPath, 'sidecar', 'mineru')
        : join(app.getAppPath(), 'sidecar', 'mineru')
      const sidecar = new MineruSidecar({
        sidecarDir,
        stateDir: join(state.dataDir, 'sidecar'),
        // D145：复用/普通复制占用空间的说明写进主进程日志（设置页安装详情同时展示）
        log: (msg) => console.log(msg),
        onReuseProgress: (msg) => console.log(msg),
        onEvent: (v) => {
          broadcast(IPC_PDF.eventSidecar, v)
          // D95：检测到 MinerU 可用（含装好后首次就绪）自动补排「未处理」论文
          if (v.state === 'ready') {
            const ids = backfillProcessJobs(state.db, state.dataDir, parser)
            if (ids.length > 0) {
              console.log(`[graphictero] MinerU 可用，补排 ${ids.length} 个解析任务`)
              void state.runner?.drain()
            }
          }
        }
      })
      state.sidecar = sidecar
      parser = new MineruParser({ sidecar })
      // E2/D190：App 退出时同步组杀 sidecar（进程组杀 uv wrapper + mineru-api 孙进程）。
      // 测试者 cdc2db0 漏网（只读 app.log / app_cdc2db0.log 无退出记录，对照 cdc2db0 代码）：
      // will-quit 里 void stop() 只发 SIGTERM，3s SIGKILL 定时器 unref，进程先退出；
      // 且 detached 子进程组收不到父进程的 SIGHUP。electron-vite 热重启是 SIGTERM 主进程，
      // 同样不走 will-quit。收口：
      // ① will-quit（正常 quit；不用 before-quit——那一步仍可能被取消，提前杀会把还要继续跑的
      //    sidecar 拆掉）同步 shutdownSync，短宽限内轮询，未退出则 SIGKILL，不靠 unref 定时器；
      // ② SIGTERM/SIGINT/SIGHUP 走同一收尾再退出（覆盖信号停与 dev 热重启）；
      // ③ uncaughtException 致命退出前尽力同步组杀；
      // ④ process exit 再组杀一次（grace 0），盖住没走到 will-quit 的 process.exit。
      // 不另起 watchdog 进程：父进程被 SIGKILL 时 watchdog 也不可靠。下次启动按 pidfile 的
      // pgid 清孤儿，但要同时对上 startedAt 与本 App 的 `uv run … mineru-api`；对不上就不杀。
      app.on('will-quit', () => {
        state.sidecar?.shutdownSync()
      })
      installExitSignalHandlers(() => state.sidecar?.shutdownSync())
      process.on('exit', () => {
        try {
          state.sidecar?.shutdownSync(0)
        } catch {
          // 退出事件里尽力组杀
        }
      })
      process.on('uncaughtException', (err) => {
        console.error('[graphictero] 未捕获异常，正在退出：', err)
        try {
          state.sidecar?.shutdownSync(500)
        } catch {
          // 尽力而为
        }
        app.exit(1)
      })
      // D57 首启自动安装（uv + 模型，几 GB）；失败进入 install_failed 持久态（首启界面 /
      // 设置页 / 状态点弹层可见可重试，渲染层另给一个通俗 toast），D95 保持「未处理」不点红
      sidecar.start().catch((e) => console.error('[graphictero] MinerU sidecar 启动失败：', e))
    }
    state.parser = parser
    state.runner = createRunner(state, parser)
    failStaleRunningJobs(state.db) // D44：遗留 running 任务标为失败，可重试
    // D95：启动时 MinerU 已可用则立即补排（异步启动未就绪时由上面的 ready 事件补）
    const backfilled = backfillProcessJobs(state.db, state.dataDir, parser)
    if (backfilled.length > 0) console.log(`[graphictero] MinerU 可用，补排 ${backfilled.length} 个解析任务`)
    // uat3b 必须修 2：历史库全文索引 backfill（082 迁移建新表，老论文的 full.md 补进索引）
    const ftsBackfilled = backfillFullTextFts(state.db, state.dataDir)
    if (ftsBackfilled > 0) console.log(`[graphictero] 全文索引补建 ${ftsBackfilled} 篇`)
    const drainTimer = setInterval(() => {
      state.runner?.drain().catch((e) => console.error('[graphictero] 任务调度异常：', e))
    }, 2000)
    drainTimer.unref()
    // D101：关系引擎后台接线（车道合并批次，维护者授权）——自带启动恢复（resumeWaiting +
    // drain，重启前遗留的 queued relation_gen 任务被捞起）+ 2s 周期 drain（重试到点唤醒）+
    // 30s 新增论文补排扫描。failStaleRunningJobs（D44，其上两行）已先清孤儿 running，
    // 顺序天然正确。全仓只此一处调用。
    state.relEngine = registerIpc(state)
    // uat8c：冒烟固定浅色，灰阶扫描不随主机外观变。产品默认仍是跟随系统。
    if (smokeOut) writeThemePref(state.db, 'light')
    installTheme(state.db)
    windowBackground = windowBackgroundFor(state.db)
    startRelationsBackground({ db: () => state.db, engine: state.relEngine })
    if (smokeOut) {
      // UI 冒烟（第三批评审）：临时数据目录 + 合成论文，真实 renderer 里走
      // 新建图谱 → 添加论文 → 拖拽 → 手工连边 → 重启验证持久化，结果写 JSON。
      seedSyntheticPapers(state.db, state.dataDir)
      const win = createWindow()
      runUiSmoke(win, state, smokeOut)
        .then((result) => {
          writeFileSync(smokeOut, JSON.stringify(result, null, 2))
          app.exit(result.ok ? 0 : 1)
        })
        .catch((e) => {
          writeFileSync(smokeOut, JSON.stringify({ ok: false, fatal: String(e) }, null, 2))
          app.exit(1)
        })
    } else if (agentE2eOut) {
      // 真实 IPC 端到端（chat→main 合并批）：合成数据先行（图谱/论文/详情/既有边），
      // 窗口不带 smoke=1（渲染层走真实 preload 桥），stub LLM 在 agentE2e 内启动接管。
      seedAgentE2e(state.db)
      const win = createWindow()
      runAgentE2e(win, state)
        .then((result) => {
          // app.exit / process.exit 在跟随系统主题时不返回。结果落盘后 SIGKILL 结束本次进程。
          exitAgentE2e(agentE2eOut, JSON.stringify(result, null, 2))
        })
        .catch((e) => {
          exitAgentE2e(agentE2eOut, JSON.stringify({ ok: false, fatal: String(e) }, null, 2))
        })
    } else {
      createWindow()
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
