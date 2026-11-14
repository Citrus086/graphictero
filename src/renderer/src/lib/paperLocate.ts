/** D201（uat12）：详情页「定位」回到画布的判定与 nonce 消费（纯函数，单测覆盖）。
 *
 *  画布 / 节点挂载且 xyflow 完成测量后才移动视口；同一 nonce 只消费一次——
 *  已消费的请求在之后回到画布时不得再次拽视口（不要每次挂载都 fit）。
 */

export interface PaperLocateRequest {
  paperId: number
  nonce: number
}

export type PaperLocateDecision = 'wait' | 'move' | 'skip'

/**
 * 挂载 / 测量等待与「不在当前图谱」回退：
 * - 图谱详情尚未加载、画布（rf）未就绪、或目标节点尚无 measured 尺寸 → 'wait'（下一拍再判）；
 * - 论文不是当前图谱成员 → 'skip'（不移动、不报错，nonce 照常消费）；
 * - 节点已就绪 → 'move'（调用方消费 nonce 后平滑 / 瞬时居中 + flash，只一次）。
 */
export function decidePaperLocate(input: {
  graphLoaded: boolean
  rfReady: boolean
  isMember: boolean
  nodeMeasured: boolean
}): PaperLocateDecision {
  if (!input.graphLoaded || !input.rfReady) return 'wait'
  if (!input.isMember) return 'skip'
  return input.nodeMeasured ? 'move' : 'wait'
}

let consumedNonce: number | null = null

/** 同一 nonce 只消费一次。返回 false = 该请求已消费过，调用方不得再移动视口。 */
export function consumePaperLocateNonce(nonce: number): boolean {
  if (consumedNonce === nonce) return false
  consumedNonce = nonce
  return true
}

export function resetPaperLocateNonceForTests(): void {
  consumedNonce = null
}
