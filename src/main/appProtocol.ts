import { protocol } from 'electron'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'
import { ASSET_SCHEME, splitSafeRelPath } from '../shared/assetUrl'

/**
 * D116：gt-app:// 协议——整个应用页面（renderer 输出目录）经它加载，不再用 file://。
 *
 * - 彻底关闭 D115 的残留暴露面：file:// 页面下 CSP 'self' 会覆盖本地 file:// 资源；
 *   页面 origin 变为 gt-app://app 后，'self' 只指 gt-app 自身；
 * - 与 gt-asset://（数据目录文件，D115）职责不合并：gt-app 只管 out/renderer；
 * - 解析：host 固定 `app`（其余 404）；路径按段 decodeURIComponent 后过与渲染层
 *   同口径的词法校验（拒绝 ..、绝对、反斜杠、空段、段内 `/`）；`/` 映射 index.html；
 *   query 合法（smoke 模式 `?smoke=1`）；fs.realpath 校验真实路径仍在输出目录内，
 *   且是普通文件；任何不合法 / 不存在 → 404，不泄露原因；
 * - dev（ELECTRON_RENDERER_URL）不走本协议（vite dev server 是 http://localhost）。
 */

export const APP_SCHEME = 'gt-app'
export const APP_HOST = 'app'

/** 生产/smoke 模式页面入口 URL（createWindow 的 loadURL 目标）。 */
export function appIndexUrl(extraQuery: Record<string, string> = {}): string {
  const q = new URLSearchParams(extraQuery).toString()
  return `${APP_SCHEME}://${APP_HOST}/${q ? `?${q}` : ''}`
}

/**
 * 必须在 app ready 之前调用（Electron 要求，且全进程只能调一次）——
 * gt-asset（D115）与 gt-app（D116）两个 scheme 在这里一并注册。
 * gt-app 的特权：standard（带 host 的标准 URL 解析、相对路径可用）+ secure
 * （可信来源，fetch/Worker/CSP 'self' 语义与 https 对齐）+ supportFetchAPI（页面
 * 代码 fetch 本地资源，如 pdfium wasm）+ codeCache（JS 字节码缓存）。
 */
export function registerAppSchemesPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: ASSET_SCHEME, privileges: { standard: true, secure: true } },
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }
  ])
}

/** URL → renderer 输出目录内真实文件路径；任何校验失败返回 null。纯逻辑（无 electron），可单测。 */
export async function resolveAppPath(rendererDir: string, rawUrl: string): Promise<string | null> {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return null
  }
  if (u.protocol !== `${APP_SCHEME}:` || u.hostname !== APP_HOST) return null
  if (u.hash || u.username || u.password || u.port) return null
  const encoded = u.pathname.replace(/^\//, '')
  let segs: string[]
  if (encoded === '') {
    segs = ['index.html'] // 页面入口 `/`（含带 query 的 `/?smoke=1`）→ index.html
  } else {
    let decodedSegs: string[]
    try {
      decodedSegs = encoded.split('/').map((s) => decodeURIComponent(s))
    } catch {
      return null // 非法百分号转义
    }
    // 解码后段内出现 / 说明有人编码了分隔符：拒绝（不把 %2F 当分隔符，也不当文件名）
    if (decodedSegs.some((s) => s.includes('/'))) return null
    const safe = splitSafeRelPath(decodedSegs.join('/'))
    if (!safe) return null
    segs = safe
  }
  let realDir: string
  let realFile: string
  try {
    realDir = await realpath(rendererDir)
    realFile = await realpath(join(rendererDir, ...segs))
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
  '.html': 'text/html;charset=utf-8',
  '.js': 'text/javascript;charset=utf-8',
  '.mjs': 'text/javascript;charset=utf-8',
  '.css': 'text/css;charset=utf-8',
  '.json': 'application/json;charset=utf-8',
  '.map': 'application/json;charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf'
}

/** 请求 → Response（404 / 200 + 文件字节）。纯逻辑，可单测。
 *  index.html 不缓存（重开 App 拿最新构建）；其余产物文件名带内容哈希，交给默认缓存。 */
export async function handleAppRequest(rendererDir: string, rawUrl: string): Promise<Response> {
  const p = await resolveAppPath(rendererDir, rawUrl)
  if (!p) return new Response(null, { status: 404 })
  try {
    const buf = await readFile(p)
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        'content-type': MIME[extname(p).toLowerCase()] ?? 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        ...(extname(p).toLowerCase() === '.html' ? { 'cache-control': 'no-store' } : {})
      }
    })
  } catch {
    return new Response(null, { status: 404 })
  }
}

/** app ready 后调用；rendererDir = join(__dirname, '../renderer')（electron-vite 输出目录）。 */
export function registerAppProtocol(rendererDir: string): void {
  protocol.handle(APP_SCHEME, (req) => handleAppRequest(rendererDir, req.url))
}
