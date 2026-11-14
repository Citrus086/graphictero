import { spawn } from 'node:child_process'
import { copyFile as copyFileAsync } from 'node:fs/promises'
import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * MinerU 模型复用（D145/D190）：首次需要模型时，若全局 `~/.mineru/models` 已有
 * 本档（MINERU_TIER=standard）所需模型，**复制（APFS 克隆优先）而非移动**到 App
 * 数据目录内的 MinerU home，避免重复下载几 GB。
 *
 * 红线（D145/D190）：本模块对源目录只读——绝不删除、移动、改写 `~/.mineru` 下
 * 任何东西（别的工具或另一份 App 可能在用）。源路径由调用方显式传入；测试只传
 * 临时目录，绝不传真实 `~/.mineru`。
 *
 * 流程：复制到 mineruHome 内的临时目录 → 校验（目录结构 + 文件数 + 字节数与
 * 源一致）→ 原子 rename 成 models/（中断不留半成品，下次重来）。
 * 克隆检测：macOS 用 `cp -c`（clonefile）。退出码 0 才算克隆成功；非 0，或
 * 非 darwin，退回普通复制并记 cloned=false（调用方提示约占多少额外磁盘）。
 * Node 的 COPYFILE_FICLONE 在不能克隆时会静默普通复制且不抛错，不能用来探测。
 */

/**
 * standard 档在本机（Apple Silicon，后端 auto）解析出的模型子目录
 * （mineru 4.0.12，`mineru-models-download --tier standard`；与
 * mineruSidecar.ts MINERU_TIER 注释同源）。缺一即认为全局目录没有完整模型，
 * 退回正常下载。
 */
export const STANDARD_TIER_MODEL_DIRS = ['MinerU-4_models_torch', 'MinerU2.5-Pro-2605-1.2B-GGUF'] as const

/**
 * 测试红线（D145）：vitest 里拒绝任何落在真实 `~/.mineru` 下的路径。
 * 先做词法判断，命中则立刻抛出，不 `stat` / `realpath` 真实目录。
 * 生产进程（无 VITEST）不拦截——App 复用时只读全局模型目录是 D190 要求的。
 */
export function assertNotRealMineruInTest(targetPath: string): void {
  if (!process.env.VITEST) return
  const realRoot = resolve(join(homedir(), '.mineru'))
  const under = (p: string): boolean => p === realRoot || p.startsWith(realRoot + sep)
  if (under(resolve(targetPath))) {
    throw new Error(`测试拒绝访问真实 ~/.mineru：${targetPath}`)
  }
  try {
    if (under(realpathSync(targetPath))) {
      throw new Error(`测试拒绝访问真实 ~/.mineru：${targetPath}`)
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('测试拒绝访问')) throw e
  }
}

function dirNonEmpty(dir: string): boolean {
  if (!existsSync(dir)) return false
  try {
    return readdirSync(dir).length > 0
  } catch {
    return false
  }
}

/**
 * 目标 models 目录是否已有本档模型：两个标准档目录都存在且非空才算就绪。
 * 空目录、只有一个档、只有杂文件都不算——否则重试会卡死或跳过复用直接起服务。
 */
export function hasTierModels(modelsDir: string): boolean {
  return STANDARD_TIER_MODEL_DIRS.every((name) => dirNonEmpty(join(modelsDir, name)))
}

/** 全局 models 目录是否有「可整体复用」的本档模型（standard 档的全部子目录都在且非空）。 */
export function hasReusableModels(globalModelsDir: string): boolean {
  assertNotRealMineruInTest(globalModelsDir)
  return hasTierModels(globalModelsDir)
}

/**
 * `models/` 已存在但不就绪时，在 MinerU home（数据根内）把它挪成
 * `models.incomplete-<时间戳>`，然后调用方再复用或下载。
 * 只 rename 本 home 下的这个目录，绝不碰源 `~/.mineru`。
 * 已就绪则不动，返回 null。
 */
