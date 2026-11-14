import { spawnSync } from 'node:child_process'

/**
 * 进程组终止工具（E2/D190）：MinerU 以 detached 新进程组启动（pgid = pid），
 * uv wrapper 与 mineru-api 孙进程同组；App 退出时必须确保整组结束，不留孤儿。
 *
 * 全部操作只对调用方显式给出的 pid（本 App 自己 spawn 的子进程组）生效；
 * 测试也只对测试自己起的进程发信号。
 */

/**
 * 进程组是否还活着（kill(-pid, 0)：ESRCH=不在，EPERM=在但无权）。
 * 注意：已被 SIGTERM 的子进程在父进程（本进程）reap 前是僵尸，kill(-pid, 0) 对
 * 僵尸仍成功——同步等待路径（事件循环被忙等卡住，reap 不会发生）要用 ps 排除僵尸，
 * 否则会把「已死待 reap」误判成活着而多送 SIGKILL（无害但语义错）。
 */
export function groupAlive(pid: number): boolean {
  // 以 ps 为准：组里是否还有非僵尸成员。kill(-pid,0) 对僵尸组在 macOS 上返回
  // EPERM（不是成功也不是 ESRCH），不能单独作判据。
  try {
    const out = spawnSync('ps', ['-A', '-o', 'pgid=', '-o', 'stat=']).stdout.toString()
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\S+)/.exec(line)
      if (m && Number(m[1]) === pid && !m[2].startsWith('Z')) return true
    }
    return false
  } catch {
    try {
      process.kill(-pid, 0)
      return true
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM'
    }
  }
}

/** 对单个进程组发信号（组杀失败退回单杀；不抛） */
export function signalGroup(pid: number, sig: NodeJS.Signals): void {
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

export interface TerminateResult {
  pids: number[]
  /** 宽限内自行退出的组 */
  exited: number[]
  /** 宽限后仍活着、被 SIGKILL 的组 */
  killed: number[]
}

/**
 * 同步终止若干进程组：先全部 SIGTERM，忙等轮询（≤graceMs）确认退出；
 * 超时未退出的同步 SIGKILL。退出路径专用——阻塞事件循环可接受（进程马上退出），
 * 不要在运行期调用。
 */
export function terminateGroupsSync(pids: number[], graceMs = 1500): TerminateResult {
  const uniq = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))]
  for (const pid of uniq) signalGroup(pid, 'SIGTERM')
  const deadline = Date.now() + graceMs
  const alive = (): number[] => uniq.filter((pid) => groupAlive(pid))
  let remaining = alive()
  while (remaining.length > 0 && Date.now() < deadline) {
    busyWait(10)
    remaining = alive()
  }
  const exited = uniq.filter((pid) => !remaining.includes(pid))
  for (const pid of remaining) signalGroup(pid, 'SIGKILL')
  return { pids: uniq, exited, killed: remaining }
}

/** 极短忙等（退出路径专用；setTimeout 在即将退出的进程里不可靠） */
function busyWait(ms: number): void {
  const end = Date.now() + ms
  while (Date.now() < end) {
    // 空转：最长 graceMs，仅在退出收尾使用
  }
}

export interface ExitSignalHandlers {
  /** 已注册的回调（测试可手动触发） */
  onSignal(signal: NodeJS.Signals): void
}

/**
 * E2：主进程收到 SIGTERM / SIGINT / SIGHUP 时先同步收尾（组杀 MinerU）再退出——
 * Electron 被信号终止时 will-quit 不触发，detached 进程组又收不到父进程 SIGHUP，
 * 没有这句兜底就会留孤儿（测试者 cdc2db0 环境备注 2 的漏网路径）。
 * @param shutdown 同步收尾（如 sidecar.shutdownSync()）
 * @param exit 退出函数（默认 process.exit；测试注入假实现）
 * @param proc 目标进程对象（默认 process；测试注入假实现）
 */
export function installExitSignalHandlers(
  shutdown: () => void,
  exit: (code: number) => void = (code) => process.exit(code),
  proc: Pick<NodeJS.Process, 'on'> = process
): ExitSignalHandlers {
  let shuttingDown = false
  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return
    shuttingDown = true
    try {
      shutdown()
    } catch {
      // 收尾尽力而为，不阻断退出
    }
    exit(0)
  }
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) proc.on(sig, () => onSignal(sig))
  return { onSignal }
}
