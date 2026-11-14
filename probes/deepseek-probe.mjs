#!/usr/bin/env node
/**
 * M0 探针（D25/D66/D84/D86/D87/D92）：用 deepseek-flash 跑小规模建图，记录 token 用量和费用。
 *
 * 用法：
 *   node probes/deepseek-probe.mjs \
 *     --papers probes/fixtures/papers.json \
 *     --markdown-dir probes/results/mineru \
 *     --limit 3 --out probes/results/deepseek-probe.json
 *
 * 干跑（0 token、0 网络，不需要 DEEPSEEK_API_KEY）：
 *   node probes/deepseek-probe.mjs --papers ... --markdown-dir ... --limit 20 --dry-run
 * 只做加载 + Markdown 匹配，打印每篇匹配到的目录与字符数后退出。
 *
 * 做法（对齐 D87/D86/D84/D92）：
 *   - 每篇读 MinerU 解析出的 Markdown（截断到 --max-chars，默认 20000 字符 ≈ 5k token），
 *     当作「详情」层上下文；论文用 P01 短 id（D86）；
 *   - ToolLoopAgent + addRelation 工具（LLM 可选类型固定集合、方向 A→B 表示 B 基于/针对 A、
 *     自然语言陈述；同一无序论文对幂等合并，见 probes/lib/relation-tool.mjs）；
 *   - 统一开启 thinking + 流式输出（D92，替换 D79 的「关系任务关 thinking」）；
 *   - 显式 maxOutputTokens（D86；D100 起默认用模型最大值 393216，不再设 8192 上限）+ 每步 addRelation 软上限（默认约 50 条，超出的调用
 *     收到校验错误而不是被记录，见 relation-tool.mjs 的 perStepLimit）；
 *   - 记录每一步 usage（含缓存命中）、工具循环步数、写出的关系、费用
 *     （lib/cost.mjs，D96 人民币价目）；
 *   - D96 对账：开跑前、结束后各查一次 /user/balance（免费接口），输出
 *     「按 usage 算的费用」与「余额实际减少」两个数；
 *
 * 需要 .env 里有 DEEPSEEK_API_KEY（D34）。
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { loadEnv } from './lib/env.mjs'
import { costCny, fetchBalance, isPeakHour } from './lib/cost.mjs'
import { createAddRelation, LLM_RELATION_TYPES } from './lib/relation-tool.mjs'
import { mapSteps, sumUsage } from './lib/map-steps.mjs'

const argList = process.argv.slice(2)
const args = {}
for (let i = 0; i < argList.length; i++) {
  if (argList[i].startsWith('--')) args[argList[i].slice(2)] = argList[i + 1] && !argList[i + 1].startsWith('--') ? argList[++i] : true
}

const papersPath = resolve(args.papers ?? 'probes/fixtures/papers.json')
const mdDir = resolve(args.markdownDir ?? args['markdown-dir'] ?? 'probes/results/mineru')
const limit = Number(args.limit ?? 3)
const maxChars = Number(args.maxChars ?? args['max-chars'] ?? 20000)
const outPath = resolve(args.out ?? 'probes/results/deepseek-probe.json')
const maxSteps = Number(args.maxSteps ?? args['max-steps'] ?? 8)
// D100：不设输出上限 → 默认用 deepseek-flash 官方最大输出 393216（384K）；省略 max_tokens 时思考模式只默认 64K，所以显式传最大值
const maxOutputTokens = Number(args.maxOutputTokens ?? args['max-output-tokens'] ?? 393216)
// 报告 §7「每步最多约 50 条 addRelation」：软上限，超限的调用收到校验错误（工具结果）
const perStepLimit = Number(args.perStepLimit ?? args['per-step-limit'] ?? 50)
// 干跑模式：只加载 fixtures + 匹配 MinerU Markdown 并打印，不调用任何网络/API
const dryRun = Boolean(args['dry-run'] ?? args.dryRun)

const env = loadEnv()
if (!dryRun && !env.DEEPSEEK_API_KEY) {
  console.error('缺少 DEEPSEEK_API_KEY（.env）')
  process.exit(2)
}

const BASE_URL = env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com' // D96：与 src/main/llm/config.ts 的 PROVIDER_BASE_URLS 同口径

/** D96 对账：查余额（免费接口）；失败不中断探针，记录错误串 */
async function tryFetchBalance() {
  try {
    const b = await fetchBalance(BASE_URL, env.DEEPSEEK_API_KEY)
    return { total: b.total, currency: b.currency }
  } catch (e) {
    return { total: null, currency: null, error: e instanceof Error ? e.message : String(e) }
  }
}

