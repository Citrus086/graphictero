import type { MineruStatusView, PdfApi } from '../../../shared/ipc/pdf'
import { UV_BREW_COMMAND, UV_INSTALL_COMMAND, UV_NOT_FOUND_MARK } from '../../../shared/uvHint'

/**
 * uat1：MinerU 状态的渲染层统一访问点（对齐 M6 candApi() 先例）。
 *
 * ?smoke=1 时用内存 mock 接管（preload 的 contextBridge 对象在渲染层不可改写，
 * 冒烟步骤经 window.__gtSmokeMineru 注入状态、断言 installMineru 调用）；
 * 真实环境直通 window.graphictero。
 *
 * 首启安装界面（00）、设置页 MineruSection、顶栏 StatusDot 三处共用同一
 * 状态源，保证「状态点 / 弹层 / 设置页 / 首启界面」口径一致。
 */

const SMOKE_MODE = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('smoke')

export interface SmokeMineruMock extends Pick<PdfApi, 'getMineruStatus' | 'installMineru' | 'onMineruStatus'> {
  /** 冒烟驱动：推进度/状态事件给所有订阅者 */
  fire(s: MineruStatusView): void
  /** 安装（重试）调用次数（断言用） */
  installCalls: number
  /** 可配置的首查状态 */
  status: MineruStatusView
}

function createSmokeMineruMock(): SmokeMineruMock {
  const listeners = new Set<(s: MineruStatusView) => void>()
  const mock: SmokeMineruMock = {
    installCalls: 0,
    status: {
      state: 'unavailable',
      version: null,
      port: null,
      pid: null,
      error: null,
      installProgress: null,
      modelsPath: null,
      modelsReady: false
    },
    fire(s) {
      mock.status = s
      listeners.forEach((cb) => cb(s))
    },
    getMineruStatus() {
      return Promise.resolve({ ...mock.status, installProgress: mock.status.installProgress ? { ...mock.status.installProgress } : null })
    },
    installMineru() {
      mock.installCalls++
      return Promise.resolve(mock.status)
    },
    onMineruStatus(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
  if (typeof window !== 'undefined') {
    ;(window as unknown as { __gtSmokeMineru?: SmokeMineruMock }).__gtSmokeMineru = mock
  }
  return mock
}

let smokeMineru: SmokeMineruMock | null = null

// smoke 模式模块加载即建 mock：冒烟步骤在任何 UI 挂载前就能注入状态
if (SMOKE_MODE) smokeMineru ??= createSmokeMineruMock()

/** MinerU 状态访问点：smoke 模式内存 mock（与组件共享同一实例），真实环境 window.graphictero */
export function mineruApi(): Pick<PdfApi, 'getMineruStatus' | 'installMineru' | 'onMineruStatus'> {
  if (SMOKE_MODE) {
    smokeMineru ??= createSmokeMineruMock()
    return smokeMineru
  }
  return window.graphictero
}

/**
 * 安装失败的通俗中文文案归类（uat1）：error 是主进程原文
 * 「MinerU 安装失败（安装依赖|复用模型文件|下载模型文件）：…」。
 * 用户文案按阶段前缀归类，原始输出只进「详细信息」。
 */
export function installFailedText(error: string): { title: string; hint: string } {
  if (error.includes(UV_NOT_FOUND_MARK)) {
    return {
      title: 'MinerU 安装失败：没有找到 uv。',
      hint: `请在终端运行 ${UV_INSTALL_COMMAND}（或 ${UV_BREW_COMMAND}）安装 uv，然后重试。`
    }
  }
  if (error.includes('复用模型文件')) {
    return {
      title: 'MinerU 安装失败：复用已下载的模型时出错。',
      hint: '全局 ~/.mineru 没有被改动，可以稍后重试。'
    }
  }
  if (error.includes('下载模型文件')) {
    return {
      title: 'MinerU 安装失败：下载模型文件时出错。',
      hint: '可能是网络中断或磁盘空间不足，可以稍后重试。'
    }
  }
  return {
    title: 'MinerU 安装失败：安装依赖时出错。',
    hint: '可能是网络中断或磁盘空间不足，可以稍后重试。'
  }
}

/** 首启界面（00）与设置页共用的安装阶段标签 */
export const INSTALL_PHASE_LABEL: Record<'deps' | 'models' | 'reuse', string> = {
  deps: '正在安装依赖…',
  models: '正在下载模型文件…',
  // D145：复用全局已下载模型（克隆/复制到 App 数据目录）
  reuse: '正在复用已下载的模型…'
}

/** uat1：首启安装门态——sidecar 处在这三态时 App 显示原型 00 安装界面（取代首页）。
 *  已安装（stopped 及之后）/ unavailable（冒烟、e2e、GRAPHICTERO_SIDECAR=off）不进门。 */
export function isFirstRunGateState(s: MineruStatusView['state'] | undefined): boolean {
  return s === 'not_installed' || s === 'installing' || s === 'install_failed'
}

/**
 * uat1b D144：MinerU「不可用」的通俗原因（渲染层论文层标签 / 详情页 / 弹层汇总用）。
 * ready（可用）与 unavailable（冒烟/e2e/sidecar=off 的占位，非真实状态）返回 null——
 * 后者保持现有「未处理」口径，不显示等待解析组件。
 */
const UNAVAILABLE_REASON: Partial<Record<MineruStatusView['state'], string>> = {
  not_installed: '解析组件（MinerU）还没安装',
  installing: '解析组件正在安装',
  install_failed: '解析组件安装失败',
  stopped: '解析组件已停止',
  starting: '解析组件正在启动',
  restarting: '解析组件崩溃后自动重启中',
  crashed: '解析组件已停止（自动重启未成功）'
}

export function mineruUnavailableReason(s: MineruStatusView['state'] | undefined): string | null {
  if (s == null || s === 'ready' || s === 'unavailable') return null
  return UNAVAILABLE_REASON[s] ?? '解析组件暂不可用'
}
