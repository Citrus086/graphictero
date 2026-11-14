import { fetchBalance } from './client'
import { AuthLlmError } from './errors'

export interface ConnectionTestView {
  ok: boolean
  message: string
}

/**
 * 语言模型「测试连接」：打余额接口，只把结果收成三句话。
 * 不回传余额数字，也不回传上游错误正文。
 */
export async function testLlmConnection(deps: {
  baseUrl: string
  apiKey: string | null
  fetchImpl?: typeof fetch
}): Promise<ConnectionTestView> {
  if (!deps.apiKey) return { ok: false, message: '未配置 API Key' }
  try {
    await fetchBalance({ baseUrl: deps.baseUrl, apiKey: deps.apiKey, fetchImpl: deps.fetchImpl })
    return { ok: true, message: '可用' }
  } catch (e) {
    if (e instanceof AuthLlmError) return { ok: false, message: 'Key 无效' }
    return { ok: false, message: '网络不可用' }
  }
}
