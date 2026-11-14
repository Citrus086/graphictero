/**
 * 阅读器文本清洗（uat3 必须修 6）：引擎 getPageTextRects / 窗口划选取出的文本统一经
 * cleanReaderText 清洗后使用——高亮文本、标注列表显示、发给 agent 的引用、选区「复制」
 * 全部走这一个出口。
 *
 * 清洗规则：
 * 1. 软连字符：\u0002（pdfium 在断词处给出的软连字符）与 \u00AD（标准 soft hyphen）删除；
 * 2. 行尾连字符/软连字符拼接：上一行以连字符或软连字符（\u0002/\u00AD）结尾且两侧都是
 *    字母 → 断词，去掉连字符直接拼接（exam-¶ple、exam\u0002¶ple → example）；
 *    行内的真连字符（state-of-the-art）不受影响；
 * 3. 跨行补空格：英文（拉丁字母/数字）行间补一个空格；两侧都是 CJK 字符时不补；
 * 4. 去乱码：控制字符（除 \t\n）、零宽字符（\u200B \uFEFF）、私用区（\uE000–\uF8FF）、
 *    替换符 \uFFFD 一律删除；连续空白折叠成一个空格。
 */

/** CJK 统一表意文字（基本区 + 扩展A）——用于「中日韩行间不补空格」判断 */
const CJK = /[\u2E80-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/
const LETTER = /[A-Za-z\u00C0-\u024F]/
const GARBAGE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B\uFEFF\uFFFD\uE000-\uF8FF]/g
const SOFT_HYPHEN = /[\u0002\u00AD]/g

/** 单条文本矩形（一行）清洗：去软连字符/乱码，行首行尾空白去掉；保留行尾连字符供拼接判断 */
function cleanLine(raw: string): string {
  return raw.replace(SOFT_HYPHEN, '').replace(GARBAGE, '').replace(/[\t ]+/g, ' ').trim()
}

/**
 * 把（可能多行的）原始文本清洗成一段连续文本。
 * 行分隔只看 \n；\r 视为普通垃圾控制字符前的残留，随 trim 处理。
 */
export function cleanReaderText(raw: string): string {
  const raws = raw.replace(/\r\n?/g, '\n').split('\n')
  const lines = raws.map(cleanLine)
  let out = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === '') continue
    if (out === '') {
      out = line
      continue
    }
    const prev = out[out.length - 1]
    const next = line[0]
    // 行尾软连字符（\u0002/\u00AD）同样表示断词：exam\u0002 + ple → example
    const softBreak = /[\u0002\u00AD][\t ]*$/.test(raws[i - 1] ?? '')
    if (softBreak && LETTER.test(prev) && LETTER.test(next)) {
      out += line // 行尾软连字符已随 cleanLine 删除，直接拼接
    } else if (prev === '-' && LETTER.test(out[out.length - 2] ?? '') && LETTER.test(next)) {
      // 行尾连字符 = 断词：exam- + ple → example（行内真连字符不在行尾，不受影响）
      out = out.slice(0, -1) + line
    } else if (CJK.test(prev) && CJK.test(next)) {
      out += line // 中文跨行不补空格
    } else {
      out += ' ' + line
    }
  }
  return out.replace(/ {2,}/g, ' ').trim()
}

/**
 * 选区「复制」写剪贴板：优先 navigator.clipboard（Electron 渲染进程可用），
 * 不可用时退回 execCommand('copy')（隐藏 textarea 方案）。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 落到 execCommand 兜底 */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}
