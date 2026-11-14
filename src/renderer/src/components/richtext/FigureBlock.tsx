import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import type { FigureView } from '../../../../shared/ipc/pdf'
import type { FigurePart } from '../../../../shared/parts'
import { cacheAssetUrl, usePartsHost } from './PartsHostContext'
import { resolveFigureByNo } from '../../../../shared/ipc/pdf'
import { isMultiPanelFigure } from '../../../../shared/figureCrop'

/**
 * uat6c S5：图注里的行内 $…$ LaTeX（MinerU 原样保留，如
 * 「Figure 2: … $( \alpha _ { t } )$ …」）按现有富文本数学管道渲染（与 TextBlock
 * 同：remark-math + KaTeX），不再显示原始 LaTeX 源码；段落包一层消掉 <p>，
 * 链接防导航口径同 TextBlock。
 */
function FigureCaption({ text }: { text: string }): React.JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        p({ children }) {
          return <>{children}</>
        },
        a({ href, title, children }) {
          return (
            <a href={href} title={title ?? href} onClick={(e) => e.preventDefault()}>
              {children}
            </a>
          )
        }
      }}
    >
      {text}
    </ReactMarkdown>
  )
}

type FigureState =
  | { kind: 'loading' }
  | { kind: 'found'; fig: FigureView; imgUrl: string | null }
  | { kind: 'missing' }
  | { kind: 'error' }

/**
 * M4 lane/render：data-figure 论文原图块（D19）。
 *
 * - 只存图号引用：路径/图注/页码经 pdf:listFigures(paperId) 解析（宿主上下文给
 *   paperId，单一事实来源）；图号 = 论文自身图号（图注里的 Figure N / 图 N，
 *   uat2 起按图注解析寻址，不再按列表下标——绝不显示错图）。
 * - 图片走本地缓存（解析缓存 images/...），经 gt-asset://（D115，主进程 realpath 校验），不发网络请求（D109 同口径）。
 * - 点击 → onOpenFigure(figureNo)（宿主跳到 PDF 对应位置，D27）。
 * - 图号找不到对应图块 → 「图 N 未找到」占位（无图注的图块不顶替任何图号）；宿主没给 paperId → 图注快照 + 提示。
 */
export function FigureBlock({
  part,
  onOpenFigure
}: {
  part: FigurePart
  onOpenFigure?: (figureNo: number) => void
}): React.JSX.Element {
  const host = usePartsHost()
  const [state, setState] = useState<FigureState>({ kind: 'loading' })
  const paperId = host.paperId

  useEffect(() => {
    if (paperId == null) return
    let cancelled = false
    setState({ kind: 'loading' })
    window.graphictero
      .listFigures(paperId)
      .then(async (figs) => {
        if (cancelled) return
        const fig = resolveFigureByNo(figs, part.figureNo)
        if (!fig) {
          setState({ kind: 'missing' }) // 按论文自身图号找不到对应图块：占位，绝不显示错图
          return
        }
        // 单面板沿用 MinerU 裁图。多面板才向主进程要并集裁图；失败留原图，不把整卡打成错误。
        let imgUrl = fig.imageSource ? cacheAssetUrl(`papers/${paperId}/mineru/${fig.imageSource}`) : null
        if (isMultiPanelFigure(fig) && typeof window.graphictero.getFigureCrop === 'function') {
          try {
            const crop = await window.graphictero.getFigureCrop(paperId, part.figureNo)
            if (!cancelled && crop.mode === 'crop' && crop.relPath) {
              const cropped = cacheAssetUrl(crop.relPath)
              if (cropped) imgUrl = cropped
            }
          } catch {
            // PDF 缺失或渲染失败：回退编号块自己的 MinerU 裁图
          }
        }
        if (!cancelled) setState({ kind: 'found', fig, imgUrl })
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [paperId, part.figureNo])

  if (paperId == null) {
    return (
      <div className="gt-part-figure" data-testid="part-figure">
        <div className="gt-figure-card">
          <span className="gt-figure-no">图 {part.figureNo}</span>
          {part.caption ? <span className="gt-figure-caption">{part.caption}</span> : null}
          <span className="gt-figure-note">（宿主未提供 paperId，无法解析图块）</span>
        </div>
      </div>
    )
  }
  if (state.kind === 'loading') {
    return (
      <div className="gt-part-figure" data-testid="part-figure">
        <div className="gt-figure-card loading">正在解析图 {part.figureNo}…</div>
      </div>
    )
  }
  if (state.kind === 'missing' || state.kind === 'error') {
    return (
      <div className="gt-part-figure" data-testid="part-figure">
        <div className="gt-figure-card missing" data-testid="figure-missing">
          图 {part.figureNo} 未找到
          {part.caption ? <span className="gt-figure-caption">（{part.caption}）</span> : null}
        </div>
      </div>
    )
  }

  const { fig, imgUrl } = state
  const caption = fig.caption ?? part.caption
  const clickable = onOpenFigure != null
  return (
    <div className="gt-part-figure" data-testid="part-figure">
      <button
        type="button"
        className="gt-figure-card"
        disabled={!clickable}
        onClick={() => onOpenFigure?.(part.figureNo)}
        title={clickable ? `跳到 PDF 第 ${fig.page + 1} 页` : undefined}
      >
        {imgUrl ? (
          <img className="gt-figure-img" data-testid="figure-card-img" src={imgUrl} alt={caption ?? `图 ${part.figureNo}`} />
        ) : (
          <span className="gt-figure-imgph">图 {part.figureNo}（无图文件，点按跳转到 PDF）</span>
        )}
        <span className="gt-figure-meta">
          <span className="gt-figure-no">图 {part.figureNo}</span>
          <span className="gt-figure-page">p.{fig.page + 1}</span>
        </span>
        {caption ? (
          <span className="gt-figure-caption">
            <FigureCaption text={caption} />
          </span>
        ) : null}
      </button>
    </div>
  )
}
