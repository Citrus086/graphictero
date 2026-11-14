#!/usr/bin/env node
/**
 * D146：开发隔离启动——持久的开发专用数据根。
 *
 * 背景（D146/D190）：开发版与已安装 App 不再共用默认数据目录
 * （~/Library/Application Support/Graphictero）。D145 后模型跟着数据根走，
 * 所以开发数据根必须持久（不能每次 mktemp——否则每回开发都触发几 GB 模型
 * 复用/下载）。
 *
 * 行为：
 * - 默认：数据根 = 非空的 GRAPHICTERO_DEV_DATA_ROOT，否则 ~/Library/Application Support/Graphictero-dev
 *   （持久，首次启动按 D145 从 ~/.mineru/models 克隆复用，之后不再重复）；
 *   user-data-dir = <数据根>/user-data。
 * - --tmp：保留旧的 mktemp 行为（一次性干净环境，给需要干净数据的场景）。
 * - 守卫：解析出的开发数据根与默认 App 目录相同 → 报错退出（D146 红线，
 *   绝不指向默认 ~/Library/Application Support/Graphictero）。
 * - --print：只打印解析结果 JSON 不启动（测试用）。
 *
 * 启动方式：spawn electron-vite dev，GRAPHICTERO_DATA_ROOT 注入环境，
 * `-- --user-data-dir=...` 传给 Electron（uat1 隔离验证会断言 userData 生效）。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 默认 App 数据目录（守卫对比对象；与 src/main/dataDir.ts defaultDataRoot 同源） */
export function defaultAppDataDir(home = homedir()) {
  return join(home, 'Library', 'Application Support', 'Graphictero')
}

/** 开发数据根解析（D146）：默认持久开发目录。空字符串视为未设置。 */
export function resolveDevDataRoot(env = process.env, home = homedir()) {
  const raw = env.GRAPHICTERO_DEV_DATA_ROOT
  if (typeof raw !== 'string' || raw.trim() === '') {
    return join(home, 'Library', 'Application Support', 'Graphictero-dev')
  }
  return raw
}

/** realpath 解引用（目标不存在时向上找存在的祖先；与 main/dataDir.ts 同思路） */
function resolveReal(p) {
  let cur = resolve(p)
  const tail = []
  for (;;) {
    try {
      return join(realpathSync(cur), ...tail)
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return resolve(p)
      tail.unshift(cur.slice(parent.length + 1))
      cur = parent
    }
  }
}

function main() {
  const tmp = process.argv.includes('--tmp')
  const printOnly = process.argv.includes('--print')

  let dataRoot
  let userDataDir
  if (tmp) {
    // 一次性干净环境（旧 mktemp 行为）
    dataRoot = mkdtempSync(join(tmpdir(), 'gt-dev-data-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'gt-dev-userdata-'))
  } else {
    dataRoot = resolveDevDataRoot()
    userDataDir = join(dataRoot, 'user-data')
    // D146 守卫：开发数据根绝不等于默认 App 数据目录（含符号链接/大小写绕过）
    const norm = (p) => (process.platform === 'darwin' ? p.toLowerCase() : p)
    if (norm(resolveReal(dataRoot)) === norm(resolveReal(defaultAppDataDir()))) {
      console.error(
        `[dev-isolated] 拒绝启动：开发数据根与默认 App 数据目录相同（${dataRoot}）。\n` +
          '默认开发目录是 Graphictero-dev；请改用其它 GRAPHICTERO_DEV_DATA_ROOT，或用 --tmp 一次性环境。'
      )
      process.exit(1)
    }
  }

  const cleanupTmp = () => {
    if (!tmp) return
    rmSync(dataRoot, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }

  if (printOnly) {
    console.log(JSON.stringify({ dataRoot, userDataDir, tmp }))
    cleanupTmp()
    return
  }

  console.log(`[dev-isolated] 数据根：${dataRoot}${tmp ? '（一次性）' : '（持久开发目录）'}`)
  const child = spawn(join(root, 'node_modules', '.bin', 'electron-vite'), ['dev', '--', `--user-data-dir=${userDataDir}`], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, GRAPHICTERO_DATA_ROOT: dataRoot }
  })
  child.on('exit', (code) => {
    cleanupTmp()
    process.exit(code ?? 0)
  })
  child.on('error', () => {
    cleanupTmp()
    process.exit(1)
  })
}

// 直接执行才启动（被测试 import 时不拉起 electron-vite）
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main()
}
