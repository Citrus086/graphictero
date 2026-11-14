import { describe, expect, it } from 'vitest'
import { stripInlineImages } from './stripInlineImages'

describe('stripInlineImages（D141）', () => {
  it('≥2MB 的 base64 被换成短占位，且一次扫完（无回溯）', () => {
    const blob = 'A'.repeat(2 * 1024 * 1024)
    const input = `前文\n![示意图 甲](data:image/png;base64,${blob})\n后文`
    const started = Date.now()
    const out = stripInlineImages(input)
    const elapsed = Date.now() - started
    expect(out).toBe('前文\n[图：示意图 甲]\n后文')
    expect(out.length).toBeLessThan(100)
    expect(out).not.toContain('base64,')
    expect(elapsed).toBeLessThan(1000)
  })

  it('空 alt、空白 alt、HTML img 单双引号和其它属性', () => {
    expect(stripInlineImages('![](data:image/jpeg;base64,QQ==)')).toBe('[图]')
    expect(stripInlineImages('![   ](data:image/gif;base64,QQ==)')).toBe('[图]')
    expect(stripInlineImages('![中文 图](data:image/svg+xml;base64,QQ== "标题")')).toBe('[图：中文 图]')
    expect(stripInlineImages('<img src="data:image/png;base64,QQ==" alt="示意图">')).toBe('[图：示意图]')
    expect(stripInlineImages("<img alt='示意图' width=12 src='data:image/png;base64,QQ==' />")).toBe('[图：示意图]')
    expect(stripInlineImages('<IMG SRC="data:image/webp;base64,QQ==">')).toBe('[图]')
    expect(stripInlineImages('<img src="data:image/png;base64,QQ==" alt="  ">')).toBe('[图]')
  })

  it('普通图片、普通链接、https 图片、以及不是图片语法的 data:image 保持原样', () => {
    const src = [
      '![x](images/abc.jpg)',
      '<img src="images/a.png" alt="本地">',
      '![远程](https://example.com/a.png)',
      '[t](https://example.com)',
      '正文里出现 data:image 但不是图片语法',
      '代码 `data:image/png;base64,QQ==` 不是图片标记'
    ].join('\n')
    expect(stripInlineImages(src)).toBe(src)
  })
})
