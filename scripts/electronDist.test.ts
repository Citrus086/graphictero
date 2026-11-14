import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * E1（electron dist 自检接入 + 离线自愈）与 D146（持久开发数据根）测试。
 * 全部用临时目录里的假项目/假缓存/假 zip——不在 worktree 真实 node_modules 上做破坏性测试。
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-edist-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ─── 假项目脚手架 ────────────────────────────────────────────────

const ELECTRON_VERSION = '35.7.5'
const BIN_REL = 'Electron.app/Contents/MacOS/Electron'
const FRAMEWORKS = [
  'Electron.app/Contents/Frameworks/Electron Framework.framework',
  'Electron.app/Contents/Frameworks/Mantle.framework',
  'Electron.app/Contents/Frameworks/ReactiveObjC.framework',
  'Electron.app/Contents/Frameworks/Squirrel.framework'
]

/** 造一个假项目根：out/ 三端 + node_modules/electron（可指定 dist 形态）+ better-sqlite3 绑定 */
function makeFixtureRoot(opts: {
  out?: boolean
  dist?: 'complete' | 'no-dist' | 'no-path-txt' | 'version-mismatch'
  binding?: boolean
}): string {
  const root = join(dir, `proj-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  if (opts.out !== false) {
    for (const rel of ['out/main/index.js', 'out/preload/index.js']) {
      mkdirSync(dirname(join(root, rel)), { recursive: true })
      writeFileSync(join(root, rel), 'x')
    }
    mkdirSync(join(root, 'out/renderer'), { recursive: true })
    writeFileSync(join(root, 'out/renderer/index.html'), '<html></html>')
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ main: 'out/main/index.js' }))

  const eDir = join(root, 'node_modules/electron')
  mkdirSync(eDir, { recursive: true })
  writeFileSync(join(eDir, 'package.json'), JSON.stringify({ name: 'electron', version: ELECTRON_VERSION }))
  writeFileSync(join(eDir, 'checksums.json'), '{}')
  if (opts.dist === 'complete' || opts.dist === 'version-mismatch') {
    mkdirSync(join(eDir, 'dist', dirname(BIN_REL)), { recursive: true })
    writeFileSync(join(eDir, 'dist', BIN_REL), 'fake-binary')
    for (const fw of FRAMEWORKS) {
      mkdirSync(join(eDir, 'dist', fw), { recursive: true })
      writeFileSync(join(eDir, 'dist', fw, 'x'), 'x')
    }
    writeFileSync(
      join(eDir, 'dist', 'version'),
      opts.dist === 'version-mismatch' ? '35.0.0' : ELECTRON_VERSION
    )
  } else if (opts.dist === 'no-path-txt') {
    // path.txt 在、dist 里缺框架与可执行（不完整细分态）
    mkdirSync(join(eDir, 'dist'), { recursive: true })
    writeFileSync(join(eDir, 'dist', 'version'), ELECTRON_VERSION)
    writeFileSync(join(eDir, 'path.txt'), `${BIN_REL}\n`)
  }
  // 'no-dist'：连 dist 目录都不建（path.txt 也没有）
  if (opts.dist === 'complete' || opts.dist === 'version-mismatch') {
    writeFileSync(join(eDir, 'path.txt'), `${BIN_REL}\n`)
  }
  if (opts.binding !== false) {
    mkdirSync(join(root, 'node_modules/better-sqlite3/build/Release'), { recursive: true })
    writeFileSync(join(root, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'), 'fake')
  }
  return root
}

// ─── E1：自检四态 ────────────────────────────────────────────────

describe('E1：check-electron-dist 四态（临时假项目，不碰真实 node_modules）', () => {
  it('完整 → ok、退出码 0（full 与 --runtime 两种模式）', async () => {
    const { checkElectronDist, exitCodeFor } = await import('./electronDistLib.mjs')
    const root = makeFixtureRoot({ dist: 'complete' })
    const full = checkElectronDist(root, { runtime: false })
    expect(full.ok).toBe(true)
    expect(exitCodeFor(full.problems)).toBe(0)
    const rt = checkElectronDist(root, { runtime: true })
    expect(rt.ok).toBe(true)
  })

  it('dist 缺失 → 退出码 2 + 文案提示怎么修', async () => {
    const { checkElectronDist, exitCodeFor } = await import('./electronDistLib.mjs')
    const root = makeFixtureRoot({ dist: 'no-dist' })
    const { problems } = checkElectronDist(root, { runtime: true })
    expect(exitCodeFor(problems)).toBe(2)
    const text = problems.map((p) => p.message).join('\n')
    expect(text).toContain('path.txt 缺失')
    expect(text).toContain('pnpm fix:electron-dist') // 给固定修复步骤
  })

  it('path.txt 在但缺框架/可执行 → 退出码 2（dist 不完整细分态）', async () => {
    const { checkElectronDist, exitCodeFor } = await import('./electronDistLib.mjs')
    const root = makeFixtureRoot({ dist: 'no-path-txt' })
    const { problems } = checkElectronDist(root, { runtime: true })
    expect(exitCodeFor(problems)).toBe(2)
    const text = problems.map((p) => p.message).join('\n')
    expect(text).toContain('electron dist 不完整')
  })

  it('dist/version 与包版本不符 → 退出码 2（版本不符细分态）', async () => {
    const { checkElectronDist, exitCodeFor } = await import('./electronDistLib.mjs')
    const root = makeFixtureRoot({ dist: 'version-mismatch' })
    const { problems } = checkElectronDist(root, { runtime: true })
    expect(exitCodeFor(problems)).toBe(2)
    expect(problems.map((p) => p.message).join('\n')).toContain('不一致')
  })

  it('原生绑定缺失 → 退出码 4；out/ 缺失在 full 模式 → 退出码 1、runtime 模式不查 out/', async () => {
    const { checkElectronDist, exitCodeFor } = await import('./electronDistLib.mjs')
    const root = makeFixtureRoot({ dist: 'complete', binding: false, out: false })
    const full = checkElectronDist(root, { runtime: false })
    const code = exitCodeFor(full.problems)
    expect(code & 1).toBe(1) // build
    expect(code & 4).toBe(4) // binding
    const rt = checkElectronDist(root, { runtime: true })
    expect(exitCodeFor(rt.problems)).toBe(4) // runtime 不要求 out/
  })

  it('ELECTRON_SKIP_BINARY_DOWNLOAD 设置时，报错文案点出该变量（测试者 场景提示）', async () => {
    const { checkElectronDist } = await import('./electronDistLib.mjs')
    const root = makeFixtureRoot({ dist: 'no-dist' })
    const old = process.env.ELECTRON_SKIP_BINARY_DOWNLOAD
    process.env.ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
    try {
      const { problems } = checkElectronDist(root, { runtime: true })
      expect(problems.map((p) => p.message).join('\n')).toContain('ELECTRON_SKIP_BINARY_DOWNLOAD')
    } finally {
      if (old === undefined) delete process.env.ELECTRON_SKIP_BINARY_DOWNLOAD
      else process.env.ELECTRON_SKIP_BINARY_DOWNLOAD = old
    }
  })
})

// ─── E1：离线自愈 ────────────────────────────────────────────────

/** 造一个假 electron dist 骨架并用 ditto 打成 zip（E1 自愈的合法缓存对象） */
function makeCachedZip(cacheDir: string, fileName: string, opts: { broken?: boolean } = {}): string {
  const stage = mkdtempSync(join(dir, 'zip-stage-'))
  if (!opts.broken) {
    mkdirSync(join(stage, dirname(BIN_REL)), { recursive: true })
    writeFileSync(join(stage, BIN_REL), 'fake-binary')
    for (const fw of FRAMEWORKS) {
      mkdirSync(join(stage, fw), { recursive: true })
      writeFileSync(join(stage, fw, 'x'), 'x')
    }
    writeFileSync(join(stage, 'version'), ELECTRON_VERSION)
  } else {
    writeFileSync(join(stage, 'README.txt'), 'not a real electron dist') // 结构不对
  }
  const zip = join(cacheDir, 'f71d58b9535ad2f1d90f09dd91a30fea648c4fe7e710e38a47d6983edd09e53f', fileName)
  mkdirSync(dirname(zip), { recursive: true })
  execFileSync('ditto', ['-c', '-k', stage, zip])
  rmSync(stage, { recursive: true, force: true })
  return zip
}

const zipName = () => `electron-v${ELECTRON_VERSION}-${process.platform}-${process.arch}.zip`

describe('E1：离线自愈（缓存有匹配 zip + checksum 对 → 修好；否则不写任何文件）', () => {
  it('缓存有匹配 zip 且 checksum 对 → 解压到 dist + 写 path.txt，重查通过', async () => {
    const { healElectronDist } = await import('./electronDistHeal.mjs')
    const { checkElectronDist } = await import('./electronDistLib.mjs')
    const root = makeFixtureRoot({ dist: 'no-dist' })
    const eDir = join(root, 'node_modules/electron')
    const cacheDir = join(dir, 'cache')
    const zip = makeCachedZip(cacheDir, zipName())
    writeFileSync(join(eDir, 'checksums.json'), JSON.stringify({ [zipName()]: createHash('sha256').update(readFileSync(zip)).digest('hex') }))

    const r = healElectronDist({ electronPkgDir: eDir, cacheRoots: [cacheDir] })
    expect(r.healed).toBe(true)
    expect(existsSync(join(eDir, 'dist', BIN_REL))).toBe(true)
    expect(readFileSync(join(eDir, 'path.txt'), 'utf8').trim()).toBe(BIN_REL)
    expect(checkElectronDist(root, { runtime: true }).ok).toBe(true)
    expect(readdirSync(eDir).some((name) => name.startsWith('.electron-dist-heal-'))).toBe(false)
  })

  it('checksum 不符 → 不自愈、不写任何文件（dist 与 path.txt 都不出现）并报错', async () => {
    const { healElectronDist } = await import('./electronDistHeal.mjs')
    const root = makeFixtureRoot({ dist: 'no-dist' })
    const eDir = join(root, 'node_modules/electron')
    const cacheDir = join(dir, 'cache')
    makeCachedZip(cacheDir, zipName())
    writeFileSync(join(eDir, 'checksums.json'), JSON.stringify({ [zipName()]: '0'.repeat(64) }))

    const r = healElectronDist({ electronPkgDir: eDir, cacheRoots: [cacheDir] })
    expect(r.healed).toBe(false)
    expect(r.reason).toContain('校验和不符')
    expect(existsSync(join(eDir, 'dist'))).toBe(false)
    expect(existsSync(join(eDir, 'path.txt'))).toBe(false)
  })

  it('缓存没有匹配 zip → 不自愈并给原因与手动步骤', async () => {
    const { healElectronDist } = await import('./electronDistHeal.mjs')
    const root = makeFixtureRoot({ dist: 'no-dist' })
    const eDir = join(root, 'node_modules/electron')
    writeFileSync(join(eDir, 'checksums.json'), JSON.stringify({ [zipName()]: '0'.repeat(64) }))
    const r = healElectronDist({ electronPkgDir: eDir, cacheRoots: [join(dir, 'empty-cache')] })
    expect(r.healed).toBe(false)
    expect(r.reason).toContain('没有')
    expect(r.hint).toContain('ditto')
    expect(existsSync(join(eDir, 'dist'))).toBe(false)
  })

  it('zip 结构不对（缺可执行）→ 不自愈', async () => {
    const { healElectronDist } = await import('./electronDistHeal.mjs')
    const root = makeFixtureRoot({ dist: 'no-dist' })
    const eDir = join(root, 'node_modules/electron')
    const cacheDir = join(dir, 'cache')
    const zip = makeCachedZip(cacheDir, zipName(), { broken: true })
    writeFileSync(join(eDir, 'checksums.json'), JSON.stringify({ [zipName()]: createHash('sha256').update(readFileSync(zip)).digest('hex') }))
    const r = healElectronDist({ electronPkgDir: eDir, cacheRoots: [cacheDir] })
    expect(r.healed).toBe(false)
    expect(r.reason).toContain('缺可执行文件')
    expect(existsSync(join(eDir, 'dist'))).toBe(false)
    expect(readdirSync(eDir).some((name) => name.startsWith('.electron-dist-heal-'))).toBe(false)
  })

  it('本机真实缓存评估：electron-v35.7.5-darwin-arm64.zip 在不在（E1 给测试者 的结论依据）', () => {
    const cache = join(process.env.HOME ?? '', 'Library', 'Caches', 'electron')
    const found = existsSync(cache)
      ? readdirSync(cache, { recursive: true } as never).some((f) => String(f).includes('electron-v35.7.5-darwin-arm64.zip'))
      : false
    // 只记录结论（本机有 → 测试者 下轮全新安装可自愈；无 → 走 ditto 手动步骤）
    expect(typeof found).toBe('boolean')
  })
})

// ─── D146：开发数据根解析与守卫 ──────────────────────────────────

describe('D146：dev-isolated 持久开发数据根（--print 干跑，不启动 Electron）', () => {
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [join(process.cwd(), 'scripts', 'dev-isolated.mjs'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env }
    })

  it('默认解析到 ~/Library/Application Support/Graphictero-dev（持久，不等于默认 App 目录）', async () => {
    // @ts-ignore 动态 import .mjs（库导出 resolveDevDataRoot / defaultAppDataDir）
    const m = (await import('./dev-isolated.mjs')) as {
      resolveDevDataRoot: (env: NodeJS.ProcessEnv) => string
      defaultAppDataDir: () => string
    }
    expect(m.resolveDevDataRoot({} as NodeJS.ProcessEnv)).toBe(join(process.env.HOME ?? '', 'Library', 'Application Support', 'Graphictero-dev'))
    expect(m.resolveDevDataRoot({} as NodeJS.ProcessEnv)).not.toBe(m.defaultAppDataDir())
    const r = run(['--print'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout.trim())
    expect(parsed.dataRoot).toContain('Graphictero-dev')
    expect(parsed.tmp).toBe(false)
  })

  it('GRAPHICTERO_DEV_DATA_ROOT 覆盖生效', async () => {
    const r = run(['--print'], { GRAPHICTERO_DEV_DATA_ROOT: join(dir, 'my-dev-root') })
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout.trim()).dataRoot).toBe(join(dir, 'my-dev-root'))
  })

  it('守卫：开发数据根等于默认 App 目录 → 明确报错退出 1（含原因与建议）', () => {
    const r = run(['--print'], { GRAPHICTERO_DEV_DATA_ROOT: join(process.env.HOME ?? '', 'Library', 'Application Support', 'Graphictero') })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('拒绝启动')
    expect(r.stderr).toContain('Graphictero-dev')
  })

  it('--tmp 变体仍每次 mktemp 新目录（两次不同）', () => {
    const r1 = run(['--print', '--tmp'])
    const r2 = run(['--print', '--tmp'])
    expect(r1.status).toBe(0)
    const p1 = JSON.parse(r1.stdout.trim())
    const p2 = JSON.parse(r2.stdout.trim())
    expect(p1.tmp).toBe(true)
    expect(p1.dataRoot).not.toBe(p2.dataRoot)
    expect(p1.dataRoot).toContain('gt-dev-data-')
    expect(p1.userDataDir).toContain('gt-dev-userdata-')
    expect(existsSync(p1.dataRoot)).toBe(false)
    expect(existsSync(p1.userDataDir)).toBe(false)
    expect(existsSync(p2.dataRoot)).toBe(false)
    expect(existsSync(p2.userDataDir)).toBe(false)
    rmSync(p1.dataRoot, { recursive: true, force: true })
    rmSync(p1.userDataDir, { recursive: true, force: true })
    rmSync(p2.dataRoot, { recursive: true, force: true })
    rmSync(p2.userDataDir, { recursive: true, force: true })
  })

  it('空的 GRAPHICTERO_DEV_DATA_ROOT 视为未设置', async () => {
    const home = join(dir, 'home-empty')
    // @ts-ignore 动态 import .mjs
    const m = (await import('./dev-isolated.mjs')) as {
      resolveDevDataRoot: (env: NodeJS.ProcessEnv, home?: string) => string
    }
    const expected = join(home, 'Library', 'Application Support', 'Graphictero-dev')
    expect(m.resolveDevDataRoot({ GRAPHICTERO_DEV_DATA_ROOT: '' }, home)).toBe(expected)
    expect(m.resolveDevDataRoot({ GRAPHICTERO_DEV_DATA_ROOT: '   ' }, home)).toBe(expected)
    const r = run(['--print'], { HOME: home, GRAPHICTERO_DEV_DATA_ROOT: '' })
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout.trim()).dataRoot).toBe(expected)
    expect(existsSync(join(home, 'Library', 'Application Support', 'Graphictero'))).toBe(false)
    expect(existsSync(expected)).toBe(false)
  })

  it('尾斜杠、大小写、指向默认 App 目录的符号链接都拒绝；旁边的目录不拒绝', () => {
    const home = join(dir, 'home-guard')
    const appDir = join(home, 'Library', 'Application Support', 'Graphictero')
    mkdirSync(appDir, { recursive: true })
    const link = join(dir, 'link-to-default-app')
    symlinkSync(appDir, link)
    const base = { HOME: home }

    const trailing = run(['--print'], { ...base, GRAPHICTERO_DEV_DATA_ROOT: `${appDir}/` })
    expect(trailing.status).toBe(1)
    expect(trailing.stderr).toContain('拒绝启动')

    if (process.platform === 'darwin') {
      const folded = run(['--print'], {
        ...base,
        GRAPHICTERO_DEV_DATA_ROOT: join(home, 'library', 'application support', 'graphictero')
      })
      expect(folded.status).toBe(1)
      expect(folded.stderr).toContain('拒绝启动')
    }

    const viaLink = run(['--print'], { ...base, GRAPHICTERO_DEV_DATA_ROOT: link })
    expect(viaLink.status).toBe(1)
    expect(viaLink.stderr).toContain('拒绝启动')

    const sibling = join(home, 'Library', 'Application Support', 'Graphictero-other')
    const ok = run(['--print'], { ...base, GRAPHICTERO_DEV_DATA_ROOT: sibling })
    expect(ok.status).toBe(0)
    expect(JSON.parse(ok.stdout.trim()).dataRoot).toBe(sibling)
  })
})

// ─── 语法冒烟（防再犯：脚本改了语法错只在正式跑时炸）────────────────

describe('scripts/*.mjs 语法检查（node --check，0 网络）', () => {
  const scripts = readdirSync(join(process.cwd(), 'scripts'))
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => join('scripts', f))
  it.each(scripts)('%s 通过语法检查', (s) => {
    execFileSync(process.execPath, ['--check', s])
  })
})
