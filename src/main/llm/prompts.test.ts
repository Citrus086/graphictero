import { describe, expect, it } from 'vitest'
import { AGENT_PROMPT, AGENT_TOOL_NAMES } from './prompts'

/**
 * uat3b D156/D157：系统提示版本与关键口径快照（版本号 +1 时必须更新本快照）。
 * 真实提示以 prompts.ts 为准，这里锚定不可静默漂移的关键行。
 */

describe('AGENT_PROMPT（agent-v7，uat3b D156/D157）', () => {
  it('版本号 agent-v7', () => {
    expect(AGENT_PROMPT.version).toBe('agent-v7')
  })

  it('D156：addRelation 被拒后不自动 updateRelation——说明既有边并问用户', () => {
    expect(AGENT_PROMPT.system).toContain('只有用户明确要求修改这条边时才调 updateRelation')
    expect(AGENT_PROMPT.system).toContain('说明既有边的内容（类型、方向、陈述、来源）并问用户是否要修改')
  })

  it('D157：先本地原文、联网只兜底并说明来源、不混成矛盾结论', () => {
    expect(AGENT_PROMPT.system).toContain('联网工具（searchPapers / webSearch / webFetch）只在本地确实没有时兜底')
    expect(AGENT_PROMPT.system).toContain('明确说明这部分来自网页')
    expect(AGENT_PROMPT.system).toContain('不得混成「矛盾」结论')
  })

  it('readPaper 读原文口径（D68）：目录含图表号、出处按原文编号', () => {
    expect(AGENT_PROMPT.system).toContain('readPaper 读的是论文原文')
    expect(AGENT_PROMPT.system).toContain('§4.2')
  })

  it('uat5：回复/改图说明只用短标题指代论文，不出现 P0x 内部编号（规则 12）', () => {
    expect(AGENT_PROMPT.system).toContain('指代论文只用短标题')
    expect(AGENT_PROMPT.system).toContain('绝不出现 P01/P02 这类内部编号')
  })

  it('工具数不变（D77/D143：14 个）', () => {
    expect(AGENT_TOOL_NAMES).toHaveLength(14)
  })
})
