/**
 * 把 ToolLoopAgent 的 steps 映射成结果 JSON 里的步骤记录。
 *
 * 注意：AI SDK v7 里 tool-result part 的字段是 `output`（不是 `result`；
 * 评审必须修 2：原来取 `.result` 导致 toolResults 全 null）。
 */
export function mapSteps(steps) {
  return steps.map((s, i) => ({
    step: i + 1,
    usage: s.usage ?? null,
    providerMetadata: s.providerMetadata ?? null,
    toolCalls: (s.content ?? []).filter((c) => c.type === 'tool-call').map((c) => c.toolName),
    toolResults: (s.content ?? [])
      .filter((c) => c.type === 'tool-result')
      .map((c) => c.output ?? null),
    finishReason: s.finishReason ?? null,
    textPreview: ((s.content ?? []).find((c) => c.type === 'text')?.text ?? '').slice(0, 300)
  }))
}

/** 汇总各步 usage（含 deepseek 缓存命中 token 数）。 */
export function sumUsage(steps) {
  return steps.reduce(
    (acc, s) => {
      const u = s.usage ?? {}
      acc.prompt_tokens += u.inputTokens ?? u.prompt_tokens ?? 0
      acc.completion_tokens += u.outputTokens ?? u.completion_tokens ?? 0
      const hit = u?.providerMetadata?.deepseek?.promptCacheHitTokens ?? s.providerMetadata?.deepseek?.promptCacheHitTokens ?? 0
      acc.prompt_cache_hit_tokens += hit
      return acc
    },
    { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 }
  )
}
