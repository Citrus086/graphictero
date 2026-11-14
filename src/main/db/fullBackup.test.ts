import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from './connection'
import { MIGRATIONS, runMigrations } from './migrations'
import { exportFullBackup, restoreFullBackup } from './fullBackup'
import { readZip, writeZip } from './zip'

// D162 流式断言：给 node:fs 打点（记录 readFileSync/createReadStream 的文件路径入参，
// 行为原样透传）。ESM namespace 不可 vi.spyOn，故用 vi.mock。
const fsCalls = vi.hoisted(() => ({
  readFileSync: [] as string[],
  createReadStream: [] as string[],
  statSync: [] as string[],
  mkdtempSync: [] as string[]
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => {
      if (typeof args[0] === 'string') fsCalls.readFileSync.push(args[0])
      return (actual.readFileSync as (...a: unknown[]) => unknown)(...args)
    },
    createReadStream: (...args: unknown[]) => {
      if (typeof args[0] === 'string') fsCalls.createReadStream.push(args[0])
      return (actual.createReadStream as (...a: unknown[]) => unknown)(...args)
    },
    statSync: (...args: unknown[]) => {
      if (typeof args[0] === 'string') fsCalls.statSync.push(args[0])
      return (actual.statSync as (...a: unknown[]) => unknown)(...args)
    },
    mkdtempSync: (...args: unknown[]) => {
      if (typeof args[0] === 'string') fsCalls.mkdtempSync.push(args[0])
      return (actual.mkdtempSync as (...a: unknown[]) => unknown)(...args)
    }
  }
})

/**
 * 「导出完整备份」/「从备份恢复」（D59/D76/D98，D162：sidecar 排除 + 流式 + zip64）。
 * 合成数据：假库 + 假 PDF 字节，无真实论文。
 */

let dir: string
let dataDir: string
let db: Database.Database
let now: string

function insertPaper(fields: Record<string, unknown>): number {
  const cols = Object.keys(fields)
  const r = db
    .prepare(`INSERT INTO papers (${cols.join(', ')}, created_at, updated_at) VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`)
    .run(...cols.map((c) => fields[c]), now, now)
  return Number(r.lastInsertRowid)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-fullbackup-'))
  dataDir = join(dir, 'data')
  mkdirSync(dataDir, { recursive: true })
  db = openDatabase(join(dataDir, 'graphictero.db'))
  runMigrations(db, MIGRATIONS)
  now = new Date().toISOString()
  db.prepare('INSERT INTO graphs (name, created_at, updated_at) VALUES (?, ?, ?)').run('备份测试图', now, now)
})

afterEach(() => {
  if (db.open) db.close()
  rmSync(dir, { recursive: true, force: true })
})

const FAKE_PDF = Buffer.concat([Buffer.from('%PDF-1.4\nfake\n'), Buffer.alloc(1024, 3), Buffer.from('\n%%EOF\n')])

