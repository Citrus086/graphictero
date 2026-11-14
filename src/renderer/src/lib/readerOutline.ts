import { PdfActionType, type PdfBookmarkObject, type PdfLinkTarget } from '@embedpdf/models'

/**
 * 阅读器「目录」tab（D105③，原型 07）：PDF outline（书签树）拍平成可渲染列表。
 * 纯函数，构造 outline 对象即可测（不触引擎/网络，不提交 PDF）。
 *
 * uat3 必须修 4：目标解析口径——
 * - destination 型：pageIndex ≥ 0 直接可用；named destination 解析不到页时引擎给
 *   -1/非法值 → pageIndex=null（不崩、不跳）；
 * - action 型（/A GoTo）：action.type === Goto 时取其 destination 的页；
 *   RemoteGoto（跳外部文档）/ URI（外部链接）/ Launch / Unsupported 一律不当页内跳转。
 */

export interface OutlineItem {
  title: string
  /** 目标页（0 基；解析不到页的目标为 null，点击不跳） */
  pageIndex: number | null
  /** 嵌套深度（0 起，UI 缩进用） */
  depth: number
}

/** 目标页解析：三种目标统一出口；非法/非页内目标返回 null */
function pageIndexOfTarget(target: PdfLinkTarget | undefined): number | null {
  if (!target) return null
  if (target.type === 'destination') {
    const p = target.destination?.pageIndex
    return typeof p === 'number' && p >= 0 ? p : null
  }
  const action = target.action
  if (action && action.type === PdfActionType.Goto) {
    const p = action.destination?.pageIndex
    return typeof p === 'number' && p >= 0 ? p : null
  }
  // RemoteGoto / URI / LaunchAppOrOpenFile / Unsupported：不是页内跳转
  return null
}

export function flattenBookmarks(bookmarks: PdfBookmarkObject[]): OutlineItem[] {
  const out: OutlineItem[] = []
  const walk = (list: PdfBookmarkObject[] | undefined, depth: number): void => {
    for (const b of list ?? []) {
      out.push({
        title: typeof b.title === 'string' ? b.title : '',
        pageIndex: pageIndexOfTarget(b.target),
        depth
      })
      walk(b.children, depth + 1)
    }
  }
  walk(bookmarks, 0)
  return out.filter((i) => i.title !== '')
}
