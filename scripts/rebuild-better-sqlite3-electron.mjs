#!/usr/bin/env node
/**
 * 用 node-gyp 直接为当前 Electron 版本重编 better-sqlite3（替代 electron-rebuild：
 * 后者在 pnpm 布局下会「Rebuild Complete」但实际没有产出）。
 *
 * 产物留在 node_modules 原处（Electron ABI），供 `pnpm dev` / electron-builder 使用；
 * Node（vitest）侧用 scripts/prepare-better-sqlite3-node.mjs 准备的副本，互不影响。
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const pkgDir = dirname(require.resolve('better-sqlite3/package.json'))
const electronVersion = require('electron/package.json').version
const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js')
// anaconda 等装在 PATH 前的 GNU libtool 会拒绝 LTO 目标文件，把系统目录提前
const cleanEnv = { ...process.env, PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH}` }

console.log(`[rebuild-better-sqlite3-electron] Electron ${electronVersion} → ${pkgDir}`)
const r = spawnSync(
  process.execPath,
  [nodeGyp, 'rebuild', '--target=' + electronVersion, '--arch=' + process.arch, '--dist-url=https://electronjs.org/headers'],
  { cwd: pkgDir, stdio: 'inherit', env: cleanEnv }
)
if (r.status !== 0 || !existsSync(join(pkgDir, 'build/Release/better_sqlite3.node'))) {
  console.error('[rebuild-better-sqlite3-electron] 失败')
  process.exit(1)
}
console.log('[rebuild-better-sqlite3-electron] 完成')
