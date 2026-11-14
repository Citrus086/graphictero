import { useState } from 'react'
import type { ImagePart } from '../../../../shared/parts'
import { cacheAssetUrl } from './PartsHostContext'

/**
 * M4 lane/render：data-image 网络图片块（D109）。
 *
 * M4 只渲染本地缓存：localPath 是数据目录内相对路径（D115），经 gt-asset:// 走本地
 * 资源通道（主进程 realpath 校验在数据目录内），不发任何网络请求、CSP 不加 https:；
 * url 仅作展示，不用于加载。
 * 无可用缓存 / 加载失败 → alt + 来源链接展示（来源必填，D20）。
 */
export function ImageBlock({ part }: { part: ImagePart }): React.JSX.Element {
  const url = part.localPath ? cacheAssetUrl(part.localPath) : null
  const [broken, setBroken] = useState(false)
  const showImg = url != null && !broken
  const sourceLabel = part.sourceTitle ?? part.sourceUrl
  return (
    <div className="gt-part-image" data-testid="part-image">
      {showImg ? (
        <img className="gt-image-img" src={url} alt={part.alt ?? ''} onError={() => setBroken(true)} />
      ) : (
        <div className="gt-image-alt" data-testid="image-fallback">
          {part.alt ?? '（无缓存图片）'}
        </div>
      )}
      <div className="gt-image-src">
        来源：
        {/* M4 只展示来源，不导航（打开方式 M5 再议） */}
        <a
          href={part.sourceUrl}
          onClick={(e) => e.preventDefault()}
          title={part.sourceUrl}
          rel="noreferrer"
        >
          {sourceLabel}
        </a>
        {showImg ? null : <span className="gt-image-note">（本地无缓存，不加载网络图）</span>}
      </div>
    </div>
  )
}
