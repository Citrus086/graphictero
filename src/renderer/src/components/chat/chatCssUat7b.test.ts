import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync(new URL('./chat.css', import.meta.url), 'utf8')

function declarations(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*')
  const body = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(CSS)?.[1]
  expect(body, `缺少 CSS 规则：${selector}`).toBeDefined()
  return Object.fromEntries(
    body!.split(';').filter(Boolean).map((entry) => {
      const colon = entry.indexOf(':')
      return [entry.slice(0, colon).trim(), entry.slice(colon + 1).trim()]
    })
  )
}

describe('uat7b D184-② 子图里选中描边始终可见（CSS 静态守卫）', () => {
  it('子图高亮节点的 .pnode.sel 强调色圈不被 xyflow 包装层重置掉', () => {
    expect(declarations('.react-flow__node.gt-sub-hi .pnode.sel')).toMatchObject({
      'box-shadow': '0 0 0 2px var(--accent),0 2px 8px rgba(47,111,235,.12)'
    })
  })

  it('暗化节点/边维持不可交互兜底（M1：handler 守卫之外的第二道防线）', () => {
    expect(declarations('.react-flow__node.gt-sub-dim')).toMatchObject({ 'pointer-events': 'none' })
    expect(declarations('.react-flow__edge.gt-sub-dim')).toMatchObject({ 'pointer-events': 'none' })
  })
})
