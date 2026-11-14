import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import type { TextPart } from '../../../../shared/parts'
import { remarkCjkBold } from './cjkBold'

/**
 * M4 lane/render：text 块（D19）。
 *
 * - Markdown（含 GFM 表格）+ LaTeX 公式（行内 $...$ / 块 $$...$$，KaTeX 渲染）
 * - 安全：不挂 rehype-raw，原始 HTML 不会被透传（react-markdown 默认跳过 html 节点）；
 *   链接协议走 react-markdown 默认 urlTransform（禁 javascript: 等）。
 * - uat2：CJK 友好粗体——`**（图3）**说明` 这类粗体内容紧贴全角标点的写法，
 *   CommonMark 定界规则会留下裸 `**`；remarkCjkBold 在 mdast 层补转 strong
 *   （只在含 CJK 的 text 节点里做，英文/行内代码零影响，见 cjkBold.ts）。
 * - 外链防导航（评审必 1）：正文链接保留 href/title 展示与可访问性，点击 preventDefault
 *   阻止站内导航（M4 纯禁跳，不打开外链、不调 shell）；与 ImageBlock 来源链接同口径。
 *   全应用仅此一处可点链接面，主进程暂无 will-navigate 拦截，若未来要真打开外链统一走
 *   shell.openExternal 白名单（维护者级）。
 */
export function TextBlock({ part }: { part: TextPart }): React.JSX.Element {
  return (
    <div className="gt-part-text" data-testid="part-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkCjkBold as never]}
        rehypePlugins={[rehypeKatex]}
        components={{
          // uat5 建议修 6：Markdown 表格包一层横向滚动容器，宽表不撑破抽屉
          table({ children }) {
            return (
              <div className="gt-md-tablewrap" data-testid="md-table-wrap">
                <table>{children}</table>
              </div>
            )
          },
          a({ href, title, children }) {
            return (
              <a
                href={href}
                title={title ?? href}
                onClick={(e) => e.preventDefault()}
              >
                {children}
              </a>
            )
          }
        }}
      >
        {part.text}
      </ReactMarkdown>
    </div>
  )
}
