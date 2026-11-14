import type { PdfTextRectObject } from '@embedpdf/models'

/**
 * 文字层 span 尺寸/变换校正（uat3 必须修 3）：引擎文本矩形的 rect 是字形实际占位，
 * 直接用 rect 宽高 + font.size 铺 span 时，实际字形宽度与 rect 不符的片段（旋转的
 * arXiv 侧戳记等）会横向溢出盖住正文，划选/高亮变成整页。
 *
 * 校正策略（纯函数，fixture 可测）：
 * - 正常横向文本：按 rect 定位；估算字形宽（拉丁均宽 ≈ 0.5em）与 rect 宽偏差 >15% 时
 *   用 transform: scaleX 贴合 rect（span 仍按 font.size 排版，横向缩放到 rect 宽）；
 * - 旋转文本（rect 高明显大于宽，如 90° 侧戳记）：span 沿长边方向排版并 rotate(90deg)，
 *   宽度 = rect 高，保证文字沿旋转方向走、不横向溢出；
 * - 调用方在文字层容器与 span 上加 overflow: hidden 裁剪兜底。
 */

export interface TextSpanStyle {
  left: number
  top: number
  width: number
  height: number
  fontSize: number
  /** 组合 transform（transform-origin: left top），无校正需求时为 undefined */
  transform?: string
}

/** 拉丁均宽估算（em 的倍数） */
const CHAR_WIDTH_EM = 0.5
/** 宽偏差超过该比例才做 scaleX 校正（避免正常文本被轻微拉伸） */
const SCALE_TOLERANCE = 0.15
/** scaleX 夹紧范围 */
const SCALE_MIN = 0.5
const SCALE_MAX = 2
/** rect 高 > 宽 × 该倍数视为旋转/竖排文本 */
const ROTATED_RATIO = 1.5

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** 单字宽估算（em 倍数）：CJK/全角 1，拉丁/数字/空格 0.5（与 CHAR_WIDTH_EM 同口径） */
function charWidthEm(ch: string): number {
  const code = ch.codePointAt(0) ?? 0
  return code >= 0x2E80 ? 1 : CHAR_WIDTH_EM
}

/**
 * uat5 建议修 1：引擎 getPageTextRects 偶发越界多读——行尾多出每次渲染都不同的
 * 字符（测试者 复测「answerX」「Setupi」），乱码会漏进高亮与「发给 agent」引文。
 * 按矩形可容纳量防御性截断显示文本：估算全长超过矩形 2×（超出 scaleX 最大压缩
 * 2 倍的物理容纳量，不可能是字体度量误差）时裁到可容纳前缀；2× 以内不动——
 * 窄矩形整行文本（scaleX 吸收）与轻微度量误差不误裁。根因疑似引擎侧，复测仍现
 * 再下沉排查。
 */
export function clipRectContent(content: string, width: number, fontSize: number): string {
  if (!content || width <= 0 || fontSize <= 0) return content
  let acc = 0
  for (const ch of content) acc += charWidthEm(ch) * fontSize
  if (acc <= width * 2) return content
  let out = ''
  acc = 0
  for (const ch of content) {
    const cw = charWidthEm(ch) * fontSize
    if (out && acc + cw > width * 1.15) break
    acc += cw
    out += ch
  }
  return out
}

/**
 * 计算单个文本矩形对应的文字层 span 样式（单位：CSS px，已乘 scale）。
 */
export function textSpanStyle(it: PdfTextRectObject, scale: number): TextSpanStyle {
  const x = it.rect.origin.x * scale
  const y = it.rect.origin.y * scale
  const w = it.rect.size.width * scale
  const h = it.rect.size.height * scale
  const fontSize = it.font.size * scale
  const len = it.content.length

  // 旋转/竖排：沿长边（原 rect 的高）排版，旋转 90° 落回 rect 内。
  // uat5 建议修 1：加「文本沿长边排得下」守卫——短链接 span（如角标 [12]）rect 可能
  // 高>宽×1.5 但长边根本容不下这些字，旧判据会把它误转 90°。
  if (h > w * ROTATED_RATIO && len > 1 && h >= fontSize * CHAR_WIDTH_EM * len * 0.9) {
    return { left: x, top: y, width: h, height: Math.max(w, fontSize * 1.2), fontSize, transform: 'rotate(90deg)' }
  }

  // 横向文本：估算宽偏差大时 scaleX 贴合 rect
  const estimated = fontSize * CHAR_WIDTH_EM * len
  if (estimated > 0 && Math.abs(estimated - w) / Math.max(w, 1) > SCALE_TOLERANCE) {
    const s = clamp(w / estimated, SCALE_MIN, SCALE_MAX)
    return { left: x, top: y, width: estimated, height: h, fontSize, transform: `scaleX(${s})` }
  }

  return { left: x, top: y, width: w, height: h, fontSize }
}