const papersAvailable = JSON.parse(readFileSync(papersPath, 'utf-8')).length
// 保护（评审必 1 的防再犯措施）：请求的 limit 大于可用篇数时明确报错退出，不静默截断（dry-run 同样报错）
if (limit > papersAvailable) {
  console.error(
    `[deepseek-probe] 错误：--limit ${limit} 大于 fixtures 可用论文数 ${papersAvailable}，` +
      `已退出。请补充 fixtures 或调低 --limit。`
  )
  process.exit(4)
}
const allPapers = JSON.parse(readFileSync(papersPath, 'utf-8')).slice(0, limit)

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '')

function findMarkdown(paper) {
  // MinerU 输出目录按 PDF 文件名命名，这里用 arXiv 号或标题前缀匹配到 papers.json 的 key
  let dir = null
  try {
    const dirs = readdirSync(mdDir).filter((d) => {
      try {
        return statSync(join(mdDir, d)).isDirectory()
      } catch {
        return false
      }
    })
    dir = dirs.find((d) => (paper.arxiv ? d.includes(paper.arxiv) : false)) ??
      dirs.find((d) => norm(d).includes(norm(paper.title).slice(0, 20)))
  } catch {
    return null
  }
  if (!dir) return null
  try {
    const files = []
    const walk = (d) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f)
        if (statSync(p).isDirectory()) walk(p)
        else if (f.endsWith('.md')) files.push(p)
      }
    }
    walk(join(mdDir, dir))
    return files[0] ?? null
  } catch {
    return null
  }
}

const corpus = []
for (const p of allPapers) {
  const md = findMarkdown(p)
  if (!md) {
    console.error(`找不到 ${p.key} 的解析 Markdown（${join(mdDir, p.key)}），请先跑 MinerU 解析`)
    process.exit(3)
  }
  let text = readFileSync(md, 'utf-8')
  const truncated = text.length > maxChars
  if (truncated) text = text.slice(0, maxChars) + '\n\n[... truncated ...]'
  corpus.push({ ...p, mdPath: md, mdChars: text.length, truncated })
}

if (dryRun) {
  console.log(`[dry-run] fixtures 共 ${papersAvailable} 篇，本次取 ${corpus.length} 篇（limit=${limit}）`)
  for (const c of corpus) {
    console.log(`[dry-run] ${c.key} 目录=「${c.mdPath.slice(mdDir.length + 1).split('/')[0]}」 字符数=${c.mdChars}${c.truncated ? '（已截断）' : ''}`)
  }
  process.exit(0)
}

const { createDeepSeek } = await import('@ai-sdk/deepseek')
const { ToolLoopAgent, stepCountIs, tool } = await import('ai')

const { addRelation, relations, resetStepCount } = createAddRelation(corpus.map((c) => c.key), {
  perStepLimit
})

const idList = corpus.map((c) => `${c.key}《${c.title}》`).join('\n')
const docBlocks = corpus.map((c) => `===== ${c.key}《${c.title}》 =====\n${readFileSync(c.mdPath, 'utf-8').slice(0, maxChars)}`).join('\n\n')
const typeList = LLM_RELATION_TYPES.join('、')

