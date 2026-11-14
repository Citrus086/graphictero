/**
 * Electron dist 离线自愈（E1/d145d146）——不联网、不跑 install.js、不从别的
 * worktree 拷贝。
 *
 * 前提：本机 electron 下载缓存（@electron/get 的布局：<缓存根>/<URL 哈希目录>/
 * electron-v<版本>-<平台>-<架构>.zip；macOS 默认 ~/Library/Caches/electron/，可用
 * electron_config_cache / ELECTRON_CACHE 覆盖）里有与 node_modules/electron 版本、
 * 平台、架构一致的 zip，且 sha256 与包内 checksums.json 对得上 → 用系统自带
 * `ditto -x -k` 解压到 dist 并写 path.txt。
 *
 * 任一条件不满足都不写任何文件，由调用方按「明确报错」路径退出。
 * 只在 postinstall / `pnpm fix:electron-dist` 里调用；dev / build 前只检查不自愈。
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** @electron/get 默认缓存根（env-paths 'electron'）+ 常见覆盖（与 install.js 同源） */
export function defaultCacheRoots(env = process.env, home = homedir()) {
  const roots = [env.electron_config_cache, env.ELECTRON_CACHE]
  if (process.platform === 'darwin') roots.push(join(home, 'Library', 'Caches', 'electron'))
  else roots.push(join(home, '.cache', 'electron'))
  return [...new Set(roots.filter(Boolean))]
}

function statSyncSafe(p) {
  try {
    return statSync(p)
  } catch {
    return null
  }
}

/** 在缓存根（≤3 层）里找指定文件名的 zip */
export function findCachedZip(cacheRoot, fileName) {
  if (!cacheRoot || !existsSync(cacheRoot)) return null
  const walk = (dir, depth) => {
    if (depth > 3) return null
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const st = statSyncSafe(full)
      if (st == null) continue
      if (st.isDirectory()) {
        const hit = walk(full, depth + 1)
        if (hit) return hit
      } else if (name === fileName) return full
    }
    return null
  }
  return walk(cacheRoot, 0)
}

export function sha256Of(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** 平台 → path.txt 内容（与 electron install.js getPlatformPath 一致） */
export function platformPath(platform = process.platform) {
  switch (platform) {
    case 'mas':
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron'
    case 'freebsd':
    case 'openbsd':
    case 'linux':
      return 'electron'
    case 'win32':
      return 'electron.exe'
    default:
      throw new Error(`Electron builds are not available on platform: ${platform}`)
  }
}

/**
 * 尝试离线自愈。返回 { healed: true, ... } 或 { healed: false, reason }。
 * 失败（无缓存 / 校验和不对 / 解压结构不对）时不写任何文件。
 */
export function healElectronDist({
  electronPkgDir,
  platform = process.platform,
  arch = process.arch,
  cacheRoots = defaultCacheRoots(),
  log = () => {}
}) {
  const pkg = JSON.parse(readFileSync(join(electronPkgDir, 'package.json'), 'utf8'))
  const version = pkg.version
  const fileName = `electron-v${version}-${platform}-${arch}.zip`
  const binRel = platformPath(platform)
  const distDir = join(electronPkgDir, 'dist')

  const checksumsPath = join(electronPkgDir, 'checksums.json')
  if (!existsSync(checksumsPath)) {
    return { healed: false, reason: `electron 包内无 checksums.json（${checksumsPath}），无法校验缓存 zip` }
  }
  const checksums = JSON.parse(readFileSync(checksumsPath, 'utf8'))
  const expected = checksums[fileName]
  if (!expected) return { healed: false, reason: `checksums.json 里没有 ${fileName} 的条目` }

  let zip = null
  for (const root of cacheRoots) {
    zip = findCachedZip(root, fileName)
    if (zip) break
  }
  if (!zip) {
    return {
      healed: false,
      reason: `本机缓存（${cacheRoots.join('、')}）里没有 ${fileName}`,
      hint: '曾在本机成功装过 electron（联网跑过 pnpm install）才会有缓存；否则需联网重装或从同机其它完整 worktree ditto 拷贝 node_modules/electron/dist + path.txt'
    }
  }
  const actual = sha256Of(zip)
  if (actual !== expected) {
    return { healed: false, reason: `缓存 zip 校验和不符（${zip}）：${actual} ≠ ${expected}，拒绝使用` }
  }

  // 解压到 dist 同级临时目录，结构验证通过才原子替换（中断不留半成品）
  const tmp = mkdtempSync(join(dirname(distDir), '.electron-dist-heal-'))
  try {
    const r = spawnSync('ditto', ['-x', '-k', zip, tmp], { stdio: 'pipe' })
    if (r.status !== 0) return { healed: false, reason: `ditto 解压失败（exit ${r.status}）` }
    if (!existsSync(join(tmp, binRel))) {
      return { healed: false, reason: `缓存 zip 解压后缺可执行文件 ${binRel}（不是完整的 electron dist 包）` }
    }
    mkdirSync(dirname(distDir), { recursive: true })
    rmSync(distDir, { recursive: true, force: true }) // 只删 electron 包自己的 dist（已验证不完整）
    renameSync(tmp, distDir)
    writeFileSync(join(electronPkgDir, 'path.txt'), binRel, 'utf8')
    log(`已从本机缓存离线恢复 electron dist（${zip}）`)
    return { healed: true, zip, distDir }
  } catch (e) {
    return { healed: false, reason: `自愈过程出错：${e instanceof Error ? e.message : String(e)}` }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
