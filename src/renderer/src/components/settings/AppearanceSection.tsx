import { useEffect, useState } from 'react'
import type { ThemePref, ThemeView } from '../../../../shared/ipc'
import { ipcErrorMessage } from '../../lib/ipcError'
import { useNotify } from '../../lib/notify'
import { applyResolvedTheme } from '../../lib/themeSync'

const api = window.graphictero
const OPTIONS: Array<[ThemePref, string]> = [
  ['light', '浅色'],
  ['dark', '深色'],
  ['system', '跟随系统']
]

/** 设置 · 外观（D195）。只有主题一行。 */
export function AppearanceSection(): React.JSX.Element {
  const notify = useNotify()
  const [theme, setTheme] = useState<ThemeView | null>(null)

  useEffect(() => {
    let live = true
    api
      .getTheme()
      .then((v) => {
        if (!live) return
        setTheme(v)
        applyResolvedTheme(v.resolved)
      })
      .catch(() => notify('读取主题失败'))
    return () => {
      live = false
    }
  }, [notify])

  const choose = async (pref: ThemePref): Promise<void> => {
    try {
      const next = await api.setTheme(pref)
      setTheme(next)
      applyResolvedTheme(next.resolved)
    } catch (e) {
      notify(ipcErrorMessage(e, '保存主题失败'))
    }
  }

  return (
    <>
      <div className="group" data-testid="appearance-theme">
        <div className="grow-r" style={{ minHeight: 42, padding: '6px 16px' }}>
          <div className="k">主题</div>
          <div className="v">
            <span className="seg">
              {OPTIONS.map(([value, label]) => (
                <span
                  key={value}
                  data-testid={`theme-${value}`}
                  className={theme?.pref === value ? 'on' : ''}
                  onClick={() => void choose(value)}
                >
                  {label}
                </span>
              ))}
            </span>
          </div>
        </div>
      </div>
      <div className="note">跟随系统时随 macOS 外观自动切换。</div>
    </>
  )
}
