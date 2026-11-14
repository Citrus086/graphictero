import type Database from 'better-sqlite3'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, lstatSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { DataDirBlockedError } from '../dataLayer'
import { resolveDataDir } from '../dataDir'
import { readZipEntries, writeZipStreaming, type ZipEntrySource, type ZipEntryMeta } from './zip'

/**
 * 「导出完整备份」/「从备份恢复」（D59/D76/D98，D162 批升级）。
 *
 * 备份内容（D162 口径）：graphictero.db（VACUUM INTO 一致性快照）+ 设置文件 +
 * 数据目录 papers/ 下论文文件夹（MinerU 解析结果照旧进备份，D98）+ shouldBackupPdf
 * 判定为真的 PDF（只手动拖入的无 DOI PDF，D59/D76 的大文件取舍，不扩大范围）。
 *
 * 排除规则集中在下面 EXCLUDED 一张表，逐条注释。zip 写入/读取全部走流式
 * （zip.ts writeZipStreaming / readZipEntries，fd 分块 + zip64），导出/恢复均为
 * 异步（await IPC handler），条日间让出事件循环，不阻塞主进程 UI。
 *
 * D78 说备份/zip 放 utilityProcess——此处仍留在主进程：改动面大、备份已是低频
 * 后台操作（用户手动触发），流式 + 分块让出后阻塞可接受；挪 utilityProcess 留作
 * 后续优化，见 PROGRESS。
 *
 * 恢复：恢复到空数据目录；目标根位置仍走 iCloud/Dropbox 拦截（D83/D76）；
 *   解压后清掉 -wal/-shm，绝不还原 .env；仍是「先解压到旁边临时目录、全部成功
 *   再整体 rename」的两阶段原子语义。
 */

/**
 * 备份排除规则（D162：集中成一张表，新增排除在这里加一行）。
 * match 参数是相对数据目录的 POSIX 路径（walkFiles 只产出文件，不产出目录）。
 */
const EXCLUDED: Array<{ name: string; match: (rel: string) => boolean; reason: string }> = [
  {
    name: '.env',
    match: (rel) => rel === '.env' || rel.endsWith('/.env'),
    reason: 'D76：备份不含 .env 和密钥'
  },
  {
    name: 'graphictero.db',
    match: (rel) => rel === 'graphictero.db',
    reason: '打包的是 VACUUM INTO 一致性快照，不打包正在使用的库文件'
  },
  {
    name: 'wal-shm',
    match: (rel) => rel === 'graphictero.db-wal' || rel === 'graphictero.db-shm',
    reason: 'D76：恢复后不该有残留'
  },
  {
    name: 'backups',
    match: (rel) => rel === 'backups' || rel.startsWith('backups/'),
    reason: '每日快照/升级前备份可再生成，打包进去只会膨胀（D59/D76）'
  },
  {
    name: 'sidecar',
    match: (rel) => rel === 'sidecar' || rel.startsWith('sidecar/'),
    reason:
      'D162：sidecar 运行时文件（venv 上万个文件、uploads/blobs 的 PDF 副本、mineru.pid、日志）不进备份'
  },
  {
    // D145（MinerU 模型挪进数据目录）：模型目录在 sidecar/ 下，已被上行整目录剪枝；
    // 这里单独写明一行——几 GB 模型文件绝不进备份（D162 排除表口径延续）。
    name: 'mineru-models',
    match: (rel) => rel === 'sidecar/mineru-home' || rel.startsWith('sidecar/mineru-home/'),
    reason: 'D145：MinerU 模型（几 GB）在 App 数据目录内可再生（复用/重下），不进备份'
  },
  {
    name: 'cache',
    match: (rel) => rel === 'cache' || rel.startsWith('cache/'),
    reason: 'D189：运行时缓存（图卡 PDF 裁图等）可再生，不进备份（与 D162 / D190④ 同一排除机制）'
  },
  {
    // cache/ 整目录已剪枝；单独写明裁图目录，避免以后 cache 下放了别的要进备份的东西时把裁图带进去。
    name: 'figure-crops',
    match: (rel) => rel === 'cache/figure-crops' || rel.startsWith('cache/figure-crops/'),
    reason: 'D189：详情图卡并集裁图（cache/figure-crops）不进备份'
  }
]

function isExcluded(rel: string): boolean {
  return EXCLUDED.some((r) => r.match(rel))
}

/**
 * 递归收集文件；符号链接跳过不跟随（避免链接环无限递归、备份语义不含链接目标）。
 * uat4-fix1 S3：目录命中 EXCLUDED（sidecar/、backups/ 等）时直接剪枝——不下行、
 * 不 stat 其内部条目（sidecar venv 约四万文件，避免主进程在过滤前整棵走一遍）。
 */
function walkFiles(root: string, dataDir: string, out: string[] = []): string[] {
  for (const name of readdirSync(root)) {
    const full = join(root, name)
    if (lstatSync(full).isSymbolicLink()) continue
    if (statSync(full).isDirectory()) {
      const rel = relative(dataDir, full).split(sep).join('/')
      if (isExcluded(rel)) continue // 排除目录整棵剪枝（S3）
      walkFiles(full, dataDir, out)
    } else out.push(full)
  }
  return out
}

