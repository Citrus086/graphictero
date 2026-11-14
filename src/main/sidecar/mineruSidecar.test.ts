import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { spawn as realSpawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { MineruStatusView } from '../../shared/ipc/pdf'
import {
  MineruSidecar,
  MINERU_TIER,
  commandIsOurMineruApi,
  parsePsLstart,
  startedAtMatches,
  type SpawnLike
} from './mineruSidecar'
import { STANDARD_TIER_MODEL_DIRS } from './modelReuse'

/**
 * MineruSidecar 单测：全部走假 spawn（EventEmitter 假子进程）与假 fetch，
 * 不真起 uv / MinerU。覆盖 D73（pidfile 清孤儿、exit 事件、健康轮询、总超时、
 * 自动重启一次）与 D57/D82（安装流程、简单进度、失败标记）。
 */

interface FakeChild {
  ee: EventEmitter
  pid: number
  killed: string[]
  exited: boolean
  stdout: EventEmitter
  stderr: EventEmitter
}

let nextPid = 70000
function makeChild(): FakeChild {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const child: FakeChild = { ee: new EventEmitter(), pid: nextPid++, killed: [], exited: false, stdout, stderr }
  return child
}

/** 把假子进程包装成 ChildProcess 形状；kill 后异步发 exit(1)（模拟真实进程被杀） */
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
let events: MineruStatusView[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-sidecar-'))
  sidecarDir = join(dir, 'sidecar-src')
  stateDir = join(dir, 'state')
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
    // D145 红线：全局 MinerU home 一律指向不存在的临时路径——测试绝不读写真实 ~/.mineru
    globalMineruHome: join(dir, 'global-mineru-home'),
    ...opts,
    onEvent: (v) => {
      events.push(v)
      opts.onEvent?.(v)
    }
  })
}

