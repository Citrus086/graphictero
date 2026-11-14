import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { augmentPath, findUv, isExecutableFile, uvFallbackDirs } from './uvPath'

/** Finder 启动的最小 PATH 下也能找到 uv（Homebrew / ~/.local/bin / ~/.cargo/bin） */

const MIN_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

describe('uvFallbackDirs / augmentPath', () => {
  it('常见位置：Homebrew 两处 + ~/.local/bin + ~/.cargo/bin', () => {
    expect(uvFallbackDirs('/Users/u')).toEqual([
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/Users/u/.local/bin',
      '/Users/u/.cargo/bin'
    ])
  })

  it('现有 PATH 在前，缺的追加，已有的不重复', () => {
    expect(augmentPath('/usr/bin:/opt/homebrew/bin', ['/opt/homebrew/bin', '/x/bin'])).toBe(
      '/usr/bin:/opt/homebrew/bin:/x/bin'
    )
  })

  it('PATH 为空或未设置时只剩常见位置；空段被丢掉', () => {
    expect(augmentPath(undefined, ['/a', '/b'])).toBe('/a:/b')
    expect(augmentPath('::/usr/bin:', ['/a'])).toBe('/usr/bin:/a')
  })
})

describe('findUv（注入可执行判断）', () => {
  it('现有 PATH 里有 uv → 优先用它', () => {
    const exe = new Set(['/custom/bin/uv', '/opt/homebrew/bin/uv'])
    expect(findUv({ envPath: `/custom/bin:${MIN_PATH}`, home: '/Users/u', isExecutable: (p) => exe.has(p) })).toBe(
      '/custom/bin/uv'
    )
  })

  it('最小 PATH 下按顺序查 Homebrew → ~/.local/bin → ~/.cargo/bin', () => {
    const only = (p: string) => (q: string) => q === p
    expect(findUv({ envPath: MIN_PATH, home: '/Users/u', isExecutable: only('/opt/homebrew/bin/uv') })).toBe('/opt/homebrew/bin/uv')
    expect(findUv({ envPath: MIN_PATH, home: '/Users/u', isExecutable: only('/usr/local/bin/uv') })).toBe('/usr/local/bin/uv')
    expect(findUv({ envPath: MIN_PATH, home: '/Users/u', isExecutable: only('/Users/u/.local/bin/uv') })).toBe('/Users/u/.local/bin/uv')
    expect(findUv({ envPath: MIN_PATH, home: '/Users/u', isExecutable: only('/Users/u/.cargo/bin/uv') })).toBe('/Users/u/.cargo/bin/uv')
  })

  it('哪里都没有 → null', () => {
    expect(findUv({ envPath: MIN_PATH, home: '/Users/u', isExecutable: () => false })).toBeNull()
    expect(findUv({ envPath: undefined, home: '/Users/u', isExecutable: () => false })).toBeNull()
  })
})

describe('isExecutableFile / findUv（真文件）', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gt-uvpath-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('只认带执行位的普通文件；目录或不可执行文件不算', () => {
    const home = join(dir, 'home')
    const bin = join(home, '.local', 'bin')
    mkdirSync(bin, { recursive: true })
    const uv = join(bin, 'uv')
    writeFileSync(uv, '#!/bin/sh\n')
    chmodSync(uv, 0o644)
    expect(isExecutableFile(uv)).toBe(false)
    chmodSync(uv, 0o755)
    expect(isExecutableFile(uv)).toBe(true)
    expect(isExecutableFile(bin)).toBe(false)
    // envPath 指向空目录：仍能从 home 的 ~/.local/bin 找到（只要系统常见位置没有 uv 抢先）
    const found = findUv({ envPath: join(dir, 'empty'), home })
    expect(found === uv || found === '/opt/homebrew/bin/uv' || found === '/usr/local/bin/uv').toBe(true)
  })
})
