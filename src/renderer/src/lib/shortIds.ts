import type { PaperSummary } from '../../../shared/ipc'
import { citePaper, replaceInternalRefTokens } from '../../../main/text/internalRefs'

/**
 * uat4-fix1 M1 / D173①：P0x 显示层替换（渲染层口径，与主进程 buildGraphShortIdReplacer
 * 同规则：图内成员按论文 id 升序编 P01…，命中 → 《短标题》，越界 / NEW / #N 剔除）。
 * 只用于展示，绝不写库。从 GraphPage 抽出供对话抽屉（改图小结 / 回复文本）复用。
 */
export function shortIdReplaceForDisplay(members: Array<{ paper: PaperSummary }>): (text: string) => string {
  const sorted = [...members].sort((a, b) => a.paper.id - b.paper.id)
  const byShort = new Map<string, PaperSummary>(sorted.map((m, i) => [`P${String(i + 1).padStart(2, '0')}`, m.paper]))
  return (text) =>
    replaceInternalRefTokens(text, (token) => {
      if (!/^P\d{2}$/.test(token)) return null // 只认 P\d{2}；越界编号 / NEW / #N 剔除
      const paper = byShort.get(token)
      return paper ? citePaper(paper) : null
    })
}