/** 标记已安装（跳过 uv sync / 模型下载）。两个标准档目录都非空才算就绪。 */
function markInstalled(): void {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'install-marker.json'), '{}', 'utf8')
  for (const sub of STANDARD_TIER_MODEL_DIRS) {
    mkdirSync(join(stateDir, 'mineru-home', 'models', sub), { recursive: true })
    writeFileSync(join(stateDir, 'mineru-home', 'models', sub, '.keep'), '', 'utf8')
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('MineruSidecar 安装（D57 / D82 简单进度条）', () => {
  it('找不到 uv → install_failed，错误给出安装命令，不 spawn', async () => {
    const spawnFn = vi.fn() as unknown as SpawnLike
    const sc = makeSidecar({ spawnFn, findUvBin: () => null })
    await expect(sc.install()).rejects.toThrow('找不到 uv')
    expect(spawnFn).not.toHaveBeenCalled()
    expect(sc.status().state).toBe('install_failed')
    expect(sc.status().error).toContain('MinerU 安装失败（安装依赖）：找不到 uv')
    expect(sc.status().error).toContain('curl -LsSf https://astral.sh/uv/install.sh | sh')
    expect(sc.status().error).toContain('brew install uv')
  })

  it('已安装但 uv 不见了 → start() 直接 crashed 并给出原因，不自动重启', async () => {
    markInstalled()
    const spawnFn = vi.fn() as unknown as SpawnLike
    const sc = makeSidecar({ spawnFn, findUvBin: () => null })
    await expect(sc.start()).rejects.toThrow('找不到 uv')
    expect(spawnFn).not.toHaveBeenCalled()
    expect(sc.status().state).toBe('crashed')
    expect(sc.status().error).toContain('找不到 uv')
  })

  it('用查到的 uv 绝对路径 spawn，子进程 PATH 补上常见位置', async () => {
    const spawnFn = vi.fn(((_cmd: string, _args: string[]) => {
      const c = makeChild()
      queueMicrotask(() => c.ee.emit('exit', 0))
      return asChildProcess(c)
    }) as unknown as SpawnLike)
    const sc = makeSidecar({ spawnFn, findUvBin: () => '/Users/u/.local/bin/uv' })
    await sc.install()
    expect(spawnFn.mock.calls[0][0]).toBe('/Users/u/.local/bin/uv')
    const path = String((spawnFn.mock.calls[0][2] as { env: NodeJS.ProcessEnv }).env.PATH).split(':')
    expect(path).toContain('/opt/homebrew/bin')
    expect(path).toContain('/usr/local/bin')
    expect(path.some((d) => d.endsWith('/.local/bin'))).toBe(true)
    expect(path.some((d) => d.endsWith('/.cargo/bin'))).toBe(true)
  })

  it('显式 uvBin 优先于自动查找', async () => {
    const spawnFn = vi.fn(((_cmd: string, _args: string[]) => {
      const c = makeChild()
      queueMicrotask(() => c.ee.emit('exit', 0))
      return asChildProcess(c)
    }) as unknown as SpawnLike)
    const findUvBin = vi.fn(() => '/elsewhere/uv')
    const sc = makeSidecar({ spawnFn, uvBin: '/explicit/uv', findUvBin })
    await sc.install()
    expect(spawnFn.mock.calls[0][0]).toBe('/explicit/uv')
    expect(findUvBin).not.toHaveBeenCalled()
  })

  it('未安装时 start() 先 uv sync 再下载模型，装完写标记并启动到 ready', async () => {
    const children: FakeChild[] = []
    const spawnFn = vi.fn(((_cmd: string, args: string[]) => {
      const c = makeChild()
      children.push(c)
      // 安装命令立即成功退出；mineru-api 子进程保持存活（健康检查由假 fetch 放行）
      if (!args.join(' ').includes('mineru-api')) queueMicrotask(() => c.ee.emit('exit', 0))
      return asChildProcess(c)
    }) as unknown as SpawnLike)
    const sc = makeSidecar({ spawnFn })
    await sc.start()

    const cmds = spawnFn.mock.calls.map((c) => `${c[0]} ${(c[1] as string[]).join(' ')}`)
    expect(cmds[0]).toContain('sync --project')
    expect(cmds[1]).toContain('mineru-models-download')
    expect(cmds[2]).toContain('mineru-api --host 127.0.0.1 --port 34567')
    // uat1：完整参数数组断言——下载与服务端共用 MINERU_TIER，保证「下载的档 = 服务的档」
    expect(spawnFn.mock.calls[1][1]).toEqual([
      'run', '--project', sidecarDir, 'mineru-models-download', '--tier', MINERU_TIER
    ])
    expect(spawnFn.mock.calls[2][1]).toEqual([
      'run', '--project', sidecarDir, 'mineru-api',
      '--host', '127.0.0.1', '--port', '34567', '--concurrency', '1',
      '--upload-dir', join(stateDir, 'uploads'), '--tier', MINERU_TIER
    ])
    expect(existsSync(join(stateDir, 'install-marker.json'))).toBe(true)
    expect(sc.isReady()).toBe(true)
    // 事件流：installing(带进度) → stopped → starting → ready
    const states = events.map((e) => e.state)
    expect(states).toContain('installing')
    expect(states).toContain('ready')
    const installing = events.filter((e) => e.state === 'installing')
    expect(installing.length).toBeGreaterThan(0)
    // venv 落在状态目录（.app 内只读，不能建在源码目录）
    expect(spawnFn.mock.calls[0][2]).toMatchObject({ env: expect.objectContaining({ UV_PROJECT_ENVIRONMENT: join(stateDir, 'venv') }) })
  })

  it('安装输出最后一行进 installProgress（D82 进度条数据源）', async () => {
    const c = makeChild()
    const spawnFn = vi.fn(((_cmd: string, _args: string[]) => {
      queueMicrotask(() => {
        c.stdout.emit('data', 'Downloading torch-2.9.0.whl\n')
        c.ee.emit('exit', 0)
      })
      return asChildProcess(c)
    }) as unknown as SpawnLike)
    const sc = makeSidecar({ spawnFn })
    await sc.install()
    const withDetail = events.filter((e) => e.state === 'installing' && e.installProgress?.detail)
    expect(withDetail.length).toBeGreaterThan(0)
    expect(withDetail.at(-1)?.installProgress?.detail).toContain('torch')
  })

  it('uv sync 失败 → install_failed + 阶段前缀（安装依赖），不假装可用', async () => {
    const spawnFn = vi.fn(((_cmd: string, _args: string[]) => {
      const c = makeChild()
      queueMicrotask(() => c.ee.emit('exit', 1))
      return asChildProcess(c)
    }) as unknown as SpawnLike)
    const sc = makeSidecar({ spawnFn })
    await expect(sc.install()).rejects.toThrow('uv sync 退出码 1')
    // uat1：失败是持久态 install_failed，不再退化成 not_installed
    expect(sc.status().state).toBe('install_failed')
    expect(sc.status().error).toContain('MinerU 安装失败（安装依赖）')
  })

  it('模型下载失败（4.0.12 缺 --tier 那类报错）→ install_failed + stderr 末行进 error', async () => {
    const spawnFn = vi.fn(((_cmd: string, args: string[]) => {
      const c = makeChild()
      // 依赖步（uv sync）成功；下载步失败并输出 4.0.12 的诊断（uat1 之前首启安装失败原因）
      if (!args.join(' ').includes('mineru-models-download')) {
        queueMicrotask(() => c.ee.emit('exit', 0))
      } else {
        queueMicrotask(() => {
          c.stderr.emit('data', '错误: 请传入模型仓库名或 --tier。\n')
          c.ee.emit('exit', 1)
        })
      }
      return asChildProcess(c)
    }) as unknown as SpawnLike)
    const sc = makeSidecar({ spawnFn })
    await expect(sc.install()).rejects.toThrow('uv run 退出码 1')
    expect(sc.status().state).toBe('install_failed')
    expect(sc.status().error).toContain('MinerU 安装失败（下载模型文件）')
    expect(sc.status().error).toContain('请传入模型仓库名或 --tier')
    expect(existsSync(join(stateDir, 'install-marker.json'))).toBe(false)
  })

  it('install_failed 重试（start 路径，同首启「重试」/弹层「重试」入口）：成功终态 ready 且只发一次 ready 事件', async () => {
    let fail = true
    const spawnFn = vi.fn(((_cmd: string, args: string[]) => {
      const c = makeChild()
      if (fail) {
        queueMicrotask(() => c.ee.emit('exit', 1))
      } else if (!args.join(' ').includes('mineru-api')) {
        queueMicrotask(() => c.ee.emit('exit', 0))
      }
      return asChildProcess(c)
    }) as unknown as SpawnLike)
    const sc = makeSidecar({ spawnFn })
    await expect(sc.install()).rejects.toThrow('退出码 1')
    expect(sc.status().state).toBe('install_failed')
    fail = false
    // uat1-fix1：首启界面「重试」/状态点弹层「重试」经 pdf:sidecarInstall → start()——
    // 未安装先 install 再拉服务，成功终态 ready（服务起好才 resolve），
    // 只经 ready 事件触发 D95 补排一次
    await sc.start()
    expect(sc.status().state).toBe('ready')
    expect(sc.isReady()).toBe(true)
    expect(sc.status().error).toBeNull()
    expect(existsSync(join(stateDir, 'install-marker.json'))).toBe(true)
    expect(sc.status().modelsReady).toBe(true)
    expect(events.filter((e) => e.state === 'ready')).toHaveLength(1) // 补排只挂 ready 事件，恰一次
    await sc.stop()
  })

  it('install_failed 态下 reinstall() 可用：删 venv + 标记后重装并起服务到 ready', async () => {
    let fail = true
    const spawnFn = vi.fn(((_cmd: string, args: string[]) => {
      const c = makeChild()
      if (fail) {
        queueMicrotask(() => c.ee.emit('exit', 1))
      } else if (!args.join(' ').includes('mineru-api')) {
        queueMicrotask(() => c.ee.emit('exit', 0))
      }
      return asChildProcess(c)
    }) as unknown as SpawnLike)
    const sc = makeSidecar({ spawnFn })
    await expect(sc.install()).rejects.toThrow('退出码 1')
    expect(sc.status().state).toBe('install_failed')
    fail = false
    await expect(sc.reinstall()).resolves.toBeUndefined()
    // uat1-fix1：重装不再停在 stopped（D144 不可用态），装完直接起服务到 ready
    expect(sc.status().state).toBe('ready')
    expect(existsSync(join(stateDir, 'install-marker.json'))).toBe(true)
    await sc.stop()
  })
})

describe('孤儿身份（D190：startedAt + uv run mineru-api）', () => {
  it('commandIsOurMineruApi 只认本 App 的 uv run … mineru-api', () => {
    expect(commandIsOurMineruApi('/opt/homebrew/bin/uv run --project /app/sidecar/mineru mineru-api --host 127.0.0.1 --port 9 --tier standard')).toBe(true)
    expect(commandIsOurMineruApi('uv run mineru-api')).toBe(true)
    expect(commandIsOurMineruApi('/opt/homebrew/bin/uv sync --project /tmp')).toBe(false)
    expect(commandIsOurMineruApi('python -c something-mineru')).toBe(false)
    expect(commandIsOurMineruApi('/usr/bin/something-with-mineru-and-uv')).toBe(false)
    expect(commandIsOurMineruApi('uv run python -c import time')).toBe(false)
  })

  it('startedAtMatches 容差内算同一次启动，差一分钟不算', () => {
    const now = Date.parse('2026-10-28T11:20:19.000Z')
    expect(startedAtMatches(new Date(now).toISOString(), now + 14_000)).toBe(true)
    expect(startedAtMatches(new Date(now).toISOString(), now + 60_000)).toBe(false)
    expect(startedAtMatches('not-a-date', now)).toBe(false)
  })

  it('parsePsLstart 能解析本机 ps -o lstart=（只信号自己起的 sleep）', () => {
    const sleep = realSpawn('/bin/sleep', ['30'])
    try {
      const out = spawnSync('ps', ['-p', String(sleep.pid), '-o', 'lstart='], {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' }
      })
      const ms = parsePsLstart(out.stdout ?? '')
      expect(ms).not.toBeNull()
      expect(Math.abs((ms as number) - Date.now())).toBeLessThan(15_000)
    } finally {
      sleep.kill('SIGTERM')
    }
  })
})

describe('MineruSidecar 启动 / pidfile（D73）', () => {
  it('已安装时直接拉起：写 pidfile、随机端口、健康通过后 ready', async () => {
    markInstalled()
    const c = makeChild()
    const spawnFn = vi.fn((() => asChildProcess(c)) as unknown as SpawnLike)
    const sc = makeSidecar({ spawnFn })
    await sc.start()
    expect(sc.isReady()).toBe(true)
    expect(JSON.parse(readFileSync(join(stateDir, 'mineru.pid'), 'utf8')).pid).toBe(c.pid) // E2：pidfile 为 JSON
    expect(sc.baseUrl()).toBe('http://127.0.0.1:34567')
    await sc.stop()
    expect(c.killed).toContain('SIGTERM')
    expect(existsSync(join(stateDir, 'mineru.pid'))).toBe(false)
  })

  it('pidfile 清孤儿：启动时间与 uv run mineru-api 都对上才组杀', async () => {
    markInstalled()
    mkdirSync(stateDir, { recursive: true })
    const orphan = realSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'])
    await new Promise((r) => setTimeout(r, 50))
    const startedAt = new Date().toISOString()
    const orphanExited = new Promise((r) => orphan.once('exit', r))
    writeFileSync(
      join(stateDir, 'mineru.pid'),
      JSON.stringify({ pid: orphan.pid, pgid: orphan.pid, startedAt }),
      'utf8'
    )
    const c = makeChild()
    const sc = makeSidecar({
      spawnFn: (() => asChildProcess(c)) as unknown as SpawnLike,
      processInfo: () => 'uv run --project /tmp/sidecar mineru-api --host 127.0.0.1 --port 9 --tier standard',
      processStartedAt: () => Date.parse(startedAt)
    })
    await sc.start()
    expect(sc.isReady()).toBe(true)
    await Promise.race([
      orphanExited,
      new Promise((r) => setTimeout(() => r('timeout'), 3000))
    ]).then((v) => expect(v).not.toBe('timeout'))
    orphan.unref()
  })

  it('命令行只有 uv 或 mineru 子串、或启动时间对不上 → 不杀', async () => {
    markInstalled()
    mkdirSync(stateDir, { recursive: true })
    const innocent = realSpawn('/bin/sleep', ['30'])
    await new Promise((r) => setTimeout(r, 50))
    const startedAt = new Date(Date.now() - 120_000).toISOString()
    writeFileSync(
      join(stateDir, 'mineru.pid'),
      JSON.stringify({ pid: innocent.pid, pgid: innocent.pid, startedAt }),
      'utf8'
    )
    const logs: string[] = []
    const c = makeChild()
    const sc = makeSidecar({
      spawnFn: (() => asChildProcess(c)) as unknown as SpawnLike,
      processInfo: () => 'uv run --project /tmp/sidecar mineru-api --host 127.0.0.1 --port 9 --tier standard',
      processStartedAt: () => Date.now(),
      log: (m) => logs.push(m)
    })
    await sc.start()
    expect(sc.isReady()).toBe(true)
    expect(() => process.kill(innocent.pid as number, 0)).not.toThrow()
    expect(logs.some((m) => m.includes('启动时间与进程不符'))).toBe(true)
    expect(JSON.parse(readFileSync(join(stateDir, 'mineru.pid'), 'utf8')).pid).toBe(c.pid)
    innocent.kill('SIGTERM')
    innocent.unref()
  })

  it('命令行不是本 App 的 mineru-api → 只清文件、不误杀', async () => {
    markInstalled()
    mkdirSync(stateDir, { recursive: true })
    const innocent = realSpawn('/bin/sleep', ['30'])
    await new Promise((r) => setTimeout(r, 50))
    const startedAt = new Date().toISOString()
    writeFileSync(
      join(stateDir, 'mineru.pid'),
      JSON.stringify({ pid: innocent.pid, pgid: innocent.pid, startedAt }),
      'utf8'
    )
    const c = makeChild()
    const sc = makeSidecar({
      spawnFn: (() => asChildProcess(c)) as unknown as SpawnLike,
      processInfo: () => '/bin/sleep 30',
      processStartedAt: () => Date.parse(startedAt)
    })
    await sc.start()
    expect(sc.isReady()).toBe(true)
    expect(() => process.kill(innocent.pid as number, 0)).not.toThrow()
    expect(JSON.parse(readFileSync(join(stateDir, 'mineru.pid'), 'utf8')).pid).toBe(c.pid)
    innocent.kill('SIGTERM')
    innocent.unref()
  })

  it('死 pid 的 pidfile 只清文件、不报错', async () => {
    markInstalled()
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'mineru.pid'), '999999', 'utf8') // 不存在的 pid
    const c = makeChild()
    const sc = makeSidecar({ spawnFn: (() => asChildProcess(c)) as unknown as SpawnLike })
    await sc.start()
    expect(sc.isReady()).toBe(true)
  })
})

