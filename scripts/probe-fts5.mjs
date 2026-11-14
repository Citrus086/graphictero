#!/usr/bin/env node
/**
 * M0 探针（D72）：无窗口验证 better-sqlite3 + FTS5 + Intl.Segmenter 中文分词。
 * 用法：node scripts/probe-fts5.mjs <可执行文件> [结果JSON路径]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const [, , binArg, outArg] = process.argv
if (!binArg) {
  console.error('用法: node scripts/probe-fts5.mjs <electron或Graphictero.app> [输出JSON]')
  process.exit(2)
}

const bin = resolve(binArg)
const out = outArg ? resolve(outArg) : join(tmpdir(), `graphictero-fts5-probe-${Date.now()}.json`)
let userDataDir = null
let child = null
let timer = null

async function run() {
try {
  // 独立临时 userData，绝不写默认 Application Support；所有退出路径在 finally 清理。
  userDataDir = mkdtempSync(join(tmpdir(), 'gt-fts5-probe-userdata-'))
  const userDataSwitch = `--user-data-dir=${userDataDir}`
  const isApp = bin.endsWith('.app')
  const cmd = isApp ? join(bin, 'Contents/MacOS/Graphictero') : bin
  const args = isApp ? [userDataSwitch, '--probe-fts5', out] : [userDataSwitch, 'out/main/index.js', '--probe-fts5', out]
  if (!existsSync(cmd)) {
    console.error(`找不到可执行文件: ${cmd}`)
    process.exitCode = 2
    return
  }
  mkdirSync(dirname(out), { recursive: true })
  if (existsSync(out)) rmSync(out)

  const outcome = await new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] })
    child.once('error', (error) => done({ code: 1, error }))
    child.once('exit', (code) => done({ code }))
    timer = setTimeout(() => {
      console.error('探针超时（60 秒）')
      child.kill('SIGKILL')
      done({ code: 3, timedOut: true })
    }, 60000)
  })
  if (timer) clearTimeout(timer)
  timer = null
  if (outcome.error) throw outcome.error
  if (outcome.timedOut) {
    process.exitCode = 3
    return
  }
  if (!existsSync(out)) {
    console.error(`没有生成结果文件: ${out}（退出码 ${outcome.code}）`)
    process.exitCode = 4
    return
  }
  const result = JSON.parse(readFileSync(out, 'utf-8'))
  console.log('探针结果: ' + JSON.stringify(result))
  const ok = outcome.code === 0 && result.ok === true
  console.log(ok ? 'FTS5 探针通过' : 'FTS5 探针失败')
  process.exitCode = ok ? 0 : 5
} catch (error) {
  console.error(`FTS5 探针异常：${error instanceof Error ? error.message : String(error)}`)
  if (process.exitCode == null || process.exitCode === 0) process.exitCode = 1
} finally {
  if (timer) clearTimeout(timer)
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true })
  if (!outArg) rmSync(out, { force: true })
}
}

await run()
