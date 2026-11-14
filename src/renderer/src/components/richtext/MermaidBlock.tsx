import { useEffect, useRef, useState } from 'react'
import type { MermaidPart } from '../../../../shared/parts'

/**
 * M4 lane/render：data-mermaid 流程图块（D19）。
 *
 * - mermaid 懒加载（动态 import，不阻塞详情首屏；D107）。
 * - securityLevel 'strict' + htmlLabels false：标签转义、禁交互脚本。
 * - 渲染失败 → 显示源码块（不崩）。
 */
let mermaidSeq = 0
let mermaidReady: Promise<typeof import('mermaid').default> | null = null

function loadMermaid(): Promise<typeof import('mermaid').default> {
  if (!mermaidReady) mermaidReady = import('mermaid').then((m) => m.default)
  return mermaidReady
}

export function mermaidTheme(theme: string | null | undefined): 'dark' | 'default' {
  return theme === 'dark' ? 'dark' : 'default'
}

export function MermaidBlock({ part }: { part: MermaidPart }): React.JSX.Element {
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [theme, setTheme] = useState<'dark' | 'default'>(() => mermaidTheme(document.documentElement.dataset.theme))
  const codeRef = useRef(part.code)
  codeRef.current = part.code

  // 外观切换时按当前 data-theme 重渲染；mermaid.initialize 是全局配置，在每次 render 前设置。
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(mermaidTheme(document.documentElement.dataset.theme)))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    setSvg(null)
    setFailed(false)
    loadMermaid()
      .then(async (mermaid) => {
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, flowchart: { htmlLabels: false }, theme })
        // render 的 id 会被写进 SVG，用序号保证唯一（严格模式下 id 仅作标识）
        const { svg: out } = await mermaid.render(`gt-mmd-${++mermaidSeq}`, codeRef.current)
        if (!cancelled) setSvg(out)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [part.id, part.code, theme])

  return (
    <div className="gt-part-mermaid" data-testid="part-mermaid">
      <div className="gt-chart-title">{part.title}</div>
      {svg ? (
        <div className="gt-mermaid-svg" data-testid="mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : failed ? (
        <pre className="gt-mermaid-src" data-testid="mermaid-fallback">{part.code}</pre>
      ) : (
        <div className="gt-mermaid-loading">正在渲染流程图…</div>
      )}
    </div>
  )
}
