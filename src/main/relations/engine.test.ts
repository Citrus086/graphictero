import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { MIGRATIONS, runMigrations } from '../db/migrations'
import { startStubLlm, type StubBehavior, type StubLlm } from '../llm/stubServer'
import { RelationGenEngine, RELATION_GEN_STEPS } from './engine'
import { makeFakeOpenAlex } from '../openalex/testing'
import type { OpenAlexWork } from '../openalex/client'
import { getJob, getJobSteps, retryJob } from '../jobs/store'
import { jobsOverview } from '../appService'
import { markPaperProcessed } from './progress'

/**
 * RelationGenEngine 测试（D53/D70/D77/D86）。OpenAlex 用假客户端、LLM 用本地
 * stub（429/401/400/断网语义），不触真实网络。
 */

let dir: string
let dataDir: string
let db: Database.Database
let stub: StubLlm
let graphId: number
let paperA: number
let paperB: number
let current: Date
let online: boolean
let hasKey: boolean
let fakeOA: ReturnType<typeof makeFakeOpenAlex>
let events: Array<{ phase: string; addedCount?: number }>

function addPaperToGraph(title: string): number {
  const now = new Date().toISOString()
  const r = db
    .prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES (?, 'zotero', 1, ?, ?)")
    .run(title, now, now)
  const id = Number(r.lastInsertRowid)
  db.prepare('INSERT INTO graph_members (graph_id, paper_id, x, y, added_at) VALUES (?, ?, 0, 0, ?)').run(graphId, id, now)
  return id
}

