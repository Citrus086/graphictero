import { describe, expect, it } from 'vitest'
import type { PdfTextRectObject } from '@embedpdf/models'
import { clipRectContent, textSpanStyle } from './readerTextLayer'

/**
 * 文字层 span 校正（uat3 必须修 3）：构造文本矩形 fixture（含旋转戳记、宽度不符），不触引擎。
 */

function rect(x: number, y: number, w: number, h: number): PdfTextRectObject['rect'] {
  return { origin: { x, y }, size: { width: w, height: h } } as PdfTextRectObject['rect']
}

function item(content: string, r: PdfTextRectObject['rect'], fontSize = 10): PdfTextRectObject {
  return { content, rect: r, font: { family: 'F', size: fontSize } } as PdfTextRectObject
}

describe('textSpanStyle（文字层 span 尺寸/变换校正）', () => {
  it('正常横向文本：按 rect 铺、不做变换', () => {
    const s = textSpanStyle(item('Hello world', rect(10, 20, 60, 12)), 2)
    expect(s).toEqual({ left: 20, top: 40, width: 120, height: 24, fontSize: 20 })
    expect(s.transform).toBeUndefined()
  })

  it('宽度与字形估算偏差 >15% 时 scaleX 贴合 rect（rect 偏窄 → 压缩）', () => {
    // 40 个字符估算 40*10*0.5=200pt 宽，rect 只有 100 → 压缩 scaleX(0.5)
    const s = textSpanStyle(item('a'.repeat(40), rect(0, 0, 100, 12)), 1)
    expect(s.transform).toBe('scaleX(0.5)')
    expect(s.width).toBe(200) // span 按自然排版宽，再缩放到 rect 宽
  })

  it('rect 偏宽 → 拉伸 scaleX；夹紧范围 [0.5, 2]', () => {
    const wide = textSpanStyle(item('ab', rect(0, 0, 60, 12)), 1) // 估 10，rect 60 → 夹到 2
    expect(wide.transform).toBe('scaleX(2)')
    const tiny = textSpanStyle(item('a'.repeat(100), rect(0, 0, 10, 12)), 1) // 估 500 → 夹到 0.5
    expect(tiny.transform).toBe('scaleX(0.5)')
  })

  it('宽度偏差 ≤15% 不校正（避免正常文本被拉伸）', () => {
    const s = textSpanStyle(item('abcdefghij', rect(0, 0, 52, 12)), 1) // 估 50 vs 52，偏差 4%
    expect(s.transform).toBeUndefined()
    expect(s.width).toBe(52)
  })

  it('旋转戳记（rect 高 > 宽×1.5）：沿长边排版 + rotate(90deg)，不横向溢出', () => {
    const s = textSpanStyle(item('arXiv:2501.00001v2', rect(8, 100, 10, 700), 9), 1)
    expect(s.transform).toBe('rotate(90deg)')
    expect(s.width).toBe(700) // 沿原 rect 的高（长边）排版
    expect(s.left).toBe(8)
    expect(s.top).toBe(100)
  })

  it('scale 放大时所有尺寸同步放大', () => {
    const s = textSpanStyle(item('Hello world', rect(10, 10, 60, 12)), 2) // 估 110 vs 120，偏差 8% 不校正
    expect(s.left).toBe(20)
    expect(s.top).toBe(20)
    expect(s.width).toBe(120)
    expect(s.height).toBe(24)
    expect(s.fontSize).toBe(20)
  })

  it('uat5 建议修 1：短链接 span（长边排不下文本）不误转 90°', () => {
    // 角标式短链接：rect 10×16，4 个字符估 20px 沿长边也排不下 → 保持横向
    const s = textSpanStyle(item('[12]', rect(0, 0, 10, 16)), 1)
    expect(s.transform).not.toBe('rotate(90deg)')
  })

  it('uat5 建议修 1：真旋转戳记照旧 rotate(90deg)（长边容得下文本）', () => {
    const s = textSpanStyle(item('arXiv:2501.00001v2', rect(8, 100, 10, 700), 9), 1)
    expect(s.transform).toBe('rotate(90deg)')
  })
})

describe('clipRectContent（uat5 建议修 1：引擎越界多读的行尾乱码防御）', () => {
  it('估算超出矩形 2× 容纳量时裁到可容纳前缀（乱码不进文字层）', () => {
    // 'answerX'：rect 只能容 ~5.75 字（11.5/2），内容 7 字估 35px 超 2× → 裁
    const clipped = clipRectContent('answerX', 10, 10)
    expect(clipped.length).toBeLessThan('answerX'.length)
    expect('answerX'.startsWith(clipped)).toBe(true)
    // 裁后估算 ≤ 1.15× 矩形宽
    let est = 0
    for (const ch of clipped) est += (ch.codePointAt(0)! >= 0x2e80 ? 1 : 0.5) * 10
    expect(est).toBeLessThanOrEqual(10 * 1.15 + 10) // 末字容许半字出界
  })

  it('2× 以内不动：scaleX 吸收的窄矩形整行文本不误裁', () => {
    expect(clipRectContent('a'.repeat(40), 100, 10)).toBe('a'.repeat(40)) // 2× 边界内
    expect(clipRectContent('Hello world', 60, 10)).toBe('Hello world') // 正常行
  })

  it('CJK 按 1em 估算：中文行超 2× 同样裁，未超不动', () => {
    expect(clipRectContent('答'.repeat(10), 10, 10)).toBe('答') // 估 100 超 2× → 只容 1 字
    expect(clipRectContent('短句', 10, 10)).toBe('短句') // 估 20 = 2× 边界内
  })
})
