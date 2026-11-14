// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import type { TextPart } from '../../../../shared/parts'
import { SourceBlock } from './SourceBlock'
import { TextBlock } from './TextBlock'
import { sanitizeChartOption } from './chartOption'
import { cacheAssetUrl } from './PartsHostContext'

afterEach(cleanup)

describe('TextBlock（Markdown + KaTeX + GFM 表格，不透传 HTML）', () => {
  it('GFM 表格渲染出 table 元素', () => {
    const part: TextPart = { type: 'text', text: '| a | b |\n|---|---|\n| 1 | 2 |' }
    const { container } = render(createElement(TextBlock, { part }))
    expect(container.querySelectorAll('table').length).toBe(1)
    expect(container.querySelector('table')!.textContent).toContain('1')
  })

  it('uat5 建议修 6：表格包一层横向滚动容器（宽表不撑破抽屉）', () => {
    const part: TextPart = { type: 'text', text: '| a | b |\n|---|---|\n| 1 | 2 |' }
    const { container } = render(createElement(TextBlock, { part }))
    const wrap = container.querySelector('[data-testid="md-table-wrap"]')
    expect(wrap).toBeTruthy()
    expect(wrap!.className).toContain('gt-md-tablewrap')
    expect(wrap!.querySelector('table')).toBeTruthy() // table 在容器内
  })

  it('行内 $...$ 与块 $$...$$ 渲染出 KaTeX 节点', () => {
    const part: TextPart = { type: 'text', text: '行内 $e^{i\\pi}+1=0$ 公式\n\n$$\\int_0^1 x dx$$\n' }
    const { container } = render(createElement(TextBlock, { part }))
    expect(container.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(2)
  })

  it('恶意原始 HTML 不透传（script/img onerror 不进入 DOM）', () => {
    const part: TextPart = {
      type: 'text',
      text: '正文<script>window.__xss=1</script><img src="x" onerror="window.__xss=2"><b>粗</b>'
    }
    const { container } = render(createElement(TextBlock, { part }))
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined()
  })

  it('http(s) 链接点击阻止站内导航：defaultPrevented=true，href 保留展示（评审必 1）', () => {
    const part: TextPart = { type: 'text', text: '[arXiv 原文](https://arxiv.org/abs/1234.5678)' }
    const { container } = render(createElement(TextBlock, { part }))
    const a = container.querySelector('a')!
    expect(a.getAttribute('href')).toBe('https://arxiv.org/abs/1234.5678')
    expect(a.getAttribute('title')).toBe('https://arxiv.org/abs/1234.5678')
    let ev: Event | null = null
    a.addEventListener('click', (e) => { ev = e })
    fireEvent.click(a)
    expect((ev as Event | null)!.defaultPrevented).toBe(true)
    // 不导航：地址不变（jsdom 地址仍是初始 about:blank-ish）
    expect(window.location.href).not.toContain('arxiv.org')
  })

  it('mailto 链接同样只展示不导航', () => {
    const part: TextPart = { type: 'text', text: '[邮件](mailto:a@b.c)' }
    const { container } = render(createElement(TextBlock, { part }))
    const a = container.querySelector('a')!
    expect(a.getAttribute('href')).toBe('mailto:a@b.c')
    fireEvent.click(a)
    expect(window.location.href).not.toContain('mailto:')
  })

  it('javascript: 链接被默认 urlTransform 拦截', () => {
    const part: TextPart = { type: 'text', text: '[点我](javascript:window.__xss=3)' }
    const { container } = render(createElement(TextBlock, { part }))
    const a = container.querySelector('a')
    expect(a).toBeTruthy()
    expect(a!.getAttribute('href')).not.toMatch(/^javascript:/i)
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined()
    fireEvent.click(a!)
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined()
  })

  it('uat2：粗体内容紧贴全角标点不露 `**`（`**（图3）**说明` / `见**（a）**所示`）', () => {
    for (const text of ['**（图3）**说明', '见**（a）**所示，结果提升明显', '前文**「核心模块」**后文', '**粗体**（注）', '（**粗体**）', '**粗体**，后文']) {
      const part: TextPart = { type: 'text', text }
      const { container, unmount } = render(createElement(TextBlock, { part }))
      expect(container.querySelector('[data-testid="part-text"]')!.textContent).not.toContain('**')
      const strong = container.querySelector('strong')
      expect(strong).toBeTruthy() // CJK 场景转出了 <strong>
      expect(strong!.textContent!.length).toBeGreaterThan(0)
      unmount()
    }
  })

  it('uat2：英文场景不回归（**bold** 与数学里的星号不被误处理）', () => {
    const part: TextPart = { type: 'text', text: 'English **bold** (note) stays, and 5 ** 3 math is untouched' }
    const { container } = render(createElement(TextBlock, { part }))
    const text = container.querySelector('[data-testid="part-text"]')!.textContent ?? ''
    expect(text).toContain('5 ** 3') // 纯英文节点的残留 ** 不做 CJK 转换
    expect(container.querySelector('strong')!.textContent).toBe('bold')
  })

  it('uat2：行内代码里的 `**` 不被处理', () => {
    const part: TextPart = { type: 'text', text: '行内 `**代码**` 保持原样，**真粗体**生效' }
    const { container } = render(createElement(TextBlock, { part }))
    const code = container.querySelector('code')!
    expect(code.textContent).toBe('**代码**')
    expect(container.querySelector('strong')!.textContent).toBe('真粗体')
  })
})

describe('SourceBlock（灰色引用行，可展开）', () => {
  it('默认收起显示来源行，点击展开引文', () => {
    const part = { type: 'source', section: '4.1 实验', quote: '引用原文内容' } as const
    const { container } = render(createElement(SourceBlock, { part }))
    expect(container.textContent).toContain('4.1 实验')
    expect(container.textContent).not.toContain('引用原文内容')
    fireEvent.click(container.querySelector('.gt-source-head')!)
    expect(container.textContent).toContain('引用原文内容')
  })
})

describe('chartOption 白名单校验（不 eval）', () => {
  it('合法 option 通过；undefined 字段按 JSON 语义丢弃', () => {
    const r = sanitizeChartOption({ title: { text: 't' }, series: [{ data: [1, 2] }], empty: undefined })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.option.title).toEqual({ text: 't' })
      expect('empty' in r.option).toBe(false)
    }
  })

  it('拒绝函数值 / 超长字符串 / 循环引用 / class 实例', () => {
    expect(sanitizeChartOption(() => 1).ok).toBe(false)
    expect(sanitizeChartOption({ s: 'x'.repeat(10_001) })).toEqual({ ok: false, reason: expect.stringContaining('超长') })
    const cyc: Record<string, unknown> = { a: 1 }
    cyc.self = cyc
    expect(sanitizeChartOption(cyc).ok).toBe(false)
    class Foo { bar = 1 }
    expect(sanitizeChartOption({ inst: new Foo() }).ok).toBe(false)
  })

  it('option 必须是对象', () => {
    expect(sanitizeChartOption([1, 2]).ok).toBe(false)
    expect(sanitizeChartOption('str').ok).toBe(false)
  })
})