function setDetail(paperId: number, text: string): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO paper_details (paper_id, parts, model, prompt_version, generated_at, created_at, updated_at)
     VALUES (?, ?, 'deepseek-flash', 'detail-v1', ?, ?, ?)`
  ).run(paperId, JSON.stringify([{ type: 'text', text }]), now, now, now)
}

function makeEngine(): RelationGenEngine {
  return new RelationGenEngine({
    db: () => db,
    dataDir,
    llm: () => ({ baseUrl: stub.baseUrl, apiKey: 'k', model: 'deepseek-flash' }),
    openAlex: () => fakeOA,
    hasLlmKey: () => hasKey,
    isOnline: () => online,
    now: () => current,
    baseBackoffMs: 0,
    onProgress: (p) => events.push(p)
  })
}

const REL_OK: StubBehavior = {
  kind: 'ok',
  text: JSON.stringify({ relations: [{ src: 'P01', dst: 'P02', types: ['基于/改进'], statement: 'B 基于 A。' }], done: true })
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gt-rel-eng-'))
  dataDir = join(dir, 'Graphictero')
  mkdirSync(dataDir, { recursive: true })
  db = new Database(join(dataDir, 'graphictero.db'))
  runMigrations(db, MIGRATIONS)
  const now = new Date().toISOString()
  graphId = Number(db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('测试图', now, now).lastInsertRowid)
  paperA = addPaperToGraph('Alpha')
  paperB = addPaperToGraph('Beta')
  setDetail(paperA, 'Alpha 详情。')
  setDetail(paperB, 'Beta 详情。')
  current = new Date('2026-10-26T12:00:00Z')
  online = true
  hasKey = true
  events = []
  fakeOA = makeFakeOpenAlex({
    // 论文没有 W-ID/DOI → 走标题找回路径（三条阈值自然满足：标题相同）
    async searchWorksByTitle(title) {
      return [{ wid: 'W1', doi: null, title, publicationYear: null, firstAuthorSurname: null, referencedWorks: ['W9'] }]
    },
    async fetchWorksByWids(wids): Promise<OpenAlexWork[]> {
      return wids.map((w) => ({ wid: w, doi: null, title: `T ${w}`, publicationYear: 2020, firstAuthorSurname: null, referencedWorks: [] }))
    }
  })
  stub = await startStubLlm([REL_OK])
})

afterEach(async () => {
  await stub.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('RelationGenEngine（relation_gen 任务）', () => {
  it('全链路：references → generate → succeeded，记已处理 + 推进度', async () => {
    const engine = makeEngine()
    const jobId = engine.enqueue(graphId)
    await engine.drain()
    const job = getJob(db, jobId)!
    expect(job.status).toBe('succeeded')
    expect(getJobSteps(db, jobId).map((s) => `${s.step}:${s.status}`)).toEqual(['references:succeeded', 'generate:succeeded'])
    const rels = db.prepare('SELECT COUNT(*) AS n FROM relations WHERE graph_id = ? AND deleted_at IS NULL').get(graphId) as { n: number }
    expect(rels.n).toBe(1)
    const processed = (db.prepare('SELECT COUNT(*) AS n FROM relation_gen_progress WHERE graph_id = ?').get(graphId) as { n: number }).n
    expect(processed).toBe(2)
    expect(events[0]).toMatchObject({ phase: 'references' })
    expect(events[events.length - 1]).toMatchObject({ phase: 'done', addedCount: 1 })
  })

  it('同图活动任务幂等合并（D77 串行的入队侧）：合并去重', async () => {
    const engine = makeEngine()
    const j1 = engine.enqueue(graphId, [paperA])
    const j2 = engine.enqueue(graphId, [paperB, paperA])
    expect(j2).toBe(j1)
    await engine.drain()
    const payload = JSON.parse((db.prepare('SELECT payload FROM jobs WHERE id = ?').get(j1) as { payload: string }).payload) as { paperIds: number[] }
    expect(payload.paperIds).toEqual([paperA, paperB])
    expect(getJob(db, j1)!.status).toBe('succeeded')
  })

  it('评审建议修（rel5）1：regenerate 活动任务被增量 enqueue 并入后 payload.regenerate 保留', async () => {
    const engine = makeEngine()
    engine.enqueue(graphId, undefined, { regenerate: true }) // 同 enqueueRegenerate 的入队语义
    engine.enqueue(graphId, [paperA]) // 增量请求并入活动任务
    const row = db.prepare("SELECT payload FROM jobs WHERE kind = 'relation_gen' AND graph_id = ?").get(graphId) as { payload: string }
    const payload = JSON.parse(row.payload) as { paperIds: number[] | null; regenerate?: boolean }
    expect(payload.paperIds).toBeNull() // 全图覆盖指定（评审必须修 1）
    expect(payload.regenerate).toBe(true) // 整图重建标记不被合并稀释（D104）
    await engine.drain()
  })

  it('合并语义（评审必须修 1）：任一方为 null（全图）→ 合并结果保持 null', async () => {
    const engine = makeEngine()
    const j1 = engine.enqueue(graphId) // 全图
    engine.enqueue(graphId, [paperA]) // 指定论文并入 → 全图覆盖指定
    await engine.drain()
    const payload = JSON.parse((db.prepare('SELECT payload FROM jobs WHERE id = ?').get(j1) as { payload: string }).payload) as { paperIds: number[] | null }
    expect(payload.paperIds).toBeNull()
    expect(getJob(db, j1)!.status).toBe('succeeded')

    // 反向：指定论文的活动任务并入全图请求，同样变全图
    const j2 = engine.enqueue(graphId, [paperA])
    engine.enqueue(graphId)
    const payload2 = JSON.parse((db.prepare('SELECT payload FROM jobs WHERE id = ?').get(j2) as { payload: string }).payload) as { paperIds: number[] | null }
    expect(payload2.paperIds).toBeNull()
    await engine.drain()
  })

  it('合并语义：空数组 [] 归一为 null（与 engine.ts 目标论文口径一致）', async () => {
    const engine = makeEngine()
    const j1 = engine.enqueue(graphId, [paperA])
    engine.enqueue(graphId, []) // 并入活动任务：[] 归一为全图，与 runStep 口径一致
    const payload = JSON.parse((db.prepare('SELECT payload FROM jobs WHERE id = ?').get(j1) as { payload: string }).payload) as { paperIds: number[] | null }
    expect(payload.paperIds).toBeNull()
    await engine.drain()

    // 指定列表之间合并仍然去重归并
    const j1b = engine.enqueue(graphId, [paperA])
    engine.enqueue(graphId, [paperB, paperA])
    const payloadB = JSON.parse((db.prepare('SELECT payload FROM jobs WHERE id = ?').get(j1b) as { payload: string }).payload) as { paperIds: number[] | null }
    expect(payloadB.paperIds).toEqual([paperA, paperB])

    const j2 = engine.enqueue(graphId, []) // 单独入队 [] → 全图
    const payload2 = JSON.parse((db.prepare('SELECT payload FROM jobs WHERE id = ?').get(j2) as { payload: string }).payload) as { paperIds: number[] | null }
    expect(payload2.paperIds).toBeNull()
    await engine.drain()
  })

  it('评审建议修（rel3）3：OpenAlex 配置指纹变化时重建客户端单例（改 mailto/Key 不用重启）', async () => {
    let fingerprint = 'v1'
    let factoryCalls = 0
    const engine = new RelationGenEngine({
      db: () => db,
      dataDir,
      llm: () => ({ baseUrl: stub.baseUrl, apiKey: 'k', model: 'deepseek-flash' }),
      openAlex: () => {
        factoryCalls++
        return fakeOA
      },
      openAlexFingerprint: () => fingerprint,
      hasLlmKey: () => hasKey,
      isOnline: () => online,
      now: () => current,
      baseBackoffMs: 0
    })
    const jobId = engine.enqueue(graphId)
    await engine.drain()
    expect(getJob(db, jobId)!.status).toBe('succeeded')
    expect(factoryCalls).toBe(1) // 指纹不变：跨论文复用单例（限速状态不丢）

    fingerprint = 'v2' // 用户改了 mailto / Key
    const jobId2 = engine.enqueue(graphId)
    await engine.drain()
    expect(getJob(db, jobId2)!.status).toBe('succeeded')
    expect(factoryCalls).toBe(2) // 指纹变化：重建
  })

  it('非零 backoff：429 重排到未来后 drain 退出，到期由外部 drain 唤醒（评审必须修 4）', async () => {
    await stub.close()
    stub = await startStubLlm([{ kind: 'status', status: 429, retryAfter: 0 }, REL_OK])
    const engine = new RelationGenEngine({
      db: () => db,
      dataDir,
      llm: () => ({ baseUrl: stub.baseUrl, apiKey: 'k', model: 'deepseek-flash' }),
      openAlex: () => fakeOA,
      hasLlmKey: () => hasKey,
      isOnline: () => online,
      now: () => current,
      baseBackoffMs: 60_000, // 非零退避：引擎自己的 drain 循环没退出时捞不回来
      onProgress: (p) => events.push(p)
    })
    const jobId = engine.enqueue(graphId)
    await engine.drain()
    // backoff 到点在未来：任务留在 queued，等下一次 drain（启动恢复 / 周期 drain 接线）
    const mid = getJob(db, jobId)!
    expect(mid.status).toBe('queued')
    expect(mid.retryCount).toBe(1)
    expect(mid.nextRetryAt).toBe(new Date(current.getTime() + 60_000).toISOString())

    current = new Date(current.getTime() + 61_000) // 时间前进，backoff 到期
    await makeEngine().drain() // 外部 drain 唤醒 → 跑完
    expect(getJob(db, jobId)!.status).toBe('succeeded')
    expect(stub.requests.length).toBe(2) // 429 一次 + 成功一次
  })

  it('离线：waiting_network 不耗重试；联网后自动继续（D70）', async () => {
    online = false
    const engine = makeEngine()
    const jobId = engine.enqueue(graphId)
    await engine.drain()
    expect(getJob(db, jobId)!.status).toBe('waiting_network')
    expect(getJob(db, jobId)!.retryCount).toBe(0)
    expect(fakeOA.calls).toHaveLength(0) // 预检拦住，没打 OpenAlex

    online = true
    const engine2 = makeEngine()
    await engine2.drain()
    expect(getJob(db, jobId)!.status).toBe('succeeded')
  })

  it('缺 Key：waiting_key 不耗重试；配好后自动继续（D70）', async () => {
    hasKey = false
    const engine = makeEngine()
    const jobId = engine.enqueue(graphId)
    await engine.drain()
    expect(getJob(db, jobId)!.status).toBe('waiting_key')

    hasKey = true
    await makeEngine().drain()
    expect(getJob(db, jobId)!.status).toBe('succeeded')
  })

  it('401：暂停整个 LLM 队列，任务停 waiting_key（D70）', async () => {
    await stub.close()
    stub = await startStubLlm([{ kind: 'status', status: 401 }])
    const engine = makeEngine()
    const jobId = engine.enqueue(graphId)
    await engine.drain()
    const job = getJob(db, jobId)!
    expect(job.status).toBe('waiting_key')
    expect(job.currentStep).toBe('generate')
    expect(db.prepare("SELECT value FROM app_settings WHERE key = 'llm_queue_paused'").get()).toBeTruthy()
  })

  it('429 遵守 Retry-After 自动重试后成功（D53）', async () => {
    await stub.close()
    stub = await startStubLlm([{ kind: 'status', status: 429, retryAfter: 0 }, REL_OK])
    const engine = makeEngine()
    const jobId = engine.enqueue(graphId)
    await engine.drain()
    expect(getJob(db, jobId)!.status).toBe('succeeded')
    expect(stub.requests.length).toBe(2) // 429 一次 + 成功一次
  })

  it('400：failed_action 不自动重试（D53）', async () => {
    await stub.close()
    stub = await startStubLlm([{ kind: 'status', status: 400, body: { error: { message: '内容超长' } } }])
    const engine = makeEngine()
    const jobId = engine.enqueue(graphId)
    await engine.drain()
    const job = getJob(db, jobId)!
    expect(job.status).toBe('failed_action')
    expect(stub.requests).toHaveLength(1) // 不重试
  })

  it('失败后续跑：手动重试从失败步骤接着跑，references 不重做（D85/D86）', async () => {
    await stub.close()
    stub = await startStubLlm([{ kind: 'status', status: 400, body: { error: { message: 'bad' } } }, REL_OK])
    const engine = makeEngine()
    const jobId = engine.enqueue(graphId)
    await engine.drain()
    expect(getJob(db, jobId)!.status).toBe('failed_action')
    const oaCallsAfterFirst = fakeOA.calls.length

    retryJob(db, jobId)
    await makeEngine().drain()
    const steps = getJobSteps(db, jobId)
    expect(steps.find((s) => s.step === 'references')?.status).toBe('succeeded')
    expect(steps.find((s) => s.step === 'references')?.attempts).toBe(1) // 没重跑
    expect(fakeOA.calls.length).toBe(oaCallsAfterFirst) // OpenAlex 没再调
    expect(steps.find((s) => s.step === 'generate')?.attempts).toBe(2)
    expect(getJob(db, jobId)!.status).toBe('succeeded') // 重试后成功
  })

  it('uat6c S2 / D183：任务成功后同（graph, 论文组）的历史失败副本被标已被取代，状态点不再计它们', async () => {
    const engine = makeEngine()
    // 两个同组历史失败副本（如 UAT jobs 30–44：同 FLARE 失败反复入队）
    const iso = (d: string) => new Date(d).toISOString()
    const mkFailed = (at: string): number =>
      Number(
        db.prepare("INSERT INTO jobs (kind, graph_id, status, payload, created_at, updated_at) VALUES ('relation_gen', ?, 'failed_action', ?, ?, ?)")
          .run(graphId, JSON.stringify({ paperIds: [paperA] }), iso(at), iso(at)).lastInsertRowid
      )
    const old1 = mkFailed('2026-10-20T00:00:00Z')
    const old2 = mkFailed('2026-10-21T00:00:00Z')
    // 不同论文组的失败不受影响
    const other = mkFailed('2026-10-20T00:00:00Z')
    db.prepare('UPDATE jobs SET payload = ? WHERE id = ?').run(JSON.stringify({ paperIds: [paperB] }), other)

    const jobId = engine.enqueue(graphId, [paperA])
    await engine.drain()
    expect(getJob(db, jobId)!.status).toBe('succeeded')
    const sup = (id: number): string | null =>
      (db.prepare('SELECT superseded_at FROM jobs WHERE id = ?').get(id) as { superseded_at: string | null }).superseded_at
    expect(sup(old1)).not.toBeNull()
    expect(sup(old2)).not.toBeNull()
    expect(sup(other)).toBeNull()
    expect(sup(jobId)).toBeNull()
    // 状态点 / 弹层计数不再计被取代行（行保留）
    const ov = jobsOverview(db)
    expect(ov.failedAction).toBe(1) // 只剩 other
    expect(ov.failed.map((f) => f.jobId)).toEqual([other])
  })

  it('截断续跑（D86）：第二次入队全图时跳过已处理论文、只补漏掉的', async () => {
    const engine = makeEngine()
    const j1 = engine.enqueue(graphId)
    await engine.drain()
    expect(getJob(db, j1)!.status).toBe('succeeded')
    const llmCallsAfterFirst = stub.requests.length

    // 人为把 B 标成未处理（模拟：B 重试成功后按新增论文补关系）
    db.prepare('DELETE FROM relation_gen_progress WHERE graph_id = ? AND paper_id = ?').run(graphId, paperB)
    const j2 = engine.enqueue(graphId)
    await engine.drain()
    expect(getJob(db, j2)!.status).toBe('succeeded')
    // 第二次只补 B：LLM 调用数 = 1（B 的逐篇生成）
    expect(stub.requests.length - llmCallsAfterFirst).toBe(1)
  })

  it('评审必须修（rel3）1：同图 queued+running 并存时 drain 真等待不空转，running 结束后跑完 queued', async () => {
    // 第一篇的 OpenAlex 标题搜索挂起（deferred）→ job1 的 references 步骤停住，
    // 人为制造「同图 running + queued 并存」（retryJob 回 queued 的同款窗口）
    let firstCall = true
    let releaseOa!: () => void
    fakeOA = makeFakeOpenAlex({
      async searchWorksByTitle(title: string) {
        if (firstCall) {
          firstCall = false
          await new Promise<void>((res) => {
            releaseOa = res
          })
        }
        return [{ wid: 'W1', doi: null, title, publicationYear: null, firstAuthorSurname: null, referencedWorks: ['W9'] }]
      },
      async fetchWorksByWids(wids): Promise<OpenAlexWork[]> {
        return wids.map((w) => ({ wid: w, doi: null, title: `T ${w}`, publicationYear: 2020, firstAuthorSurname: null, referencedWorks: [] }))
      }
    })
    const engine = makeEngine()
    const job1 = engine.enqueue(graphId) // kick 的 drain 开始跑 job1（卡在 references）

    // 等 job1 进入 running（带超时，挂起即失败）
    const waitStatus = async (id: number, status: string, ms = 3000): Promise<void> => {
      const t0 = Date.now()
      for (;;) {
        if (getJob(db, id)!.status === status) return
        if (Date.now() - t0 > ms) throw new Error(`等待 job ${id}=${status} 超时`)
        await new Promise((r) => setTimeout(r, 10))
      }
    }
    await waitStatus(job1, 'running')

    // 同图再插一条 queued（绕过 enqueue 的活动任务合并，模拟 retryJob 回 queued）
    const iso = current.toISOString()
    const job2 = Number(
      db.prepare("INSERT INTO jobs (kind, graph_id, status, payload, created_at, updated_at) VALUES ('relation_gen', ?, 'queued', '{}', ?, ?)")
        .run(graphId, iso, iso).lastInsertRowid
    )
    const insStep = db.prepare("INSERT INTO job_steps (job_id, step, status) VALUES (?, ?, 'pending')")
    for (const s of RELATION_GEN_STEPS) insStep.run(job2, s)

    // drain 必须**真等待**（不是微任务自旋）：此时不得返回
    let done = false
    const draining = engine.drain()
    draining.then(() => {
      done = true
    })
    await new Promise((r) => setTimeout(r, 100))
    expect(done).toBe(false)

    releaseOa() // job1 跑完 → drain 捞起 job2
    const timeout = new Promise((_res, rej) => setTimeout(() => rej(new Error('drain 挂起（忙等未修复）')), 5000))
    await Promise.race([draining, timeout])
    expect(done).toBe(true)
    await waitStatus(job2, 'succeeded')
    expect(getJob(db, job1)!.status).toBe('succeeded')
  })

  it('评审建议修 12：drain 每图只取最老一条排队任务（同图串行不并行，D77）', async () => {
    // 并发探针：同图两条 queued 若被同一批 Promise.all 启动，OpenAlex 调用会重叠（max=2）；
    // 每图只取最老一条则严格串行（max=1）。payload 指定不同论文，用进度事件的 paperId 断最老先跑。
    let active = 0
    let maxActive = 0
    fakeOA = makeFakeOpenAlex({
      async searchWorksByTitle(title: string) {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 20)) // 留出重叠窗口
        active--
        return [{ wid: 'W1', doi: null, title, publicationYear: null, firstAuthorSurname: null, referencedWorks: ['W9'] }]
      },
      async fetchWorksByWids(wids): Promise<OpenAlexWork[]> {
        return wids.map((w) => ({ wid: w, doi: null, title: `T ${w}`, publicationYear: 2020, firstAuthorSurname: null, referencedWorks: [] }))
      }
    })
    const refOrder: number[] = []
    const iso = current.toISOString()
    const mk = (pid: number): number => {
      const id = Number(
        db.prepare("INSERT INTO jobs (kind, graph_id, status, payload, created_at, updated_at) VALUES ('relation_gen', ?, 'queued', ?, ?, ?)")
          .run(graphId, JSON.stringify({ paperIds: [pid] }), iso, iso).lastInsertRowid
      )
      const insStep = db.prepare("INSERT INTO job_steps (job_id, step, status) VALUES (?, ?, 'pending')")
      for (const s of RELATION_GEN_STEPS) insStep.run(id, s)
      return id
    }
    const old1 = mk(paperA)
    const old2 = mk(paperB)
    const engine = new RelationGenEngine({
      db: () => db,
      dataDir,
      llm: () => ({ baseUrl: stub.baseUrl, apiKey: 'k', model: 'deepseek-flash' }),
      openAlex: () => fakeOA,
      hasLlmKey: () => hasKey,
      isOnline: () => online,
      now: () => current,
      baseBackoffMs: 0,
      onProgress: (p) => {
        // references 相位按篇推送且没有跨任务兜底，最适合断「最老先跑」的顺序
        if (p.phase === 'references' && p.paperId != null) refOrder.push(p.paperId)
      }
    })
    await engine.drain()
    expect(getJob(db, old1)!.status).toBe('succeeded')
    expect(getJob(db, old2)!.status).toBe('succeeded')
    expect(maxActive).toBe(1) // 同图串行：OpenAlex 调用从不重叠
    expect(refOrder.indexOf(paperA)).toBeGreaterThanOrEqual(0)
    expect(refOrder.indexOf(paperA)).toBeLessThan(refOrder.indexOf(paperB)) // 最老的先跑
  })

  it('指定 paperIds：只处理指定论文（D48 重试成功补进图里的路径）', async () => {
    markPaperProcessed(db, graphId, paperA, current.toISOString()) // A 已处理过
    const engine = makeEngine()
    const jobId = engine.enqueue(graphId, [paperA, paperB])
    await engine.drain()
    expect(getJob(db, jobId)!.status).toBe('succeeded')
    // references 步骤只跑指定论文
    const refRows = db.prepare("SELECT COUNT(*) AS n FROM paper_references WHERE source = 'openalex'").get() as { n: number }
    expect(refRows.n).toBe(2) // A 和 B 各一条（fake OA 各返回 1 条 ref）
  })
})

describe('RelationGenEngine（详情未就绪跳过 / D88 重新生成）', () => {
  it('详情未就绪的论文跳过、不标记已处理，任务仍成功（D62/D67/D85）', async () => {
    // Gamma 无详情：入队指定它，generate 步骤不得抛错、不得记已处理
    const gamma = addPaperToGraph('Gamma') // has_pdf=1 但没有 paper_details
    const engine = makeEngine()
    const jobId = engine.enqueue(graphId, [gamma])
    await engine.drain()
    expect(getJob(db, jobId)!.status).toBe('succeeded')
    expect(getJobSteps(db, jobId).map((s) => `${s.step}:${s.status}`)).toEqual(['references:succeeded', 'generate:succeeded'])
    const processed = (db.prepare('SELECT COUNT(*) AS n FROM relation_gen_progress WHERE graph_id = ? AND paper_id = ?').get(graphId, gamma) as { n: number }).n
    expect(processed).toBe(0) // 保持未处理，等 startRelationsBackground 补排
  })

  it('「重新生成关系」（D88）：enqueueRegenerate 清掉已处理标记并重新排队全图', async () => {
    await stub.close()
    stub = await startStubLlm([REL_OK, REL_OK]) // 首轮 + regenerate 各一次
    const engine = makeEngine()
    const j1 = engine.enqueue(graphId)
    await engine.drain()
    expect(getJob(db, j1)!.status).toBe('succeeded')
    expect((db.prepare('SELECT COUNT(*) AS n FROM relation_gen_progress WHERE graph_id = ?').get(graphId) as { n: number }).n).toBe(2)

    const llmCallsAfterFirst = stub.requests.length
    const j2 = engine.enqueueRegenerate(graphId)
    expect(j2).not.toBe(j1)
    // regenerate 标记进 payload（D104：整图重建只替换 job 边、删未重写旧 job 边）
    expect(((getJob(db, j2)!.payload as Record<string, unknown>).regenerate as boolean) ?? false).toBe(true)
    // 已处理标记被清掉 → 两论文都重新参与
    expect((db.prepare('SELECT COUNT(*) AS n FROM relation_gen_progress WHERE graph_id = ?').get(graphId) as { n: number }).n).toBe(0)
    await engine.drain()
    expect(getJob(db, j2)!.status).toBe('succeeded')
    expect(stub.requests.length - llmCallsAfterFirst).toBeGreaterThan(0)
    // 边仍然只有一条（无序对幂等，D89；本轮重写的 A–B job 边保留）
    const rels = db.prepare('SELECT COUNT(*) AS n FROM relations WHERE graph_id = ? AND deleted_at IS NULL').get(graphId) as { n: number }
    expect(rels.n).toBe(1)
  })

  it('D104：regenerate 只替换 job 边——本轮未重写到的旧 job 边被删，session 边保留', async () => {
    await stub.close()
    stub = await startStubLlm([REL_OK, REL_OK])
    const paperC = addPaperToGraph('Gamma')
    setDetail(paperC, 'Gamma 详情。')
    const engine = makeEngine()
    const j1 = engine.enqueue(graphId)
    await engine.drain()
    expect(getJob(db, j1)!.status).toBe('succeeded')
    // LLM 只输出 P01→P02：A–B 是本轮 job 边；再造一条「本轮不会重写」的旧 job 边 B–C 和一条 session 边 A–C
    const now = current.toISOString()
    db.prepare("INSERT INTO jobs (kind, graph_id, status, created_at, updated_at) VALUES ('relation_gen', ?, 'succeeded', ?, ?)").run(graphId, now, now)
    const fakeJobId = Number((db.prepare('SELECT id FROM jobs WHERE kind = ? ORDER BY id LIMIT 1').get('relation_gen') as { id: number }).id)
    db.prepare("INSERT INTO relations (graph_id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types, source_type, source_job_id, created_at, updated_at) VALUES (?, ?, ?, ?, '旧 job 边。', '[\"compares\"]', '[]', 'job', ?, ?, ?)").run(graphId, Math.min(paperB, paperC), Math.max(paperB, paperC), paperB, fakeJobId, now, now)
    db.prepare("INSERT INTO relations (graph_id, paper_low, paper_high, src_paper, statement_text, llm_types, auto_types, source_type, created_at, updated_at) VALUES (?, ?, ?, ?, '手动边。', '[\"compares\"]', '[]', 'session', ?, ?)").run(graphId, Math.min(paperA, paperC), Math.max(paperA, paperC), paperA, now, now)

    const j2 = engine.enqueueRegenerate(graphId)
    await engine.drain()
    expect(getJob(db, j2)!.status).toBe('succeeded')
    const rows = db
      .prepare('SELECT paper_low, paper_high, source_type, deleted_at FROM relations WHERE graph_id = ? ORDER BY id')
      .all(graphId) as Array<{ paper_low: number; paper_high: number; source_type: string; deleted_at: string | null }>
    const bc = rows.find((r) => r.paper_low === Math.min(paperB, paperC) && r.paper_high === Math.max(paperB, paperC))!
    expect(bc.deleted_at).not.toBeNull() // 未重写的旧 job 边被删
    const ac = rows.find((r) => r.paper_low === Math.min(paperA, paperC) && r.paper_high === Math.max(paperA, paperC))!
    expect(ac.deleted_at).toBeNull() // session 边保留
    expect(ac.source_type).toBe('session')
    const ab = rows.find((r) => r.paper_low === Math.min(paperA, paperB) && r.paper_high === Math.max(paperA, paperB))!
    expect(ab.deleted_at).toBeNull() // 本轮重写的 job 边保留
    expect(ab.source_type).toBe('job')
  })

  it('评审建议修 3a：同图有活动任务时 enqueueRegenerate 拒绝，且不先清「已处理」标记', async () => {
    // 排队一条 waiting_key（活动状态）的任务
    hasKey = false
    const engine = makeEngine()
    engine.enqueue(graphId)
    await engine.drain()
    const activeStatus = (
      db.prepare("SELECT status FROM jobs WHERE kind = 'relation_gen' AND graph_id = ?").get(graphId) as { status: string }
    ).status
    expect(activeStatus).toBe('waiting_key')
    markPaperProcessed(db, graphId, paperA, current.toISOString())
    markPaperProcessed(db, graphId, paperB, current.toISOString())

    expect(() => engine.enqueueRegenerate(graphId)).toThrow('已有进行中的关系生成任务')
    // 拒绝时不清标记：运行中任务 + 补排不会把全图再跑一遍
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM relation_gen_progress WHERE graph_id = ?').get(graphId) as { n: number }).n
    ).toBe(2)
    // 活动任务未被合并/改动（仍是全图 payload 的 waiting_key）
    const job = db.prepare("SELECT status, payload FROM jobs WHERE kind = 'relation_gen' AND graph_id = ?").get(graphId) as { status: string; payload: string }
    expect(job.status).toBe('waiting_key')
    expect((JSON.parse(job.payload) as { paperIds: number[] | null }).paperIds).toBeNull()
  })

  it('评审建议修 4：重试耗尽的终态失败补发 phase:"error"（横幅不静默消失）', async () => {
    await stub.close()
    // 首次 + 3 次自动重试全部 429（stub 队列空后默认 ok，必须喂满 4 条）
    stub = await startStubLlm([
      { kind: 'status', status: 429, retryAfter: 0 },
      { kind: 'status', status: 429, retryAfter: 0 },
      { kind: 'status', status: 429, retryAfter: 0 },
      { kind: 'status', status: 429, retryAfter: 0 }
    ])
    const errs: Array<{ phase: string; error?: string }> = []
    const engine = new RelationGenEngine({
      db: () => db,
      dataDir,
      llm: () => ({ baseUrl: stub.baseUrl, apiKey: 'k', model: 'deepseek-flash' }),
      openAlex: () => fakeOA,
      hasLlmKey: () => hasKey,
      isOnline: () => online,
      now: () => current,
      baseBackoffMs: 0,
      onProgress: (p) => {
        if (p.phase === 'error') errs.push({ phase: p.phase, error: p.error })
      }
    })
    const jobId = engine.enqueue(graphId)
    await engine.drain()
    const job = getJob(db, jobId)!
    expect(job.status).toBe('failed_retryable') // 3 次自动重试耗尽
    expect(errs).toHaveLength(1)
    expect(errs[0].phase).toBe('error')
    expect(errs[0].error).toBeTruthy()
  })

  it('评审建议修 4：failed_action（400 不可重试）同样补发 phase:"error"；waiting_key 不发', async () => {
    await stub.close()
    stub = await startStubLlm([{ kind: 'status', status: 400, body: { error: { message: 'bad' } } }])
    const errs: string[] = []
    const engine = new RelationGenEngine({
      db: () => db,
      dataDir,
      llm: () => ({ baseUrl: stub.baseUrl, apiKey: 'k', model: 'deepseek-flash' }),
      openAlex: () => fakeOA,
      hasLlmKey: () => hasKey,
      isOnline: () => online,
      now: () => current,
      baseBackoffMs: 0,
      onProgress: (p) => {
        if (p.phase === 'error') errs.push(p.error ?? '')
      }
    })
    const jobId = engine.enqueue(graphId)
    await engine.drain()
    expect(getJob(db, jobId)!.status).toBe('failed_action')
    expect(errs).toHaveLength(1)

    // waiting_key（缺 Key 预检拦住）不是终态失败，不补发 error
    errs.length = 0
    hasKey = false
    const engine2 = new RelationGenEngine({
      db: () => db,
      dataDir,
      llm: () => ({ baseUrl: stub.baseUrl, apiKey: 'k', model: 'deepseek-flash' }),
      openAlex: () => fakeOA,
      hasLlmKey: () => hasKey,
      isOnline: () => online,
      now: () => current,
      baseBackoffMs: 0,
      onProgress: (p) => {
        if (p.phase === 'error') errs.push(p.error ?? '')
      }
    })
    const jobId2 = engine2.enqueue(graphId)
    await engine2.drain()
    expect(getJob(db, jobId2)!.status).toBe('waiting_key')
    expect(errs).toHaveLength(0)
  })
})
