import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { spawn as realSpawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { MineruStatusView } from '../../shared/ipc/pdf'
import { MineruSidecar, MINERU_TIER, type SpawnLike } from './mineruSidecar'
import { STANDARD_TIER_MODEL_DIRS, listFileEntries } from './modelReuse'
import { installExitSignalHandlers, terminateGroupsSync } from './processGroup'

/**
 * D145/D190 + E2 单测：
 * - D145：两处 spawn 同一 MINERU_HOME（在数据目录内）；全局有模型 → 复制复用
 *   （不 spawn 下载、源目录只读）；全局无模型 → 下载；复用失败 → install_failed
 *   可重试；旧 marker + 新目录空 → 复用完成后才 spawn mineru-api。
 * - E2：shutdownSync 同步组杀（含 SIGTERM 被忽略的孙进程 → SIGKILL 兜底）；
 *   pidfile JSON 组清孤儿 + 命令行身份校验；installExitSignalHandlers 信号收口。
 * 全部用临时目录与假 spawn / 测试自己起的 sleep 进程——绝不碰真实 ~/.mineru。
 */

interface FakeChild {
  ee: EventEmitter
  pid: number
  killed: string[]
  exited: boolean
  stdout: EventEmitter
  stderr: EventEmitter
}

let nextPid = 90000
function makeChild(): FakeChild {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  return { ee: new EventEmitter(), pid: nextPid++, killed: [], exited: false, stdout, stderr }
}

function asChildProcess(c: FakeChild): ChildProcess {
  const ee = c.ee as EventEmitter & { pid?: number } & Partial<ChildProcess>
  ee.pid = c.pid
  ee.stdout = c.stdout as unknown as ChildProcess['stdout']
  ee.stderr = c.stderr as unknown as ChildProcess['stderr']
  ee.kill = ((signal?: string) => {
    c.killed.push(signal ?? 'SIGTERM')
    queueMicrotask(() => {
      if (!c.exited) {
        c.exited = true
        c.ee.emit('exit', 1)
      }
    })
    return true
  }) as ChildProcess['kill']
  return ee as ChildProcess
}

function healthOk(version = '4.0.12'): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ status: 'ok', version }), { status: 200 })) as unknown as typeof fetch
}

const healthFail = (async () => new Response('boom', { status: 503 })) as unknown as typeof fetch

let dir: string
let sidecarDir: string
let stateDir: string
let globalHome: string
let events: MineruStatusView[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-sidecar-d145-'))
  sidecarDir = join(dir, 'sidecar-src')
  stateDir = join(dir, 'state')
  globalHome = join(dir, 'global-mineru') // 假全局 MinerU home（红线：绝不指真实 ~/.mineru）
  mkdirSync(sidecarDir, { recursive: true })
  events = []
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeSidecar(opts: Partial<ConstructorParameters<typeof MineruSidecar>[0]> = {}): MineruSidecar {
  return new MineruSidecar({
    sidecarDir,
    stateDir,
    fetchImpl: healthOk(),
    spawnFn: vi.fn() as unknown as SpawnLike,
    // 不依赖本机是否装了 uv
    findUvBin: () => 'uv',
    randomPort: () => 34567,
    readyPollMs: 5,
    healthPollMs: 20,
    globalMineruHome: globalHome,
    ...opts,
    onEvent: (v) => {
      events.push(v)
      opts.onEvent?.(v)
    }
  })
}

/** 造假全局模型（standard 档两个子目录，各一个小文件） */
function makeGlobalModels(): void {
  for (const sub of STANDARD_TIER_MODEL_DIRS) {
    mkdirSync(join(globalHome, 'models', sub), { recursive: true })
    writeFileSync(join(globalHome, 'models', sub, 'w.bin'), Buffer.alloc(1024, 7))
  }
}

function markInstalledWithoutModels(): void {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'install-marker.json'), '{}', 'utf8')
}

