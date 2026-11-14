import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/**
 * 定位 uv。Finder/Dock 启动的 App 继承的是 launchd 的最小 PATH（/usr/bin:/bin:/usr/sbin:/sbin），
 * 不含 Homebrew（/opt/homebrew/bin、/usr/local/bin）和官方安装脚本的 ~/.local/bin、~/.cargo/bin，
 * 直接 spawn('uv') 会 ENOENT。先查现有 PATH，再查这些常见位置；子进程 PATH 也补上它们。
 */
export function uvFallbackDirs(home: string = homedir()): string[] {
  return ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local', 'bin'), join(home, '.cargo', 'bin')]
}

/** 现有 PATH 在前（保持用户的优先级），缺的目录按顺序追加；去重、去空段 */
export function augmentPath(envPath: string | undefined, extraDirs: string[]): string {
  const parts = (envPath ?? '').split(delimiter).filter(Boolean)
  for (const d of extraDirs) if (!parts.includes(d)) parts.push(d)
  return parts.join(delimiter)
}

export function isExecutableFile(p: string): boolean {
  try {
    accessSync(p, constants.X_OK)
    return statSync(p).isFile()
  } catch {
    return false
  }
}

export interface FindUvOptions {
  envPath?: string
  home?: string
  isExecutable?: (p: string) => boolean
}

/** 返回 uv 的绝对路径；现有 PATH 与常见位置都没有时返回 null */
export function findUv(opts: FindUvOptions = {}): string | null {
  const isExec = opts.isExecutable ?? isExecutableFile
  const envPath = 'envPath' in opts ? opts.envPath : process.env.PATH
  for (const dir of augmentPath(envPath, uvFallbackDirs(opts.home)).split(delimiter)) {
    const candidate = join(dir, 'uv')
    if (isExec(candidate)) return candidate
  }
  return null
}
