/**
 * 关系生成 prompt（车道内版本化，落 relations.prompt_version provenance，D75）。
 *
 * 输出形式说明：主进程 LLM 薄客户端不支持工具调用（tool-call 是 M5 Agent / 探针
 * 路径），D66「同一步并行多个 addRelation」在本实现里
 * 落地为「每次调用输出一批关系 JSON（每批 ≤ 50 条，D86），截断或没写完就接着
 * 调用直到 done」。prompt 的规则口径与探针 system 一致：短 id、方向语义、
 * 固定类型集合（LLM 只判 基于/改进、具体实现、对比；引用/同一作者由程序自动
 * 附加，D89）、没依据不写、只输出 JSON。
 *
 * 输出预算：D92 统一开 thinking + 流式；20 篇探针实测 thinking 吃满 8192 上限
 * 导致 finishReason=length、0 条关系（probes/results/deepseek-probe-20.json），
 * 所以关系生成调用显式给足 maxOutputTokens（D100：generator.ts 默认
 * DEEPSEEK_FLASH_MAX_OUTPUT 384k，可调）。
 */

export interface VersionedPrompt {
  version: string
  system: string
}

export const RELATION_GEN_PROMPT: VersionedPrompt = {
  version: 'relation-gen-v3', // uat2-fix1：无引用依据「基于/改进」保留类型（与后处理一致，不得劝改「对比」）
  system: [
    '你在为一个论文关系图谱生成关系。规则：',
    '1. 论文用短 id 表示（如 P01、P02），只能从给你的列表里选，写错 id 的关系会被丢弃。',
    '2. 方向：src → dst 表示「dst 基于 / 针对 src」（被引方、被更早提出的一方是 src）。',
    '3. 关系类型只能是这三种之一或多个：基于/改进、具体实现、对比。「引用」「同一作者」由程序自动判断，你不要输出。',
    '4. 「基于/改进」以两篇论文确实存在引用关系为依据（一篇的参考文献列表里有另一篇）；即使你没有把握，也照实写你判断的类型——程序会保留你写的「基于/改进」并标注「AI 推断 · 无引用依据」，不会替你改类型。',
    '5. 每条关系必须附一两句自然语言陈述，解释这条关系；陈述里禁止出现 P01、P06 这类内部编号（指代论文用「作者 + 年份」或短标题）；没有依据的论文对不要硬写。',
    '6. 每次最多输出 50 条关系；没写完就把 "done" 置为 false，会再给你一次机会继续。',
    '7. 只输出 JSON，不要输出其他文字。格式：',
    '{"relations":[{"src":"P01","dst":"P02","types":["基于/改进"],"statement":"…"}],"done":true}'
  ].join('\n')
}

/** 续写调用：带上已写入的边，让模型只补剩下的（D86 截断续跑） */
export const RELATION_GEN_CONTINUE_SUFFIX =
  '\n\n上面已写入的关系不要重复。只输出还没写过的论文对，仍按同样的 JSON 格式。'

export const NEW_PAPER_RELATION_PROMPT: VersionedPrompt = {
  version: 'relation-new-paper-v3', // uat2-fix1：同 RELATION_GEN_PROMPT——保留类型，不得劝改「对比」
  system: [
    '图谱里新加入了一篇论文（NEW），请判断它与图谱中相关论文的关系。规则：',
    '1. 只输出新论文与其他论文之间的关系，不要输出图谱旧论文两两之间的关系。',
    '2. 方向：src → dst 表示「dst 基于 / 针对 src」。新论文是 NEW；如果新论文基于某篇旧论文，写 {"src":"旧论文 id","dst":"NEW",…}。',
    '3. 关系类型只能是：基于/改进、具体实现、对比（可多选）。「引用」「同一作者」由程序自动判断，不要输出。',
    '4. 「基于/改进」以两篇论文确实存在引用关系为依据（一篇的参考文献列表里有另一篇）；即使你没有把握，也照实写你判断的类型——程序会保留你写的「基于/改进」并标注「AI 推断 · 无引用依据」，不会替你改类型。',
    '5. 每条关系附一两句自然语言陈述；陈述里禁止出现 P01、NEW 这类内部编号（指代论文用「作者 + 年份」或短标题）；没有依据不要硬写。',
    '6. 只输出 JSON，不要输出其他文字。格式：',
    '{"relations":[{"src":"NEW","dst":"P01","types":["对比"],"statement":"…"}],"done":true}'
  ].join('\n')
}

/**
 * D103 第一阶段：从新论文的信号候选里挑 5–8 篇精读。挑选依据是每篇候选附带的
 * 信号（引用 / 文献耦合 / 关键词）与标题/摘要的主题相关性；第二阶段才读所选
 * 候选的详情写关系。输出 {"candidates":["P01",…]}。
 */
export const CANDIDATE_SELECT_PROMPT: VersionedPrompt = {
  version: 'candidate-select-v1',
  system: [
    '图谱里新加入了一篇论文（NEW），你要从候选列表里挑出 5–8 篇最值得精读全文、',
    '以判断它与 NEW 关系的论文。规则：',
    '1. 依据每篇候选后面的「信号」——引用（直接或间接）、文献耦合（共享参考文献）、',
    '关键词命中——以及你从 NEW 与候选的标题、摘要里读出的主题相关性。',
    '2. 优先挑与 NEW 有引用或文献耦合联系的；其次挑主题明显相关、可能有方法继承、',
    '改进或对比关系的。',
    '3. 只能从候选列表给的短 id 里选，挑 5–8 篇；宁缺毋滥，没有把握的可以不选满。',
    '4. 只输出 JSON，不要输出其他文字。格式：',
    '{"candidates":["P01","P03","P07"]}'
  ].join('\n')
}

/** D40 兜底：从 MinerU 的 References 段抽取引用条目（deepseek-flash） */
export const REFERENCES_EXTRACT_PROMPT: VersionedPrompt = {
  version: 'references-extract-v1',
  system: [
    '从论文的 References（参考文献）段落里抽取条目。规则：',
    '1. 每条尽量给出标题（title）、年份（year，整数）、DOI（doi，没有则省略）。',
    '2. 只输出 JSON 数组，不要输出其他文字。格式：',
    '[{"title":"…","year":2020,"doi":"10.…"}]'
  ].join('\n')
}
