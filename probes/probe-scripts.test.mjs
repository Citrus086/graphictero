import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 探针脚本语法冒烟（评审必须修 1 的防再犯措施）：
 * vitest 只 import probes/lib/*.mjs，探针脚本本体（会调付费 API）从不被执行，
 * 语法错误（如 deepseek-probe.mjs 曾出现的游离括号）只有正式跑时才会炸。
 * 这里对每个 .mjs 跑 `node --check`（纯语法校验，0 token、0 网络）。
 */
const dirs = ['probes', 'probes/lib']
const scripts = dirs.flatMap((d) =>
  readdirSync(join(process.cwd(), d))
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
    .map((f) => join(d, f))
)

describe('探针脚本语法（node --check，0 token 干跑）', () => {
  it.each(scripts)('%s 通过语法检查', (script) => {
    expect(() => execFileSync(process.execPath, ['--check', script], { stdio: 'pipe' })).not.toThrow()
  })

  it('覆盖到全部探针脚本（含会调付费 API 的入口脚本）', () => {
    expect(scripts).toContain('probes/deepseek-probe.mjs')
    expect(scripts).toContain('probes/openalex-probe.mjs')
    expect(scripts.length).toBeGreaterThanOrEqual(6)
  })
})

describe('deepseek-probe --limit 保护（0 token、0 网络）', () => {
  // 自建临时 fixtures：1 篇论文 + 对应 MinerU Markdown 目录，不依赖本地 gitignored 产物
  let tmp
  let mdDir
  let papersPath

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'gt-probe-limit-'))
    mdDir = join(tmp, 'mineru', 'Test Paper - arXiv 9999.00001')
    papersPath = join(tmp, 'papers.json')
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function setup() {
    mkdirSync(mdDir, { recursive: true })
    writeFileSync(join(mdDir, 'Test Paper - arXiv 9999.00001.md'), '# 假正文\n\nhello\n')
    writeFileSync(
      papersPath,
      JSON.stringify([{ key: 'T01', title: 'Test Paper', arxiv: '9999.00001', year: 2026 }])
    )
  }

  it('--limit 大于可用篇数时明确报错退出（exit 4），dry-run 也不例外', () => {
    setup()
    const r = spawnSync(
      process.execPath,
      ['probes/deepseek-probe.mjs', '--papers', papersPath, '--markdown-dir', join(tmp, 'mineru'), '--limit', '5', '--dry-run'],
      { stdio: 'pipe', encoding: 'utf-8' }
    )
    expect(r.status, `stdout=${r.stdout} stderr=${r.stderr}`).toBe(4)
    expect(r.stderr).toContain('大于 fixtures 可用论文数 1') // 明确报错，不静默截断
    expect(r.stdout).not.toContain('[dry-run]') // 报错后没有干跑输出
  })

  it('--limit 等于可用篇数时干跑正常退出（exit 0）', () => {
    setup()
    const r = spawnSync(
      process.execPath,
      ['probes/deepseek-probe.mjs', '--papers', papersPath, '--markdown-dir', join(tmp, 'mineru'), '--limit', '1', '--dry-run'],
      { stdio: 'pipe', encoding: 'utf-8' }
    )
    expect(r.status, `stdout=${r.stdout} stderr=${r.stderr}`).toBe(0)
    expect(r.stdout).toContain('[dry-run] fixtures 共 1 篇，本次取 1 篇（limit=1）')
    expect(r.stdout).toContain('T01')
  })

  it('某篇匹配不到 Markdown 时明确报错退出（exit 3）', () => {
    setup()
    // markdown-dir 指向一个没有任何解析产物的空目录
    const emptyMd = join(tmp, 'mineru-empty')
    mkdirSync(emptyMd, { recursive: true })
    const r = spawnSync(
      process.execPath,
      ['probes/deepseek-probe.mjs', '--papers', papersPath, '--markdown-dir', emptyMd, '--limit', '1', '--dry-run'],
      { stdio: 'pipe', encoding: 'utf-8' }
    )
    expect(r.status, `stdout=${r.stdout} stderr=${r.stderr}`).toBe(3)
    expect(r.stderr).toContain('找不到 T01 的解析 Markdown')
  })

  it('输出 JSON 记录 requestedLimit 与 papersAvailable（不静默）', () => {
    // 保护字段在正式输出 JSON 的结构里（不跑网络，只静态检查脚本包含且非 dry-run 分支写入）
    const src = readFileSync(join(process.cwd(), 'probes/deepseek-probe.mjs'), 'utf-8')
    expect(src).toContain('requestedLimit: limit')
    expect(src).toContain('papersAvailable,')
    expect(src).toContain('大于 fixtures 可用论文数')
  })
})