describe('MineruSidecar 崩溃与重启（D73/D99：exit 事件 / 健康轮询 / 每次崩溃自动重启一次）', () => {
  it('D99：崩溃→自动重启成功→计数清零→再崩溃→再次自动重启', async () => {
    markInstalled()
    const children: FakeChild[] = []
    const spawnFn = vi.fn((() => {
      const c = makeChild()
      children.push(c)
      return asChildProcess(c)
    }) as unknown as SpawnLike)
    const sc = makeSidecar({ spawnFn })
    await sc.start()
    expect(children.length).toBe(1)
    // 第一次崩溃 → 自动重启
    children[0].ee.emit('exit', 1)
    await waitFor(() => children.length >= 2)
    expect(events.some((e) => e.state === 'restarting')).toBe(true)
    await waitFor(() => sc.isReady())
    // 第二次崩溃 → 重启成功已清零计数 → 再次自动重启（不是整个生命周期只一次）
    children[1].ee.emit('exit', 1)
    await waitFor(() => children.length >= 3)
    await waitFor(() => sc.isReady())
    expect(sc.isReady()).toBe(true)
    expect(events.filter((e) => e.state === 'restarting').length).toBe(2)
  })

  it('D99：重启本身失败（未达健康就再崩）→ 不再自动重启，进入失败态', async () => {
    markInstalled()
    const children: FakeChild[] = []
    const spawnFn = vi.fn((() => {
      const c = makeChild()
      children.push(c)
      return asChildProcess(c)
    }) as unknown as SpawnLike)
    const sc = makeSidecar({ spawnFn })
    await sc.start()
    expect(children.length).toBe(1)
    // 第一次崩溃 → 自动重启
    children[0].ee.emit('exit', 1)
    await waitFor(() => children.length >= 2)
    // 重启拉起后未健康就再崩（启动中退出）→ 不再自动重启 → crashed
    children[1].ee.emit('exit', 1)
    await waitFor(() => sc.status().state === 'crashed')
    expect(sc.status().error).toContain('意外退出')
    await new Promise((r) => setTimeout(r, 200))
    expect(children.length).toBe(2) // 没有第三次 spawn
  })

  it('健康检查连续失败 → 杀进程重启；重启后恢复健康 → ready', async () => {
    markInstalled()
    const children: FakeChild[] = []
    const spawnFn = vi.fn((() => {
      const c = makeChild()
      children.push(c)
      return asChildProcess(c)
    }) as unknown as SpawnLike)
    let healthy = false
    const fetchFn = (async () => {
      if (!healthy) throw new Error('down')
      return new Response(JSON.stringify({ status: 'ok', version: '4.0.12' }), { status: 200 })
    }) as unknown as typeof fetch
    const sc = makeSidecar({ spawnFn, fetchImpl: fetchFn, healthFailLimit: 2, healthPollMs: 15 })
    // 启动阶段先把健康打开放行
    healthy = true
    await sc.start()
    expect(sc.isReady()).toBe(true)
    // 运行期健康连续失败 → 触发重启
    healthy = false
    for (let i = 0; i < 100 && children.length < 2; i++) await new Promise((r) => setTimeout(r, 20))
    expect(children.length).toBe(2)
    expect(children[0].killed.length).toBeGreaterThan(0)
    expect(events.some((e) => e.state === 'restarting')).toBe(true)
    // 重启后恢复 → ready
    healthy = true
    for (let i = 0; i < 100 && !sc.isReady(); i++) await new Promise((r) => setTimeout(r, 10))
    expect(sc.isReady()).toBe(true)
  })

  it('启动总超时（D73 总超时）→ crashed + 中文原因', async () => {
    markInstalled()
    const t0 = Date.now()
    const spawnFn = vi.fn((() => asChildProcess(makeChild())) as unknown as SpawnLike)
    const sc = makeSidecar({
      spawnFn,
      fetchImpl: healthFail,
      now: () => Date.now() - t0, // 相对时钟：真实推进，100ms 后超时
      readyPollMs: 5,
      startTimeoutMs: 100
    })
    await expect(sc.start()).rejects.toThrow('总超时')
    for (let i = 0; i < 100 && sc.status().state !== 'crashed'; i++) await new Promise((r) => setTimeout(r, 10))
    expect(sc.status().state).toBe('crashed')
    expect(sc.status().error).toContain('总超时')
  })
})

