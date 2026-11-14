#!/usr/bin/env node
/**
 * 构建产物 / Electron dist 自检 CLI（uat6c 只读自检 + E1/d145d146 接入与自愈）。
 *
 * 用法：
 *   node scripts/check-electron-dist.mjs            # 完整检查（smoke 前；含 out/ 构建产物）
 *   node scripts/check-electron-dist.mjs --runtime  # 只查 electron dist + path.txt + 原生绑定
 *                                                   #（dev / dev:isolated / build 前；不要求 out/）
 *   node scripts/check-electron-dist.mjs --runtime --fix  # 检查 + 尝试离线自愈（postinstall /
 *                                                   # `pnpm fix:electron-dist`；dev/build 前不自愈）
 *
 * 退出码（bitmask）：0 完整；1 构建产物（out/）；2 electron dist；4 原生绑定；多类相加。
 * 不完整时非零退出并打印：缺什么、为什么（electron install.js 未执行/被中断，
 * 含 ELECTRON_SKIP_BINARY_DOWNLOAD 提示）、怎么修（自愈 / ditto 手动步骤）。
 */
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { checkElectronDist, exitCodeFor } from './electronDistLib.mjs'
import { healElectronDist } from './electronDistHeal.mjs'

const root = resolve(dirname(new URL(import.meta.url).pathname), '..')
const runtime = process.argv.includes('--runtime')
const fix = process.argv.includes('--fix')

let { problems } = checkElectronDist(root, { runtime })

// --fix：只在 electron dist 类问题上尝试离线自愈（缓存有匹配 zip + checksum 通过才写文件）
if (fix && problems.some((p) => p.category === 'dist')) {
  try {
    const require = createRequire(join(root, 'package.json'))
    const { realpathSync } = await import('node:fs')
    const electronPkgDir = dirname(realpathSync(require.resolve('electron/package.json')))
    const result = healElectronDist({ electronPkgDir, log: (m) => console.log(`[check-electron-dist] ${m}`) })
    if (result.healed) {
      ;({ problems } = checkElectronDist(root, { runtime })) // 自愈后重查
    } else {
      console.error(`[check-electron-dist] 离线自愈不可用：${result.reason}${result.hint ? `（${result.hint}）` : ''}`)
    }
  } catch (e) {
    console.error(`[check-electron-dist] 离线自愈失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

if (problems.length > 0) {
  console.error('[check-electron-dist] 发现 %d 个问题：', problems.length)
  for (const p of problems) console.error(`  - [${p.category}] ${p.message}`)
  process.exit(exitCodeFor(problems))
}
console.log(`[check-electron-dist] ${runtime ? 'electron dist 与原生绑定' : '构建产物与 electron dist'}完整`)