/** 两个标准档目录都非空：start() 视为模型已就绪，不再复用或下载。 */
function placeReadyAppModels(): void {
  markInstalledWithoutModels()
  for (const sub of STANDARD_TIER_MODEL_DIRS) {
    mkdirSync(join(stateDir, 'mineru-home', 'models', sub), { recursive: true })
    writeFileSync(join(stateDir, 'mineru-home', 'models', sub, '.keep'), 'k', 'utf8')
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('D145/D190：两处 spawn 同一 MINERU_HOME（在数据目录内）', () => {
  it('安装（uv sync / 模型）与服务（mineru-api）的 env 带同一个 MINERU_HOME = <stateDir>/mineru-home', async () => {
    const children: FakeChild[] = []
    const spawnFn = vi.fn(((_cmd: string, args: string[]) => {
      const c = makeChild()
      children.push(c)
      if (!args.join(' ').includes('mineru-api')) queueMicrotask(() => c.ee.emit('exit', 0))
      return asChildProcess(c)
    }) as unknown as SpawnLike)
    const sc = makeSidecar({ spawnFn })
    await sc.start()

    const mineruHome = join(stateDir, 'mineru-home')
    for (const call of spawnFn.mock.calls) {
      const opts = call[2] as { env: NodeJS.ProcessEnv }
      expect(opts.env.MINERU_HOME).toBe(mineruHome)
      expect(mineruHome.startsWith(stateDir)).toBe(true) // 在数据目录内
      expect(opts.env.MINERU_CONFIG).toBeUndefined() // 不继承全局配置路径
    }
    // 下载档 = 服务档（MINERU_TIER 不变）
    expect(spawnFn.mock.calls[1][1]).toEqual(['run', '--project', sidecarDir, 'mineru-models-download', '--tier', MINERU_TIER])
    await sc.stop()
  })
})

describe('D190 锁定：继承的 MINERU_CONFIG 不得传给子进程', () => {
  it('父进程设了 MINERU_CONFIG，uv sync 与 mineru-api 的 env 都丢掉它，MINERU_HOME 仍在数据目录内', async () => {
    const prev = process.env.MINERU_CONFIG
    process.env.MINERU_CONFIG = join(dir, 'should-not-propagate.yaml')
    try {
      const spawnFn = vi.fn(((_cmd: string, args: string[]) => {
        const c = makeChild()
        if (!args.join(' ').includes('mineru-api')) queueMicrotask(() => c.ee.emit('exit', 0))
        return asChildProcess(c)
      }) as unknown as SpawnLike)
      const sc = makeSidecar({ spawnFn })
      await sc.start()
      expect(spawnFn.mock.calls.length).toBeGreaterThanOrEqual(2)
      for (const call of spawnFn.mock.calls) {
        const opts = call[2] as { env: NodeJS.ProcessEnv }
        expect(opts.env.MINERU_CONFIG).toBeUndefined()
        expect(opts.env.MINERU_HOME).toBe(join(stateDir, 'mineru-home'))
      }
      await sc.stop()
    } finally {
      if (prev === undefined) delete process.env.MINERU_CONFIG
      else process.env.MINERU_CONFIG = prev
    }
  })
})

describe('D145/D190：全局有模型 → 克隆/复制复用（不下载、源目录只读）', () => {
  it('全局有本档模型：不走 mineru-models-download，模型复制进 App 目录，源目录逐字节不变', async () => {
    makeGlobalModels()
    const srcRoot = join(globalHome, 'models')
    const srcBefore = Object.fromEntries(listFileEntries(srcRoot))
    const srcMtime = statSync(srcRoot).mtimeMs
    const reuseMsgs: string[] = []
    const children: FakeChild[] = []
    const spawnFn = vi.fn(((_cmd: string, args: string[]) => {
      const c = makeChild()
      children.push(c)
      if (!args.join(' ').includes('mineru-api')) queueMicrotask(() => c.ee.emit('exit', 0))
      return asChildProcess(c)
    }) as unknown as SpawnLike)
    const sc = makeSidecar({ spawnFn, onReuseProgress: (m) => reuseMsgs.push(m) })
    await sc.start()

    const cmds = spawnFn.mock.calls.map((c) => (c[1] as string[]).join(' '))
    expect(cmds.some((c) => c.includes('mineru-models-download'))).toBe(false) // 复用，不下载
    expect(cmds.some((c) => c.includes('mineru-api'))).toBe(true)
    // 模型落在 App 的 MinerU home 里且与源一致
    expect(Object.fromEntries(listFileEntries(join(stateDir, 'mineru-home', 'models')))).toEqual(srcBefore)
    // 源目录只读：复用后仍逐字节一致，目录 mtime 不变
    expect(Object.fromEntries(listFileEntries(srcRoot))).toEqual(srcBefore)
    expect(statSync(srcRoot).mtimeMs).toBe(srcMtime)
    // 阶段文案「正在复用已下载的模型」经 installProgress 推送过
    expect(events.some((e) => e.installProgress?.phase === 'reuse')).toBe(true)
    expect(reuseMsgs.some((m) => m.includes('复用'))).toBe(true)
    await sc.stop()
  })

  it('升级路径：旧 marker 在、新目录无模型 → 复用完成后才 spawn mineru-api，终态 ready', async () => {
    makeGlobalModels()
    markInstalledWithoutModels()
    const children: FakeChild[] = []
    const spawnFn = vi.fn(((_cmd: string, args: string[]) => {
      const c = makeChild()
      children.push(c)
      if (!args.join(' ').includes('mineru-api')) queueMicrotask(() => c.ee.emit('exit', 0))
      return asChildProcess(c)
    }) as unknown as SpawnLike)
    const sc = makeSidecar({ spawnFn })
    await sc.start()
    expect(sc.isReady()).toBe(true)
    const cmds = spawnFn.mock.calls.map((c) => (c[1] as string[]).join(' '))
    // 复用完成前不启动服务：唯一一次 spawn 就是 mineru-api（复用不产生 spawn）
    expect(cmds).toHaveLength(1)
    expect(cmds[0]).toContain('mineru-api')
    expect(existsSync(join(stateDir, 'mineru-home', 'models', STANDARD_TIER_MODEL_DIRS[0]))).toBe(true)
    // 升级路径复用完成后回到 stopped 语义再拉起：状态流里短暂 installing 后 ready
    expect(events.some((e) => e.state === 'installing')).toBe(true)
    await sc.stop()
  })

  it('App 模型目录已有两个标准档时不重复复用/下载（重装后二次 start 直接拉服务）', async () => {
    makeGlobalModels()
    placeReadyAppModels()
    const spawnFn = vi.fn((() => {
      const c = makeChild()
      return asChildProcess(c)
    }) as unknown as SpawnLike)
    const sc = makeSidecar({ spawnFn })
    await sc.start()
    const cmds = spawnFn.mock.calls.map((c) => (c[1] as string[]).join(' '))
    expect(cmds).toHaveLength(1) // 只有 mineru-api，没有复用/下载
    expect(cmds[0]).toContain('mineru-api')
    await sc.stop()
  })

  it('models 已存在但不就绪（空 / 一个档 / 杂文件）→ 挪开后复用，源目录不动', async () => {
    makeGlobalModels()
    const srcRoot = join(globalHome, 'models')
    const srcMtime = statSync(srcRoot).mtimeMs
    const setups: Array<(root: string) => void> = [
      (root) => mkdirSync(root, { recursive: true }),
      (root) => {
        mkdirSync(join(root, STANDARD_TIER_MODEL_DIRS[0]), { recursive: true })
        writeFileSync(join(root, STANDARD_TIER_MODEL_DIRS[0], 'half.bin'), 'half')
      },
      (root) => {
        mkdirSync(root, { recursive: true })
        writeFileSync(join(root, 'junk.txt'), 'junk')
      }
    ]
    for (const setup of setups) {
      rmSync(join(stateDir, 'mineru-home'), { recursive: true, force: true })
      markInstalledWithoutModels()
      setup(join(stateDir, 'mineru-home', 'models'))
      const spawnFn = vi.fn((() => asChildProcess(makeChild())) as unknown as SpawnLike)
      const sc = makeSidecar({ spawnFn })
      await sc.start()
      expect(sc.isReady()).toBe(true)
      const parked = readdirSync(join(stateDir, 'mineru-home')).filter((n) => n.startsWith('models.incomplete-'))
      expect(parked.length).toBeGreaterThan(0)
      expect(existsSync(join(stateDir, 'mineru-home', 'models', STANDARD_TIER_MODEL_DIRS[0]))).toBe(true)
      expect(existsSync(join(stateDir, 'mineru-home', 'models', STANDARD_TIER_MODEL_DIRS[1]))).toBe(true)
      expect(statSync(srcRoot).mtimeMs).toBe(srcMtime)
      const cmds = spawnFn.mock.calls.map((c) => (c[1] as string[]).join(' '))
      expect(cmds.some((c) => c.includes('mineru-models-download'))).toBe(false)
      await sc.stop()
    }
  })

  it('cp -c 失败 → 退回普通复制，安装详情与复用日志写明约占额外磁盘', async () => {
    makeGlobalModels()
    const reuseMsgs: string[] = []
    const spawnFn = vi.fn(((_cmd: string, args: string[]) => {
      const c = makeChild()
      if (!args.join(' ').includes('mineru-api')) queueMicrotask(() => c.ee.emit('exit', 0))
      return asChildProcess(c)
    }) as unknown as SpawnLike)
    const sc = makeSidecar({
      spawnFn,
      cloneExec: async () => 1,
      onReuseProgress: (m) => reuseMsgs.push(m)
    })
    await sc.start()
    const warn = events.filter((e) => (e.installProgress?.detail ?? '').includes('无法克隆，已普通复制'))
    expect(warn.length).toBeGreaterThan(0)
    expect(warn.some((e) => /约占 \d+(\.\d+)? (KB|MB|GB) 额外磁盘/.test(e.installProgress?.detail ?? ''))).toBe(true)
    expect(reuseMsgs.some((m) => /无法克隆，已普通复制，约占 \d+(\.\d+)? (KB|MB|GB) 额外磁盘/.test(m))).toBe(true)
    expect(sc.isReady()).toBe(true)
    await sc.stop()
  })
})

describe('D145：全局无模型 → 照常下载到 App 目录', () => {
  it('假全局目录不存在 → spawn mineru-models-download（MINERU_HOME 指到 App 目录）', async () => {
    const children: FakeChild[] = []
    const spawnFn = vi.fn(((_cmd: string, args: string[]) => {
      const c = makeChild()
      children.push(c)
      if (!args.join(' ').includes('mineru-api')) queueMicrotask(() => c.ee.emit('exit', 0))
      return asChildProcess(c)
    }) as unknown as SpawnLike)
    const sc = makeSidecar({ spawnFn })
    await sc.start()
    const cmds = spawnFn.mock.calls.map((c) => (c[1] as string[]).join(' '))
    expect(cmds.some((c) => c.includes('mineru-models-download --tier standard'))).toBe(true)
    await sc.stop()
  })
})

describe('D145：复用失败 → install_failed、无半成品、重试可恢复', () => {
  it('复用中途失败（全局源里有读不了的文件）→ install_failed；清理源后重试成功到 ready', async () => {
    makeGlobalModels()
    const blocked = join(globalHome, 'models', STANDARD_TIER_MODEL_DIRS[0], 'blocked.bin')
    writeFileSync(blocked, Buffer.alloc(32))
    chmodSync(blocked, 0o000) // 读不了 → 复制中途失败
    // 假 spawn：安装步成功、服务存活
    const spawnFn = vi.fn(((_cmd: string, args: string[]) => {
      const c = makeChild()
      if (!args.join(' ').includes('mineru-api')) queueMicrotask(() => c.ee.emit('exit', 0))
      return asChildProcess(c)
    }) as unknown as SpawnLike)
    const sc = makeSidecar({ spawnFn })
    await expect(sc.install()).rejects.toThrow()
    expect(sc.status().state).toBe('install_failed')
    expect(sc.status().error).toContain('复用模型文件')
    // 无半成品：App 模型目录与临时目录都不存在
    expect(existsSync(join(stateDir, 'mineru-home', 'models'))).toBe(false)
    expect(existsSync(join(stateDir, 'mineru-home', '.models-reuse-tmp'))).toBe(false)
    // 重试可恢复：源修好后走 start() 成功到 ready
    chmodSync(blocked, 0o644)
    await sc.start()
    expect(sc.isReady()).toBe(true)
    await sc.stop()
  })
})

describe('E2/D190：App 退出同步组杀（真小子进程，只对测试自己起的进程发信号）', () => {
  it('terminateGroupsSync：SIGTERM 宽限内组退出；SIGTERM 被忽略的进程宽限后 SIGKILL', async () => {
    // ① 普通 sleep：SIGTERM 即退
    const sleep1 = realSpawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
    sleep1.unref()
    const r1 = terminateGroupsSync([sleep1.pid as number], 800)
    expect(r1.exited).toContain(sleep1.pid)
    expect(() => process.kill(-(sleep1.pid as number), 0)).toThrow() // 组已退出

    // ② trap TERM 的 shell：等 trap 装好再发信号；宽限后 SIGKILL
    const stubborn = realSpawn('sh', ['-c', 'trap "" TERM; sleep 60'], { detached: true, stdio: 'ignore' })
    stubborn.unref()
    await new Promise((r) => setTimeout(r, 150)) // sh 需要时间执行 trap 命令
    const t0 = Date.now()
    const r2 = terminateGroupsSync([stubborn.pid as number], 300)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280) // 同步等待过宽限
    expect(r2.killed).toContain(stubborn.pid)
    await new Promise((r) => setTimeout(r, 100)) // SIGKILL 生效需要一拍
    expect(() => process.kill(-(stubborn.pid as number), 0)).toThrow()
  })

  it('shutdownSync：启动中的 sidecar（真 sleep 进程组）被同步终止，start() promise 显式 settle', async () => {
    placeReadyAppModels()
    let spawnedPid: number | null = null
    const spawnFn = vi.fn(((_cmd: string, _args: string[], _opts: unknown) => {
      const c = realSpawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
      c.unref()
      spawnedPid = c.pid ?? null
      return c
    }) as unknown as SpawnLike)
    const sc = makeSidecar({ spawnFn, fetchImpl: healthFail, startTimeoutMs: 60_000 })
    const p = sc.start()
    await waitFor(() => sc.status().state === 'starting' && spawnedPid != null)
    sc.shutdownSync(800)
    await expect(p).rejects.toThrow('App 退出') // settle，不悬挂
    await new Promise((r) => setTimeout(r, 100))
    expect(() => process.kill(-(spawnedPid as number), 0)).toThrow() // 组已退出，不留孤儿
  })

  it('pidfile JSON 清孤儿：命令行含 mineru/uv 才按组杀（身份校验，pid 复用不误杀）', async () => {
    placeReadyAppModels()
    // 孤儿：真实 detached sleep（测试自己起的）
    const orphan = realSpawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
    orphan.unref()
    const orphanExited = new Promise((r) => orphan.once('exit', r))
    await new Promise((r) => setTimeout(r, 50))
    writeFileSync(
      join(stateDir, 'mineru.pid'),
      JSON.stringify({ pid: orphan.pid, pgid: orphan.pid, startedAt: new Date().toISOString() }),
      'utf8'
    )
    const c = makeChild()
    const sc = makeSidecar({
      spawnFn: (() => asChildProcess(c)) as unknown as SpawnLike,
      processInfo: () => 'uv run mineru-api --host 127.0.0.1' // 身份匹配 → 杀
    })
    await sc.start()
    await Promise.race([orphanExited, new Promise((r) => setTimeout(() => r('timeout'), 3000))]).then((v) =>
      expect(v).not.toBe('timeout')
    )
    expect(() => process.kill(-(orphan.pid as number), 0)).toThrow()
    await sc.stop()
  })

  it('pidfile JSON 指向的进程命令行不匹配 → 只清文件、不误杀', async () => {
    placeReadyAppModels()
    const innocent = realSpawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    innocent.unref()
    await new Promise((r) => setTimeout(r, 50))
    writeFileSync(
      join(stateDir, 'mineru.pid'),
      JSON.stringify({ pid: innocent.pid, pgid: innocent.pid, startedAt: new Date().toISOString() }),
      'utf8'
    )
    const c = makeChild()
    const sc = makeSidecar({
      spawnFn: (() => asChildProcess(c)) as unknown as SpawnLike,
      processInfo: () => '/usr/bin/some-other-tool' // 身份不匹配 → 不杀
    })
    await sc.start()
    expect(() => process.kill(innocent.pid as number, 0)).not.toThrow() // 还活着
    innocent.kill('SIGTERM') // 测试自己清理
    await sc.stop()
  })

  it('旧版纯数字 pidfile：对不上就不杀，只删 pidfile 并记日志', async () => {
    placeReadyAppModels()
    const orphan = realSpawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
    orphan.unref()
    await new Promise((r) => setTimeout(r, 50))
    writeFileSync(join(stateDir, 'mineru.pid'), String(orphan.pid), 'utf8')
    const logs: string[] = []
    const c = makeChild()
    const sc = makeSidecar({
      spawnFn: (() => asChildProcess(c)) as unknown as SpawnLike,
      processInfo: () => 'uv run --project /x mineru-api --host 127.0.0.1',
      log: (m) => logs.push(m)
    })
    await sc.start()
    expect(() => process.kill(orphan.pid as number, 0)).not.toThrow()
    expect(logs.some((m) => m.includes('纯数字') && m.includes('不杀'))).toBe(true)
    expect(JSON.parse(readFileSync(join(stateDir, 'mineru.pid'), 'utf8')).pid).toBe(c.pid)
    orphan.kill('SIGTERM')
    await sc.stop()
  })

  it('stop() 在子进程退出前保留 pidfile；shutdownSync 仍能杀掉忽略 SIGTERM 的进程', async () => {
    placeReadyAppModels()
    const child = realSpawn('sh', ['-c', 'trap "" TERM; sleep 60'], { detached: true, stdio: 'ignore' })
    child.unref()
    await new Promise((r) => setTimeout(r, 150))
    const pid = child.pid as number
    const sc = makeSidecar({
      spawnFn: (() => child) as unknown as SpawnLike,
      fetchImpl: healthOk(),
      startTimeoutMs: 60_000
    })
    await sc.start()
    const pidPath = join(stateDir, 'mineru.pid')
    expect(JSON.parse(readFileSync(pidPath, 'utf8')).pid).toBe(pid)
    await sc.stop()
    expect(JSON.parse(readFileSync(pidPath, 'utf8')).pid).toBe(pid)
    expect(MineruSidecar.groupAliveFor(pid)).toBe(true)
    sc.shutdownSync(300)
    await new Promise((r) => setTimeout(r, 150))
    expect(MineruSidecar.groupAliveFor(pid)).toBe(false)
    expect(existsSync(pidPath)).toBe(false)
  })

  it('SIGKILL 兜底在进程实际退出后才删 pidfile', async () => {
    placeReadyAppModels()
    const child = realSpawn('sh', ['-c', 'trap "" TERM; sleep 60'], { detached: true, stdio: 'ignore' })
    child.unref()
    await new Promise((r) => setTimeout(r, 150))
    const pid = child.pid as number
    const sc = makeSidecar({
      spawnFn: (() => child) as unknown as SpawnLike,
      sigkillGraceMs: 250
    })
    await sc.start()
    const pidPath = join(stateDir, 'mineru.pid')
    await sc.stop()
    expect(JSON.parse(readFileSync(pidPath, 'utf8')).pid).toBe(pid)
    await waitFor(() => !existsSync(pidPath) && !MineruSidecar.groupAliveFor(pid), 3000)
    expect(MineruSidecar.groupAliveFor(pid)).toBe(false)
  })
})

describe('E2：主进程信号收口（installExitSignalHandlers）', () => {
  it('SIGTERM/SIGINT/SIGHUP 注册：收到信号先同步收尾再退出（漏网路径收口）', async () => {
    const registered: string[] = []
    const exits: number[] = []
    const shutdowns: string[] = []
    const fakeProc = {
      on(sig: string, cb: () => void): void {
        registered.push(sig)
        // 不真正触发，回调经返回句柄手动调
        void cb
      }
    }
    const handlers = installExitSignalHandlers(
      () => {
        shutdowns.push('shutdown')
      },
      (code) => {
        exits.push(code)
      },
      fakeProc as never
    )
    expect(registered.sort()).toEqual(['SIGHUP', 'SIGINT', 'SIGTERM'])
    handlers.onSignal('SIGTERM')
    expect(shutdowns).toEqual(['shutdown']) // 先收尾
    expect(exits).toEqual([0]) // 再退出
    handlers.onSignal('SIGINT') // 重复信号不重复收尾
    expect(shutdowns).toHaveLength(1)
  })
})