describe('路径校验（防穿越，D115 gt-asset://）', () => {
  it('cacheAssetUrl 拒绝 .. / 绝对路径 / 反斜杠 / 空段 / 盘符', () => {
    expect(cacheAssetUrl('papers/1/mineru/images/a.png')).toBe('gt-asset://data/papers/1/mineru/images/a.png')
    expect(cacheAssetUrl('../secret')).toBeNull()
    expect(cacheAssetUrl('papers/../../secret')).toBeNull()
    expect(cacheAssetUrl('/etc/passwd')).toBeNull()
    expect(cacheAssetUrl('C:/x.png')).toBeNull()
    expect(cacheAssetUrl('a\\b')).toBeNull()
    expect(cacheAssetUrl('a//b')).toBeNull()
    expect(cacheAssetUrl('./a')).toBeNull()
    expect(cacheAssetUrl('')).toBeNull()
  })

  it('路径段百分号编码（评审建 2）：空格/#/?/%', () => {
    expect(cacheAssetUrl('papers/1/images/a b.png')).toBe('gt-asset://data/papers/1/images/a%20b.png')
    // 文件名含 # / ? / % 不编码会断成 fragment/query 或非法转义
    expect(cacheAssetUrl('papers/1/images/a#1?.png')).toBe('gt-asset://data/papers/1/images/a%231%3F.png')
    expect(cacheAssetUrl('papers/1/images/100%.png')).toBe('gt-asset://data/papers/1/images/100%25.png')
    // 编码不引入新斜杠、不破坏防穿越语义（%2F 只是文件名里的文本，不是分隔符）
    expect(cacheAssetUrl('a%2F..%2Fb')).toBe('gt-asset://data/a%252F..%252Fb')
  })

  it('URL 不含数据目录绝对路径（D115：数据目录不下发渲染层）', () => {
    const u = cacheAssetUrl('papers/1/a.png')!
    expect(u.startsWith('gt-asset://data/')).toBe(true)
    expect(u).not.toContain('file:')
  })
})