describe('MineruSidecar 启动 settle（必 2：start() promise 不得悬挂）', () => {
  it('启动中子进程退出 → start() 最终 settle（reject），自动重启状态正确', async () => {
    markInstalled()
    const children: FakeChild[] = []
    const spawnFn = vi.fn((() => {
      const c = makeChild()
      children.push(c)
      return asChildProcess(c)
    }) as unknown as SpawnLike)
    const sc = makeSidecar({ spawnFn, fetchImpl: healthFail, startTimeoutMs: 60_000 })
    const p = sc.start()
    await waitFor(() => children.length === 1)
    await waitFor(() => sc.status().state === 'starting')
    children[0].ee.emit('exit', 1) // 启动中死亡（端口被占/首启崩溃那类）
    await expect(p).rejects.toThrow('意外退出') // IPC pdf:sidecarStart 能回包了
    await waitFor(() => children.length === 2) // 仍自动重启一次
    await waitFor(() => sc.status().state === 'starting')
    children[1].ee.emit('exit', 1)
    await waitFor(() => sc.status().state === 'crashed')
    expect(sc.status().error).toContain('意外退出')
  })

  it('启动中 stop() → start() settle（reject），状态 stopped', async () => {
    markInstalled()
    const c = makeChild()
    const sc = makeSidecar({
      spawnFn: (() => asChildProcess(c)) as unknown as SpawnLike,
      fetchImpl: healthFail,
      startTimeoutMs: 60_000
    })
    const p = sc.start()
    await waitFor(() => sc.status().state === 'starting')
    await sc.stop()
    await expect(p).rejects.toThrow('已停止')
    expect(sc.status().state).toBe('stopped')
  })
})

