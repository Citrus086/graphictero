/**
 * D138（Q-M6-15）：页边笔记卡跟随锚点高度——卡片纵向位置取锚点在阅读器 body 里的
 * 同高水平线，超出视口时贴边（clamp 到上下 margin）。
 */
export function noteCardTop(anchorTopInBody: number, bodyHeight: number, cardHeight: number, margin = 8): number {
  const max = Math.max(margin, bodyHeight - cardHeight - margin)
  return Math.min(Math.max(anchorTopInBody, margin), max)
}
