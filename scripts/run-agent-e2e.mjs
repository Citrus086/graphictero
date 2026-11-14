#!/usr/bin/env node
/**
 * 真实 IPC 端到端冒烟（chat→main 合并批清单①，review_lane_chat4 §六-2）：
 * `--agent-e2e` 模式的启动包装（对齐 scripts/run-ui-smoke.mjs）。
 *
 * 与 smoke:ui 的区别：窗口**不带 ?smoke=1**，渲染层走真实 preload 桥
 * （window.graphictero → ipcMain.handle → AgentRuntime）；LLM 经
 * GRAPHICTERO_LLM_BASE_URL 测试缝指向主进程内启动的 stubServer，
 * **绝不调真实 DeepSeek / 任何付费 API**。
 *
 * 用法：node scripts/run-agent-e2e.mjs（前置 pnpm run build；退出码 = 结果）。
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finishRunHygiene, startRunHygiene } from './runHygiene.mjs'

const projectRoot = process.cwd()
const hygiene = startRunHygiene(projectRoot)
let root = null
let timer = null
let ok = false

/** Electron 忽略 SIGTERM 时 spawn 的 timeout 会一直等。只结束命令行里带本次临时目录的进程。 */
function killMatching(token) {
  let listing = ''
  try {
    listing = execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' })
  } catch {
    return
  }
  for (const line of listing.split('\n')) {
    if (!line.includes(token)) continue
    const pid = Number(line.trim().split(/\s+/)[0])
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 已经退出
    }
  }
}

try {
  root = mkdtempSync(join(tmpdir(), 'gt-agent-e2e-'))
  const out = join(root, 'agent-e2e-result.json')
  // uat1：Electron userData 与数据根同父目录下的独立子目录——永不写默认
  // ~/Library/Application Support/Graphictero（dev 包名 graphictero 与打包名 Graphictero
  // 在 macOS 大小写不敏感文件系统上是同一个目录，会互相污染，包括 data-root.json）
  const userDataDir = join(root, 'user-data')
  const bin = join(projectRoot, 'node_modules', '.bin', 'electron')

  console.log(`[agent-e2e] 临时数据根：${root}`)

  const child = spawn(bin, ['--user-data-dir=' + userDataDir, 'out/main/index.js', '--agent-e2e', out], {
    env: { ...process.env, GRAPHICTERO_DATA_ROOT: root, GRAPHICTERO_SIDECAR: 'off' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (s) => process.stdout.write(s))
  child.stderr.on('data', (s) => process.stderr.write(s))
  timer = setTimeout(() => {
    console.error('[agent-e2e] 超时，结束本次测试进程')
    killMatching(root)
  }, 180000)
  const status = await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code))
    child.on('error', () => resolve(1))
  })
  clearTimeout(timer)
  timer = null
  killMatching(root)

  ok = status === 0
  try {
    const result = JSON.parse(readFileSync(out, 'utf8'))
    console.log('[agent-e2e] 结果：')
    console.log(JSON.stringify(result, null, 2))
    ok = result.ok === true
  } catch {
    console.error('[agent-e2e] 未生成结果文件')
    ok = false
  }
} catch (error) {
  console.error(`[agent-e2e] 启动/运行失败：${error instanceof Error ? error.message : String(error)}`)
  ok = false
} finally {
  if (timer) clearTimeout(timer)
  if (root) killMatching(root)
  if (root) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch (error) {
      console.error(`[agent-e2e] 临时数据根清理失败：${error instanceof Error ? error.message : String(error)}`)
      ok = false
    }
  }
  try {
    const result = finishRunHygiene(hygiene)
    if (result.added.length > 0) {
      console.error(`[agent-e2e] hygiene 发现新增顶层条目：${result.added.join('、')}`)
      ok = false
    }
  } catch (error) {
    console.error(`[agent-e2e] hygiene 清理/检查失败：${error instanceof Error ? error.message : String(error)}`)
    ok = false
  }
}
console.log(ok ? '[agent-e2e] 通过' : '[agent-e2e] 失败')
process.exit(ok ? 0 : 1)
