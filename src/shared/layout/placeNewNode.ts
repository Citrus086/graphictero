/**
 * uat4 建议修12 / uat5 建议修7：新节点放置（纯函数，画布论文节点与候选节点共用）。
 *
 * 围绕既有节点簇的质心按黄金角（≈137.508°）螺旋逐步外扩，返回第一个与所有既有
 * 节点包围盒（nodeW×nodeH）不相交的位置——新节点落在既有布局附近，不排到很远
 * 空白区。已有节点坐标一律不动（本函数不改输入）；连续添加多个新节点时把已放置
 * 的位置一并放进 existing 即保证互不相交。canvasW 可选：给了就只接受水平方向落
 * 在视口内（留 pad 边距）的候选。
 */
export function placeNewNode(
  existing: Array<{ x: number; y: number }>,
  nodeW: number,
  nodeH: number,
  canvasW?: number
): { x: number; y: number } {
  const pad = 12
  if (existing.length === 0) return { x: pad, y: pad }
  const cx = existing.reduce((s, n) => s + n.x, 0) / existing.length
  const cy = existing.reduce((s, n) => s + n.y, 0) / existing.length
  const gap = 2 // 命中检测留 2px 余量，吸收返回值取整造成的边界贴合
  const hits = (x: number, y: number): boolean =>
    existing.some((n) => x < n.x + nodeW + gap && n.x < x + nodeW + gap && y < n.y + nodeH + gap && n.y < y + nodeH + gap)
  const offCanvas = (x: number): boolean => canvasW != null && canvasW > 0 && (x < pad || x + nodeW > canvasW - pad)
  // 初始半径取簇包围盒跨度的外缘，让第一圈候选就落在簇附近（质心本身必然重叠）
  const span = Math.max(
    Math.max(...existing.map((n) => n.x + nodeW)) - Math.min(...existing.map((n) => n.x)),
    Math.max(...existing.map((n) => n.y + nodeH)) - Math.min(...existing.map((n) => n.y))
  )
  const golden = Math.PI * (3 - Math.sqrt(5))
  const r0 = span / 2 + Math.max(nodeW, nodeH)
  let fallback = { x: Math.round(cx), y: Math.round(cy) }
  for (let i = 0; i < 5000; i++) {
    const r = r0 + i * 8 // 每步沿螺旋外扩 8px，必越过任何有限布局
    const x = cx + r * Math.cos(i * golden) - nodeW / 2
    const y = cy + r * Math.sin(i * golden) - nodeH / 2
    fallback = { x: Math.round(x), y: Math.round(y) }
    if (!offCanvas(x) && !hits(x, y)) return fallback
  }
  return fallback // 5000 步内必找到；到不了这里
}
