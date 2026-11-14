#!/usr/bin/env node
/**
 * UI 冒烟（M1 第三批评审）：临时数据目录 + 合成数据，真实 renderer 窗口里
 * 走 新建图谱 → 添加论文 → 拖拽 → 手工连边 → 重启验证（详见 src/main/smokeUi.ts）。
 *
 * 用法：node scripts/run-ui-smoke.mjs [--build]
 * 直接 node 默认复用现有 out；smoke:ui 传 --build，在 hygiene 启动后构建。
 */
import { spawnSync } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finishRunHygiene, startRunHygiene } from './runHygiene.mjs'

const projectRoot = process.cwd()
// 必须在 --build 前记录：electron-vite 的临时 config 与其它顶层新增都以这里为基准。
const hygiene = startRunHygiene(projectRoot)
const shouldBuild = process.argv.slice(2).includes('--build')
let root = null
let ok = false

try {
  if (shouldBuild) execFileSync('pnpm', ['run', 'build'], { cwd: projectRoot, stdio: 'inherit' })

  // uat6c：启动前的构建产物 / electron dist 只读自检（不联网；缺什么给修复提示）
  execFileSync(process.execPath, [join(projectRoot, 'scripts', 'check-electron-dist.mjs')], { stdio: 'inherit' })

  root = mkdtempSync(join(tmpdir(), 'gt-ui-smoke-'))
  const out = join(root, 'smoke-result.json')
  // uat1：Electron userData 与数据根同父目录下的独立子目录——dev 包名 graphictero 与打包名
  // Graphictero 在 macOS 大小写不敏感文件系统上是同一个默认目录，必须显式隔离，保证
  // 永不写默认 ~/Library/Application Support/Graphictero（含 data-root.json）
  const userDataDir = join(root, 'user-data')
  const bin = join(projectRoot, 'node_modules', '.bin', 'electron')

  console.log(`[smoke] 临时数据根：${root}`)

  // 终审建议修 3：构建产物的 CSP meta 不得带 dev 白名单（ws/http localhost）或占位符
  const builtHtml = readFileSync(join(projectRoot, 'out/renderer/index.html'), 'utf8')
  const cspMeta = builtHtml.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/)?.[1] ?? ''
  if (!cspMeta || cspMeta.includes('localhost') || cspMeta.includes('%CSP_DEV_CONNECT%') || !cspMeta.includes("connect-src 'self'")) {
    console.error('[smoke] 构建产物 CSP 异常（含 localhost 白名单 / 占位符残留 / connect-src 缺失）：', cspMeta)
    throw new Error('CSP 自检失败')
  }
  const r = spawnSync(bin, ['--user-data-dir=' + userDataDir, 'out/main/index.js', '--smoke-ui', out], {
    env: { ...process.env, GRAPHICTERO_DATA_ROOT: root },
    encoding: 'utf8',
    // uat7 在 148 步上增加选择/用量/详情测量，含 mermaid 最长 20s 等待，120s 会在收尾前被杀掉。
    timeout: 300000
  })
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)

  ok = r.status === 0
  try {
    const result = JSON.parse(readFileSync(out, 'utf8'))
    console.log('[smoke] 结果：')
    console.log(JSON.stringify(result, null, 2))
    ok = result.ok === true
  } catch {
    console.error('[smoke] 未生成结果文件')
    ok = false
  }
} catch (error) {
  console.error(`[smoke] 启动失败：${error instanceof Error ? error.message : String(error)}`)
  ok = false
} finally {
  if (root) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch (error) {
      console.error(`[smoke] 临时数据根清理失败：${error instanceof Error ? error.message : String(error)}`)
      ok = false
    }
  }
  try {
    const result = finishRunHygiene(hygiene)
    if (result.added.length > 0) {
      console.error(`[smoke] hygiene 发现新增顶层条目：${result.added.join('、')}`)
      ok = false
    }
  } catch (error) {
    console.error(`[smoke] hygiene 清理/检查失败：${error instanceof Error ? error.message : String(error)}`)
    ok = false
  }
}
console.log(ok ? '[smoke] 通过' : '[smoke] 失败')
process.exit(ok ? 0 : 1)
