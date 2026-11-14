/**
 * uat7b M1：子图 / 选择跨「详情页往返」的恢复存放点。
 *
 * 从子图双击已选节点打开详情会卸载 GraphPage（路由切到 03 页），子图与选择是
 * 纯视图状态、随卸载丢失。这里按 graphId 暂存，返回同一图谱时消费一次并恢复
 * （渲染层再按最新成员集合剔除已移除论文；剩余不足 2 篇不进子图、只恢复选择）。
 * 只恢复同一图谱：key 就是 graphId，切到别的图谱读不到；消费语义保证恢复一次。
 * 模块级内存态：仅本次运行期间有效，不写库、不进撤销栈（D176 口径不变）。
 */

export interface SavedCanvasView {
  /** 进入详情时的子图冻结集合（null = 未开子图，不暂存这种情形） */
  subgraph: number[] | null
  /** 当时的已选集合（子图冻结期间选择不变，与子图成员一致） */
  selected: number[]
}

const saved = new Map<number, SavedCanvasView>()

export function saveCanvasView(
  graphId: number,
  view: { subgraph: ReadonlySet<number> | null; selected: ReadonlySet<number> }
): void {
  if (view.subgraph == null) return // 只有从子图进入详情才需要恢复
  saved.set(graphId, { subgraph: [...view.subgraph], selected: [...view.selected] })
}

/** 取出并清除某图谱的暂存视图状态（消费一次；没有则 null）。 */
export function takeCanvasView(graphId: number): SavedCanvasView | null {
  const view = saved.get(graphId) ?? null
  saved.delete(graphId)
  return view
}

/** 测试隔离用：清空全部暂存（生产代码不调用）。 */
export function clearCanvasViews(): void {
  saved.clear()
}

/**
 * uat17b D212 建议修 5：聚焦跨「详情页往返」的暂存，与子图恢复并列（消费一次）。
 * 聚焦中双击开详情会卸载 GraphPage，focusMode / 进入聚焦前的视口随卸载丢失；
 * 这里按 graphId 暂存，返回同一图谱时消费一次并恢复聚焦（根已删由 detail effect 退出）。
 * 已按 Esc 退出聚焦的不暂存（返回后仍是全图）；模块级内存，不写库、不进撤销栈。
 */
export interface SavedCanvasFocus {
  root: number
  depth: 1 | 2
  /** 进入聚焦前的视口（Esc 退出聚焦 / 恢复失败时退回）；拿不到时为 null */
  originViewport: { x: number; y: number; zoom: number } | null
}

const savedFocus = new Map<number, SavedCanvasFocus>()

/** 卸载时聚焦开着才暂存；focus 为 null（未聚焦或已 Esc 退出）则什么都不写。 */
export function saveCanvasFocus(graphId: number, focus: SavedCanvasFocus | null): void {
  if (focus == null) return
  savedFocus.set(graphId, focus)
}

/** 取出并清除某图谱的暂存聚焦（消费一次；没有则 null）。 */
export function takeCanvasFocus(graphId: number): SavedCanvasFocus | null {
  const focus = savedFocus.get(graphId) ?? null
  savedFocus.delete(graphId)
  return focus
}

/** 测试隔离用：清空全部暂存聚焦（生产代码不调用）。 */
export function clearCanvasFocuses(): void {
  savedFocus.clear()
}
