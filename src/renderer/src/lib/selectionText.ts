/**
 * uat3b 必须修 3 + uat5 建议修 8.2：阅读器选区文本约束。
 *
 * 根因：文字层 span 是绝对定位 + DOM 顺序 ≠ 视觉顺序（双栏论文、旋转戳记），
 * `window.getSelection().toString()` 按 DOM 顺序取文本——划选 3 行会穿过 DOM 上
 * 夹在中间的整栏文字（UAT：选 3 行发出约 4.5k 字整页）。浏览器画出的选区高亮矩形
 * （range.getClientRects()）才是「用户实际划过」的 ground truth。
 *
 * 做法：span 的包围盒与选区矩形求交——
 * - 纵向覆盖 <50%：视为擦到行边，不计入；
 * - 纵向 ≥50% 且横向 ≥95%：整行计入；
 * - 纵向 ≥50% 但横向部分覆盖（半行选中，uat5 建议修 8.2）：按字符裁剪——
 *   覆盖左缘取前 n 字、覆盖右缘取后 n 字、两侧都不到缘取中间 n 字
 *   （n = round(字数 × 横向覆盖比)），不再整个 span 收进来；
 * 计入的 span 按视觉行聚类（top 容差 4px 聚行、行内按 left、行按 top）拼文本。跨行交给
 * cleanReaderText 补空格/断词（与 uat3 第 6 条同一清洗出口）。
 *
 * 回退（无选区矩形 / 无 span 命中）受限：range.toString() 超过 500 字一律放弃
 * （uat5 建议修 8.2：几何失败时不再回退出整页文字）。
 */

interface PickedSpan {
  top: number
  left: number
  text: string
}

/** 回退上限：几何不可用时 toString() 超过该长度视为整页泄漏，放弃 */
const FALLBACK_MAX_CHARS = 500

function limitedFallback(range: Range): string {
  const t = range.toString()
  return t.length <= FALLBACK_MAX_CHARS ? t : ''
}

/** 按视觉行聚类拼文本：行内左→右，行上→下 */
function joinVisualLines(picked: PickedSpan[]): string {
  const sorted = [...picked].sort((a, b) => a.top - b.top || a.left - b.left)
  const lines: PickedSpan[][] = []
  for (const p of sorted) {
    const line = lines.find((l) => Math.abs(l[0].top - p.top) <= 4)
    if (line) line.push(p)
    else lines.push([p])
  }
  return lines
    .map((l) => [...l].sort((a, b) => a.left - b.left).map((s) => s.text).join(''))
    .join('\n')
}

/** 横向部分覆盖时按字符裁剪（n = round(字数 × 横向覆盖比)，至少 1 字） */
function clipSpanText(text: string, r: DOMRect, selRects: DOMRect[]): string | null {
  let interW = 0
  let coveredLeft = false
  let coveredRight = false
  for (const s of selRects) {
    const l = Math.max(r.left, s.left)
    const rt = Math.min(r.right, s.right)
    if (rt > l) {
      interW += rt - l
      if (s.left <= r.left + 1) coveredLeft = true
      if (s.right >= r.right - 1) coveredRight = true
    }
  }
  if (interW <= 0 || r.width <= 0) return null
  const f = Math.min(1, interW / r.width)
  if (f >= 0.95) return text
  const n = Math.max(1, Math.round(text.length * f))
  if (coveredLeft && !coveredRight) return text.slice(0, n)
  if (coveredRight && !coveredLeft) return text.slice(text.length - n)
  const start = Math.max(0, Math.floor((text.length - n) / 2))
  return text.slice(start, start + n)
}

/** 选区在文字层内实际划过的文本（视觉顺序），交给 cleanReaderText 清洗后做引文/复制。 */
export function selectionTextWithin(container: HTMLElement, range: Range): string {
  const selRects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0)
  if (selRects.length === 0) return limitedFallback(range)
  const picked: PickedSpan[] = []
  for (const span of Array.from(container.querySelectorAll('span'))) {
    const r = span.getBoundingClientRect()
    const area = r.width * r.height
    if (area <= 0) continue
    let inter = 0
    let interH = 0
    for (const s of selRects) {
      const w = Math.min(r.right, s.right) - Math.max(r.left, s.left)
      const h = Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top)
      if (w > 0 && h > 0) {
        inter += w * h
        interH = Math.max(interH, h)
      }
    }
    if (interH / r.height < 0.5) continue // 只擦到行边，不计入
    const text = span.textContent ?? ''
    // 整行或半行都经字符裁剪：横向全覆盖原样返回，部分覆盖按字数比例裁
    const clipped = clipSpanText(text, r, selRects)
    if (clipped) picked.push({ top: r.top, left: r.left, text: clipped })
  }
  if (picked.length === 0) return limitedFallback(range)
  return joinVisualLines(picked)
}
