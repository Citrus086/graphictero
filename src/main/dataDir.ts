import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

/**
 * 数据目录解析与校验（D81/D83/D90/D91）。
 *
 * - 默认根位置：~/Library/Application Support/，数据目录固定为其中的
 *   `Graphictero/`（目录名固定，D91；根位置可在设置里改，D83）。
 * - 选到 iCloud Drive、Dropbox、OneDrive 或 Google Drive 的同步目录时拦下并提示
 *   （D76/D83/D94；含 Drive for desktop 旧版/File Stream 形态的 /Volumes/GoogleDrive
 *   挂载点，评审建 1）；拦截前对路径做符号链接解引用（realpathSync，目标不存在时解析
 *   最近存在的父目录），比较在 darwin 下大小写不敏感（APFS 默认不区分大小写，
 *   评审必须修 2）。
 * - iCloud「桌面与文稿」同步开启时 ~/Desktop、~/Documents 也属 iCloud，一并拦截
 *   （启发式：CloudDocs 容器下的 Desktop/Documents 子目录存在即视为开启——只对
 *   开了桌面文稿同步的人生效；仅开 iCloud Drive 的用户不会误拦，评审复核建议修 4）。
 *
 * 本模块不依赖 electron，纯函数（可用 fs），可在 Node（vitest）和 Electron 主进程里直接用。
 */

export const APP_DIR_NAME = 'Graphictero'

/** 默认根位置（不含 Graphictero 子目录） */
export function defaultDataRoot(home: string = homedir()): string {
  return join(home, 'Library', 'Application Support')
}

export type CloudBlockReason = 'icloud' | 'dropbox' | 'onedrive' | 'googledrive'

export type ResolveDataDirResult =
  | { ok: true; dir: string }
  | { ok: false; reason: 'empty_path' | 'relative_path' | CloudBlockReason }

/** darwin 文件系统默认大小写不敏感：比较前统一转小写（其余平台精确比较） */
function normCase(p: string): string {
  return process.platform === 'darwin' ? p.toLowerCase() : p
}

/**
 * 符号链接解引用：realpathSync 失败（目标不存在）时，逐级向上找最近存在的
 * 父目录解引用，再把不存在的尾部拼回去。
 */
export function resolveRealPath(path: string): string {
  let p = resolve(path)
  const tail: string[] = []
  for (;;) {
    try {
      return join(realpathSync(p), ...tail)
    } catch {
      const parent = dirname(p)
      if (parent === p) return resolve(path) // 到根了仍失败：退回词法路径
      tail.unshift(p.slice(parent.length + 1))
      p = parent
    }
  }
}

/** 路径前缀判断：p 在 root 之内（含 root 本身） */
function within(p: string, root: string): boolean {
  const [np, nr] = [normCase(p), normCase(root)]
  return np === nr || np.startsWith(nr + sep)
}

/**
 * iCloud「桌面与文稿」同步是否开启（启发式）：CloudDocs 容器本身对任何开了
 * iCloud Drive 的用户都存在，真正标志桌面文稿同步的是容器里的 Desktop /
 * Documents 子目录。任一存在即视为开启（fail-safe）。
 */
function iCloudDesktopDocsEnabled(home: string): boolean {
  const cloudDocs = join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')
  return existsSync(join(cloudDocs, 'Desktop')) || existsSync(join(cloudDocs, 'Documents'))
}

/**
 * 判断给定路径是否落在 iCloud Drive / Dropbox / OneDrive / Google Drive 同步目录里
 * （解引用 + 大小写不敏感）。返回拦截原因；不拦截返回 null。
 */
