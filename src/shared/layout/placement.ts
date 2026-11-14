/**
 * 新加入节点的增量定位（M1 终审建议修 1）。
 *
 * 加论文（弹窗勾选 / Zotero 导入路径）不再触发全图 ELK 重排——那会覆盖用户手工
 * 布局。只为本次真正新增的节点找位置：排在已有节点的外侧（右侧空白区），不与
 * 已有节点重叠；已有节点坐标一律不动。工具栏「整理」仍是全图重排（D80 不变）。
 * 拖入路径不走这里（落在放置点，见 GraphPage.onDrop）。
 */

export interface ExistingNode {
  id: string
  x: number
  y: number
}

export interface PlacementOptions {
  width?: number // 节点宽（与画布一致，默认 200）
  height?: number // 节点高（默认 64）
  gapX?: number // 新节点区与已有节点的水平间距
  gapY?: number // 新节点之间的竖直间距
  padding?: number // 空图时的起始边距（与 ELK padding 一致）
}

export interface Placement {
  x: number
  y: number
}

const overlaps = (
  a: { x: number; y: number },
  b: { x: number; y: number },
  w: number,
  h: number
): boolean => a.x < b.x + w && b.x < a.x + w && a.y < b.y + h && b.y < a.y + h

/**
 * 为 newIds 计算坐标。返回 Map：只含新节点；已有节点坐标不返回、不改动。
 * - 图里已有节点：新节点放在其包围盒右侧（startX = maxX + gapX），从包围盒顶部
 *   开始竖排，排过包围盒底部则换下一列（再右移一列），保证与已有节点零重叠；
 * - 空图：从 (padding, padding) 起按近方形网格排。
 */
export function placeNewNodes(
  existing: ExistingNode[],
  newIds: string[],
  opts: PlacementOptions = {}
): Map<string, Placement> {
  const w = opts.width ?? 200
  const h = opts.height ?? 64
  const gapX = opts.gapX ?? 60
  const gapY = opts.gapY ?? 24
  const padding = opts.padding ?? 12

  const result = new Map<string, Placement>()
  if (newIds.length === 0) return result

  if (existing.length === 0) {
    const cols = Math.max(1, Math.ceil(Math.sqrt(newIds.length)))
    newIds.forEach((id, i) => {
      result.set(id, {
        x: padding + (i % cols) * (w + gapX),
        y: padding + Math.floor(i / cols) * (h + gapY)
      })
    })
    return result
  }

  const maxX = Math.max(...existing.map((n) => n.x + w))
  const minY = Math.min(...existing.map((n) => n.y))
  const maxY = Math.max(...existing.map((n) => n.y + h))

  let col = 0
  let row = 0
  const rowsPerCol = Math.max(1, Math.ceil((maxY - minY + gapY) / (h + gapY)))
  for (const id of newIds) {
    const pos = { x: maxX + gapX + col * (w + gapX), y: minY + row * (h + gapY) }
    // 防御：理论上 x > maxX 必不重叠，仍逐个校验，撞上就换下一列
    while (existing.some((n) => overlaps(pos, n, w, h)) || [...result.values()].some((p) => overlaps(pos, p, w, h))) {
      col++
      pos.x = maxX + gapX + col * (w + gapX)
    }
    result.set(id, pos)
    row++
    if (row >= rowsPerCol) {
      row = 0
      col++
    }
  }
  return result
}
