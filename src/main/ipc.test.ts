import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from './db/connection'
import { MIGRATIONS, runMigrations } from './db/migrations'
import { getGraphDetail } from './appService'

/**
 * 评审建议修 10 + 必须修 1 的回归测试：IPC 接线层参数穿透。
 * mock electron 的 ipcMain.handle 捕获全部 handler，以 (event, args...) 调用，
 * 断言服务层收到正确值（旧 `h` 包装器零参调用 fn()，参数全丢、全部带参 IPC 失效）。
 */

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()

vi.mock('electron', () => ({
  app: {
    getPath: () => join(process.cwd(), 'node_modules/.cache/gt-test-userdata'),
    getVersion: () => '9.9.9',
    relaunch: vi.fn(),
    exit: vi.fn()
  },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler)
    }
  },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openExternal: vi.fn(async () => {}) }
}))

import { registerIpc, type AppState } from './ipc'
import { enqueueJob, getJob, getLlmQueuePauseReason, setJobStatus, setLlmQueuePaused } from './jobs/store'
import { readFileSync } from 'node:fs'

/** 测试辅助：把任务直接置为 failed_retryable */
function db_failJob(db: Database.Database, id: number): void {
  setJobStatus(db, id, 'failed_retryable', { failedStep: 'detail', error: '测试失败' })
}

let dir: string
let state: AppState

function insertPaper(title: string): number {
  const now = new Date().toISOString()
  const r = state.db
    .prepare("INSERT INTO papers (title, source, has_pdf, created_at, updated_at) VALUES (?, 'zotero', 1, ?, ?)")
    .run(title, now, now)
  return Number(r.lastInsertRowid)
}

beforeEach(() => {
  handlers.clear()
  dir = mkdtempSync(join(tmpdir(), 'gt-ipc-'))
  mkdirSync(join(dir, 'Graphictero', 'backups'), { recursive: true })
  const db = openDatabase(join(dir, 'Graphictero', 'graphictero.db'))
  runMigrations(db, MIGRATIONS)
  state = { db, dataDir: join(dir, 'Graphictero'), backupDir: join(dir, 'Graphictero', 'backups'), root: dir }
  registerIpc(state)
})

afterEach(() => {
  state.db.close()
  rmSync(dir, { recursive: true, force: true })
})

const call = (channel: string, ...args: unknown[]): Promise<unknown> => {
  const h = handlers.get(channel)
  if (!h) throw new Error(`channel ${channel} 未注册`)
  return h({ sender: { isDestroyed: () => true, send: vi.fn() } }, ...args)
}

