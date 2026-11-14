import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MineruParser } from './mineruParser'

/**
 * 真实 MinerU 集成冒烟（不进 `pnpm test`：文件名 *.it.ts 不在 vitest include 内）。
 * 手动跑：`pnpm vitest run src/main/parser/mineru.smoke.it.ts`
 *
 * 前置：主仓库 ~/Desktop/repos/graphictero/sidecar/mineru/.venv 已有 M0 装好的
 * MinerU 4.0.12 + 模型（本车道 worktree 无 .venv，复用其环境变量指向，不重复下载）。
 * 用 fixture 里最小的 PDF（Bovens 2007，约 158KB）真跑一遍解析链路：
 * uploads → job → 轮询 → Markdown + 图片解包。全程本地、免费。
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '../../../')
const MAIN_VENV = process.env.MINERU_SMOKE_VENV ?? resolve(process.env.HOME ?? '~', 'Desktop/repos/graphictero/sidecar/mineru/.venv')
const PORT = 45673
const BASE = `http://127.0.0.1:${PORT}`

let child: ChildProcess | null = null
let tmp: string
let fixture: string

beforeAll(async () => {
  if (!existsSync(MAIN_VENV)) throw new Error(`主仓库 venv 不存在：${MAIN_VENV}`)
  tmp = mkdtempSync(join(tmpdir(), 'gt-mineru-smoke-'))
  // fixture 里最小的 PDF
  const pdfDir = join(ROOT, 'probes/fixtures/pdfs')
  const pdfs = readdirSync(pdfDir).filter((f) => f.endsWith('.pdf'))
  fixture = join(pdfDir, pdfs.sort((a, b) => statSync(join(pdfDir, a)).size - statSync(join(pdfDir, b)).size)[0])
  child = spawn('uv', ['run', '--project', join(ROOT, 'sidecar/mineru'), 'mineru-api', '--host', '127.0.0.1', '--port', String(PORT), '--concurrency', '1', '--upload-dir', join(tmp, 'uploads')], {
    cwd: tmp,
    env: { ...process.env, UV_PROJECT_ENVIRONMENT: MAIN_VENV, MINERU_API_RETENTION_SECONDS: '3600' }
  })
  child.stderr?.on('data', (d) => process.stderr.write(`[mineru-api] ${d}`))
  // 等 /v1/health 就绪（模型已缓存时很快）
  const deadline = Date.now() + 120_000
  for (;;) {
    try {
      const res = await fetch(`${BASE}/v1/health`)
      if (res.ok) break
    } catch {
      // 还没起好
    }
    if (Date.now() > deadline) throw new Error('mineru-api 启动超时')
    await new Promise((r) => setTimeout(r, 500))
  }
}, 180_000)

afterAll(() => {
  child?.kill('SIGTERM')
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

describe('真实 MinerU 集成冒烟（本地、免费；需主仓库 venv）', () => {
  it('解析最小 fixture PDF：拿到 Markdown，图片按图号解包', async () => {
    const parser = new MineruParser({
      sidecar: {
        isReady: () => true,
        baseUrl: () => BASE,
        pageProgress: () => ({ pagesDone: null, pagesTotal: null })
      },
      pollMs: 1000,
      totalTimeoutMs: 10 * 60_000
    })
    const progress: string[] = []
    const outDir = join(tmp, 'mineru-out')
    const result = await parser.parse(fixture, outDir, (p) => progress.push(`${p.stage}:${p.completedFiles}/${p.totalFiles}`))
    expect(result.markdown.length).toBeGreaterThan(500)
    expect(result.markdown).toMatch(/#|Abstract|Introduction|摘要/i)
    // 产物按图号落盘（该论文图片少；images/ 目录由 zip 决定，至少 full 链路无错）
    expect(progress[0]).toBe('upload:0/1')
    expect(progress.at(-1)?.startsWith('download:')).toBe(true)
    expect(progress).toContain('parse:1/1') // 轮询拿到文件级完成进度（D72 口径）
    console.log(`[smoke] fixture=${fixture}`)
    console.log(`[smoke] markdown ${result.markdown.length} 字符；进度=${progress.join(' → ')}`)
    if (existsSync(join(outDir, 'images'))) {
      console.log(`[smoke] 图片：${readdirSync(join(outDir, 'images')).join(', ')}`)
    }
  }, 10 * 60_000)
})