const agent = new ToolLoopAgent({
  model: createDeepSeek({ apiKey: env.DEEPSEEK_API_KEY })('deepseek-flash'),
  tools: { addRelation: tool(addRelation) },
  stopWhen: stepCountIs(maxSteps),
  maxOutputTokens, // D86：显式设置；D100：默认模型最大值 393216
  providerOptions: {
    // D92：统一开启 thinking（探针的 thinking 开/关对比按 D92 不再做）
    deepseek: { thinking: { type: 'enabled' } }
  },
  system: `你是论文关系图谱的构建 agent。给定 N 篇论文的全文解析文本，判断哪些论文之间存在真实的关系，并用 addRelation 写出。\n\n规则：\n- 论文短 id：\n${idList}\n- 方向语义：src → dst 表示「dst 基于/针对 src」（dst 是更新/改进/应用的一方）。\n- 关系类型只能从固定集合多选：${typeList}。\n- 每条关系附一两句自然语言陈述，解释为什么属于这些类型。\n- 没有依据就不要写关系；不确定可以在最后总结说明。\n- 重要：每确定一条关系，必须调用 addRelation 工具提交；不要把 JSON 写在正文里。\n- 全部关系写完后，输出一行 DONE。`,
  // 语料只放 instructions 一处（评审建议修 10：之前 instructions 和 prompt 各带一份）
  instructions: `下面是 ${corpus.length} 篇论文的解析文本。请阅读并写出你确信的关系：\n\n${docBlocks}`
})

const t0 = Date.now()
// D96 对账：开跑前先记一次余额（免费接口）
const balanceBefore = await tryFetchBalance()
// D92：统一流式输出；消费流以驱动工具循环，最终 await 拿 steps/usage
const stream = await agent.stream({ prompt: '请按 system 里的规则阅读以上论文并写出你确信的关系。' })
for await (const part of stream.fullStream) {
  if (part.type === 'step-start') resetStepCount() // 每步软上限的「步」边界
  else void part // 流式消费；正文增量不回显，避免污染终端
}
const result = await stream
// AI SDK v7 流式结果的 text 是 Promise（2026-10-26 首次 20 篇探针在此崩溃、结果未落盘）
let finalText = null
try {
  finalText = String((await result.text) ?? '').slice(0, 1000)
} catch (e) {
  finalText = `读取 result.text 失败：${e?.message ?? e}`
}
const wallSec = (Date.now() - t0) / 1000

const steps = mapSteps(await result.steps)
const sum = sumUsage(steps)

const at = new Date()
// D96：人民币计价（国内账号），不再做美元×汇率；费用 = 按结束时时刻的时段价。
// sumUsage 直接产出 OpenAI 格式 usage（prompt_tokens / completion_tokens / prompt_cache_hit_tokens）
const cost = costCny(sum, at)
const balanceAfter = await tryFetchBalance()
const balanceUsedCny =
  balanceBefore.total != null && balanceAfter.total != null ? balanceBefore.total - balanceAfter.total : null
const output = {
  model: 'deepseek-flash',
  thinking: true, // D92：统一开启
  streaming: true, // D92：统一流式
  requestedLimit: limit, // 请求的 --limit（大于可用篇数时见控制台警告与 papersAvailable）
  papersAvailable, // fixtures 里实际可用论文总数
  paperCount: corpus.length,
  corpus: corpus.map((c) => ({ key: c.key, title: c.title, mdChars: c.mdChars, truncated: c.truncated })),
  wallSec: Math.round(wallSec),
  peakHour: isPeakHour(at),
  steps,
  stepCount: steps.length,
  totalUsage: sum,
  maxOutputTokens,
  perStepLimit,
  costCny: cost, // D96：按 usage 与时段价算出的人民币费用
  balanceBefore: balanceBefore.total, // D96 对账：开跑前余额（CNY）
  balanceAfter: balanceAfter.total, // 结束后余额（CNY）
  balanceUsedCny, // 余额实际减少（对账用；与 costCny 两数相照）
  balanceCurrency: balanceAfter.currency ?? balanceBefore.currency ?? 'CNY',
  balanceError: balanceAfter.error ?? balanceBefore.error ?? null,
  relations,
  finalText
}
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(output, null, 2))
console.log(
  JSON.stringify(
    {
      paperCount: output.paperCount,
      stepCount: output.stepCount,
      totalUsage: sum,
      costCny: cost,
      balanceUsedCny,
      balanceBefore: balanceBefore.total,
      balanceAfter: balanceAfter.total,
      relations: relations.length
    },
    null,
    2
  )
)
console.log(`详细结果: ${outPath}`)
