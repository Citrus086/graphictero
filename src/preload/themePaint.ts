import { ipcRenderer } from 'electron'

export type PaintTheme = 'light' | 'dark'

/** documentElement 尚未创建时返回 false，由调用方继续等 DOM。 */
export function paintResolvedTheme(resolved: PaintTheme | undefined, doc: Document = document): boolean {
  const root = doc.documentElement as HTMLElement | null
  if (!root) return false
  if (resolved === 'dark') root.dataset.theme = 'dark'
  else delete root.dataset.theme
  return true
}

/**
 * preload 可能早于 &lt;html&gt; 执行。立即尝试一次，并用 MutationObserver 抢在首帧前
 * 补上；DOMContentLoaded / readystatechange 是无 Observer 环境的兜底。成功后全部撤掉。
 */
export function installThemePaint(resolved: PaintTheme | undefined, doc: Document = document): () => void {
  let observer: MutationObserver | null = null
  const paint = (): void => {
    if (!paintResolvedTheme(resolved, doc)) return
    observer?.disconnect()
    doc.removeEventListener('DOMContentLoaded', paint)
    doc.removeEventListener('readystatechange', paint)
  }
  if (paintResolvedTheme(resolved, doc)) return () => {}
  doc.addEventListener('DOMContentLoaded', paint)
  doc.addEventListener('readystatechange', paint)
  if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(paint)
    observer.observe(doc, { childList: true, subtree: true })
  }
  return () => {
    observer?.disconnect()
    doc.removeEventListener('DOMContentLoaded', paint)
    doc.removeEventListener('readystatechange', paint)
  }
}

/**
 * 首帧前把主题写到 <html data-theme>（D194①）。
 * preload 在页面脚本之前跑；主进程 settings:themeSync 已在 createWindow 前注册。
 * 通道缺失时由 renderer 挂载后的 getTheme 兜底，不让同步异常挡住窗口。
 */
try {
  const view = ipcRenderer.sendSync('settings:themeSync') as { resolved?: PaintTheme } | null
  installThemePaint(view?.resolved)
} catch {
  // 同步通道未就绪：useThemeSync 会再取一次主进程偏好。
}
