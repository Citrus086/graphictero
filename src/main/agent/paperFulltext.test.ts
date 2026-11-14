import { describe, expect, it } from 'vitest'
import { collectFigureTableNos, fullMarkdownToc, locateInFullText, parseFullMarkdown, readFullSection } from './paperFulltext'

/**
 * readPaper 读 full.md 原文（uat3b 必须修 2）：自造短 Markdown fixture（含章节号/
 * 表号/图号），不提交任何论文全文。
 */

const FULL = `# 深度学习综述

## 1 引言
深度学习是表示学习。表 1 列出常用数据集。

## 2 方法
### 2.1 编码器
编码器结构如图 2 所示。The encoder maps input to latent space.

### 2.2 解码器
解码器结构如图 3 所示。

## 3 实验
Table 2 shows results. 表 3 是消融实验。

## 4 结论
完。
`

describe('parseFullMarkdown（原文切节，保留原文章节号）', () => {
  it('按标题切节；标题前引言作为首节；序号 1 起', () => {
    const secs = parseFullMarkdown(FULL)
    expect(secs.map((s) => s.title)).toEqual(['深度学习综述', '1 引言', '2 方法', '2.1 编码器', '2.2 解码器', '3 实验', '4 结论'])
    expect(secs[0].index).toBe(1)
    expect(secs[2].level).toBe(2)
  })
  it('坏输入不炸：空串返回空，无标题全文当一节', () => {
    expect(parseFullMarkdown('')).toEqual([])
    const one = parseFullMarkdown('只有一段话。')
    expect(one).toHaveLength(1)
    expect(one[0].title).toBe('引言')
  })
})

describe('collectFigureTableNos / fullMarkdownToc（图号表号按原文编号）', () => {
  it('图号/表号按出现顺序去重，保留原文写法', () => {
    const { figures, tables } = collectFigureTableNos(FULL)
    expect(figures).toEqual(['图 2', '图 3'])
    expect(tables).toContain('表 1')
    expect(tables).toContain('Table 2')
    expect(tables).toContain('表 3')
  })
  it('目录带章节树 + 图表号 + 总字数', () => {
    const toc = fullMarkdownToc(FULL)
    expect(toc.sections).toHaveLength(7)
    expect(toc.figures).toEqual(['图 2', '图 3'])
    expect(toc.totalChars).toBe(FULL.length)
  })
})

describe('readFullSection（长节分段返回）', () => {
  const long = `## 5 长节\n${'abcdefghij '.repeat(500)}\n`
  it('offset 分段：第一段 hasMore、nextOffset 续读、最后一段收尾', () => {
    const first = readFullSection(long, '5', 0, 1000)!
    expect(first.hasMore).toBe(true)
    expect(first.nextOffset).toBeGreaterThan(0)
    expect(first.text.endsWith('\n') || first.text.length <= 1000).toBe(true) // 断点回退到行尾
    const second = readFullSection(long, '5', first.nextOffset!, 1000)!
    expect(second.offset).toBe(first.nextOffset)
    expect(second.text.length).toBeGreaterThan(0)
    // 最终读到头
    let cur = first
    let guard = 0
    while (cur.hasMore && guard++ < 20) cur = readFullSection(long, '5', cur.nextOffset!, 1000)!
    expect(cur.hasMore).toBe(false)
  })
  it('序号与标题模糊匹配都能定位；无此节返回 null', () => {
    expect(readFullSection(FULL, '3')!.title).toBe('2 方法') // 序号 3 = 2 方法（1 起含书标题）
    expect(readFullSection(FULL, '4')!.title).toBe('2.1 编码器')
    expect(readFullSection(FULL, '编码器')!.title).toBe('2.1 编码器')
    expect(readFullSection(FULL, '不存在')).toBeNull()
  })
})

describe('locateInFullText（searchLibrary 命中定位）', () => {
  it('命中词 → 章节号 + 上下文片段 + 偏移', () => {
    const loc = locateInFullText(FULL, 'latent space')!
    expect(loc.section).toBe('2.1 编码器')
    expect(loc.snippet).toContain('latent space')
    expect(loc.offset).toBeGreaterThan(0)
  })
  it('未命中返回 null', () => {
    expect(locateInFullText(FULL, 'quantum gravity')).toBeNull()
  })
})
