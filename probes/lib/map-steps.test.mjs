import { describe, expect, it } from 'vitest'
import { ToolLoopAgent, stepCountIs, tool } from 'ai'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { mapSteps, sumUsage } from './map-steps.mjs'
import { createAddRelation } from './relation-tool.mjs'

const KEYS = ['P01', 'P02']

// AI SDK v7 走 LanguageModelV4 协议：tool-call 的 input 是 JSON 字符串（由 SDK 解析）、
// finishReason 是 { unified, raw }、usage 是 { inputTokens: { total }, outputTokens: { total } }
const usage = (i, o) => ({ inputTokens: { total: i }, outputTokens: { total: o } })
const toolCall = (input) => ({
  type: 'tool-call',
  toolCallId: 'call-1',
  toolName: 'addRelation',
  input: JSON.stringify(input)
})
const toolCallsEnd = { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: usage(100, 20) }
const stopEnd = (text = 'DONE') => ({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage(50, 5) })

/**
 * 不联网的集成测试（评审必须修 2）：用 MockLanguageModel 跑真实 ToolLoopAgent
 * 循环，证明映射后的 toolResults 非空（AI SDK v7 的 tool-result part 取 `output`）。
 */
describe('mapSteps：toolResults 提取（AI SDK v7 字段为 output）', () => {
  it('generate 路径：toolResults 非空，含工具返回内容', async () => {
    const { addRelation } = createAddRelation(KEYS)
    const model = new MockLanguageModelV4({
      doGenerate: [
        { content: [toolCall({ src: 'P01', dst: 'P02', types: ['对比'], statement: '两篇对比' })], finishReason: toolCallsEnd.finishReason, usage: usage(100, 20) },
        { content: [{ type: 'text', text: 'DONE' }], finishReason: stopEnd().finishReason, usage: usage(50, 5) }
      ]
    })
    const agent = new ToolLoopAgent({ model, tools: { addRelation: tool(addRelation) }, stopWhen: stepCountIs(4) })
    const result = await agent.generate({ prompt: '建图' })
    const steps = mapSteps(result.steps)
    expect(steps).toHaveLength(2)
    expect(steps[0].toolCalls).toEqual(['addRelation'])
    expect(steps[0].toolResults).toHaveLength(1)
    expect(steps[0].toolResults[0]).not.toBeNull()
    expect(steps[0].toolResults[0]).toEqual(expect.objectContaining({ ok: true }))
  })

  it('校验错误也可见（D86）：非法 id 的 addRelation 返回 ok:false 的工具结果', async () => {
    const { addRelation } = createAddRelation(KEYS)
    const model = new MockLanguageModelV4({
      doGenerate: [
        { content: [toolCall({ src: 'P99', dst: 'P02', types: ['对比'], statement: 'x' })], finishReason: toolCallsEnd.finishReason, usage: usage(10, 5) },
        { content: [{ type: 'text', text: 'DONE' }], finishReason: stopEnd().finishReason, usage: usage(10, 5) }
      ]
    })
    const agent = new ToolLoopAgent({ model, tools: { addRelation: tool(addRelation) }, stopWhen: stepCountIs(4) })
    const result = await agent.generate({ prompt: '建图' })
    const steps = mapSteps(result.steps)
    expect(steps[0].toolResults[0]).toEqual(expect.objectContaining({ ok: false }))
    expect(steps[0].toolResults[0].error).toContain('id 无效或自环')
  })

  it('流式路径（D92 探针同款 agent.stream + fullStream 消费）：toolResults 非空', async () => {
    const { addRelation } = createAddRelation(KEYS)
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({ chunks: [toolCall({ src: 'P01', dst: 'P02', types: ['对比'], statement: '两篇对比' }), toolCallsEnd] })
        },
        {
          stream: simulateReadableStream({ chunks: [{ type: 'text-delta', delta: 'DONE' }, stopEnd()] })
        }
      ]
    })
    const agent = new ToolLoopAgent({ model, tools: { addRelation: tool(addRelation) }, stopWhen: stepCountIs(4) })
    const stream = await agent.stream({ prompt: '建图' })
    for await (const part of stream.fullStream) void part
    const result = await stream
    const steps = mapSteps(await result.steps)
    expect(steps[0].toolResults).toHaveLength(1)
    expect(steps[0].toolResults[0]).toEqual(expect.objectContaining({ ok: true }))
  })

  it('sumUsage 汇总输入/输出与缓存命中', () => {
    const steps = mapSteps([
      { usage: { inputTokens: 100, outputTokens: 10, providerMetadata: { deepseek: { promptCacheHitTokens: 80 } } }, content: [] },
      { usage: { inputTokens: 50, outputTokens: 5, providerMetadata: { deepseek: { promptCacheHitTokens: 50 } } }, content: [] }
    ])
    expect(sumUsage(steps)).toEqual({ prompt_tokens: 150, completion_tokens: 15, prompt_cache_hit_tokens: 130 })
  })
})
