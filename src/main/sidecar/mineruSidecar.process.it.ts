import { describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MineruSidecar, type SpawnLike } from './mineruSidecar'

/**
 * 真进程集成验证（评审必 1）：`uv run` 是 wrapper，mineru-api 是孙进程。
 * 用真 uv 起假 sidecar（`uv run python -c "import time; time.sleep(60)"`），验证：
 *   1. stop() 进程组杀：uv wrapper 和 python 孙进程一起死（只杀 wrapper 会泄漏）；
 *   2. cleanupOrphan 进程组杀：pidfile 指向活着的 uv wrapper 时，孙进程也被清掉。
 *
 * 不进默认 `pnpm test`（*.it.ts，走 vitest.smoke.config.ts 的 include 口径）。
 * 跑：`pnpm exec vitest run --config vitest.smoke.config.ts src/main/sidecar/mineruSidecar.process.it.ts`
 * 无需真 MinerU：假 sidecar 只占住 uv wrapper + python 孙进程，模型/依赖都不装。
 */

const UV_FAKE_SIDECAR = ['run', 'python', '-c', 'import time; time.sleep(60)  # mineru-api'] as const

/** uv 不在 PATH（CI/他人机器）则跳过：集成验证只在有 uv 的本机跑 */
const hasUv = ((): boolean => {
  try {
    spawnSync('uv', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const itUv = hasUv ? it : it.skip

const healthOk = (async () =>
  new Response(JSON.stringify({ status: 'ok', version: 'fake' }), { status: 200 })) as unknown as typeof fetch

let dir: string
let stateDir: string
let sidecarDir: string

function setup(): void {
  dir = mkdtempSync(join(tmpdir(), 'gt-sidecar-proc-'))
  stateDir = join(dir, 'state')
  sidecarDir = join(dir, 'src')
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(sidecarDir, { recursive: true })
  writeFileSync(join(stateDir, 'install-marker.json'), '{}', 'utf8') // 跳过安装
  // D145：App 模型目录已有内容，start() 不再走全局复用（本集成测试绝不读真实 ~/.mineru）
  for (const sub of ['MinerU-4_models_torch', 'MinerU2.5-Pro-2605-1.2B-GGUF']) {
    mkdirSync(join(stateDir, 'mineru-home', 'models', sub), { recursive: true })
    writeFileSync(join(stateDir, 'mineru-home', 'models', sub, '.keep'), '', 'utf8')
  }
}

function readRecordedPid(file: string): number {
  const raw = readFileSync(file, 'utf8').trim()
  try {
    const parsed = JSON.parse(raw) as { pid?: number } | number
    if (typeof parsed === 'number') return parsed
    if (parsed && typeof parsed.pid === 'number') return parsed.pid
  } catch {
    // 旧版纯数字 pidfile
  }
  return Number(raw)
}

function teardown(): void {
  rmSync(dir, { recursive: true, force: true })
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

/** 假子进程（EventEmitter），健康检查由假 fetch 放行 → start() 立即 ready */
function fakeSpawn(): SpawnLike {
  return (() => {
    const ee = new EventEmitter() as EventEmitter & { pid?: number } & Partial<ChildProcess>
    ee.pid = 90001
    ee.kill = (() => true) as ChildProcess['kill']
    return ee as ChildProcess
  }) as unknown as SpawnLike
}

function makeSidecar(spawnFn: SpawnLike): MineruSidecar {
  return new MineruSidecar({
    sidecarDir,
    stateDir,
    fetchImpl: healthOk,
    spawnFn,
    randomPort: () => 34567,
    readyPollMs: 10,
    // D145 红线：全局 MinerU home 指向临时路径，不读真实 ~/.mineru
    globalMineruHome: join(dir, 'not-the-real-mineru')
  })
}

describe('MineruSidecar 真进程组杀（必 1，真 uv + 假 sidecar）', () => {
  itUv(
    'stop() 进程组杀：uv wrapper 与 python 孙进程一起死（只杀 wrapper 会泄漏孙进程）',
    { timeout: 30_000 },
    async () => {
      setup()
      try {
        // spawnFn 换成真 spawn，但命令换成假 sidecar：真 uv wrapper + python 孙进程
        const realSpawnFn = ((_cmd: string, _args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; detached?: boolean }) =>
          spawn('uv', [...UV_FAKE_SIDECAR], { ...opts, stdio: 'ignore' })) as unknown as SpawnLike
        const sc = makeSidecar(realSpawnFn)
        await sc.start()
        expect(sc.isReady()).toBe(true)
        const uvPid = readRecordedPid(join(stateDir, 'mineru.pid'))
        expect(groupAlive(uvPid)).toBe(true)

        await sc.stop()

        // 宽限 3 秒（SIGTERM 后还有 SIGKILL 兜底），轮询最多 5 秒
        const deadline = Date.now() + 5000
        while (groupAlive(uvPid) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100))
        }
        // 进程组（uv wrapper + python 孙进程同组）整体消失
        expect(groupAlive(uvPid)).toBe(false)
      } finally {
        teardown()
      }
    }
  )

  itUv(
    'cleanupOrphan 进程组杀：pidfile 指向活着的 uv wrapper → 孙进程一并清掉',
    { timeout: 30_000 },
    async () => {
      setup()
      // 上一个会话泄漏的 sidecar：uv wrapper 活着、python 孙进程同组
      const startedAt = new Date().toISOString()
      const leaked = spawn('uv', [...UV_FAKE_SIDECAR], { detached: true, stdio: 'ignore' })
      const uvPid = leaked.pid as number
      try {
        // 等 uv 把 python 孙进程拉起来（wrapper 命令行进 ps 也要时间）
        const t0 = Date.now()
        for (;;) {
          const out = spawnSync('ps', ['-p', String(uvPid), '-o', 'command=']).stdout.toString()
          if (out.includes('uv') || Date.now() - t0 > 10_000) break
          await new Promise((r) => setTimeout(r, 100))
        }
        expect(groupAlive(uvPid)).toBe(true)

        // 上个会话的 pidfile：pid + 启动时间。命令行里带 mineru-api，cleanup 才认。
        writeFileSync(
          join(stateDir, 'mineru.pid'),
          JSON.stringify({ pid: uvPid, pgid: uvPid, startedAt }),
          'utf8'
        )

        const sc = makeSidecar(fakeSpawn())
        await sc.start()
        expect(sc.isReady()).toBe(true)

        // 孤儿进程组被清掉（SIGKILL 立即生效）
        const deadline = Date.now() + 5000
        while (groupAlive(uvPid) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100))
        }
        expect(groupAlive(uvPid)).toBe(false)
        // 新 sidecar 的 pidfile 是假子进程的，不受影响
        expect(existsSync(join(stateDir, 'mineru.pid'))).toBe(true)
      } finally {
        try {
          process.kill(-uvPid, 'SIGKILL')
        } catch {
          // 已清掉
        }
        teardown()
      }
    }
  )
})
