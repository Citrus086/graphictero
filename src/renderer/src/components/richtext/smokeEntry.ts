/**
 * M4 lane/render：PartsView 的 UI 冒烟测试挂载入口（index.html 的第二个 module script，
 * 正常使用时无行为）。仅当 URL 带 ?smoke=1（冒烟模式由主进程拼 query）时往
 * window.__gtSmokeParts 暴露 render/unmount，让 smokeUi.ts 的 lane/render 段能在
 * 真实 renderer 里挂载 PartsView（假数据/stub），不动任何冻结文件与既有页面。
 */
import { createRoot, type Root } from 'react-dom/client'
import { createElement, type ReactNode } from 'react'
import { PartsView } from './PartsView'
import { PartsHostContext, type PartsHost } from './PartsHostContext'
import type { DetailPart } from '../../../../shared/parts'

declare global {
  interface Window {
    __gtSmokeParts?: {
      render(parts: DetailPart[], opts: { host?: PartsHost; onOpenFigure?: (figureNo: number) => void }): void
      unmount(): void
      lastFigureNo(): number | null
    }
  }
}

if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('smoke')) {
  let root: Root | null = null
  let hostEl: HTMLDivElement | null = null
  let lastFigureNo: number | null = null
  const ensureHost = (): HTMLDivElement => {
    if (!hostEl || !document.body.contains(hostEl)) {
      hostEl = document.createElement('div')
      hostEl.setAttribute('data-testid', 'smoke-parts-host')
      document.body.appendChild(hostEl)
    }
    return hostEl
  }
  window.__gtSmokeParts = {
    render(parts, opts) {
      lastFigureNo = null
      const el = ensureHost()
      if (!root) root = createRoot(el)
      const view: ReactNode = createElement(
        PartsHostContext.Provider,
        { value: opts.host ?? {} },
        createElement(PartsView, {
          parts,
          onOpenFigure: opts.onOpenFigure ?? ((n: number) => { lastFigureNo = n })
        })
      )
      root.render(view)
    },
    unmount() {
      root?.unmount()
      root = null
      hostEl?.remove()
      hostEl = null
    },
    lastFigureNo() {
      return lastFigureNo
    }
  }
}
