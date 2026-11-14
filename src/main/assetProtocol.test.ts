import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() } }))

import { handleAssetRequest, resolveAssetPath } from './assetProtocol'
import { assetUrl } from '../shared/assetUrl'

// D115：gt-asset:// 主进程解析——词法 + realpath 双重校验
let root: string
let dataDir: string
let outside: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'gt-asset-'))
  dataDir = join(root, 'Application Support', 'Graphictero') // 含空格，同默认数据目录
  outside = join(root, 'outside')
  mkdirSync(join(dataDir, 'papers', '7', 'mineru', 'images'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(dataDir, 'papers', '7', 'mineru', 'images', 'p0.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  writeFileSync(join(dataDir, 'papers', '7', 'mineru', 'images', 'a #1?%.jpg'), 'jpg')
  writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET')
  writeFileSync(join(root, 'sibling.txt'), 'sibling')
  // 数据目录内指向目录外的 symlink（文件与目录各一）
  symlinkSync(join(outside, 'secret.txt'), join(dataDir, 'papers', '7', 'evil.png'))
  symlinkSync(outside, join(dataDir, 'papers', '7', 'evildir'))
  // 数据目录内指向目录内的 symlink：允许
  symlinkSync(join(dataDir, 'papers', '7', 'mineru', 'images', 'p0.png'), join(dataDir, 'papers', '7', 'ok-link.png'))
  // 前缀相似的兄弟目录（Graphictero-evil）不能因 startsWith 误判为目录内
  mkdirSync(join(root, 'Application Support', 'Graphictero-evil'), { recursive: true })
  writeFileSync(join(root, 'Application Support', 'Graphictero-evil', 'x.png'), 'x')
  symlinkSync(join(root, 'Application Support', 'Graphictero-evil', 'x.png'), join(dataDir, 'prefix.png'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('resolveAssetPath（D115）', () => {
  it('数据目录内文件 → 真实路径（含空格/#/?/% 文件名，经 assetUrl 编码往返）', async () => {
    expect(await resolveAssetPath(dataDir, assetUrl('papers/7/mineru/images/p0.png')!)).toMatch(/p0\.png$/)
    expect(await resolveAssetPath(dataDir, assetUrl('papers/7/mineru/images/a #1?%.jpg')!)).toMatch(/a #1\?%\.jpg$/)
  })

  it('路径穿越被拒：.. / 编码的 .. / 编码的斜杠 / 反斜杠 / 绝对', async () => {
    const bad = [
      'gt-asset://data/../outside/secret.txt',
      'gt-asset://data/papers/../../outside/secret.txt',
      'gt-asset://data/papers/%2E%2E/%2E%2E/outside/secret.txt',
      'gt-asset://data/..%2F..%2Foutside%2Fsecret.txt',
      'gt-asset://data/papers%2F7%2Fmineru%2Fimages%2Fp0.png',
      'gt-asset://data/..%5C..%5Coutside%5Csecret.txt',
      'gt-asset://data/%2Fetc%2Fpasswd',
      'gt-asset://data//etc/passwd',
      `gt-asset://data/${encodeURIComponent(join(outside, 'secret.txt'))}`
    ]
    for (const u of bad) expect(await resolveAssetPath(dataDir, u), u).toBeNull()
    expect(assetUrl('../outside/secret.txt')).toBeNull()
  })

  it('symlink 指向数据目录外（文件 / 目录 / 前缀相似兄弟目录）→ 拒绝', async () => {
    expect(await resolveAssetPath(dataDir, assetUrl('papers/7/evil.png')!)).toBeNull()
    expect(await resolveAssetPath(dataDir, assetUrl('papers/7/evildir/secret.txt')!)).toBeNull()
    expect(await resolveAssetPath(dataDir, assetUrl('prefix.png')!)).toBeNull()
  })

  it('symlink 指向数据目录内 → 允许', async () => {
    expect(await resolveAssetPath(dataDir, assetUrl('papers/7/ok-link.png')!)).toMatch(/p0\.png$/)
  })

  it('错误 scheme / host / query / fragment / 非法转义 / 目录 / 不存在 → 拒绝', async () => {
    const bad = [
      'file:///etc/passwd',
      'gt-asset://other/papers/7/mineru/images/p0.png',
      'gt-asset://data/papers/7/mineru/images/p0.png?x=1',
      'gt-asset://data/papers/7/mineru/images/p0.png#f',
      'gt-asset://data/papers/7/mineru/images/%E0%A4%A.png',
      'gt-asset://data/papers/7',
      'gt-asset://data/',
      'gt-asset://data/papers/7/nope.png',
      'not a url'
    ]
    for (const u of bad) expect(await resolveAssetPath(dataDir, u), u).toBeNull()
  })
})

describe('handleAssetRequest（D115）', () => {
  it('合法 → 200 + 字节 + 图片 MIME + nosniff', async () => {
    const r = await handleAssetRequest(dataDir, assetUrl('papers/7/mineru/images/p0.png')!)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/png')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  })

  it('穿越 / symlink 外指 → 404 且不回任何内容', async () => {
    for (const u of ['gt-asset://data/../outside/secret.txt', assetUrl('papers/7/evil.png')!]) {
      const r = await handleAssetRequest(dataDir, u)
      expect(r.status).toBe(404)
      expect(await r.text()).toBe('')
    }
  })
})
