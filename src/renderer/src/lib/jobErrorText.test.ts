import { describe, expect, it } from 'vitest'
import { humanizeJobError, redactJobError } from './jobErrorText'

describe('humanizeJobError（B2）', () => {
  it('按现有错误类型说人话，原文进详情', () => {
    expect(humanizeJobError('OpenAlex 请求被限流（429）').summary).toBe('OpenAlex 请求失败（429 请求过多）')
    expect(humanizeJobError('OpenAlex 网络错误：fetch failed').summary).toBe('网络不可用')
    expect(humanizeJobError('OpenAlex 请求超时').summary).toBe('请求超时')
    expect(humanizeJobError('未找到论文').summary).toBe('未找到论文')
    expect(humanizeJobError('OpenAlex 当日免费额度已用完，今天不再自动重试').summary).toBe('OpenAlex 当日免费额度已用完')
    expect(humanizeJobError('生成关系失败').summary).toBe('生成关系失败')
    const raw = 'OpenAlex 错误（400）：{"message":"nope"}'
    const text = humanizeJobError(raw)
    expect(text.summary).toBe('请求参数被服务拒绝（HTTP 400），请检查设置后重试')
    expect(text.detail).toContain('nope')
  })

  it('额度与网络匹配不误伤其它服务或普通英文文本', () => {
    expect(humanizeJobError('DeepSeek quota exceeded').summary).toBe('请求失败')
    expect(humanizeJobError('DeepSeek credit balance is low').summary).toBe('请求失败')
    expect(humanizeJobError('关系生成失败：network').summary).toBe('关系生成失败：network')
    expect(humanizeJobError('OpenAlex ENOTFOUND').summary).toBe('网络不可用')
    expect(humanizeJobError('request ECONNREFUSED').summary).toBe('网络不可用')
    expect(humanizeJobError('request ETIMEDOUT').summary).toBe('网络不可用')
  })

  it('D197：HTTP 400 给清楚的处理建议，非状态数字不误判', () => {
    for (const raw of ['400', 'HTTP 400: bad request', 'Request failed with status code 400', 'OpenAlex 错误（400）：{}']) {
      expect(humanizeJobError(raw).summary).toBe('请求参数被服务拒绝（HTTP 400），请检查设置后重试')
    }
    expect(humanizeJobError('paper 400 was rejected').summary).toBe('请求失败')
    expect(humanizeJobError('论文 400 的标题匹配失败').summary).toBe('论文 400 的标题匹配失败')
  })

  it('uat10 评审建议 2：短中文 400（无 JSON / URL）也换成人话；其它短中文仍原样', () => {
    expect(humanizeJobError('OpenAlex 错误（400）').summary).toBe('请求参数被服务拒绝（HTTP 400），请检查设置后重试')
    expect(humanizeJobError('OpenAlex 返回 400').summary).toBe('请求参数被服务拒绝（HTTP 400），请检查设置后重试')
    expect(humanizeJobError('生成关系失败').summary).toBe('生成关系失败') // 非 400 短中文早退不回退
    expect(humanizeJobError('论文 400 的标题匹配失败').summary).toBe('论文 400 的标题匹配失败') // 非状态数字不误判
  })

  it('打码 URL 与 JSON 里的 api_key / mailto，摘要不含密钥', () => {
    const raw = 'OpenAlex 错误（400）：https://api.openalex.org/works?api_key=SECRETKEY&mailto=a@b.c {"api_key":"SECRETKEY","mailto":"a@b.c"}'
    const text = humanizeJobError(raw)
    expect(text.summary).toBe('请求参数被服务拒绝（HTTP 400），请检查设置后重试')
    expect(text.summary).not.toContain('SECRETKEY')
    expect(text.detail).not.toContain('SECRETKEY')
    expect(text.detail).not.toContain('a@b.c')
    expect(text.detail).toContain('api_key=***')
    expect(text.detail).toContain('mailto=***')
    expect(redactJobError(raw)).toBe(text.detail)
  })
})
