import { describe, expect, it } from 'vitest'
import { shortCiteTitle, replaceInternalRefTokens, citePaper } from './internalRefs'

/**
 * uat6 S2：短标题按词边界截断 + 《》后空格收紧。
 * 口径：连字符 / 冒号（含全角）/ 空格为优先断点，取 ≤14 的最长断点前缀；
 * 无合格断点才硬切（单超长英文词）；纯中文逐字可断。UAT 例：
 * 《BrowseComp-Plu…》（14 字硬切）→《BrowseComp…》（词边界）。
 */

describe('shortCiteTitle（uat6 S2 词边界截断）', () => {
  it('连字符+冒号标题（BrowseComp-Plus）：取最靠近上限的断点 → BrowseComp-Plus…（不超 max+5 容差）', () => {
    expect(shortCiteTitle('BrowseComp-Plus: A More Fair and Transparent Evaluation')).toBe('BrowseComp-Plus…')
  })

  it('空格断点：取不超过上限的最长前缀（When Is Enough 恰 14 字）', () => {
    expect(shortCiteTitle('When Is Enough: Illusory Completion in Search')).toBe('When Is Enough…')
  })

  it('中文冒号断点（全角）', () => {
    expect(shortCiteTitle('当缺席成为证据：评估检索完备性的方法研究')).toBe('当缺席成为证据…')
  })

  it('纯中文无标点：逐字截断到 14 字（与既有 14 字口径一致）', () => {
    expect(shortCiteTitle('一篇标题特别长长到超过十四个汉字的研究论文题名示例')).toBe('一篇标题特别长长到超过十四个…')
  })

  it('短于上限不截断', () => {
    expect(shortCiteTitle('SeaKR: Agent')).toBe('SeaKR: Agent')
    expect(shortCiteTitle('短')).toBe('短')
  })

  it('单个超长英文词（无断点）：退回硬切', () => {
    expect(shortCiteTitle('Supercalifragilisticexpialidocious')).toBe('Supercalifragi…')
  })

  it('恰好顶到上限的断点前缀若尾随分隔符（冒号）则去掉', () => {
    expect(shortCiteTitle('abcdefghijklm: rest of title')).toBe('abcdefghijklm…')
  })

  it('连续空白先压成单空格再截断（不在空白处留半句）', () => {
    expect(shortCiteTitle('Adaptive   Stopping for Multi-Turn')).toBe('Adaptive Stopping…')
  })
})

describe('replaceInternalRefTokens（uat6 S2：右书名号后空格收紧；uat6c S4：左侧同口径）', () => {
  it('《短标题》替换记号后原文空格残留 →「》 的」收紧为「》的」', () => {
    const out = replaceInternalRefTokens('改进了 P01 的停止规则。', () => '《甲之研究》')
    expect(out).toBe('改进了《甲之研究》的停止规则。')
  })

  it('uat6c S4：中文与《之间的空格同样收紧（「与 《甲》」→「与《甲》」），不再出现 CJK+空格+《', () => {
    const out = replaceInternalRefTokens('P01 与 P02 都主张终答案指标会掩盖过程性缺陷。', (t) => (t === 'P01' ? '《SGR-Bench…》' : '《Do LLM Agents…》'))
    expect(out).toBe('《SGR-Bench…》与《Do LLM Agents…》都主张终答案指标会掩盖过程性缺陷。')
    expect(out).not.toMatch(/[\u3400-\u9fff] 《/)
  })

  it('uat6c-fix1 S3：围栏代码块与行内代码里的空白规则不生效（代码排版不被破坏）', () => {
    const resolve = (t: string): string | null => (t === 'P01' ? '《甲》' : null)
    // 围栏代码块内的「》 的」与连续空格原样保留
    const fenced = replaceInternalRefTokens('改进了 P01。\n```\n甲 的  乙 》 的\n```\n与 P01 对比。', resolve)
    expect(fenced).toContain('```\n甲 的  乙 》 的\n```')
    expect(fenced).toContain('改进了《甲》。')
    expect(fenced).toContain('与《甲》对比。')
    // 行内代码内的空格原样保留，代码外照常收紧
    const inline = replaceInternalRefTokens('用 `甲 的  乙` 与 P01 对比  差异。', resolve)
    expect(inline).toContain('`甲 的  乙`')
    expect(inline).toContain('与《甲》对比 差异。')
  })

  it('英文 / 数字紧跟《》的空格保留（只收紧中文侧）', () => {
    const out = replaceInternalRefTokens('见 P01 et al.', () => '《甲》')
    expect(out).toBe('见《甲》 et al.')
  })
})

describe('citePaper（经 shortCiteTitle 词边界口径）', () => {
  it('长标题给《词边界截断》，无标题退「作者, 年份」', () => {
    expect(citePaper({ title: 'BrowseComp-Plus: A More Fair and Transparent Evaluation' })).toBe('《BrowseComp-Plus…》')
    expect(citePaper({ title: null, firstAuthor: 'Yao', year: 2024 })).toBe('Yao, 2024')
  })
})
