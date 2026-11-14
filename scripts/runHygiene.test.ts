import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-ignore 可复用 Node 脚本无 TS 声明
import { finishRunHygiene, parseTopLevelStatus, startRunHygiene } from './runHygiene.mjs'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-run-hygiene-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeRepo(): string {
  const root = join(dir, 'repo')
  mkdirSync(root)
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  writeFileSync(join(root, '.gitignore'), '/electron.vite.config.*.mjs\n*.ignored\nout/\nnode_modules/\n')
  return root
}

describe('runHygiene：配置清理与 git 顶层新增守卫', () => {
  it('porcelain -z 只解析 ??/!! 的顶层条目，固定豁免 out/ 与 node_modules/', () => {
    const parsed = parseTopLevelStatus(
      ['?? out/', '!! node_modules/', '?? src/', '?? nested/file.txt', '!! electron.vite.config.12.mjs', ' M package.json', '?? root.txt', ''].join('\0')
    )
    expect([...parsed].sort()).toEqual(['electron.vite.config.12.mjs', 'nested/', 'root.txt', 'src/'])
  })

  it('只清启动后新建且 mtime>=启动的纯数字普通文件；目录、symlink、历史与宽松匹配均保留', () => {
    const root = makeRepo()
    const existing = join(root, 'electron.vite.config.1.mjs')
    writeFileSync(existing, 'existing')
    const hygiene = startRunHygiene(root)
    // 即使启动后把已有文件的 mtime 改新，也不能删。
    utimesSync(existing, new Date(), new Date())

    const generated = join(root, 'electron.vite.config.123.mjs')
    const historical = join(root, 'electron.vite.config.456.mjs')
    const numericDir = join(root, 'electron.vite.config.789.mjs')
    const numericLink = join(root, 'electron.vite.config.101112.mjs')
    const invalid = join(root, 'electron.vite.config.123.extra.mjs')
    writeFileSync(generated, 'new')
    writeFileSync(historical, 'old mtime')
    const oldSeconds = (hygiene.startedAtMs - 60_000) / 1000
    utimesSync(historical, oldSeconds, oldSeconds)
    mkdirSync(numericDir)
    writeFileSync(join(numericDir, 'placeholder.txt'), 'git 只报告非空目录')
    symlinkSync(existing, numericLink)
    writeFileSync(invalid, 'not a generated config')

    const result = finishRunHygiene(hygiene)
    expect(result.removed).toEqual(['electron.vite.config.123.mjs'])
    expect(existsSync(generated)).toBe(false)
    for (const path of [existing, historical, numericDir, numericLink, invalid]) expect(existsSync(path)).toBe(true)
    expect(result.added).toEqual(
      expect.arrayContaining([
        'electron.vite.config.101112.mjs',
        'electron.vite.config.123.extra.mjs',
        'electron.vite.config.456.mjs',
        'electron.vite.config.789.mjs/'
      ])
    )
    expect(result.added).not.toContain('electron.vite.config.1.mjs')
    expect(result.added).not.toContain('electron.vite.config.123.mjs')
  })

  it('正常生成的配置清理后守卫无新增；baseline 内变化与固定例外不报警', () => {
    const root = makeRepo()
    mkdirSync(join(root, 'existing-dir'))
    writeFileSync(join(root, 'existing-dir', 'before.txt'), 'before')
    const hygiene = startRunHygiene(root)
    writeFileSync(join(root, 'electron.vite.config.999.mjs'), 'generated')
    writeFileSync(join(root, 'existing-dir', 'after.txt'), 'after')
    mkdirSync(join(root, 'out'), { recursive: true })
    writeFileSync(join(root, 'out', 'new.js'), 'out')
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'new.js'), 'dependency')

    expect(finishRunHygiene(hygiene)).toEqual({ removed: ['electron.vite.config.999.mjs'], added: [] })
  })

  it('其余顶层新增 untracked/ignored 条目都报告，但不替调用方删除', () => {
    const root = makeRepo()
    const hygiene = startRunHygiene(root)
    writeFileSync(join(root, 'new-root.txt'), 'new')
    writeFileSync(join(root, 'new.ignored'), 'new ignored')
    mkdirSync(join(root, 'new-dir'))
    writeFileSync(join(root, 'new-dir', 'x.txt'), 'new')

    const result = finishRunHygiene(hygiene)
    expect(result.added).toEqual(['new-dir/', 'new-root.txt', 'new.ignored'])
    expect(existsSync(join(root, 'new-root.txt'))).toBe(true)
    expect(existsSync(join(root, 'new.ignored'))).toBe(true)
    expect(existsSync(join(root, 'new-dir', 'x.txt'))).toBe(true)
  })
})
