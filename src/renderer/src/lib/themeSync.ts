import { useEffect } from 'react'
import type { ThemeView } from '../../../shared/ipc'

/** 把主进程解析好的主题写到 <html data-theme>。浅色去掉属性，走 :root。 */
export function applyResolvedTheme(resolved: ThemeView['resolved']): void {
  if (resolved === 'dark') document.documentElement.dataset.theme = 'dark'
  else delete document.documentElement.dataset.theme
}

/** preload 抢首帧；挂载时再取一次偏好兜底，跟随系统由主进程广播 event:theme。 */
export function useThemeSync(): void {
  useEffect(() => {
    const api = window.graphictero
    if (typeof api?.onTheme !== 'function') return
    let active = true
    let eventSeen = false
    const off = api.onTheme((view) => {
      eventSeen = true
      if (active) applyResolvedTheme(view.resolved)
    })
    if (typeof api.getTheme === 'function') {
      void api.getTheme().then((view) => {
        // 挂载后若已收到更新的广播，不用较旧的 getTheme 结果盖回去。
        if (active && !eventSeen) applyResolvedTheme(view.resolved)
      }).catch(() => {
        // preload 已尽力着色；读取偏好失败不挡住应用挂载。
      })
    }
    return () => {
      active = false
      off()
    }
  }, [])
}
