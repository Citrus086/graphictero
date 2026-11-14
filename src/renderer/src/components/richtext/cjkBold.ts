/**
 * uat2：CJK 友好的粗体后处理（remark 插件）。
 *
 * CommonMark 定界规则对 CJK 标点不友好：粗体内容以全角标点收尾、后面紧挨
 * 中文字符时（如 `**（图3）**说明`、`见**（a）**所示`），收尾 `**` 被判非法
 * 定界符，`**` 原样露出。本插件在 mdast 上扫描 text 节点里的残留 `**...**`
 * 并转成 strong 节点。
 *
 * 保守边界（写进进度文档）：
 * - 只在含 CJK 字符（含全角标点区）的 text 节点里做转换——英文场景零影响；
 * - 行内代码是 inlineCode 节点不是 text，天然不受影响；
 * - 空内容（`** **`，trim 后为空）不转；
 * - 已在 CommonMark 里正常解析的粗体不会留下残留 `**`，插件不触碰。
 *
 * 不新增依赖：最小结构类型代替 @types/mdast（pnpm 下它只是传递依赖）。
 */

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
}

/** CJK 表意区 + CJK 标点 + 全角字符区（粗体紧邻全角标点的场景判定） */
const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F\u2000-\u206F\u2010-\u2027]/
const BOLD_RE = /\*\*([^*]+)\*\*/g

function convertTextChildren(parent: MdNode): void {
  const children = parent.children
  if (!children) return
  const out: MdNode[] = []
  let changed = false
  for (const child of children) {
    if (child.type === 'text' && typeof child.value === 'string' && child.value.includes('**') && CJK_RE.test(child.value)) {
      const parts: MdNode[] = []
      let last = 0
      let hit = false
      BOLD_RE.lastIndex = 0
      for (let m = BOLD_RE.exec(child.value); m !== null; m = BOLD_RE.exec(child.value)) {
        if (m[1].trim() === '') continue // 空粗体不转
        hit = true
        if (m.index > last) parts.push({ type: 'text', value: child.value.slice(last, m.index) })
        parts.push({ type: 'strong', children: [{ type: 'text', value: m[1] }] })
        last = m.index + m[0].length
      }
      if (hit) {
        changed = true
        if (last < child.value.length) parts.push({ type: 'text', value: child.value.slice(last) })
        out.push(...parts)
        continue
      }
    }
    out.push(child)
  }
  if (changed) parent.children = out
  for (const child of out) convertTextChildren(child) // 递归（paragraph/heading/list/blockquote 等容器）
}

/** remark 插件：把 text 节点里残留的 CJK 场景 `**...**` 转成 strong */
export function remarkCjkBold(): (tree: MdNode) => void {
  return (tree) => convertTextChildren(tree)
}
