import { execFileSync } from 'node:child_process'
import { lstatSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const GENERATED_CONFIG = /^electron\.vite\.config\.[0-9]+\.mjs$/
const TOP_LEVEL_EXCEPTIONS = new Set(['out/', 'node_modules/'])

/** 只取 ?? / !! 条目的顶层路径；out/、node_modules/ 是构建与依赖的固定例外。 */
export function parseTopLevelStatus(output) {
  const result = new Set()
  for (const record of output.split('\0')) {
    const status = record.slice(0, 2)
    if (status !== '??' && status !== '!!') continue
    const path = record.slice(3)
    if (!path) continue
    const slash = path.indexOf('/')
    const top = slash === -1 ? path : path.slice(0, slash + 1)
    if (!TOP_LEVEL_EXCEPTIONS.has(top)) result.add(top)
  }
  return result
}

function currentTopLevelStatus(root) {
  const output = execFileSync('git', ['status', '--porcelain', '--ignored', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  })
  return parseTopLevelStatus(output)
}

/**
 * 启动快照。existingConfigs 同时记录普通文件、目录与 symlink，保证启动时已存在的
 * 同名条目永远不会被本次运行清理。
 */
export function startRunHygiene(root = process.cwd()) {
  const startedAtMs = Date.now()
  const existingConfigs = new Set(readdirSync(root).filter((name) => GENERATED_CONFIG.test(name)))
  const baseline = currentTopLevelStatus(root)
  return { root, startedAtMs, existingConfigs, baseline }
}

/** 只删启动后新建、mtime 不早于启动的严格命名普通文件；不跟随或删除 symlink。 */
export function cleanupGeneratedConfigs({ root, startedAtMs, existingConfigs }) {
  const removed = []
  for (const name of readdirSync(root)) {
    if (!GENERATED_CONFIG.test(name) || existingConfigs.has(name)) continue
    const path = join(root, name)
    let stat
    try {
      stat = lstatSync(path)
    } catch {
      continue
    }
    if (!stat.isFile() || stat.mtimeMs < startedAtMs) continue
    try {
      unlinkSync(path)
      removed.push(name)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return removed.sort()
}

/** 清理本次配置后，报告相对启动 baseline 新增的顶层 ?? / !! 条目；调用方据此失败。 */
export function finishRunHygiene(state) {
  const removed = cleanupGeneratedConfigs(state)
  const current = currentTopLevelStatus(state.root)
  const added = [...current].filter((name) => !state.baseline.has(name)).sort()
  return { removed, added }
}
