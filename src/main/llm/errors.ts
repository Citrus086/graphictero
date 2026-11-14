/**
 * LLM 调用的错误分类（D53/D70/D85）。
 *
 * 两类错误：
 * - 可自动恢复：断网、429 限流、5xx、超时 → 自动重试 3 次（指数递增；
 *   429 遵守 Retry-After；断网不消耗重试次数，进 waiting_network 排队）；
 * - 重试无用：401（Key 错误）/402（余额不足）→ 不自动重试，暂停整个 LLM 队列；
 *   400（内容超长等）→ failed_action 显示明确原因；缺少 API Key → waiting_key 排队。
 */

/** 可自动恢复：429（带 retryAfterMs）/ 5xx / 超时 / 在线时的网络错误 */
export class RetryableLlmError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number
  ) {
    super(message)
    this.name = 'RetryableLlmError'
  }
}

/** 401 / 402：API Key 无效或余额不足——暂停整个 LLM 队列，不自动重试（D70） */
export class AuthLlmError extends Error {
  constructor(
    message: string,
    public readonly status: 401 | 402
  ) {
    super(message)
    this.name = 'AuthLlmError'
  }
}

/** 400 等重试无用的请求错误：直接显示原因（failed_action），不自动重试 */
export class BadRequestLlmError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message)
    this.name = 'BadRequestLlmError'
  }
}

/** 网络层失败（fetch 抛错）：由调度器结合 net.isOnline() 决定 waiting_network 还是可重试 */
export class NetworkLlmError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NetworkLlmError'
  }
}

/** 未配置 API Key：任务进 waiting_key 排队，不配为失败（D53） */
export class MissingKeyError extends Error {
  constructor() {
    super('缺少 API Key')
    this.name = 'MissingKeyError'
  }
}

/** MinerU 解析步骤失败（D85：只有这一步手动重试，不走 LLM 自动重试规则） */
export class ParseStepError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ParseStepError'
  }
}
