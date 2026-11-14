import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/**
 * App MinerU 模型目录体积（uat8c D / D145）。
 * 只统计 <dataDir>/sidecar/mineru-home/models。路径落在用户 ~/.mineru 下直接拒绝，不读不写。
 * 异步遍历，结果在主进程内存缓存一小段时间，设置页重复进入不反复扫盘。
 */

const CACHE_MS = 30_000
const cache = new Map<string, { bytes: number | null; at: number }>()

export interface ModelDirSizeView {
  /** null = 目录不存在或里面没有文件 → 界面「未下载」 */
  bytes: number | null
  label: string
}

export function userMineruRoot(): string {
  return resolve(homedir(), '.mineru')
}

/** 目标路径等于或位于用户 MinerU 根目录之内则拒绝。resolve 防 ..；调用方遍历前还会 realpath 防符号链接。 */
export function assertNotUserMineru(dir: string, bannedRoot = userMineruRoot()): void {
  const banned = resolve(bannedRoot)
  const target = resolve(dir)
  if (target === banned || target.startsWith(banned + sep)) {
    throw new Error('拒绝访问用户目录下的 MinerU')
  }
}

export function appMineruModelsDir(dataDir: string): string {
  return join(dataDir, 'sidecar', 'mineru-home', 'models')
}

export function formatModelSize(bytes: number | null): string {
  if (bytes == null || bytes <= 0) return '未下载'
  const gb = bytes / 1024 ** 3
  if (gb >= 0.05) return `已下载 · 约 ${gb.toFixed(1)} GB`
  const mb = bytes / 1024 ** 2
  if (mb >= 0.05) return `已下载 · 约 ${mb.toFixed(1)} MB`
  return '已下载 · 不足 0.1 MB'
}

async function walkBytes(dir: string): Promise<number> {
  let total = 0
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const child = join(dir, entry.name)
    if (entry.isDirectory()) total += await walkBytes(child)
    else if (entry.isFile()) {
      try {
        total += (await stat(child)).size
      } catch {
        // 扫描途中文件消失：跳过这一项
      }
    }
  }
  return total
}

/** 目录不存在或没有任何文件 → null。拒绝 ~/.mineru；realpath 后再次拒绝指向其中的符号链接。 */
export async function directorySizeBytes(dir: string, bannedRoot = userMineruRoot()): Promise<number | null> {
  assertNotUserMineru(dir, bannedRoot)
  const realDir = await realpath(dir).catch(() => null)
  if (!realDir) return null
  // 用户没有旧 ~/.mineru 时 realpath 会失败；退回 resolve 只做路径比较，不影响 App 目录统计。
  const realBanned = await realpath(bannedRoot).catch(() => resolve(bannedRoot))
  assertNotUserMineru(realDir, realBanned)
  try {
    const info = await stat(realDir)
    if (!info.isDirectory()) return null
  } catch {
    return null
  }
  const bytes = await walkBytes(realDir)
  return bytes > 0 ? bytes : null
}

export async function measureModelDir(dir: string, now = Date.now()): Promise<ModelDirSizeView> {
  const key = resolve(dir)
  const hit = cache.get(key)
  if (hit && now - hit.at < CACHE_MS) return { bytes: hit.bytes, label: formatModelSize(hit.bytes) }
  const bytes = await directorySizeBytes(dir)
  cache.set(key, { bytes, at: now })
  return { bytes, label: formatModelSize(bytes) }
}

/** 测试隔离缓存。 */
export function clearModelSizeCache(): void {
  cache.clear()
}
