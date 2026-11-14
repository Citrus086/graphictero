import { describe, expect, it } from 'vitest'
import { cleanReaderText } from './readerText'

/**
 * 阅读器文本清洗（uat3 必须修 6）：构造短字符串 fixture，不触引擎/网络。
 */

describe('cleanReaderText（阅读器文本统一清洗出口）', () => {
  it('行尾连字符 = 断词，拼接且去掉连字符（exam- + ple → example）', () => {
    expect(cleanReaderText('We propose an exam-\nple of this.')).toBe('We propose an example of this.')
  })

  it('行内真连字符不误删（state-of-the-art 原样保留）', () => {
    expect(cleanReaderText('a state-of-the-art\nmethod')).toBe('a state-of-the-art method')
  })

  it('软连字符 \\u0002 / \\u00AD 删除（断词处 exam\\u0002 + ple → example）', () => {
    expect(cleanReaderText('exam\u0002\nple')).toBe('example')
    expect(cleanReaderText('exam\u00AD\nple')).toBe('example')
    expect(cleanReaderText('well-\u00ADknown')).toBe('well-known') // 行内软连字符直接去掉
  })

  it('控制字符 / 零宽字符 / 私用区 / 替换符清除', () => {
    expect(cleanReaderText('ab\u0001c\u0007d')).toBe('abcd')
    expect(cleanReaderText('a\u200Bb\uFEFFc')).toBe('abc')
    expect(cleanReaderText('ab\uF000c')).toBe('abc')
    expect(cleanReaderText('a�b')).toBe('ab')
    expect(cleanReaderText('a\tb')).toBe('a b') // \t 变空格
  })

  it('英文跨行补空格', () => {
    expect(cleanReaderText('Hello\nworld')).toBe('Hello world')
    expect(cleanReaderText('line one\nline two\nline three')).toBe('line one line two line three')
  })

  it('中文跨行不补空格；中英混排只在中英文边界补空格', () => {
    expect(cleanReaderText('第一章\n引言')).toBe('第一章引言')
    expect(cleanReaderText('我们提出\na new method')).toBe('我们提出 a new method')
    expect(cleanReaderText('a new method\n我们提出')).toBe('a new method 我们提出')
  })

  it('多行 + 断词 + 中英混排组合', () => {
    expect(cleanReaderText('我们提出 trans-\nformer 架构。\n下一节详述。')).toBe('我们提出 transformer 架构。下一节详述。')
  })

  it('空白折叠与首尾 trim', () => {
    expect(cleanReaderText('  a   b  \n\n  c ')).toBe('a b c')
  })

  it('空输入返回空串（不崩）', () => {
    expect(cleanReaderText('')).toBe('')
    expect(cleanReaderText('\n\n  \u0001 ')).toBe('')
  })
})
