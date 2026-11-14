/** 只把最后一次图谱 reload 的详情交给调用方；过期结果既不能写 state，也不能用于增量落位。 */
export function currentReloadResult<T>(requestSeq: number, latestSeq: number, value: T): T | null {
  return requestSeq === latestSeq ? value : null
}
