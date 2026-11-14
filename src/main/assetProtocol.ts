import { protocol } from 'electron'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'
import { ASSET_HOST, ASSET_SCHEME, splitSafeRelPath } from '../shared/assetUrl'

/**
 * D115：gt-asset:// 协议（详情页本地图片）。
 *
 * - 渲染层只给数据目录内相对路径（见 shared/assetUrl.ts），数据目录绝对路径不下发；
 * - 解析：host 必须是 `data`，无 query/fragment；路径按段 decodeURIComponent，解码后的
 *   段再过一遍与渲染层同口径的词法校验（拒绝 ..、绝对、反斜杠、空段、段内 `/`）；
 * - 拼到「请求时的」数据目录（迁移数据目录后自动跟随）下，fs.realpath 解出真实路径，
 *   必须严格位于 realpath(数据目录) 之内（symlink 指向目录外 → 拒绝），且是普通文件；
 * - 任何不合法 / 不存在 → 404，不泄露原因。
 *
 * 特权 scheme 注册（registerSchemesAsPrivileged，Electron 要求 ready 前且全进程只能
 * 调一次）自 D116 起与 gt-app:// 一起在 appProtocol.ts 统一完成。
 */

/** URL → 数据目录内真实文件路径；任何校验失败返回 null。纯逻辑（无 electron），可单测。 */
export async function resolveAssetPath(dataDir: string, rawUrl: string): Promise<string | null> {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return null
  }
  if (u.protocol !== `${ASSET_SCHEME}:` || u.hostname !== ASSET_HOST) return null
  if (u.search || u.hash || u.username || u.password || u.port) return null
  const encoded = u.pathname.replace(/^\//, '')
  let decodedSegs: string[]
  try {
    decodedSegs = encoded.split('/').map((s) => decodeURIComponent(s))
  } catch {
    return null // 非法百分号转义
  }
  // 解码后段内出现 / 说明有人编码了分隔符：拒绝（不把 %2F 当分隔符，也不当文件名）
  if (decodedSegs.some((s) => s.includes('/'))) return null
  const segs = splitSafeRelPath(decodedSegs.join('/'))
  if (!segs) return null
  let realDir: string
  let realFile: string
  try {
    realDir = await realpath(dataDir)
    realFile = await realpath(join(dataDir, ...segs))
  } catch {
    return null // 不存在 / 断链 symlink
  }
  if (!realFile.startsWith(realDir.endsWith(sep) ? realDir : realDir + sep)) return null
  try {
    if (!(await stat(realFile)).isFile()) return null
  } catch {
    return null
  }
  return realFile
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif'
}

/** 请求 → Response（404 / 200 + 文件字节）。纯逻辑，可单测。 */
export async function handleAssetRequest(dataDir: string, rawUrl: string): Promise<Response> {
  const p = await resolveAssetPath(dataDir, rawUrl)
  if (!p) return new Response(null, { status: 404 })
  try {
    const buf = await readFile(p)
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        'content-type': MIME[extname(p).toLowerCase()] ?? 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store'
      }
    })
  } catch {
    return new Response(null, { status: 404 })
  }
}

/** app ready 后调用；getDataDir 每次请求时读（数据目录迁移后跟随）。 */
export function registerAssetProtocol(getDataDir: () => string): void {
  protocol.handle(ASSET_SCHEME, (req) => handleAssetRequest(getDataDir(), req.url))
}
