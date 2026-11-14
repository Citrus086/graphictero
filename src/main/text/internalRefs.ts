import type Database from 'better-sqlite3'

/**
 * D150：内部编号（P01 / NEW / #25）换成短标题或作者+年份。
 * resolve 返回 null 时剔除记号。P/NEW 与 #N 的映射由调用方决定
 * （关系生成的 NEW 与候选的图内短 id 不是同一张表）。
 */

const TOKEN = /\b(?:P\d{1,3}|NEW)\b|#(\d{1,9})\b/g

/**
 * uat6 S2：超过 max 个字符时**按词边界截断**并加省略号——优先断点是连字符、
 * 冒号（含全角）、空格（连续空白先压成单空格）；取不超过 max+5（容差，完成正跨过
 * 上限的那个词）的最长断点前缀，保证不出现「半个单词 + 省略号」
 * （UAT：《BrowseComp-Plu…》→《BrowseComp-Plus…》；带空格长词组取到完整词
 * 《Beta Improvement…》）。断点前缀都超 max+5（单个超长英文词）才退回硬切
 * （ unavoidable，注释写明）。上限沿用 14（+5 容差）。
 */
export function shortCiteTitle(title: string, max = 14): string {
  const t = title.trim().replace(/\s+/g, ' ')
  if (!t) return ''
  if (t.length <= max) return t
  const BREAK_RE = /[-–—:：\s]/g
  let best = -1
  let bestDist = Infinity
  let m: RegExpExecArray | null
  while ((m = BREAK_RE.exec(t)) !== null) {
    const len = m.index
    if (len > max + 5) break // 断点已超容差，后面更长，不必再看
    if (len === 0) continue
    const dist = Math.abs(len - max)
    if (dist < bestDist || (dist === bestDist && len > best)) {
      best = len
      bestDist = dist
    }
  }
  // 整词落在容差内（标题结束也是候选断点）→ 取全词
  if (t.length <= max + 5) {
    const dist = Math.abs(t.length - max)
    if (dist < bestDist) best = t.length
  }
  // 断点前缀去掉尾随分隔符；无合格断点（如单个超长英文词）退回硬切
  const cut = (best >= 0 ? t.slice(0, best) : t.slice(0, max)).replace(/[-–—:：\s]+$/, '')
  return `${cut || t.slice(0, max)}…`
}

/** 有标题用《短标题》；否则「作者, 年份」（缺一则只留有的那半）。都没有返回 null。 */
export function citePaper(paper: {
  title?: string | null
  firstAuthor?: string | null
  year?: number | null
}): string | null {
  const title = paper.title?.trim() ?? ''
  if (title) {
    const short = shortCiteTitle(title)
    return short ? `《${short}》` : null
  }
  const author = paper.firstAuthor?.trim() ?? ''
  const year = paper.year != null && Number.isFinite(paper.year) ? String(paper.year) : ''
  if (author && year) return `${author}, ${year}`
  if (author) return author
  if (year) return year
  return null
}

/** 关系两端的引用：两边都有则「甲与乙」，否则留下有的那一边。 */
export function citePair(a: string | null, b: string | null): string | null {
  if (a && b) return `${a}与${b}`
  return a ?? b
}

/**
 * #N 的查找顺序：本图谱论文 > 本图谱活关系（两端短标题）> 论文库任意未删论文 > 剔除。
 * 论文 id 与关系 id 可能撞号，先认论文。
 */
export function resolveStoredIdToken(
  db: Database.Database,
  graphId: number,
  id: number,
  cite: (paperId: number) => string | null
): string | null {
  const member = db
    .prepare(
      `SELECT 1 AS ok FROM graph_members m
       JOIN papers p ON p.id = m.paper_id
       WHERE m.graph_id = ? AND p.id = ? AND p.deleted_at IS NULL`
    )
    .get(graphId, id) as { ok: number } | undefined
  if (member) return cite(id)
  const rel = db
    .prepare(
      'SELECT paper_low, paper_high FROM relations WHERE id = ? AND graph_id = ? AND deleted_at IS NULL'
    )
    .get(id, graphId) as { paper_low: number; paper_high: number } | undefined
  if (rel) return citePair(cite(rel.paper_low), cite(rel.paper_high))
  const any = db.prepare('SELECT 1 AS ok FROM papers WHERE id = ? AND deleted_at IS NULL').get(id) as
    | { ok: number }
    | undefined
  if (any) return cite(id)
  return null
}

/**
 * uat6c-fix1 S3：把空格规则（》/《 收紧、连续空格折叠）只作用于代码段之外——
 * 围栏代码块（``` ... ```）与行内代码（`...`）里的文本原样保留（替换记号仍先在
 * 全文中做，TOKEN 不会出现在代码语义里；此处只保护空白规则不破坏代码排版）。
 */
function mapOutsideCode(text: string, fn: (s: string) => string): string {
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((seg, i) => (i % 2 === 1 ? seg : fn(seg)))
    .join('')
}

/** 替换正文里的 P01 / NEW / #25。resolve 收到的记号是 `P01`、`NEW` 或 `#25`。 */
export function replaceInternalRefTokens(text: string, resolve: (token: string) => string | null): string {
  return mapOutsideCode(
    text.replace(TOKEN, (full, hashDigits: string | undefined) => {
      const token = hashDigits != null && hashDigits !== '' ? `#${hashDigits}` : full
      return resolve(token) ?? ''
    }),
    (seg) =>
      seg
        // uat6 S2：《短标题》替换记号后原文空格残留成「》 的」——右书名号后紧跟
        // 中文时收紧（面板 / 导出 / 小结 / 候选理由 / 工具返回同一出口）
        .replace(/》 (?=[\u3400-\u9fff])/g, '》')
        // uat6c S4：同口径收紧左侧——中文与《之间不加空格（「与 《Do LLM…》」→
        // 「与《Do LLM…》」）；英文 / 数字边界（如 "见 《甲》 et al." 中 》 后空格）不受影响
        .replace(/([\u3400-\u9fff]) (?=《)/g, '$1')
        .replace(/[ \t]{2,}/g, ' '),
  ).trim()
}