describe('导出完整备份（D59/D76）', () => {
  it('包含数据库与论文文件夹；不含 .env、backups、-wal/-shm；有 DOI 的 PDF 不进备份', async () => {
    const withDoi = insertPaper({ title: 'Has DOI', doi: '10.1/hasdoi', has_pdf: 1, pdf_source: 'zotero' })
    const userDrop = insertPaper({ title: 'User Drop No DOI', has_pdf: 1, pdf_source: 'user_drop' })
    const zoteroNoDoi = insertPaper({ title: 'Zotero No DOI', has_pdf: 1, pdf_source: 'zotero' })
    for (const id of [withDoi, userDrop, zoteroNoDoi]) {
      mkdirSync(join(dataDir, 'papers', String(id)), { recursive: true })
      writeFileSync(join(dataDir, 'papers', String(id), 'paper.pdf'), FAKE_PDF)
    }
    mkdirSync(join(dataDir, 'papers', '999'), { recursive: true }) // 库外残留文件夹（也要进备份）
    writeFileSync(join(dataDir, 'papers', '999', 'paper.pdf'), FAKE_PDF)
    writeFileSync(join(dataDir, '.env'), 'DEEPSEEK_API_KEY=secret-should-not-leak\n')
    mkdirSync(join(dataDir, 'backups'), { recursive: true })
    writeFileSync(join(dataDir, 'backups', 'snapshot-2026-10-25.db'), 'fake snapshot')

    const zipPath = await exportFullBackup(db, dataDir, join(dir, 'backup.zip'))
    const names = (await readZip(zipPath)).map((e) => e.name)

    expect(names).toContain('graphictero.db')
    expect(names).toContain(`papers/${userDrop}/paper.pdf`) // 无 DOI 手动拖入：进备份
    expect(names).toContain(`papers/999/paper.pdf`)
    expect(names).not.toContain(`papers/${withDoi}/paper.pdf`) // 有 DOI：不进（可重新下载）
    expect(names).not.toContain(`papers/${zoteroNoDoi}/paper.pdf`) // 无 DOI 但 Zotero 来源：可从 Zotero 重导
    expect(names.some((n) => n.includes('.env'))).toBe(false)
    expect(names.some((n) => n.startsWith('backups/'))).toBe(false)
    expect(names.some((n) => n.endsWith('-wal') || n.endsWith('-shm'))).toBe(false)
  })

  it('D162：sidecar/ 运行时文件（venv/uploads/pid/日志）不进备份', async () => {
    mkdirSync(join(dataDir, 'sidecar', 'venv', 'lib'), { recursive: true })
    writeFileSync(join(dataDir, 'sidecar', 'venv', 'x.py'), 'fake venv file\n')
    writeFileSync(join(dataDir, 'sidecar', 'venv', 'lib', 'y.py'), 'fake venv file 2\n')
    mkdirSync(join(dataDir, 'sidecar', 'uploads', 'blobs'), { recursive: true })
    writeFileSync(join(dataDir, 'sidecar', 'uploads', 'blobs', 'a.bin'), FAKE_PDF)
    writeFileSync(join(dataDir, 'sidecar', 'mineru.pid'), '12345\n')
    writeFileSync(join(dataDir, 'sidecar', 'mineru.log'), 'fake log\n')

    const p1 = insertPaper({ title: '解析过的', has_pdf: 1, pdf_source: 'user_drop' })
    mkdirSync(join(dataDir, 'papers', String(p1)), { recursive: true })
    writeFileSync(join(dataDir, 'papers', String(p1), 'full.md'), '# 假正文\n') // 解析结果照旧进备份（D98）
    writeFileSync(join(dataDir, 'papers', String(p1), 'paper.pdf'), FAKE_PDF)

    const zipPath = await exportFullBackup(db, dataDir, join(dir, 'backup.zip'))
    const names = (await readZip(zipPath)).map((e) => e.name)

    expect(names.some((n) => n === 'sidecar' || n.startsWith('sidecar/'))).toBe(false)
    expect(names).toContain(`papers/${p1}/full.md`)
    expect(names).toContain(`papers/${p1}/paper.pdf`)
  })

  it('uat4-fix1 S3：排除目录（sidecar/）在 walk 时直接剪枝——不下行、不 stat 内部条目', async () => {
    mkdirSync(join(dataDir, 'sidecar', 'venv', 'lib'), { recursive: true })
    writeFileSync(join(dataDir, 'sidecar', 'venv', 'x.py'), 'fake\n')
    writeFileSync(join(dataDir, 'sidecar', 'venv', 'lib', 'y.py'), 'fake\n')
    mkdirSync(join(dataDir, 'sidecar', 'uploads', 'blobs'), { recursive: true })
    writeFileSync(join(dataDir, 'sidecar', 'uploads', 'blobs', 'a.bin'), FAKE_PDF)
    const p1 = insertPaper({ title: '剪枝测试', has_pdf: 1, pdf_source: 'user_drop' })
    mkdirSync(join(dataDir, 'papers', String(p1)), { recursive: true })
    writeFileSync(join(dataDir, 'papers', String(p1), 'paper.pdf'), FAKE_PDF)

    fsCalls.statSync.length = 0
    await exportFullBackup(db, dataDir, join(dir, 'backup.zip'))
    // S3（uat4-fix2 修正断言）：statSync 记录里不得出现任何 sidecar/venv 内部路径——
    // 剪枝后排除目录不下行、不 stat 其条目（旧断言匹配 join("sidecar","x") 子串，
    // 与实际文件 sidecar/venv/x.py 不匹配，等于没锁）
    const venvStats = fsCalls.statSync.filter((p) => p.includes(join('sidecar', 'venv')))
    expect(venvStats).toEqual([])
    // 对照：papers/ 下的文件正常被 stat（walked 到）
    expect(fsCalls.statSync.some((p) => p.includes(join('papers', String(p1), 'paper.pdf')))).toBe(true)
  })

  it('D145：sidecar/mineru-home 里的 MinerU 模型（几 GB）不进备份（D162 排除表单独一行）', async () => {
    mkdirSync(join(dataDir, 'sidecar', 'mineru-home', 'models', 'MinerU-4_models_torch'), { recursive: true })
    writeFileSync(join(dataDir, 'sidecar', 'mineru-home', 'models', 'MinerU-4_models_torch', 'w.bin'), Buffer.alloc(4096, 9))
    writeFileSync(join(dataDir, 'sidecar', 'mineru-home', 'config.yaml'), 'models:\n  base_dir: x\n')
    const p1 = insertPaper({ title: 'D145 备份排除', has_pdf: 1, pdf_source: 'user_drop' })
    mkdirSync(join(dataDir, 'papers', String(p1)), { recursive: true })
    writeFileSync(join(dataDir, 'papers', String(p1), 'paper.pdf'), FAKE_PDF)

    const zipPath = await exportFullBackup(db, dataDir, join(dir, 'backup.zip'))
    const names = (await readZip(zipPath)).map((e) => e.name)
    // 模型目录与其中任何文件都不进备份（sidecar/ 整棵剪枝 + D145 显式一行）
    expect(names.some((n) => n.includes('mineru-home'))).toBe(false)
    expect(names.some((n) => n.startsWith('sidecar/'))).toBe(false)
    expect(names).toContain(`papers/${p1}/paper.pdf`) // 对照：论文 PDF 照常进备份
  })

  it('D189：cache/figure-crops 裁图不进备份（cache/ 整目录剪枝）', async () => {
    mkdirSync(join(dataDir, 'cache', 'figure-crops', '7'), { recursive: true })
    writeFileSync(join(dataDir, 'cache', 'figure-crops', '7', '2-abc.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))
    writeFileSync(join(dataDir, 'cache', 'other.txt'), 'nope\n')
    const p1 = insertPaper({ title: 'D189 备份排除', has_pdf: 1, pdf_source: 'user_drop' })
    mkdirSync(join(dataDir, 'papers', String(p1)), { recursive: true })
    writeFileSync(join(dataDir, 'papers', String(p1), 'paper.pdf'), FAKE_PDF)

    const zipPath = await exportFullBackup(db, dataDir, join(dir, 'backup.zip'))
    const names = (await readZip(zipPath)).map((e) => e.name)
    expect(names.some((n) => n.startsWith('cache/'))).toBe(false)
    expect(names.some((n) => n.includes('figure-crops'))).toBe(false)
    expect(names).toContain(`papers/${p1}/paper.pdf`)
  })

  it('D162：文件条目流式写入——导出期间对数据目录文件不调用 readFileSync', async () => {
    const p1 = insertPaper({ title: '流式测试', has_pdf: 1, pdf_source: 'user_drop' })
    mkdirSync(join(dataDir, 'papers', String(p1)), { recursive: true })
    writeFileSync(join(dataDir, 'papers', String(p1), 'paper.pdf'), Buffer.alloc(300 * 1024, 5))

    fsCalls.readFileSync.length = 0
    fsCalls.createReadStream.length = 0
    readFileSync(join(dataDir, 'graphictero.db')) // 校准：打点确实记录 readFileSync 调用
    expect(fsCalls.readFileSync.length).toBeGreaterThan(0)
    fsCalls.readFileSync.length = 0

    await exportFullBackup(db, dataDir, join(dir, 'backup.zip'))

    const dataDirFilesRead = fsCalls.readFileSync.filter((p) => p.startsWith(dataDir))
    expect(dataDirFilesRead).toEqual([]) // 文件条目一律走 createReadStream 分块读，绝不 readFileSync 整块读
    const pdfStreamed = fsCalls.createReadStream.some((p) =>
      p.endsWith(join('papers', String(p1), 'paper.pdf'))
    )
    expect(pdfStreamed).toBe(true)
  })

  it('uat8-fix1 M2：导出成功与失败都清理临时快照目录', async () => {
    fsCalls.mkdtempSync.length = 0
    await exportFullBackup(db, dataDir, join(dir, 'backup.zip'))
    const successTemps = [...fsCalls.mkdtempSync]
    expect(successTemps.length).toBeGreaterThan(0)
    for (const path of successTemps) expect(existsSync(path)).toBe(false)

    db.close() // 让 VACUUM INTO 在临时目录创建后失败，走导出 finally
    fsCalls.mkdtempSync.length = 0
    await expect(exportFullBackup(db, dataDir, join(dir, 'failure.zip'))).rejects.toThrow()
    const failureTemps = [...fsCalls.mkdtempSync]
    expect(failureTemps.length).toBeGreaterThan(0)
    for (const path of failureTemps) expect(existsSync(path)).toBe(false)
  })

  it('D162：导出→恢复到空目录，数据一致（往返，解析结果含中文文件名）', async () => {
    const p1 = insertPaper({ title: '往返测试', has_pdf: 1, pdf_source: 'user_drop' })
    mkdirSync(join(dataDir, 'papers', String(p1)), { recursive: true })
    writeFileSync(join(dataDir, 'papers', String(p1), 'full.md'), '# 往返\n\n假正文。\n')
    writeFileSync(join(dataDir, 'papers', String(p1), 'paper.pdf'), FAKE_PDF)
    db.prepare("INSERT INTO graphs (name, created_at, updated_at) VALUES ('往返图二', ?, ?)").run(now, now)

    const zipPath = await exportFullBackup(db, dataDir, join(dir, 'backup.zip'))
    const result = await restoreFullBackup(zipPath, join(dir, 'roundtrip-root'))

    const restored = openDatabase(join(result.dataDir, 'graphictero.db'))
    expect(restored.prepare('SELECT COUNT(*) c FROM graphs').get()).toEqual({ c: 2 })
    restored.close()
    expect(readFileSync(join(result.dataDir, 'papers', String(p1), 'full.md'), 'utf8')).toBe('# 往返\n\n假正文。\n')
    expect(readFileSync(join(result.dataDir, 'papers', String(p1), 'paper.pdf')).equals(FAKE_PDF)).toBe(true)
  })
})

describe('从备份恢复（D59/D76）', () => {
  it('恢复到空数据目录：图谱与论文齐全、无 .env、无残留 -wal/-shm', async () => {
    const p1 = insertPaper({ title: '恢复测试论文', has_pdf: 1, pdf_source: 'user_drop' }) // 无 DOI 手动拖入：PDF 进备份
    mkdirSync(join(dataDir, 'papers', String(p1)), { recursive: true })
    writeFileSync(join(dataDir, 'papers', String(p1), 'paper.pdf'), FAKE_PDF)
    writeFileSync(join(dataDir, '.env'), 'DEEPSEEK_API_KEY=secret\n')
    db.prepare("INSERT INTO graphs (name, created_at, updated_at) VALUES ('第二张图', ?, ?)").run(now, now)

    const zipPath = await exportFullBackup(db, dataDir, join(dir, 'backup.zip'))

    const targetRoot = join(dir, 'new-root')
    const result = await restoreFullBackup(zipPath, targetRoot)
    expect(result.dataDir).toBe(join(targetRoot, 'Graphictero'))
    expect(result.paperFolders).toBe(1)

    // 图谱与论文齐全：直接打开恢复出的库验证
    const restored = openDatabase(join(result.dataDir, 'graphictero.db'))
    expect(restored.prepare('SELECT COUNT(*) c FROM graphs').get()).toEqual({ c: 2 })
    const paper = restored.prepare('SELECT title, doi FROM papers').get() as { title: string; doi: string }
    expect(paper.title).toBe('恢复测试论文')
    restored.close()

    // 无 .env、无 -wal/-shm 残留
    expect(existsSync(join(result.dataDir, '.env'))).toBe(false)
    expect(readdirSync(result.dataDir).some((n) => n.endsWith('-wal') || n.endsWith('-shm'))).toBe(false)
    // PDF 也恢复了
    expect(existsSync(join(result.dataDir, 'papers', String(p1), 'paper.pdf'))).toBe(true)
  })

  it('备份里的 .env 条目在恢复时被跳过（密钥绝不从备份还原）', async () => {
    writeFileSync(join(dataDir, '.env'), 'DEEPSEEK_API_KEY=secret\n')
    const zipPath = await exportFullBackup(db, dataDir, join(dir, 'backup.zip'))
    // 手工往 zip 里塞一个 .env（模拟旧备份/恶意备份）
    const entries = await readZip(zipPath)
    entries.push({ name: 'evil.env', data: Buffer.from('BAD=1') })
    entries.push({ name: '.env', data: Buffer.from('BAD=2') })
    writeZip(entries, zipPath)

    const result = await restoreFullBackup(zipPath, join(dir, 'new-root'))
    const names = readdirSync(result.dataDir)
    expect(names.some((n) => n.includes('.env'))).toBe(false)
  })

  it('目标非空目录拒绝恢复；缺少 graphictero.db 的 zip 拒绝恢复', async () => {
    const zipPath = await exportFullBackup(db, dataDir, join(dir, 'backup.zip'))
    const targetRoot = join(dir, 'new-root')
    mkdirSync(join(targetRoot, 'Graphictero'), { recursive: true })
    writeFileSync(join(targetRoot, 'Graphictero', 'stray.txt'), 'x')
    await expect(restoreFullBackup(zipPath, targetRoot)).rejects.toThrow(/空目录/)

    const badZip = join(dir, 'bad.zip')
    writeZip([{ name: 'readme.txt', data: Buffer.from('x') }], badZip)
    await expect(restoreFullBackup(badZip, join(dir, 'another-root'))).rejects.toThrow(/graphictero\.db/)
  })
})

describe('备份恢复：失败路径与原子性（评审建议修 4）', () => {
  const minimalDbZip = (): string => {
    const zipPath = join(dir, 'crafted.zip')
    writeZip([{ name: 'graphictero.db', data: Buffer.from('fake db') }], zipPath)
    return zipPath
  }

  const craftZip = (entries: Array<{ name: string; data: Buffer }>): string => {
    const zipPath = join(dir, 'crafted.zip')
    writeZip([{ name: 'graphictero.db', data: Buffer.from('fake db') }, ...entries], zipPath)
    return zipPath
  }

  it('zip-slip 条目（../x）被拒绝：目标位置不留半成品，重试不被「非空目录」挡', async () => {
    const zipPath = craftZip([{ name: '../evil.txt', data: Buffer.from('pwned') }])
    const targetRoot = join(dir, 'slip-root')
    await expect(restoreFullBackup(zipPath, targetRoot)).rejects.toThrow(/非法路径/)
    expect(existsSync(join(dir, 'evil.txt'))).toBe(false) // 没逃逸到上级目录
    expect(existsSync(join(targetRoot, 'Graphictero'))).toBe(false) // 没有半成品
    // 重试不被「非空目录」挡住：根目录至多留一个空壳
    if (existsSync(targetRoot)) expect(readdirSync(targetRoot)).toEqual([])
  })

  it('绝对路径条目（/abs/x）不逃逸：滤掉根段后落在恢复目录内', async () => {
    const zipPath = craftZip([{ name: '/abs/extra.txt', data: Buffer.from('safe') }])
    const result = await restoreFullBackup(zipPath, join(dir, 'abs-root'))
    expect(existsSync(join(result.dataDir, 'abs', 'extra.txt'))).toBe(true)
    expect(existsSync(join(dir, 'abs', 'extra.txt'))).toBe(false)
  })

  it('截断的 zip 被拒绝恢复', async () => {
    const zipPath = minimalDbZip()
    const buf = readFileSync(zipPath)
    writeFileSync(zipPath, buf.subarray(0, buf.length - 40)) // 砍掉 EOCD
    await expect(restoreFullBackup(zipPath, join(dir, 'trunc-root'))).rejects.toThrow(/EOCD/)
    expect(existsSync(join(dir, 'trunc-root', 'Graphictero'))).toBe(false)
  })

  it('坏 CRC 的 zip 被拒绝恢复，目标位置不留半成品', async () => {
    const zipPath = minimalDbZip()
    const buf = readFileSync(zipPath)
    // graphictero.db 条目的数据区从 30 + 14（文件名长）字节开始，翻转其中一字节
    buf[46] ^= 0xff
    writeFileSync(zipPath, buf)
    await expect(restoreFullBackup(zipPath, join(dir, 'crc-root'))).rejects.toThrow(/CRC/)
    expect(existsSync(join(dir, 'crc-root', 'Graphictero'))).toBe(false)
  })

  it('中文文件名条目 round-trip：字节一致、论文文件夹计数正确', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n中文名测试\n'), Buffer.alloc(512, 9)])
    const zipPath = craftZip([{ name: 'papers/2/论文 全文.pdf', data: pdf }])
    const result = await restoreFullBackup(zipPath, join(dir, 'cn-root'))
    expect(result.paperFolders).toBe(1)
    expect(readFileSync(join(result.dataDir, 'papers', '2', '论文 全文.pdf')).equals(pdf)).toBe(true)
  })

  it('大条目（4 MB）round-trip 字节一致', async () => {
    const big = Buffer.alloc(4 * 1024 * 1024, 7)
    const zipPath = craftZip([{ name: 'papers/3/big.pdf', data: big }])
    const entries = await readZip(zipPath)
    expect(entries.find((e) => e.name === 'papers/3/big.pdf')?.data.equals(big)).toBe(true)
  })

  it('恢复到已存在的空目录：整体 rename 替换空目录成功', async () => {
    const zipPath = craftZip([{ name: 'papers/4/paper.pdf', data: FAKE_PDF }])
    const targetRoot = join(dir, 'empty-existing-root')
    mkdirSync(join(targetRoot, 'Graphictero'), { recursive: true }) // 预先存在的空目录
    const result = await restoreFullBackup(zipPath, targetRoot)
    expect(result.paperFolders).toBe(1)
    expect(existsSync(join(result.dataDir, 'papers', '4', 'paper.pdf'))).toBe(true)
  })
})