/** papers/<id>/paper.pdf 是否进备份：无 DOI 且手动拖入（D59/D76 的大文件取舍，D162 不扩大范围）。 */
function shouldBackupPdf(db: Database.Database, relPath: string): boolean {
  const m = /^papers[\\/]+(\d+)[\\/]+paper\.pdf$/.exec(relPath)
  if (!m) return true
  const row = db
    .prepare('SELECT doi, pdf_source FROM papers WHERE id = ?')
    .get(Number(m[1])) as { doi: string | null; pdf_source: string | null } | undefined
  if (!row) return true // 库里查不到对应论文（残留文件夹）：不知道来源，保守进备份
  return row.doi === null && row.pdf_source === 'user_drop'
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** 导出完整备份（异步、流式；D162）。返回备份文件绝对路径。 */
export async function exportFullBackup(db: Database.Database, dataDir: string, outFile: string): Promise<string> {
  // 1) 一致性快照（WAL 下安全）
  const tmpDir = mkdtempSync(join(tmpdir(), 'gt-fullbackup-'))
  try {
    const snapPath = join(tmpDir, 'graphictero.db')
    db.exec(`VACUUM INTO '${snapPath.replace(/'/g, "''")}'`)

    // 2) 条目清单：db 快照走文件路径（流式读，绝不 readFileSync 整块读），
    //    数据目录文件按 EXCLUDED 表 + shouldBackupPdf 过滤，同样只传路径。
    const entries: ZipEntrySource[] = [{ name: 'graphictero.db', source: snapPath }]
    const outResolved = resolve(outFile)
    for (const file of walkFiles(dataDir, dataDir)) {
      if (resolve(file) === outResolved) continue // 备份文件本身在数据目录里时排除
      const rel = relative(dataDir, file).split(sep).join('/')
      if (isExcluded(rel)) continue
      if (!shouldBackupPdf(db, rel)) continue
      entries.push({ name: rel, source: file })
    }
    mkdirSync(dirname(outResolved), { recursive: true })
    await writeZipStreaming(entries, outResolved)
    return outResolved
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1)
}

/** 解压目标路径安全检查：拒绝绝对路径与 .. 逃逸。 */
function safeJoin(root: string, rel: string): string {
  const clean = rel.split('/').filter((s) => s !== '' && s !== '.')
  if (clean.some((s) => s === '..')) throw new Error(`备份内含非法路径：${rel}`)
  return join(root, ...clean)
}

export interface RestoreResult {
  dataDir: string
  /** 备份里包含的论文文件夹数（校验「论文齐全」用） */
  paperFolders: number
}

/**
 * 从备份恢复到空数据目录（异步、流式；D162）；目标根位置仍走 iCloud/Dropbox 拦截（D83/D76）。
 * 边读边写盘：不对整个包或单个大文件整块进内存；CRC 在读取流里逐块校验。
 */
export async function restoreFullBackup(
  zipPath: string,
  targetRoot: string,
  home?: string
): Promise<RestoreResult> {
  const resolved = resolveDataDir(targetRoot, home)
  if (!resolved.ok) throw new DataDirBlockedError(resolved.reason)

  if (existsSync(resolved.dir) && readdirSync(resolved.dir).length > 0) {
    throw new Error(`目标数据目录 ${resolved.dir} 不是空目录，拒绝覆盖恢复`)
  }

  // 先扫一遍中央目录确认这是完整备份（坏 zip/截断在写任何文件前抛）
  const names: string[] = []
  await readZipEntries(zipPath, async (meta) => {
    names.push(meta.name)
  })
  if (!names.includes('graphictero.db')) {
    throw new Error('备份里缺少 graphictero.db，不是完整的 Graphictero 备份')
  }

  // 两阶段原子恢复：先解压到目标旁边的临时目录，全部成功再整体 rename 进目标——
  // 中途失败（zip-slip 非法路径、坏 CRC、磁盘错等）只留临时目录被清掉，目标位置不留半成品。
  const stageParent = dirname(resolved.dir)
  mkdirSync(stageParent, { recursive: true })
  const stageDir = mkdtempSync(join(stageParent, '.gt-restore-stage-'))
  let moved = false
  let paperFolders = 0
  try {
    const seenFolders = new Set<string>()
    await readZipEntries(zipPath, async (meta: ZipEntryMeta, chunks: AsyncIterable<Buffer>) => {
      if (basename(meta.name).endsWith('.env')) return // 密钥绝不从备份还原（D76）
      if (meta.name.endsWith('.db-wal') || meta.name.endsWith('.db-shm')) return
      const dest = safeJoin(stageDir, meta.name) // 拒绝 .. 逃逸；绝对路径条目落在根内不逃逸
      mkdirSync(dirname(dest), { recursive: true })
      const out = createWriteStream(dest, { flags: 'w' })
      try {
        for await (const chunk of chunks) {
          if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', r))
        }
      } finally {
        await new Promise<void>((r) => out.end(r))
      }
      const m = /^papers[\\/]+(\d+)[\\/]/.exec(meta.name)
      if (m) seenFolders.add(m[1])
      await tick() // 让出事件循环，不阻塞主进程（D162）
    })
    // 全部条目落盘成功：目标已验空（或不存在），整体 rename（同分区原子）
    if (existsSync(resolved.dir)) rmSync(resolved.dir, { recursive: true, force: true })
    renameSync(stageDir, resolved.dir)
    moved = true
    paperFolders = seenFolders.size
  } finally {
    if (!moved) rmSync(stageDir, { recursive: true, force: true })
  }

  // 恢复后无残留 -wal/-shm（D76）：解压时已跳过，这里兜底清掉目标里已有的
  for (const suffix of ['-wal', '-shm']) {
    const f = join(resolved.dir, `graphictero.db${suffix}`)
    if (existsSync(f)) rmSync(f)
  }
  return { dataDir: resolved.dir, paperFolders }
}
