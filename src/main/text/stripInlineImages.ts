/**
 * D141：送进模型之前，把 MinerU markdown 里的内嵌 base64 图片换成短占位。
 * 磁盘上的 full.md 保持 MinerU 原样（阅读器可能要用 data URI）。
 * 只认 `data:image/`。扫描是单次前向的，base64 用排除型字符类，避免灾难回溯。
 */

function placeholder(alt: string): string {
  const trimmed = alt.trim()
  return trimmed.length > 0 ? `[图：${trimmed}]` : '[图]'
}

function startsWithFold(s: string, i: number, lit: string): boolean {
  if (i + lit.length > s.length) return false
  for (let k = 0; k < lit.length; k++) {
    const c = s.charCodeAt(i + k)
    const d = lit.charCodeAt(k)
    if (c === d) continue
    const lower = c >= 65 && c <= 90 ? c + 32 : c
    if (lower !== d) return false
  }
  return true
}

function isBase64Char(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 43 || // +
    code === 47 || // /
    code === 61 || // =
    code === 32 ||
    code === 9 ||
    code === 10 ||
    code === 13
  )
}

function isWs(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13
}

interface Span {
  text: string
  end: number
}

/** `![alt](data:image/<subtype>;base64,<data> "title")` → 占位。不匹配则 null。 */
function tryMarkdownImage(s: string, i: number): Span | null {
  if (s.charCodeAt(i) !== 33 || s.charCodeAt(i + 1) !== 91) return null
  let j = i + 2
  const altStart = j
  while (j < s.length) {
    if (s.charCodeAt(j) === 93 && s.charCodeAt(j + 1) === 40) break
    if (s.charCodeAt(j) === 10 || s.charCodeAt(j) === 13) return null
    j++
    if (j - altStart > 4000) return null
  }
  if (j >= s.length || s.charCodeAt(j) !== 93) return null
  const alt = s.slice(altStart, j)
  j += 2
  while (j < s.length && isWs(s.charCodeAt(j))) j++
  if (!startsWithFold(s, j, 'data:image/')) return null
  j += 'data:image/'.length
  const subStart = j
  while (j < s.length && s.charCodeAt(j) !== 59) {
    const code = s.charCodeAt(j)
    if (code === 41 || isWs(code)) return null
    j++
    if (j - subStart > 128) return null
  }
  if (!startsWithFold(s, j, ';base64,')) return null
  j += ';base64,'.length
  while (j < s.length && isBase64Char(s.charCodeAt(j))) j++
  let k = j
  while (k < s.length && isWs(s.charCodeAt(k))) k++
  const quote = s.charCodeAt(k)
  if (quote === 34 || quote === 39) {
    k++
    while (k < s.length && s.charCodeAt(k) !== quote) {
      if (s.charCodeAt(k) === 10 || s.charCodeAt(k) === 13) return null
      k++
    }
    if (s.charCodeAt(k) !== quote) return null
    k++
    while (k < s.length && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9)) k++
  }
  if (s.charCodeAt(k) !== 41) return null
  return { text: placeholder(alt), end: k + 1 }
}

function isNameChar(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 45 || code === 95 || code === 58
}

/** `<img ... src="data:image/...">`（引号、属性顺序、大小写、自闭合都不限）。 */
function tryHtmlImage(s: string, i: number): Span | null {
  if (s.charCodeAt(i) !== 60 || !startsWithFold(s, i + 1, 'img')) return null
  const boundary = s.charCodeAt(i + 4)
  if (boundary !== 0 && isNameChar(boundary) && !isWs(boundary) && boundary !== 47 && boundary !== 62) return null
  let j = i + 4
  let alt = ''
  let srcIsInline = false
  while (j < s.length && s.charCodeAt(j) !== 62) {
    const code = s.charCodeAt(j)
    if (isWs(code) || code === 47) {
      j++
      continue
    }
    const nameStart = j
    while (j < s.length && isNameChar(s.charCodeAt(j))) j++
    if (j === nameStart) return null
    const name = s.slice(nameStart, j).toLowerCase()
    while (j < s.length && isWs(s.charCodeAt(j))) j++
    if (s.charCodeAt(j) !== 61) continue
    j++
    while (j < s.length && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++
    let value = ''
    const q = s.charCodeAt(j)
    if (q === 34 || q === 39) {
      j++
      const vStart = j
      while (j < s.length && s.charCodeAt(j) !== q) j++
      if (j >= s.length || s.charCodeAt(j) !== q) return null
      value = s.slice(vStart, j)
      j++
    } else {
      const vStart = j
      while (j < s.length) {
        const c = s.charCodeAt(j)
        if (isWs(c) || c === 62 || c === 47) break
        j++
      }
      value = s.slice(vStart, j)
    }
    if (name === 'alt') alt = value
    else if (name === 'src') srcIsInline = startsWithFold(value, 0, 'data:image/')
  }
  if (j >= s.length || s.charCodeAt(j) !== 62 || !srcIsInline) return null
  return { text: placeholder(alt), end: j + 1 }
}

export function stripInlineImages(markdown: string): string {
  let out = ''
  let i = 0
  while (i < markdown.length) {
    const code = markdown.charCodeAt(i)
    if (code === 33) {
      const hit = tryMarkdownImage(markdown, i)
      if (hit) {
        out += hit.text
        i = hit.end
        continue
      }
    } else if (code === 60) {
      const hit = tryHtmlImage(markdown, i)
      if (hit) {
        out += hit.text
        i = hit.end
        continue
      }
    }
    out += markdown[i]
    i++
  }
  return out
}
