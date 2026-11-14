/**
 * 渲染进程 IPC 错误展示（评审建 7）：preload invoke 失败时 Electron 会包一层
 * 「Error invoking remote method 'zotero:import': Error: …」前缀，直接展示 e.message
 * 会把这串英文暴露给用户。这里统一剥掉前缀，拿到主进程本来的（中文）文案。
 */
export function ipcErrorMessage(e: unknown, fallback: string): string {
  const raw = e instanceof Error ? e.message : String(e)
  const stripped = raw
    .replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
    .trim()
  return stripped === '' ? fallback : stripped
}
