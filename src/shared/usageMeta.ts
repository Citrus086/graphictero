/**
 * 用量来源的共享常量（uat7b：S6(a) 把 BACKGROUND_POST_CATEGORIES 从主进程挪到
 * shared；D186 系列配色映射）。主进程与渲染层都从这一处取，渲染层不再 import
 * src/main 下的模块。
 */
import { USAGE_CATEGORIES, type UsageCategory } from './ipc'

/** 后台小计 = 名片 / 详情 / 概览 / 关系生成（对话 = chat + web 在 usageSubtotals 里） */
export const BACKGROUND_POST_CATEGORIES: ReadonlySet<UsageCategory> = new Set(['card', 'detail', 'overview', 'relation'])

/**
 * D186（作者决策 2026-10-28 13:45 GMT，修订 D180 灰阶）：用量图表系列按来源
 * 各用一种颜色——柱图 / 环形图 / 图例色块 / tooltip 色点 / 表格色块 / 过滤 chip
 * 都用这张映射；颜色跟来源 key 走，不跟系列顺序 / 过滤 / 图例隐藏 / ¥-Token
 * 切换 / 时间范围变化。低饱和、色盲友好（Okabe-Ito / Tableau 系），各色对白底
 * 对比度约 3.4–4.8:1（≥3:1），且都不是 --accent（#2F6FEB，避开饱和蓝）。
 * 未知 / 将来新增来源走 FALLBACK_USAGE_SOURCE_COLOR 中性灰。
 */
export const USAGE_SOURCE_COLORS: Record<UsageCategory, string> = {
  chat: '#B0752F', // Agent 对话 · 赭橙
  web: '#3F86B0', // 联网 · 钢蓝（低饱和，与 --accent 区分）
  detail: '#2F8A6E', // 详情生成 · 灰青绿
  relation: '#B05A4E', // 关系生成 · 砖红
  card: '#A06A92', // 名片 · 灰紫红
  overview: '#9C8A2E' // 导出概览 · 橄榄芥黄
}

/** 未知来源的中性灰兜底（不进 USAGE_CATEGORIES 的将来新类别）。 */
export const FALLBACK_USAGE_SOURCE_COLOR = '#828282'

/** 来源 key → 颜色（含兜底）。 */
export function usageSourceColor(category: string): string {
  return (USAGE_SOURCE_COLORS as Record<string, string>)[category] ?? FALLBACK_USAGE_SOURCE_COLOR
}