export function quarantineIncompleteModels(mineruHome: string, now = Date.now()): string | null {
  assertNotRealMineruInTest(mineruHome)
  const modelsDir = join(mineruHome, 'models')
  assertNotRealMineruInTest(modelsDir)
  if (!existsSync(modelsDir) || hasTierModels(modelsDir)) return null
  mkdirSync(mineruHome, { recursive: true })
  let dest = join(mineruHome, `models.incomplete-${now}`)
  if (existsSync(dest)) dest = join(mineruHome, `models.incomplete-${now}-${Math.random().toString(36).slice(2, 8)}`)
  const rel = relative(resolve(mineruHome), resolve(dest))
  if (rel.startsWith('..') || rel === '' || isAbsolute(rel)) {
    throw new Error('拒绝在 MinerU home 外挪动模型目录')
  }
  renameSync(modelsDir, dest)
  return dest
}

/** 递归收集相对路径 → 字节数（文件清单，校验用）。 */
export function listFileEntries(root: string, base = root, out = new Map<string, number>()): Map<string, number> {
  if (!existsSync(root)) return out
  for (const name of readdirSync(root)) {
    const full = join(root, name)
    const st = statSync(full)
    if (st.isDirectory()) listFileEntries(full, base, out)
    else if (st.isFile()) out.set(relative(base, full).split('\\').join('/'), st.size)
  }
  return out
}

export interface CopyStats {
  files: number
  bytes: number
  /** true = `cp -c` 整树退出码 0；false = 退回普通复制（或非 darwin） */
  cloned: boolean
}

/** 约占多少额外磁盘。≥ 0.1 GB 用 GB，否则 MB / KB，方便小文件测试与几 GB 模型同一句式。 */
export function formatExtraDisk(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024)
  if (gb >= 0.1) return `${gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)} GB`
  const mb = bytes / (1024 * 1024)
  if (mb >= 0.1) return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** D190 ②：不能克隆时安装详情 / 日志用的那一句。 */
export function plainCopyDiskWarning(bytes: number): string {
  return `无法克隆，已普通复制，约占 ${formatExtraDisk(bytes)} 额外磁盘`
}

/**
 * 克隆执行器：参数组传给 `cp`（不经 shell）。返回退出码，0 = 克隆成功。
 * 测试注入这个，而不是会抛错的 copyFile——COPYFILE_FICLONE 失败时 Node 不抛错。
 */
export type CloneExec = (args: readonly string[]) => Promise<number> | number

export type CopyFileFn = (src: string, dest: string) => void | Promise<void>

export interface ReuseOptions {
  /** 注入克隆命令。不传时：darwin 用真实 `cp -c`，其它平台直接普通复制。 */
  cloneExec?: CloneExec
  /** 注入普通复制。不传时用 fs.promises.copyFile。 */
  copyFile?: CopyFileFn
  /** 覆盖平台判断（测试「非 darwin」）。不影响已注入的 cloneExec。 */
  platform?: NodeJS.Platform
  /** 普通复制时每结束一个目录回调一次（让出事件循环之后），用来刷新安装进度。 */
  onProgress?: (msg: string) => void | Promise<void>
}

/** macOS `cp -c -R`。非 0（含 spawn 失败）表示这次不是克隆。 */
export function defaultCloneExec(args: readonly string[]): Promise<number> {
  return new Promise((resolvePromise) => {
    const child = spawn('cp', [...args], { stdio: 'ignore' })
    child.on('error', () => resolvePromise(1))
    child.on('close', (code) => resolvePromise(code ?? 1))
  })
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolvePromise) => {
    setImmediate(resolvePromise)
  })
}

async function copyPlainTree(
  src: string,
  dest: string,
  stats: CopyStats,
  opts: ReuseOptions,
  relDir = ''
): Promise<void> {
  mkdirSync(dest, { recursive: true })
  for (const name of readdirSync(src)) {
    const s = join(src, name)
    const d = join(dest, name)
    const st = statSync(s)
    if (st.isDirectory()) {
      const rel = relDir ? `${relDir}/${name}` : name
      await copyPlainTree(s, d, stats, opts, rel)
      await yieldEventLoop()
      await opts.onProgress?.(`无法克隆，正在普通复制 ${rel}（${stats.files} 个文件）`)
    } else if (st.isFile()) {
      if (opts.copyFile) await opts.copyFile(s, d)
      else await copyFileAsync(s, d)
      stats.files++
      stats.bytes += st.size
    }
  }
}

/**
 * 复制 src→dest。darwin（或测试注入了 cloneExec）先 `cp -c -R`：
 * 退出码 0 且目标里有文件 → cloned=true；否则删掉可能的半成品，普通复制，cloned=false。
 * 非 darwin 且未注入执行器：不调用 cp，直接普通复制。
 */