describe('MineruSidecar 安装/启动交错保护（建 3）', () => {
  it('安装中 start()/reinstall() 拒绝；stop() 一并终止安装子进程', async () => {
    const c = makeChild()
    const spawnFn = vi.fn((() => asChildProcess(c)) as unknown as SpawnLike)
    const sc = makeSidecar({ spawnFn })
    const installP = sc.install()
    await waitFor(() => sc.status().state === 'installing')
    await expect(sc.start()).rejects.toThrow('正在安装中')
    await expect(sc.reinstall()).rejects.toThrow('正在安装中')
    await sc.stop()
    expect(c.killed).toContain('SIGTERM') // 安装子进程被一并终止
    await expect(installP).rejects.toThrow('uv sync 退出码 1')
  })

  it('spawn 失败（uv 不存在 / EMFILE）→ start() settle 且 crashed，不 uncaught', async () => {
    markInstalled()
    const c = makeChild()
    const sc = makeSidecar({
      spawnFn: (() => asChildProcess(c)) as unknown as SpawnLike,
      startTimeoutMs: 60_000,
      maxRestarts: 0
    })
    const p = sc.start()
    await waitFor(() => sc.status().state === 'starting')
    c.ee.emit('error', new Error('spawn uv ENOENT'))
    await expect(p).rejects.toThrow('无法启动')
    await waitFor(() => sc.status().state === 'crashed')
    expect(sc.status().error).toContain('ENOENT')
  })
})

describe('MineruSidecar 页级进度（D72 best-effort）', () => {
  it('从子进程输出解析 window 行', async () => {
    markInstalled()
    const c = makeChild()
    const sc = makeSidecar({ spawnFn: (() => asChildProcess(c)) as unknown as SpawnLike })
    await sc.start()
    c.stderr.emit('data', 'Hybrid processing-window run. page_count=10, window_size=64, total_windows=1\n')
    expect(sc.pageProgress()).toEqual({ pagesDone: null, pagesTotal: 10 })
    c.stdout.emit('data', 'Hybrid processing window 1/1: pages 1-4/10 (4 pages)\n')
    expect(sc.pageProgress()).toEqual({ pagesDone: 4, pagesTotal: 10 })
  })
})
