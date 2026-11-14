import { z } from 'zod'

/**
 * addRelation 工具（D84/D86/D89）+ 关系收集器。
 *
 * - LLM 可选类型只含「基于/改进、具体实现、对比」（D84 固定集合；「引用」「同一作者」
 *   由程序自动附加、只读，D89/D93，不交给 LLM 判断——评审建议修 4）；
 * - id/自环校验失败时把校验错误作为工具结果返回（D86）；
 * - 幂等：按无序论文对 upsert（D86「写入幂等」/D89「一对一条边」）——同一对论文
 *   正反向各写一次也只保留一条，内容以后一次写入为准（与 src/main/db/relations.ts
 *   的 DB 层 upsert 语义一致）。
 */
export const LLM_RELATION_TYPES = ['基于/改进', '具体实现', '对比']

export function pairKey(src, dst) {
  return [src, dst].sort().join('\u0000')
}

/**
 * @param {string[]} validKeys 论文短 id 白名单
 * @param {object} [opts]
 * @param {number} [opts.perStepLimit] 每个工具循环步的 addRelation 软上限
 *   （报告 §7「每步最多约 50 条」）：超限的调用把校验错误作为工具结果返回（D86 风格），
 *   不计入 relations；探针在 fullStream 的 step-start 事件处调 resetStepCount()
 */
export function createAddRelation(validKeys, { perStepLimit = Infinity } = {}) {
  const relations = []
  const byPair = new Map()
  let stepCount = 0

  const addRelation = {
    description:
      '在图谱中新增一条论文关系。方向：src → dst 表示「dst 基于/针对 src」。' +
      'types 从固定集合里多选：基于/改进、具体实现、对比。' +
      'statement 是自然语言陈述（一两句，解释这些类型）。' +
      '注意：引用、同一作者两个类型由程序自动判断，不要选。',
    inputSchema: z.object({
      src: z.string().describe('源论文短 id，如 P01（A → B 里的 A）'),
      dst: z.string().describe('目标论文短 id，如 P02（A → B 里的 B）'),
      types: z.array(z.enum(LLM_RELATION_TYPES)).min(1),
      statement: z.string().describe('关系陈述，自然语言，一两句')
    }),
    execute: async (input) => {
      if (!validKeys.includes(input.src) || !validKeys.includes(input.dst) || input.src === input.dst) {
        return { ok: false, error: `id 无效或自环：${input.src} -> ${input.dst}，可用：${validKeys.join(' ')}` }
      }
      stepCount++
      if (stepCount > perStepLimit) {
        return {
          ok: false,
          error: `本步 addRelation 超过软上限（约 ${perStepLimit} 条），请在本步总结后停止；已接受 ${perStepLimit} 条`
        }
      }
      const rel = { src: input.src, dst: input.dst, types: input.types, statement: input.statement }
      const key = pairKey(input.src, input.dst)
      if (byPair.has(key)) {
        // 幂等合并：同一无序对只留一条边，内容以后一次写入为准（D89）
        const idx = byPair.get(key)
        relations[idx] = rel
        return { ok: true, merged: true, recorded: rel }
      }
      byPair.set(key, relations.length)
      relations.push(rel)
      return { ok: true, recorded: rel }
    }
  }

  /** 探针在流式消费的 step-start 边界处重置计数，实现「每步」语义 */
  const resetStepCount = () => {
    stepCount = 0
  }

  return { addRelation, relations, resetStepCount }
}