export async function copyModelsTree(src: string, dest: string, stats: CopyStats, opts: ReuseOptions = {}): Promise<void> {
  const platform = opts.platform ?? process.platform
  const tryClone = opts.cloneExec != null || platform === 'darwin'
  if (tryClone) {
    const exec = opts.cloneExec ?? defaultCloneExec
    let code = 1
    try {
      code = await exec(['-c', '-R', src, dest])
    } catch {
      code = 1
    }
    if (code === 0 && existsSync(dest)) {
      const entries = listFileEntries(dest)
      if (entries.size > 0) {
        stats.files = entries.size
        stats.bytes = [...entries.values()].reduce((sum, n) => sum + n, 0)
        stats.cloned = true
        return
      }
    }
    rmSync(dest, { recursive: true, force: true })
  }
  stats.cloned = false
  await opts.onProgress?.('无法克隆，正在普通复制…')
  await copyPlainTree(src, dest, stats, opts)
}

export interface ReuseResult extends CopyStats {
  modelsDir: string
  /** 不就绪的旧 models/ 被挪走时的路径；没有则为 null */
  quarantined: string | null
}

/**
 * 把 sourceModelsDir 复用到 mineruHome/models：
 * 不就绪的旧 models/ 先挪到 home 内的 models.incomplete-* →
 * 临时目录复制 → 与源逐项校验（路径 + 字节数）→ 原子 rename。
 * 任一步失败：清掉临时目录后抛错（目标不留半成品）。已就绪的 models/ 拒绝覆盖。
 */
export async function reuseModels(
  sourceModelsDir: string,
  mineruHome: string,
  log?: (msg: string) => void,
  opts: ReuseOptions = {}
): Promise<ReuseResult> {
  assertNotRealMineruInTest(sourceModelsDir)
  assertNotRealMineruInTest(mineruHome)
  const modelsDir = join(mineruHome, 'models')
  let quarantined: string | null = null
  if (existsSync(modelsDir)) {
    if (hasTierModels(modelsDir)) throw new Error(`模型目录已存在：${modelsDir}（拒绝覆盖）`)
    quarantined = quarantineIncompleteModels(mineruHome)
  }
  mkdirSync(mineruHome, { recursive: true })
  const tmp = join(mineruHome, '.models-reuse-tmp')
  rmSync(tmp, { recursive: true, force: true }) // 上一次中断的残留
  const stats: CopyStats = { files: 0, bytes: 0, cloned: true }
  try {
    await copyModelsTree(sourceModelsDir, tmp, stats, opts)
    // 校验：目录结构 + 文件数 + 字节数与源一致（克隆/复制都不允许丢内容）
    const srcEntries = listFileEntries(sourceModelsDir)
    const dstEntries = listFileEntries(tmp)
    if (srcEntries.size !== dstEntries.size) {
      throw new Error(`模型复用校验失败：文件数 ${dstEntries.size} ≠ 源 ${srcEntries.size}`)
    }
    for (const [rel, size] of srcEntries) {
      if (dstEntries.get(rel) !== size) throw new Error(`模型复用校验失败：${rel} 大小 ${dstEntries.get(rel)} ≠ 源 ${size}`)
    }
    if (srcEntries.size === 0) throw new Error('模型复用校验失败：源目录为空')
    renameSync(tmp, modelsDir) // 同分区原子改名：中断不留半成品
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true })
    throw e
  }
  const how = stats.cloned ? 'APFS 克隆不占额外空间' : plainCopyDiskWarning(stats.bytes)
  log?.(
    `[graphictero] 已复用已下载的 MinerU 模型（${stats.files} 个文件，${(stats.bytes / 1024 / 1024).toFixed(0)} MB，${how}）`
  )
  return { ...stats, modelsDir, quarantined }
}

/** 复用失败后的可重试性：目标 models 不存在、临时目录已清（下次可整体重来）。 */
export function reuseLeftovers(mineruHome: string): { tmpExists: boolean } {
  return { tmpExists: existsSync(join(mineruHome, '.models-reuse-tmp')) }
}

/** 父目录（测试与调用方拼路径用）。 */
export function modelsDirOf(mineruHome: string): string {
  return join(mineruHome, 'models')
}

/** 仅供文档：临时目录名（redo 语义见 reuseModels）。 */
export function reuseTmpDir(mineruHome: string): string {
  return join(mineruHome, '.models-reuse-tmp')
}
