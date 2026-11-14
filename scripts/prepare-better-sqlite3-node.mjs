#!/usr/bin/env node
/**
 * 为 Node（vitest / Node 脚本）准备 better-sqlite3 的原生绑定。
 *
 * 背景（ABI 问题）：根 package.json 的 postinstall 用 node-gyp 按 Electron 头文件
 * 重编 node_modules/better-sqlite3（Electron 35 = NODE_MODULE_VERSION 133），供
 * `pnpm dev` / 打包 .app 使用；而 vitest 跑在系统 Node（如 Node 26 = ABI 147）下，
 * 直接用会报 `NODE_MODULE_VERSION` 不匹配。
 *
 * 做法：把 better-sqlite3 拷到 node_modules/.bs3-node（不带 build/），在里面跑
 * 一次普通 node-gyp rebuild（按当前 Node 头文件编译）。vitest.config.ts 把
 * `better-sqlite3` 别名到这个副本。Electron 侧不受影响。
 *
 * 已存在且可加载时直接跳过。
 */
import { cpSync, existsSync, lstatSync, mkdirSync, copyFileSync, realpathSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(new URL(import.meta.url).pathname), '..')
const src = join(root, 'node_modules/better-sqlite3')
// 注意：node_modules/better-sqlite3 是 pnpm 的符号链接，cpSync 对符号链接源会把
// 目标也建成符号链接（等于没拷贝）。先 realpath 再逐条目拷到真实目录。
const srcReal = realpathSync(src)
const dst = join(root, 'node_modules/.bs3-node')
const binding = join(dst, 'build/Release/better_sqlite3.node')

function loadable() {
  if (!existsSync(binding)) return false
  const r = spawnSync(process.execPath, ['-e', `new (require(${JSON.stringify(dst)}))(':memory:')`], {
    stdio: 'pipe'
  })
  return r.status === 0
}

if (loadable()) {
  console.log(`[prepare-better-sqlite3-node] Node ABI ${process.versions.modules} 绑定已就绪，跳过`)
  process.exit(0)
}

console.log(`[prepare-better-sqlite3-node] 为 Node ABI ${process.versions.modules} 编译绑定...`)
rmSync(dst, { recursive: true, force: true })
copyDeref(srcReal, dst)
// pnpm 把 better-sqlite3 的运行时依赖（bindings 等）放在包目录的兄弟 node_modules 里，
// 这里挂一个绝对符号链接过去（注意 dst 本身必须是真实目录，否则 require 会被
// realpath 回真包目录，导致加载到 Electron ABI 的绑定）。
symlinkSync(dirname(srcReal), join(dst, 'node_modules'), 'dir')

/**
 * 递归拷贝并解引用符号链接：node_modules/better-sqlite3 是 pnpm 的符号链接，
 * 里面的依赖也是相对符号链接，直接 cpSync 会拷出断链。
 */
function copyDeref(from, to) {
  const st = lstatSync(from)
  if (st.isSymbolicLink()) return copyDeref(realpathSync(from), to)
  if (st.isDirectory()) {
    mkdirSync(to, { recursive: true })
    for (const entry of readdirSync(from)) {
      if (to === dst && (entry === 'build' || entry === 'node_modules')) continue
      copyDeref(join(from, entry), join(to, entry))
    }
    return
  }
  copyFileSync(from, to)
}

const require = createRequire(import.meta.url)
const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js')
// anaconda 等装在 PATH 前的 GNU libtool 会拒绝 LTO 目标文件，把系统目录提前
const cleanEnv = { ...process.env, PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH}` }
const r = spawnSync(process.execPath, [nodeGyp, 'rebuild'], { cwd: dst, stdio: 'inherit', env: cleanEnv })

if (r.status !== 0 || !loadable()) {
  console.error('[prepare-better-sqlite3-node] 失败：Node 下仍无法加载 better-sqlite3')
  process.exit(1)
}
console.log('[prepare-better-sqlite3-node] 完成')
