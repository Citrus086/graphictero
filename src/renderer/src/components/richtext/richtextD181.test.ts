import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync(new URL('./richtext.css', import.meta.url), 'utf8')

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

describe('D181 富文本窄内容居中与宽表滚动（CSS 静态守卫）', () => {
  it('data-figure 图卡 / MinerU 表卡居中，卡内图片居中且图注左对齐', () => {
    expect(declarations('.gt-part-figure')).toMatchObject({ 'justify-content': 'center' })
    expect(declarations('.gt-figure-img')).toMatchObject({ 'align-self': 'center' })
    expect(declarations('.gt-figure-caption')).toMatchObject({ 'text-align': 'left' })
  })

  it('.gt-part-image 整体居中', () => {
    expect(declarations('.gt-part-image')).toMatchObject({ 'margin-left': 'auto', 'margin-right': 'auto' })
  })

  it('窄 Markdown 表居中，宽表仍由原 wrapper 横向滚动且不裁左缘', () => {
    // uat7b S6(b)：一条 margin:6px auto 声明（不靠源码顺序与 .gt-part-text table 对抗）
    expect(declarations('.gt-md-tablewrap table')).toMatchObject({ margin: '6px auto' })
    const wrapper = declarations('.gt-md-tablewrap')
    expect(wrapper).toMatchObject({ 'overflow-x': 'auto' })
    expect(wrapper).not.toHaveProperty('justify-content')
  })

  it('窄 Mermaid svg 居中，宽图仍由容器横向滚动', () => {
    expect(declarations('.gt-mermaid-svg svg')).toMatchObject({
      display: 'block',
      'margin-left': 'auto',
      'margin-right': 'auto'
    })
    expect(declarations('.gt-mermaid-svg')).toMatchObject({ 'overflow-x': 'auto' })
  })
})
