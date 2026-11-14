import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() } }))

import { APP_HOST, APP_SCHEME, appIndexUrl, handleAppRequest, resolveAppPath } from './appProtocol'

// D116：gt-app:// 主进程解析——词法 + realpath 双重校验（对齐 assetProtocol.test.ts 风格）
let root: string
let rendererDir: string
let outside: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'gt-app-'))
  rendererDir = join(root, 'out', 'renderer')
  outside = join(root, 'outside')
  mkdirSync(join(rendererDir, 'assets', 'deep'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(rendererDir, 'index.html'), '<!doctype html><title>gt-app</title>')
  writeFileSync(join(rendererDir, 'assets', 'app-ABC123.js'), 'console.log(1)')
  writeFileSync(join(rendererDir, 'assets', 'pdfium-XYZ.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d]))
  writeFileSync(join(rendererDir, 'assets', 'a #1?%.css'), 'body{}')
  writeFileSync(join(rendererDir, 'assets', 'KaTeX-Main.woff2'), 'font')
  writeFileSync(join(rendererDir, 'assets', 'deep', 'chart.svg'), '<svg/>')
  writeFileSync(join(rendererDir, 'assets', 'data.json'), '{}')
  writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET')
  writeFileSync(join(root, 'sibling.txt'), 'sibling')
  // 输出目录内指向目录外的 symlink（文件与目录各一）
  symlinkSync(join(outside, 'secret.txt'), join(rendererDir, 'assets', 'evil.js'))
  symlinkSync(outside, join(rendererDir, 'assets', 'evildir'))
  // 输出目录内指向目录内的 symlink：允许
  symlinkSync(join(rendererDir, 'assets', 'app-ABC123.js'), join(rendererDir, 'assets', 'ok-link.js'))
  // 前缀相似的兄弟目录（renderer-evil）不能因 startsWith 误判为目录内
  mkdirSync(join(root, 'out', 'renderer-evil'), { recursive: true })
  writeFileSync(join(root, 'out', 'renderer-evil', 'x.js'), 'x')
  symlinkSync(join(root, 'out', 'renderer-evil', 'x.js'), join(rendererDir, 'assets', 'prefix.js'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('appIndexUrl（D116 入口 URL）', () => {
  it('拼 gt-app://app/ 与带 query 的入口', () => {
    expect(appIndexUrl()).toBe('gt-app://app/')
    expect(appIndexUrl({ smoke: '1' })).toBe('gt-app://app/?smoke=1')
    expect(appIndexUrl({ smoke: '1', motion: 'off' })).toBe('gt-app://app/?smoke=1&motion=off')
    expect(appIndexUrl({ motion: 'off' })).toBe('gt-app://app/?motion=off')
  })
})

describe('resolveAppPath（D116）', () => {
  it('入口 / 与真实资源 → 输出目录内文件（含空格/#/?/% 文件名，query 合法）', async () => {
    expect(await resolveAppPath(rendererDir, `${APP_SCHEME}://${APP_HOST}/`)).toMatch(/index\.html$/)
    expect(await resolveAppPath(rendererDir, `${APP_SCHEME}://${APP_HOST}/?smoke=1`)).toMatch(/index\.html$/)
    expect(await resolveAppPath(rendererDir, `${APP_SCHEME}://${APP_HOST}/assets/app-ABC123.js`)).toMatch(/app-ABC123\.js$/)
    expect(await resolveAppPath(rendererDir, `${APP_SCHEME}://${APP_HOST}/assets/a%20%231%3F%25.css`)).toMatch(/a #1\?%\.css$/)
    expect(await resolveAppPath(rendererDir, `${APP_SCHEME}://${APP_HOST}/assets/deep/chart.svg`)).toMatch(/chart\.svg$/)
    // URL 解析会先规范化掉 `.` 段（等价于上面的合法路径）；穿越防线在 realpath 包含校验
    expect(await resolveAppPath(rendererDir, `${APP_SCHEME}://${APP_HOST}/assets/./app-ABC123.js`)).toMatch(/app-ABC123\.js$/)
  })

  it('路径穿越被拒：.. / 编码的 .. / 编码的斜杠 / 反斜杠 / 绝对路径 / 空段', async () => {
    const bad = [
      'gt-app://app/../outside/secret.txt',
      'gt-app://app/assets/../../outside/secret.txt',
      'gt-app://app/assets/%2E%2E/%2E%2E/outside/secret.txt',
      'gt-app://app/..%2F..%2Foutside%2Fsecret.txt',
      'gt-app://app/assets%2Fapp-ABC123.js',
      'gt-app://app/..%5C..%5Coutside%5Csecret.txt',
      'gt-app://app/%2Fetc%2Fpasswd',
      'gt-app://app//etc/passwd',
      'gt-app://app/assets//app-ABC123.js',
      `gt-app://app/${encodeURIComponent(join(outside, 'secret.txt'))}`
    ]
    for (const u of bad) expect(await resolveAppPath(rendererDir, u), u).toBeNull()
  })

  it('symlink 指向输出目录外（文件 / 目录 / 前缀相似兄弟目录）→ 拒绝；指向目录内 → 允许', async () => {
    expect(await resolveAppPath(rendererDir, 'gt-app://app/assets/evil.js')).toBeNull()
    expect(await resolveAppPath(rendererDir, 'gt-app://app/assets/evildir/secret.txt')).toBeNull()
    expect(await resolveAppPath(rendererDir, 'gt-app://app/assets/prefix.js')).toBeNull()
    expect(await resolveAppPath(rendererDir, 'gt-app://app/assets/ok-link.js')).toMatch(/app-ABC123\.js$/)
  })

  it('错误 scheme / host / port / fragment / 非法转义 / 目录 / 不存在 → 拒绝', async () => {
    const bad = [
      'file:///etc/passwd',
      'gt-asset://app/assets/app-ABC123.js',
      'gt-app://other/',
      'gt-app://other/assets/app-ABC123.js',
      'gt-app://app:8080/',
      'gt-app://app/assets/app-ABC123.js#f',
      'gt-app://app/assets/%E0%A4%A.js',
      'gt-app://app/assets',
      'gt-app://app/assets/deep',
      'gt-app://app/nope.html',
      'not a url'
    ]
    for (const u of bad) expect(await resolveAppPath(rendererDir, u), u).toBeNull()
  })
})

describe('handleAppRequest（D116）', () => {
  it('入口与资源 → 200 + 正确 MIME + nosniff（html/js/css/wasm/svg/json/字体）', async () => {
    const cases: Array<[string, string, string | null]> = [
      ['gt-app://app/', 'text/html;charset=utf-8', 'no-store'],
      ['gt-app://app/assets/app-ABC123.js', 'text/javascript;charset=utf-8', null],
      ['gt-app://app/assets/a%20%231%3F%25.css', 'text/css;charset=utf-8', null],
      ['gt-app://app/assets/pdfium-XYZ.wasm', 'application/wasm', null],
      ['gt-app://app/assets/deep/chart.svg', 'image/svg+xml', null],
      ['gt-app://app/assets/data.json', 'application/json;charset=utf-8', null],
      ['gt-app://app/assets/KaTeX-Main.woff2', 'font/woff2', null]
    ]
    for (const [u, mime, cache] of cases) {
      const r = await handleAppRequest(rendererDir, u)
      expect(r.status, u).toBe(200)
      expect(r.headers.get('content-type'), u).toBe(mime)
      expect(r.headers.get('x-content-type-options'), u).toBe('nosniff')
      expect(r.headers.get('cache-control'), u).toBe(cache)
    }
    expect(await (await handleAppRequest(rendererDir, 'gt-app://app/')).text()).toContain('gt-app')
  })

  it('穿越 / symlink 外指 / 目录 / 不存在 / 非 app host → 404 且不回任何内容', async () => {
    const bad = [
      'gt-app://app/../outside/secret.txt',
      'gt-app://app/assets/evil.js',
      'gt-app://app/assets',
      'gt-app://app/nope.html',
      'gt-app://other/'
    ]
    for (const u of bad) {
      const r = await handleAppRequest(rendererDir, u)
      expect(r.status, u).toBe(404)
      expect(await r.text(), u).toBe('')
    }
  })
})
