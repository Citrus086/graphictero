/**
 * 构建产物 / Electron dist 自检库（E1/d145d146）——不联网、不下载、不写任何文件。
 *
 * 背景：测试者 复测时发现某次 checkout 的 electron dist 不完整（260K、缺 path.txt；
 * 本机复现根因：electron 的 postinstall（install.js 下载 dist）在 pnpm 下未执行
 * 或被中断，如 ELECTRON_SKIP_BINARY_DOWNLOAD=1 / --ignore-scripts）。uat6c 加了
 * 只读自检但只接入 smoke；本批（E1）把它接进 postinstall / dev / dev:isolated /
 * build 之前，不完整就明确失败（非零退出 + 缺什么/为什么/怎么修）。
 *
 * 检查项：
 *  - full（默认，smoke 前）：构建产物 out/ 三端 + electron dist + better-sqlite3 绑定；
 *  - runtime（--runtime，dev/build 前）：electron dist + path.txt + better-sqlite3 绑定
 *    （不要求 out/ 已构建）。
 *
 * 退出码（bitmask）：0 完整；1 构建产物（out/）问题；2 electron dist 问题；
 * 4 better-sqlite3 原生绑定问题；多类相加。
 *
 * 修复提示只给命令建议；离线自愈（--fix）在 electronDistHeal.mjs，只在
 * postinstall / `pnpm fix:electron-dist` 里做，dev / build 前只检查不改文件。
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { createRequire } from 'node:module'

export const EXIT = { ok: 0, build: 1, dist: 2, binding: 4 }

export const CATEGORY_LABEL = {
  build: '构建产物（out/）',
  dist: 'electron dist',
  binding: 'better-sqlite3 原生绑定'
}

function nonEmpty(p) {
  try {
    return statSync(p).size > 0
  } catch {
    return false
  }
}

/** electron 的 install.js 被跳过/中断的提示（E1：区分 ELECTRON_SKIP_BINARY_DOWNLOAD 场景） */
function skipHint() {
  return process.env.ELECTRON_SKIP_BINARY_DOWNLOAD
    ? '检测到 ELECTRON_SKIP_BINARY_DOWNLOAD 已设置——electron 的 install.js 被跳过，dist 不会被下载。'
    : '常见原因：electron 的 install.js 在 pnpm 下未执行或被中断（如安装时设了 ELECTRON_SKIP_BINARY_DOWNLOAD=1 或 --ignore-scripts）。'
}

/**
 * 自检。runtime=true 只查 electron dist + path.txt + 原生绑定（dev/build 前）；
 * runtime=false 额外查 out/ 构建产物（smoke 前完整检查）。
 */
export function checkElectronDist(root, { runtime = false } = {}) {
  const problems = []
  const push = (category, message) => problems.push({ category, message })
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

  if (!runtime) {
    const mainEntry = pkg.main ? (isAbsolute(pkg.main) ? pkg.main : join(root, pkg.main)) : null
    if (mainEntry == null || !nonEmpty(mainEntry ?? '')) {
      push('build', `构建产物缺失或为空：package.json main = ${pkg.main ?? '(未设置)'}（先跑 pnpm build）`)
    }
    for (const [label, rel] of [
      ['main 入口', 'out/main/index.js'],
      ['preload 入口', 'out/preload/index.js'],
      ['renderer 页面', 'out/renderer/index.html']
    ]) {
      if (!nonEmpty(join(root, rel))) push('build', `${label}缺失或为空：${rel}（先跑 pnpm build）`)
    }
  }

  // electron dist（postinstall 下载；本模块不联网）
  let electronPkgDir = null
  try {
    const require = createRequire(join(root, 'package.json'))
    electronPkgDir = dirname(realpathSync(require.resolve('electron/package.json')))
  } catch {
    push('dist', '找不到 electron 包（node_modules 未安装？先 pnpm install）')
  }
  if (electronPkgDir) {
    let electronPkg
    try {
      electronPkg = JSON.parse(readFileSync(join(electronPkgDir, 'package.json'), 'utf8'))
    } catch {
      electronPkg = {}
    }
    const distDir = join(electronPkgDir, 'dist')
    const pathTxt = join(electronPkgDir, 'path.txt')
    if (!existsSync(pathTxt)) {
      push(
        'dist',
        `node_modules/electron/path.txt 缺失（electron dist 未安装；${skipHint()}` +
          '可 pnpm fix:electron-dist 从本机缓存离线恢复，或从同机其它完整 worktree 拷贝 node_modules/electron/dist + path.txt）'
      )
    } else {
      const binRel = readFileSync(pathTxt, 'utf8').trim()
      if (!nonEmpty(join(distDir, binRel))) push('dist', `path.txt 指向的可执行文件缺失：${binRel}`)
      for (const fw of [
        'Electron.app/Contents/Frameworks/Electron Framework.framework',
        'Electron.app/Contents/Frameworks/Mantle.framework',
        'Electron.app/Contents/Frameworks/ReactiveObjC.framework',
        'Electron.app/Contents/Frameworks/Squirrel.framework'
      ]) {
        if (!existsSync(join(distDir, fw))) push('dist', `electron dist 不完整：缺 ${fw}`)
      }
      const versionFile = join(distDir, 'version')
      if (existsSync(versionFile)) {
        const v = readFileSync(versionFile, 'utf8').trim()
        if (v !== (electronPkg.version ?? '')) {
          push('dist', `electron dist/version（${v}）与 electron 包版本（${electronPkg.version}）不一致`)
        }
      } else {
        push('dist', 'electron dist/version 缺失（dist 不完整）')
      }
    }
  }

  // better-sqlite3 Electron ABI 绑定（postinstall 的 node-gyp 重编产物）
  try {
    const bs3 = join(root, 'node_modules/better-sqlite3')
    const binding = join(realpathSync(bs3), 'build/Release/better_sqlite3.node')
    if (!existsSync(binding)) {
      push('binding', 'better-sqlite3 的 Electron 原生绑定缺失：node_modules/better-sqlite3/build/Release/better_sqlite3.node（跑 node scripts/rebuild-better-sqlite3-electron.mjs 或重新 pnpm install）')
    }
  } catch {
    push('binding', '找不到 better-sqlite3 包（node_modules 未安装？先 pnpm install）')
  }

  return { problems, ok: problems.length === 0 }
}

/** 问题列表 → 退出码（bitmask：build=1 / dist=2 / binding=4） */
export function exitCodeFor(problems) {
  let code = 0
  for (const p of problems) code |= EXIT[p.category] ?? 0
  return code
}