export function blockedCloudReason(path: string, home: string = homedir()): CloudBlockReason | null {
  const p = resolveRealPath(path)
  // 被拦的根目录同样做符号链接解引用（输入侧与根目录侧口径一致，
  // 否则 /tmp → /private/tmp 这类系统软链会让比较失真）
  const homeReal = resolveRealPath(home)
  // iCloud Drive：~/Library/Mobile Documents/...（含 com~apple~CloudDocs）
  if (within(p, resolve(join(homeReal, 'Library', 'Mobile Documents')))) return 'icloud'
  // iCloud「桌面与文稿」：开启同步后 ~/Desktop、~/Documents 实际进 iCloud
  //（判据：CloudDocs/Desktop 或 CloudDocs/Documents 子目录存在）
  if (iCloudDesktopDocsEnabled(homeReal)) {
    if (within(p, resolve(join(homeReal, 'Desktop')))) return 'icloud'
    if (within(p, resolve(join(homeReal, 'Documents')))) return 'icloud'
  }
  // home 首层口径（与 CloudStorage 分支对齐 startsWith；评审建 2：OneDrive/Google Drive
  // 收紧为「精确名」或「名 - 公司名」后缀，不再拦 ~/onedrive-export 这类自建目录；
  // 评审建 4：Dropbox 用 startsWith 覆盖旧版 Business 的「Dropbox (公司名)」）：
  //   Dropbox：传统位置 ~/Dropbox*，新版 macOS 挂在 ~/Library/CloudStorage/Dropbox-*
  //   OneDrive：~/OneDrive /「OneDrive - 公司名」，新版挂在 CloudStorage/OneDrive-*
  //   Google Drive：旧版桌面端 ~/Google Drive /「Google Drive - 公司名」，
  //   Drive for desktop 挂在 CloudStorage/GoogleDrive-邮箱
  if (within(p, homeReal)) {
    const first = normCase(p.slice(homeReal.length + 1).split(sep)[0] ?? '')
    if (first.startsWith('dropbox')) return 'dropbox'
    if (first === 'onedrive' || first.startsWith('onedrive - ')) return 'onedrive'
    if (first === 'google drive' || first.startsWith('google drive - ')) return 'googledrive'
  }
  // Drive for desktop 非 File Provider 形态（File Stream/旧版）挂载在 /Volumes/GoogleDrive（评审建 1）
  if (within(p, resolve('/Volumes/GoogleDrive'))) return 'googledrive'
  if (within(p, resolve(join(homeReal, 'Library', 'CloudStorage')))) {
    const cloudRoot = resolve(join(homeReal, 'Library', 'CloudStorage'))
    const rel = p.slice(cloudRoot.length + 1)
    const first = normCase(rel.split(sep)[0] ?? '')
    if (first.startsWith('dropbox')) return 'dropbox'
    if (first.startsWith('onedrive')) return 'onedrive'
    if (first.startsWith('googledrive')) return 'googledrive'
  }
  return null
}

/**
 * 把用户选择的根位置解析成数据目录。
 * 合法：<根位置>/Graphictero；拦截 iCloud Drive / Dropbox / OneDrive / Google Drive（D83/D94）。
 */
export function resolveDataDir(rootPath: string, home: string = homedir()): ResolveDataDirResult {
  if (!rootPath || rootPath.trim() === '') return { ok: false, reason: 'empty_path' }
  if (!isAbsolute(rootPath)) return { ok: false, reason: 'relative_path' }
  const blocked = blockedCloudReason(rootPath, home)
  if (blocked) return { ok: false, reason: blocked }
  return { ok: true, dir: join(resolve(rootPath), APP_DIR_NAME) }
}

export const BLOCK_MESSAGES: Record<CloudBlockReason, string> = {
  icloud: '数据目录不能放在 iCloud 同步的位置（iCloud Drive，或开启「桌面与文稿」后的桌面/文稿），同步中的数据库容易损坏，请换一个位置。',
  dropbox: '数据目录不能放在 Dropbox 里（同步中的数据库容易损坏），请换一个位置。',
  onedrive: '数据目录不能放在 OneDrive 同步目录里（同步中的数据库容易损坏），请换一个位置。',
  googledrive: '数据目录不能放在 Google Drive 同步目录里（同步中的数据库容易损坏），请换一个位置。'
}

/** 根位置本身不合法时的弹窗文案（empty_path/relative_path 的英文 reason 不直接外露） */
export const RESOLVE_FAIL_MESSAGES: Record<string, string> = {
  empty_path: '数据目录的根位置不能为空，请重新选择一个文件夹。',
  relative_path: '数据目录的根位置必须是完整路径（从 / 开始），请重新选择。'
}

/** 统一取拦截/不合法原因的用户可读文案（BLOCK_MESSAGES 是 CloudBlockReason 的窄类型表，
 *  对 string 索引会 TS7053；这里收敛成一个入口，index.ts / ipc.ts 不再各自拼） */
export function dataDirBlockMessage(reason: string): string {
  return (BLOCK_MESSAGES as Record<string, string>)[reason] ?? RESOLVE_FAIL_MESSAGES[reason] ?? `数据目录不合法：${reason}`
}
