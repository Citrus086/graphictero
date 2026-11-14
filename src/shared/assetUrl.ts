/**
 * D115：数据目录内本地资源（详情页图片）的专用协议 gt-asset://。
 *
 * URL 只携带「数据目录内相对路径」，渲染层不知道数据目录绝对路径；主进程
 * （src/main/assetProtocol.ts）按段解码后拼到当前数据目录下，再 realpath 校验
 * 真实路径仍在数据目录内（堵 symlink 外指），只回普通文件。
 *
 * 形如 gt-asset://data/papers/7/mineru/images/a%231.png —— host 固定为 `data`
 * （标准 scheme 必须有 host），每个路径段 encodeURIComponent（空格/#/?/% 安全，
 * 段内 %2F 只是文件名文本，不会变成分隔符）。
 */
export const ASSET_SCHEME = 'gt-asset'
export const ASSET_HOST = 'data'

/** 相对路径的词法校验：拒绝空串、绝对路径（/ 或盘符）、反斜杠、NUL、空段、`.`、`..`。
 *  通过则返回各段；否则 null。主进程与渲染层共用同一口径。 */
export function splitSafeRelPath(relPath: string): string[] | null {
  if (!relPath || relPath.includes('\\') || relPath.includes('\0')) return null
  if (relPath.startsWith('/') || /^[a-zA-Z]:/.test(relPath)) return null
  const segs = relPath.split('/')
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return null
  return segs
}

/** 数据目录内相对路径 → gt-asset:// URL；不合法（穿越/绝对/反斜杠等）→ null。 */
export function assetUrl(relPath: string): string | null {
  const segs = splitSafeRelPath(relPath)
  if (!segs) return null
  return `${ASSET_SCHEME}://${ASSET_HOST}/${segs.map((s) => encodeURIComponent(s)).join('/')}`
}
