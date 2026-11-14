import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')

describe('D200 motion CSS', () => {
  it('共享时长 / 缓动，reduced-motion 与 data-motion=off 都瞬时', () => {
    expect(css).toContain('--motion-fast:120ms')
    expect(css).toContain('--motion-base:200ms')
    expect(css).toContain('--ease:cubic-bezier(.2,0,0,1)')
    expect(css).toContain('@media (prefers-reduced-motion:reduce)')
    expect(css).toContain('html[data-motion=off]')
    expect(css).toContain('animation:none!important;transition:none!important')
  })

  it('popover / drawer / modal / page 均有进入与退出状态，退出不截获点击', () => {
    for (const kind of ['pop', 'drawer', 'modal', 'page', 'view']) {
      expect(css).toContain(`.gt-motion-${kind}[data-motion-state=entering]`)
      expect(css).toContain(`.gt-motion-${kind}[data-motion-state=exiting]`)
    }
    expect(css).toContain('@keyframes gt-fade-out')
    expect(css).toContain('forwards;pointer-events:none')
  })

  it('节点 enter/exit 与按钮行卡过渡复用令牌，不做 transition:all', () => {
    expect(css).toContain('.react-flow__node.gt-node-enter .pnode')
    expect(css).toContain('.react-flow__node.gt-node-exit .pnode')
    expect(css).toContain('.btn:active:not(:disabled)')
    expect(css).toContain('background-color var(--motion-fast) var(--ease)')
    expect(css).not.toContain('transition:all')
  })
})
