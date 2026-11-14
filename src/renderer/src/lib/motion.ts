/** D200：共享动效口径。浏览器动画与单测都复用这些纯函数 / 可注入帧调度器。 */

export const MOTION_FAST_MS = 120
export const MOTION_BASE_MS = 200
/** 节点数严格大于 300 时跳过位置插值；enter/exit 仍由 CSS 负责。 */
export const GRAPH_POSITION_ANIMATION_LIMIT = 300

export interface MotionPoint {
  x: number
  y: number
}

export interface MotionNodeLike {
  id: string
  position: MotionPoint
}

export interface MotionPreference {
  /** html[data-motion="off"]、smoke / e2e 等确定性开关 */
  forcedOff?: boolean
  /** prefers-reduced-motion: reduce */
  reducedMotion?: boolean
}

export function shouldDisableMotion(pref: MotionPreference): boolean {
  return pref.forcedOff === true || pref.reducedMotion === true
}

/** 当前渲染进程是否关闭动效。无 DOM 的纯单测环境不隐式启用动画。 */
export function currentMotionDisabled(): boolean {
  if (typeof document === 'undefined') return true
  const forcedOff = document.documentElement.dataset.motion === 'off'
  if (forcedOff) return true
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  return shouldDisableMotion({ forcedOff, reducedMotion })
}

export function shouldAnimateNodePositions(nodeCount: number, disabled: boolean): boolean {
  return !disabled && nodeCount <= GRAPH_POSITION_ANIMATION_LIMIT
}

/** uat12（review_uat11 建议修 1）：动效关闭时绝不启动位置 tween（瞬时路径已直接落位），
 *  避免拖拽起点 / 后续提交漏了早退时又跑出 200ms rAF。 */
export function shouldRunPositionTween(moveCount: number, disabled: boolean): boolean {
  return moveCount > 0 && !disabled
}

export function clampMotionProgress(t: number): number {
  if (!Number.isFinite(t)) return t === Number.POSITIVE_INFINITY ? 1 : 0
  return Math.max(0, Math.min(1, t))
}

/** 与 CSS 的标准 ease-out 方向一致，且起止速度平滑。 */
export function easeMotion(t: number): number {
  const p = clampMotionProgress(t)
  return 1 - (1 - p) ** 3
}

export function interpolatePosition(from: MotionPoint, to: MotionPoint, t: number): MotionPoint {
  const p = easeMotion(t)
  return { x: from.x + (to.x - from.x) * p, y: from.y + (to.y - from.y) * p }
}

export interface NodePositionMove {
  id: string
  from: MotionPoint
  to: MotionPoint
}

export interface NodeTransitionPlan<T extends MotionNodeLike = MotionNodeLike> {
  entering: string[]
  exiting: T[]
  moves: NodePositionMove[]
}

/**
 * 按 id 规划节点 enter/exit 与位置插值。新增节点直接在目标位置出现；
 * 删除节点由调用方保留 exiting 快照至淡出结束；正在拖拽的 id 不产生 move。
 */
export function planNodeTransitions<T extends MotionNodeLike>(
  previous: T[],
  next: T[],
  draggingIds: ReadonlySet<string> = new Set()
): NodeTransitionPlan<T> {
  const before = new Map(previous.map((n) => [n.id, n]))
  const after = new Set(next.map((n) => n.id))
  const entering = next.filter((n) => !before.has(n.id)).map((n) => n.id)
  const exiting = previous.filter((n) => !after.has(n.id))
  const moves: NodePositionMove[] = []
  for (const node of next) {
    const old = before.get(node.id)
    if (!old || draggingIds.has(node.id)) continue
    if (old.position.x === node.position.x && old.position.y === node.position.y) continue
    moves.push({ id: node.id, from: { ...old.position }, to: { ...node.position } })
  }
  return { entering, exiting, moves }
}

export type MotionFrameRequest = (callback: (time: number) => void) => number
export type MotionFrameCancel = (handle: number) => void

export interface InterruptibleAnimation {
  /** run 会取消旧任务；新任务的第一帧时间戳是起点。 */
  run: (durationMs: number, onFrame: (t: number) => void, onComplete?: () => void) => void
  cancel: () => void
  isActive: () => boolean
}

/**
 * 只有一个活动任务的 requestAnimationFrame 调度器。旧回调即使在 cancel 后已入队，
 * 也会被 generation 守卫忽略；新布局因此从当前显示位置接续，不叠加闪烁。
 */
export function createInterruptibleAnimation(
  requestFrame?: MotionFrameRequest,
  cancelFrame?: MotionFrameCancel
): InterruptibleAnimation {
  const request: MotionFrameRequest = requestFrame ?? ((cb) => globalThis.requestAnimationFrame(cb))
  const cancel: MotionFrameCancel = cancelFrame ?? ((handle) => globalThis.cancelAnimationFrame(handle))
  let generation = 0
  let handle: number | null = null

  const stop = (): void => {
    generation += 1
    if (handle != null) cancel(handle)
    handle = null
  }

  return {
    run(durationMs, onFrame, onComplete) {
      stop()
      if (durationMs <= 0) {
        onFrame(1)
        onComplete?.()
        return
      }
      const own = generation
      let startedAt: number | null = null
      const tick = (now: number): void => {
        if (own !== generation) return
        startedAt ??= now
        const t = clampMotionProgress((now - startedAt) / durationMs)
        onFrame(t)
        if (t >= 1) {
          handle = null
          onComplete?.()
        } else {
          handle = request(tick)
        }
      }
      handle = request(tick)
    },
    cancel: stop,
    isActive: () => handle != null
  }
}