describe('IPC 接线层参数穿透（评审必须修 1 / 建议修 10）', () => {
  it('全部业务 channel 都已注册', () => {
    for (const ch of [
      'graphs:list', 'graphs:create', 'graph:get', 'library:list', 'library:deletePaper',
      'graph:addPapers', 'graph:removePaper', 'graph:setPosition', 'relation:create', 'relation:delete',
      'data:info', 'data:chooseRoot', 'data:exportBackup', 'data:restoreBackup',
      'zotero:status', 'zotero:listCollections', 'zotero:import',
      'settings:getLlm', 'settings:setLlm', 'settings:setApiKey', 'settings:clearApiKey', 'settings:testLlm',
      'settings:getOpenAlex', 'settings:setOpenAlexKey', 'settings:clearOpenAlexKey', 'settings:testOpenAlex',
      'settings:getTheme', 'settings:setTheme',
      'settings:usageSummary', 'usage:series', 'usage:bySession', 'usage:byPeriod', 'usage:recent', 'settings:balance',
      'app:version', 'data:lastSnapshot', 'data:lastImport', 'zotero:display',
      'jobs:overview', 'jobs:retry', 'app:openExternal',
      'pdf:sidecarStatus', 'pdf:sidecarStart', 'pdf:sidecarStop', 'pdf:sidecarReinstall', 'pdf:papersStatus',
      'pdf:getDocument', 'pdf:listAnnotations', 'pdf:createAnnotation', 'pdf:updateAnnotation', 'pdf:deleteAnnotation',
      'pdf:listFigures', 'pdf:figureCrop', 'pdf:lastParse', 'pdf:modelSize',
      'library:searchSidebar',
      // M5 预备提交骨架（lane/agent 批 1 实装替换；实装后断言仍在）
      'agent:listSessions', 'agent:createSession', 'agent:renameSession', 'agent:deleteSession',
      'agent:getMessages', 'agent:send', 'agent:stop', 'agent:retryMessage',
      'agent:candidateConfirm', 'agent:candidateIgnore', 'agent:listCandidates', 'agent:cardLiveStates', 'agent:sessionCost',
      'agent:sessionCostBreakdown'
    ]) {
      expect(handlers.has(ch), ch).toBe(true)
    }
  })

  it('pdf:papersStatus：paperIds 穿透，返回失败状态与原因（失败标记数据通路）', async () => {
    const a = insertPaper('未处理论文')
    const b = insertPaper('失败论文')
    const jobId = enqueueJob(state.db, 'process_paper', { paperId: b })
    db_failJob(state.db, jobId)
    const rows = (await call('pdf:papersStatus', [a, b, 99999])) as Array<{
      paperId: number
      state: string
      failedStep: string | null
      error: string | null
    }>
    expect(rows.find((r) => r.paperId === a)).toMatchObject({ state: 'unprocessed' })
    expect(rows.find((r) => r.paperId === b)).toMatchObject({ state: 'failed', failedStep: 'detail', error: '测试失败' })
    expect(rows.find((r) => r.paperId === 99999)).toMatchObject({ state: 'unprocessed' })
  })

  it('pdf:sidecarStatus：无 sidecar（冒烟/测试模式）返回 unavailable', async () => {
    const s = (await call('pdf:sidecarStatus')) as { state: string }
    expect(s.state).toBe('unavailable')
  })

  it('pdf 标注 CRUD：创建（含 quads/note）→ 列表 → 更新笔记/颜色 → 删除（D27）', async () => {
    const pid = insertPaper('阅读器论文')
    const created = (await call('pdf:createAnnotation', pid, {
      page: 0,
      type: 'highlight',
      text: 'Line One',
      color: 'yellow',
      bbox: [72, 60, 300, 24],
      quads: [[72, 60, 300, 24]]
    })) as { id: number; text: string; note: string | null; quads: unknown[] }
    expect(created.text).toBe('Line One')
    expect(created.note).toBeNull()
    expect(created.quads).toHaveLength(1)

    const listed = (await call('pdf:listAnnotations', pid)) as Array<{ id: number }>
    expect(listed).toHaveLength(1)

    const updated = (await call('pdf:updateAnnotation', created.id, { note: '笔记内容', color: 'blue' })) as {
      note: string | null
      color: string
    }
    expect(updated.note).toBe('笔记内容')
    expect(updated.color).toBe('blue')

    await call('pdf:deleteAnnotation', created.id)
    expect(((await call('pdf:listAnnotations', pid)) as unknown[]).length).toBe(0)
  })

  it('pdf:getDocument：无 PDF 的论文抛中文错误', async () => {
    const pid = insertPaper('无PDF论文')
    await expect(call('pdf:getDocument', pid)).rejects.toThrow('找不到 PDF 文件')
  })

  it('评审必 1：pdf:getDocument / pdf:listFigures 的 paperId 校验——字符串/负数/小数/零抛错且不触 fs', async () => {
    const pid = insertPaper('校验论文')
    // 字符串路径穿越：若不是校验拦住，join 归一化后会去读 dataDir 外的 structured_content.json / paper.pdf
    for (const bad of ['../../x', "papers/../../x", -1, 0, 1.5, NaN]) {
      await expect(call('pdf:getDocument', bad)).rejects.toThrow('论文 ID 不合法')
      await expect(call('pdf:listFigures', bad)).rejects.toThrow('论文 ID 不合法')
    }
    // 校验放行的正整数：字符串拼接路径不再可达，落回「论文不存在」或正常读取口径
    await expect(call('pdf:getDocument', 99999)).rejects.toThrow('论文 99999 不存在或已删除')
    expect(await call('pdf:listFigures', 99999)).toEqual([])
    expect(await call('pdf:listFigures', pid)).toEqual([])
  })

  it('graphs:create：renderer 传的 name 原样到达服务层（旧实现收到 undefined）', async () => {
    const g = (await call('graphs:create', '我的图谱')) as { id: number; name: string }
    expect(g.name).toBe('我的图谱')
    const detail = (await call('graph:get', g.id)) as { graph: { name: string } }
    expect(detail.graph.name).toBe('我的图谱')
  })

  it('D189：从库删除清掉该论文的图卡裁图缓存，目录缺失也不抛', async () => {
    const paperId = insertPaper('裁图缓存')
    const otherId = insertPaper('另一篇')
    const cropDir = join(state.dataDir, 'cache', 'figure-crops', String(paperId))
    const otherDir = join(state.dataDir, 'cache', 'figure-crops', String(otherId))
    mkdirSync(cropDir, { recursive: true })
    mkdirSync(otherDir, { recursive: true })
    writeFileSync(join(cropDir, '2-abc.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    writeFileSync(join(otherDir, '1-def.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await call('library:deletePaper', paperId)
    expect(existsSync(cropDir)).toBe(false)
    expect(existsSync(join(otherDir, '1-def.png'))).toBe(true)
    await call('library:deletePaper', paperId)
    expect(existsSync(otherDir)).toBe(true)
  })

  it('pdf:figureCrop：非法 id 抛；没有图块时回 mineru 且不抛', async () => {
    await expect(call('pdf:figureCrop', -1, 1)).rejects.toThrow('论文 ID 不合法')
    const pid = insertPaper('无图')
    expect(await call('pdf:figureCrop', pid, 1)).toEqual({ mode: 'mineru', relPath: null })
    expect(await call('pdf:figureCrop', pid, 0)).toEqual({ mode: 'mineru', relPath: null })
    expect(await call('pdf:figureCrop', 99999, 1)).toEqual({ mode: 'mineru', relPath: null })
  })

  it('graph:get / library:deletePaper：id 参数穿透', async () => {
    const g = (await call('graphs:create', 'G1')) as { id: number }
    const paperId = insertPaper('穿透测试')
    const lib = (await call('library:list', g.id)) as Array<{ id: number; inGraph: boolean }>
    expect(lib.find((p) => p.id === paperId)?.inGraph).toBe(false)
    await call('library:deletePaper', paperId)
    const after = (await call('library:list')) as Array<{ id: number }>
    expect(after.find((p) => p.id === paperId)).toBeUndefined()
  })

  it('graph:setPosition：graphId/paperId/x/y 四个参数全部穿透并落库', async () => {
    const g = (await call('graphs:create', 'G1')) as { id: number }
    const paperId = insertPaper('坐标穿透')
    await call('graph:addPapers', g.id, [paperId])
    await call('graph:setPosition', g.id, paperId, 111.5, -22)
    const m = getGraphDetail(state.db, g.id).members[0]
    expect(m).toMatchObject({ x: 111.5, y: -22 })
  })

  it('relation:create：input 对象穿透，服务层校验错误原样抛回（reject）', async () => {
    const g = (await call('graphs:create', 'G1')) as { id: number }
    const a = insertPaper('A')
    const b = insertPaper('B')
    const relId = (await call('relation:create', {
      graphId: g.id,
      srcPaperId: a,
      dstPaperId: b,
      statement: '穿透',
      types: ['based_on']
    })) as number
    expect(typeof relId).toBe('number')
    await expect(
      call('relation:create', { graphId: g.id, srcPaperId: a, dstPaperId: b, statement: '', types: [] })
    ).rejects.toThrow('关系类型必选')
  })

  it('graph:removePaper：两参穿透，成员删除且相关边软删（终审收尾建议修 2）', async () => {
    const g = (await call('graphs:create', 'G1')) as { id: number }
    const a = insertPaper('RA')
    const b = insertPaper('RB')
    await call('graph:addPapers', g.id, [a, b])
    const relId = (await call('relation:create', {
      graphId: g.id,
      srcPaperId: a,
      dstPaperId: b,
      statement: '',
      types: ['based_on']
    })) as number
    await call('graph:removePaper', g.id, a)
    const detail = getGraphDetail(state.db, g.id)
    expect(detail.members.map((m) => m.paper.id)).toEqual([b]) // 成员已删
    expect(detail.relations).toEqual([]) // 相关边已软删（视图不含）
    const row = state.db.prepare('SELECT deleted_at FROM relations WHERE id = ?').get(relId) as { deleted_at: string | null }
    expect(row.deleted_at).not.toBeNull() // 软删断言
    // 论文仍在论文库（「从图谱移除」与「从库删除」分开，D75）
    expect(state.db.prepare('SELECT deleted_at FROM papers WHERE id = ?').get(a)).toMatchObject({ deleted_at: null })
  })

  it('relation:delete：id 穿透，软删生效且幂等（终审收尾建议修 2）', async () => {
    const g = (await call('graphs:create', 'G1')) as { id: number }
    const a = insertPaper('DA')
    const b = insertPaper('DB')
    const relId = (await call('relation:create', {
      graphId: g.id,
      srcPaperId: a,
      dstPaperId: b,
      statement: 'x',
      types: ['compares']
    })) as number
    await call('relation:delete', relId)
    const row = state.db.prepare('SELECT deleted_at FROM relations WHERE id = ?').get(relId) as { deleted_at: string | null }
    expect(row.deleted_at).not.toBeNull()
    expect(getGraphDetail(state.db, g.id).relations).toEqual([])
    await expect(call('relation:delete', relId)).resolves.toBeUndefined() // 幂等
  })

  it('settings:setApiKey / getLlm：Key 写数据目录 .env（D34），不进库、不回传本体', async () => {
    const before = (await call('settings:getLlm')) as { hasApiKey: boolean }
    expect(before.hasApiKey).toBe(false)
    await call('settings:setLlm', 'deepseek', 'deepseek-flash')
    await call('settings:setApiKey', 'sk-test-dummy-key')
    const after = (await call('settings:getLlm')) as { provider: string; model: string; hasApiKey: boolean; keyTail: string | null }
    expect(after).toMatchObject({ provider: 'deepseek', model: 'deepseek-flash', hasApiKey: true, keyTail: '-key' })
    expect(JSON.stringify(after)).not.toContain('sk-test-dummy-key')
    // .env 在数据目录里；库里 app_settings 只留 provider/model，绝无 Key
    const envText = readFileSync(join(state.dataDir, '.env'), 'utf8')
    expect(envText).toContain('DEEPSEEK_API_KEY=sk-test-dummy-key')
    const rows = state.db.prepare('SELECT value FROM app_settings').all() as Array<{ value: string }>
    expect(rows.some((r) => r.value.includes('sk-test-dummy-key'))).toBe(false)
    // 留空保存不再等于清除，也不解除暂停
    setLlmQueuePaused(state.db, '401')
    await expect(call('settings:setApiKey', '')).rejects.toThrow('请输入 API Key')
    await expect(call('settings:setApiKey', '   ')).rejects.toThrow('请输入 API Key')
    expect(((await call('settings:getLlm')) as { hasApiKey: boolean }).hasApiKey).toBe(true)
    expect(getLlmQueuePauseReason(state.db)).toBe('401')
    await call('settings:clearApiKey')
    expect(((await call('settings:getLlm')) as { hasApiKey: boolean }).hasApiKey).toBe(false)
    expect(readFileSync(join(state.dataDir, '.env'), 'utf8')).not.toContain('DEEPSEEK_API_KEY')
    expect(getLlmQueuePauseReason(state.db)).toBe('401')
  })

  it('OpenAlex Key 只改目标行，渲染端只拿末 4 位', async () => {
    await call('settings:setApiKey', 'sk-test-dummy-key')
    await call('settings:setOpenAlexKey', 'oa-dummy-key-zzzz')
    const view = (await call('settings:getOpenAlex')) as { configured: boolean; tail: string | null }
    expect(view).toEqual({ configured: true, tail: 'zzzz' })
    expect(JSON.stringify(view)).not.toContain('oa-dummy-key-zzzz')
    const envText = readFileSync(join(state.dataDir, '.env'), 'utf8')
    expect(envText).toContain('OPENALEX_API_KEY=oa-dummy-key-zzzz')
    expect(envText).toContain('DEEPSEEK_API_KEY=sk-test-dummy-key')
    await expect(call('settings:setOpenAlexKey', '')).rejects.toThrow('请输入 API Key')
    expect(readFileSync(join(state.dataDir, '.env'), 'utf8')).toContain('OPENALEX_API_KEY=oa-dummy-key-zzzz')
    await call('settings:clearOpenAlexKey')
    expect(await call('settings:getOpenAlex')).toEqual({ configured: false, tail: null })
    const left = readFileSync(join(state.dataDir, '.env'), 'utf8')
    expect(left).not.toContain('OPENALEX_API_KEY')
    expect(left).toContain('DEEPSEEK_API_KEY=sk-test-dummy-key')
  })

  it('app:version 与最近自动备份只读', async () => {
    expect(await call('app:version')).toBe('9.9.9')
    expect(await call('data:lastSnapshot')).toEqual({ at: null })
  })

  it('jobs:overview / jobs:retry：汇总穿透 + 失败任务重试回 queued（D85）', async () => {
    const paperId = insertPaper('任务穿透')
    const jobId = enqueueJob(state.db, 'process_paper', { paperId })
    db_failJob(state.db, jobId)
    const ov = (await call('jobs:overview')) as { failedRetryable: number; failed: Array<{ jobId: number; paperTitle: string }> }
    expect(ov.failedRetryable).toBe(1)
    expect(ov.failed[0]).toMatchObject({ jobId, paperTitle: '任务穿透' })
    await call('jobs:retry', jobId)
    expect(getJob(state.db, jobId)?.status).toBe('queued')
  })

  it('jobs:overview D167：active 列出正在处理 / 排队的论文简称', async () => {
    const longTitle = '一篇标题特别长长到超过十四个汉字的研究论文题名示例'
    const p1 = insertPaper('排队中的论文A')
    const p2 = insertPaper(longTitle)
    const j1 = enqueueJob(state.db, 'process_paper', { paperId: p1 })
    const j2 = enqueueJob(state.db, 'process_paper', { paperId: p2 })
    state.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(j2)
    const ov = (await call('jobs:overview')) as {
      active: Array<{ jobId: number; paperTitle: string; status: string; step: string | null }>
    }
    const byId = new Map(ov.active.map((a) => [a.jobId, a]))
    expect(byId.get(j1)).toMatchObject({ status: 'queued', paperTitle: '排队中的论文A' })
    // 简称口径 = shortCiteTitle（14 字截断）
    expect(byId.get(j2)).toMatchObject({ status: 'running', paperTitle: '一篇标题特别长长到超过十四个…' })
    expect(byId.get(j1)?.step).not.toBeNull() // process_paper 有步骤行
  })
})
