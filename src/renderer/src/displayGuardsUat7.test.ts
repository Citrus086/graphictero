import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const rendererRoot = join(root, 'src/renderer/src')
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}
function read(relative: string): string {
  return readFileSync(join(root, relative), 'utf8')
}

describe('D178 设置外无金额静态守卫', () => {
  it('renderer 非测试源码的 ¥ / formatCny 只许在设置用量模块', () => {
    const allowed = (path: string): boolean =>
      path.endsWith(join('pages', 'SettingsPage.tsx')) || path.includes(join('components', 'settings', 'usage')) || path.includes(join('components', 'settings', 'Usage'))
    const violations = sourceFiles(rendererRoot).flatMap((path) => {
      if (allowed(path)) return []
      const text = readFileSync(path, 'utf8')
      return text.includes('¥') || text.includes('formatCny(') ? [path.slice(root.length + 1)] : []
    })
    expect(violations).toEqual([])
  })
})

describe('D177 + 弹层 CSS 守卫', () => {
  it('弹层在 composer 内左右各 12px，无横向滚动，标题单行省略', () => {
    const css = read('src/renderer/src/components/chat/chat.css')
    const menu = css.match(/\.gt-at-menu\{([^}]*)\}/)?.[1] ?? ''
    expect(menu).toContain('left:12px')
    expect(menu).toContain('right:12px')
    expect(menu).toContain('min-width:0')
    expect(menu).toContain('overflow-x:hidden')
    const title = css.match(/\.gt-at-menu \.gt-sess-item-name\{([^}]*)\}/)?.[1] ?? ''
    expect(title).toContain('min-width:0')
    expect(title).toContain('text-overflow:ellipsis')
    expect(title).toContain('white-space:nowrap')
  })
})

describe('uat7b S6(a) 渲染层不引用主进程模块', () => {
  it('renderer 非测试源码不新增 src/main 的相对路径 import（允许清单按文件钉死）', () => {
    // uat7b S6(a) 修的正是这类引用里带副作用模块（main/llm/usage 牵 sqlite）。
    // 以下两个文件引用的是评审过的纯函数模块（可安全 tree-shake），历史遗留、迁去
    // shared 留给后续重构批——按文件钉死：新文件 import 任何 main/ 路径、或这两个文件
    // 新增别的 main/ 引用，一律进 violations。
    const legacyPureByFile: Record<string, string[]> = {
      'src/renderer/src/components/export/ExportDialog.tsx': ['main/relations/context', 'main/llm/pricing'],
      'src/renderer/src/lib/shortIds.ts': ['main/text/internalRefs']
    }
    const violations = sourceFiles(rendererRoot).flatMap((path) => {
      const rel = path.slice(root.length + 1)
      const text = readFileSync(path, 'utf8')
      const matches = text.match(/from\s+['"](\.[^'"]*\/)+main\/[^'"]+['"]/g) ?? []
      const allowed = legacyPureByFile[rel] ?? []
      const bad = matches.filter((m) => !allowed.some((ok) => m.includes(ok)))
      return bad.length > 0 ? [`${rel} → ${bad.join(' ')}`] : []
    })
    expect(violations).toEqual([])
  })
})

describe('D179 画布右键入口守卫', () => {
  it('从库删除只在侧栏 library 菜单分支，批量移除与共享边去重存在', () => {
    const source = read('src/renderer/src/pages/GraphPage.tsx')
    expect(source.match(/从库删除…/g)).toHaveLength(1)
    expect(source).toContain("menu.kind === 'library' && (")
    expect(source).toContain("menu.kind === 'selection' ? `从图谱移除所选 ${menu.papers.length} 篇`")
    expect(source).toContain('removalRelationSnapshots(detail.relations, ids)')
    expect(source).toContain('undoStack.current.push({\n      label,')
  })
})
