import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 数据根位置的持久化（D83 的设置页「更改…」生效点）。
 *
 * 设计文档把根位置列为 app_settings 的落点（002），但启动时要先定位数据目录
 * 才能打开库读 app_settings——鸡生蛋。所以真正的启动判据是一个放在
 * Electron userData（与数据目录无关）里的小 JSON 文件：
 *   优先级：GRAPHICTERO_DATA_ROOT 环境变量 > userData/data-root.json > 默认根位置。
 * 迁移/恢复成功后写入新根位置并 relaunch。
 */

export interface RootOverride {
  root: string
  updatedAt: string
}

export function readRootOverride(userDataDir: string): string | null {
  const file = join(userDataDir, 'data-root.json')
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as RootOverride
    return typeof parsed.root === 'string' && parsed.root !== '' ? parsed.root : null
  } catch {
    return null
  }
}

export function writeRootOverride(userDataDir: string, root: string): void {
  mkdirSync(userDataDir, { recursive: true })
  const payload: RootOverride = { root, updatedAt: new Date().toISOString() }
  writeFileSync(join(userDataDir, 'data-root.json'), JSON.stringify(payload, null, 2))
}
