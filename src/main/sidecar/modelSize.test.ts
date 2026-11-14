import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appMineruModelsDir,
  assertNotUserMineru,
  clearModelSizeCache,
  directorySizeBytes,
  formatModelSize,
  measureModelDir
} from './modelSize'

let dir: string

beforeEach(() => {
  clearModelSizeCache()
  dir = mkdtempSync(join(tmpdir(), 'gt-modelsize-'))
})

afterEach(() => {
  clearModelSizeCache()
  rmSync(dir, { recursive: true, force: true })
})

describe('模型目录大小（只扫 App 数据目录）', () => {
  it('异步统计临时目录里的假文件，30 秒内走缓存', async () => {
    const models = appMineruModelsDir(dir)
    mkdirSync(models, { recursive: true })
    writeFileSync(join(models, 'chunk.bin'), Buffer.alloc(200_000))
    const first = await measureModelDir(models)
    expect(first.bytes).toBe(200_000)
    expect(first.label).toContain('MB')
    rmSync(join(models, 'chunk.bin'))
    const cached = await measureModelDir(models)
    expect(cached).toEqual(first)
    clearModelSizeCache()
    const gone = await measureModelDir(models)
    expect(gone).toEqual({ bytes: null, label: '未下载' })
  })

  it('体积文案：空、不足 0.1 MB、MB、GB', () => {
    expect(formatModelSize(null)).toBe('未下载')
    expect(formatModelSize(0)).toBe('未下载')
    expect(formatModelSize(100)).toBe('已下载 · 不足 0.1 MB')
    expect(formatModelSize(Math.round(0.2 * 1024 * 1024))).toContain('MB')
    expect(formatModelSize(Math.round(1.2 * 1024 ** 3))).toContain('GB')
  })

  it('拒绝用户目录下的 ~/.mineru，不读盘', () => {
    expect(() => assertNotUserMineru(join(homedir(), '.mineru', 'models'))).toThrow('拒绝访问用户目录下的 MinerU')
  })

  it('realpath 后拒绝指向用户 MinerU 的符号链接，不遍历目标', async () => {
    const bannedRoot = join(dir, 'home', '.mineru')
    const bannedModels = join(bannedRoot, 'models')
    mkdirSync(bannedModels, { recursive: true })
    writeFileSync(join(bannedModels, 'secret.bin'), Buffer.alloc(1024))
    const models = appMineruModelsDir(dir)
    mkdirSync(join(models, '..'), { recursive: true })
    symlinkSync(bannedModels, models, 'dir')
    await expect(directorySizeBytes(models, bannedRoot)).rejects.toThrow('拒绝访问用户目录下的 MinerU')
  })
})
