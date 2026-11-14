import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')

/** 取一条完整规则块（选择器到 }），便于逐条断言而不受全文其它规则干扰。 */
function ruleBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped}\\{[^}]*\\}`))
  expect(match, `rule ${selector} should exist`).toBeTruthy()
  return match![0]
}

describe('D202/D205 退出层交叉淡化 CSS', () => {
  it('D206：页面旧层不透明垫底不淡出，新页整层带底淡入；view 旧层整层淡出', () => {
    const exitPage = ruleBlock('.gt-motion-page[data-motion-state=exiting]')
    expect(exitPage).toContain('background:var(--bg)')
    expect(exitPage).not.toContain('animation')
    const enterPage = ruleBlock('.gt-motion-page[data-motion-state=entering]')
    expect(enterPage).toContain('background:var(--bg)')
    expect(enterPage).toContain('animation:gt-fade-in var(--motion-base) var(--ease) both')
    expect(enterPage).toContain('z-index:56')
    const exitView = ruleBlock('.gt-motion-view[data-motion-state=exiting]')
    expect(exitView).toContain('background:var(--side)')
    expect(exitView).toContain('animation:gt-fade-out var(--motion-fast) var(--ease) forwards')
    expect(css).not.toContain('.gt-motion-page[data-motion-state=exiting]>*')
    expect(css).toContain('@keyframes gt-fade-out')
  })

  it('退出层仍绝对定位不占布局、不截获点击（无布局跳动、无点到旧层）', () => {
    for (const kind of ['page', 'view']) {
      const block = ruleBlock(`.gt-motion-${kind}[data-motion-state=exiting]`)
      expect(block).toContain('position:absolute')
      expect(block).toContain('inset:0')
      expect(block).toContain('pointer-events:none')
    }
  })

  it('时长 / 缓动沿用 D200 令牌，动效开关仍瞬时', () => {
    expect(css).toContain('--motion-fast:120ms')
    expect(css).toContain('--motion-base:200ms')
    expect(css).toContain('--ease:cubic-bezier(.2,0,0,1)')
    expect(css).toContain('html[data-motion=off]')
  })
})
