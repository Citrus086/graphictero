import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ExportOptions } from '../../../../shared/ipc/export'
import { RELATION_TYPE_LABELS, type RelationType } from '../../../../shared/relationTypes'
import { Ic } from '../../lib/icons'
import { ipcErrorMessage } from '../../lib/ipcError'
import { useNotify } from '../../lib/notify'
import { exportApi } from '../../lib/exportApi'
// uat4 建议修 2：概览费用估算复用主进程计价口径（estimateTokens / FLASH_PRICE，均为纯模块）
import { estimateTokens } from '../../../../main/relations/context'
import { FLASH_PRICE } from '../../../../main/llm/pricing'

/**
 * M6 lane/ui 批 2：导出 Markdown 弹窗（原型 08；D31/D60/D132）。
 *
 * - 选项：研究线概览（默认不勾；D178 起只显示中性模型调用 / 可用状态，金额集中设置页）、
 *   附每篇详情、关系类型过滤（uat4 建议修 1：全不勾
 *   = 0 条关系并禁用导出）、文末参考文献。
 * - 预览：防抖 400ms 调 export:preview；概览块走 export:overview 的结果（只在用户点
 *   「生成概览」时调一次并缓存——避免每次改选项都花钱；保存时由后端按需生成）。
 * - 保存：export:save 弹系统保存框；返回 null = 取消（静默关闭），成功 toast 显示路径。
 * - 错误态 / 空预览态；后端（生成器 + IPC 实装）归 lane/fetch 批 2，本组件经
 *   exportApi() 接缝消费契约。
 */

const ALL_TYPES = Object.keys(RELATION_TYPE_LABELS) as RelationType[]
const PREVIEW_DEBOUNCE_MS = 400

/** 与主进程 overviewPrompt（src/main/ipc/export.ts）同口径的固定说明文字（不含图名/行）。 */
const OVERVIEW_PROMPT_FIXED =
  '图谱「」的论文如下。请用中文写一段研究线概览，不超过 200 字，只依据这些信息，不要编造。\n'
/** 每篇一行的经验均值 token（`- 《标题》 (年份)：一句话`），对话框拿不到成员标题，按均值估。 */
const AVG_PAPER_LINE_TOKENS = 40
/** 概览正文输出按 ~400 token 估（200 字概览上限口径）。 */
const OVERVIEW_OUTPUT_BODY_TOKENS = 400
/**
 * uat6 S7：概览生成开 thinking（D92），实测输出 token 含推理——uat4 复测一次概览
 * 生成 2013 output tokens（正文仅 ~200 字）。预估按 正文 × 推理放大系数 计入推理：
 * 系数取实测 2013/400 ≈ 5（写死为口径常量，注释标明来源；只是数量级提示）。
 */
export const OVERVIEW_REASONING_FACTOR = 5

/**
 * uat4 建议修 2：按实际输入规模估算概览费用。输入 = overviewPrompt 文本 token
 * （estimateTokens 口径：CJK 每字 1、拉丁每 4 字符 1），取上限：输入全部按 cache miss
 * 高峰价 + 输出（含推理放大，uat6 S7）高峰价（D96 价目，pricing.ts）。
 * 只是数量级提示，不追求精确。
 */
export function estimateOverviewCostCny(
  memberCount: number,
  graphName: string,
  reasoningFactor: number = OVERVIEW_REASONING_FACTOR
): number {
  const inputTokens = estimateTokens(OVERVIEW_PROMPT_FIXED) + graphName.length + memberCount * AVG_PAPER_LINE_TOKENS
  const outputTokens = OVERVIEW_OUTPUT_BODY_TOKENS * Math.max(1, reasoningFactor)
  return (inputTokens / 1e6) * FLASH_PRICE.inputCacheMiss.peak + (outputTokens / 1e6) * FLASH_PRICE.output.peak
}

/** 把缓存的概览文本拼进预览：插在第一篇论文小节（第一个 '\n## '）之前 */
export function stitchOverview(md: string, overviewText: string): string {
  const block = `## 概览\n\n${overviewText}\n`
  const idx = md.indexOf('\n## ')
  if (idx < 0) return `${md}\n${block}`
  return `${md.slice(0, idx + 1)}${block}\n${md.slice(idx + 1)}`
}

export function ExportDialog({
  graphId,
  graphName,
  memberCount,
  onClose
}: {
  graphId: number
  graphName: string
  memberCount: number
  onClose: () => void
}): React.JSX.Element {
  const notify = useNotify()
  const [overview, setOverview] = useState(false)
  const [details, setDetails] = useState(false)
  const [types, setTypes] = useState<Set<RelationType>>(new Set(ALL_TYPES))
  const [references, setReferences] = useState(true)
  const [preview, setPreview] = useState('')
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [overviewCache, setOverviewCache] = useState<string | null>(null)
  const [overviewBusy, setOverviewBusy] = useState(false)
  /** uat4-fix1 S4：打开对话框即问主进程概览缓存（不调模型）；命中则不显示「预计」 */
  const [peekCached, setPeekCached] = useState(false)
  /** S4：本次点击真实计费生成了概览（区别于缓存命中）——显示「已生成」而非缓存文案 */
  const [freshGenerated, setFreshGenerated] = useState(false)
  const [saving, setSaving] = useState(false)
  const reqSeq = useRef(0)
  /** 同一 tick 连点：state 要等重渲染才变成 true，挡不住第二次点击（D132 这一下会花钱） */
  const overviewGuard = useRef(false)
  const saveGuard = useRef(false)

  useEffect(() => {
    let on = true
    exportApi()
      .peekOverview(graphId)
      .then((r) => {
        if (on) setPeekCached(r.cached)
      })
      .catch(() => {})
    return () => {
      on = false
    }
  }, [graphId])

  const options = useMemo<ExportOptions>(
    () => ({
      graphId,
      overview,
      details,
      relationTypes: ALL_TYPES.filter((t) => types.has(t)),
      references
    }),
    [graphId, overview, details, types, references]
  )

  // 预览防抖：概览块不走 preview（避免每次改选项都触发 LLM）——无缓存时 preview
  // 传 overview:false，展示用占位说明；有本地缓存时手动拼接；uat4-fix1 S4：peek 命中
  // 主进程缓存时 preview 传 overview:true——主进程直接拼缓存概览（不调模型，preview 永不调 LLM）
  useEffect(() => {
    const seq = ++reqSeq.current
    setPreviewing(true)
    const t = setTimeout(() => {
      exportApi()
        .preview({ ...options, overview: overview && overviewCache == null && peekCached })
        .then((md) => {
          if (seq !== reqSeq.current) return
          const text =
            overview && overviewCache != null
              ? stitchOverview(md, overviewCache)
              : md
          setPreview(text)
          setPreviewError(null)
          setPreviewing(false)
        })
        .catch((e: unknown) => {
          if (seq !== reqSeq.current) return
          setPreview('')
          setPreviewError(ipcErrorMessage(e, '生成预览失败'))
          setPreviewing(false)
        })
    }, PREVIEW_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [options, overview, overviewCache, peekCached])

  const generateOverview = async (): Promise<void> => {
    if (overviewGuard.current || overviewBusy) return
    overviewGuard.current = true
    setOverviewBusy(true)
    try {
      const { text, cached } = await exportApi().overview(options)
      setOverviewCache(text)
      // S4：cached=true 表示命中缓存（未计费）→ 走缓存文案；false 表示本次真实生成（已计费）
      setFreshGenerated(!cached)
    } catch (e) {
      notify(ipcErrorMessage(e, '生成概览失败'))
    } finally {
      overviewGuard.current = false
      setOverviewBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    if (saveGuard.current || saving) return
    saveGuard.current = true
    setSaving(true)
    try {
      const path = await exportApi().save(options)
      if (path == null) {
        onClose() // 系统保存框取消：静默关闭
        return
      }
      notify(`已导出 Markdown 到 ${path}`)
      onClose()
    } catch (e) {
      notify(ipcErrorMessage(e, '导出失败'))
    } finally {
      saveGuard.current = false
      setSaving(false)
    }
  }

  const toggleType = (t: RelationType): void => {
    setTypes((prev) => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t)
      else next.add(t)
      return next
    })
  }

  const empty = !previewError && !previewing && preview.trim() === ''
  // uat4 建议修 1：关系类型全不勾 = 0 条关系，禁用导出
  const canSave = !previewError && !empty && !previewing && memberCount > 0 && types.size > 0

  return (
    <div className="gt-exp-ov" data-testid="export-dialog" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gt-exp-modal">
        <div className="gt-exp-head">
          <div className="grow" style={{ fontSize: 15, fontWeight: 600 }}>
            导出 Markdown
          </div>
          <button type="button" className="btn icon" title="关闭" data-testid="export-close" onClick={onClose}>
            <Ic name="close" size={14} />
          </button>
        </div>
        <div className="t3" style={{ fontSize: 12.5, padding: '0 20px 12px' }}>
          按「整理」后的布局顺序输出，文末可附参考文献列表。
        </div>
        <div className="gt-exp-body">
          <div className="gt-exp-opts">
            <div className="gt-exp-xh">内容</div>
            <label className="gt-exp-ol" data-testid="export-opt-overview">
              <input
                type="checkbox"
                checked={overview}
                onChange={(e) => {
                  setOverview(e.target.checked)
                  if (!e.target.checked) {
                    setOverviewCache(null)
                    setFreshGenerated(false) // uat4-fix2 S4：取消勾选同时清「本次已生成」态
                  }
                }}
              />
              <span className="gt-exp-cb">{overview ? <Ic name="check" size={11} w={2} /> : null}</span>
              <span className="gt-exp-olt">
                <span>
                  研究线概览
                  {overview &&
                    (freshGenerated ? (
                      // D178：只说明可用状态，不在导出对话框显示费用 / 计费字样
                      <span className="gt-exp-cost">（已生成，可直接使用）</span>
                    ) : overviewCache != null || peekCached ? (
                      <span className="gt-exp-cost">（已生成，可直接使用）</span>
                    ) : (
                      <span className="gt-exp-cost">（会调用一次模型）</span>
                    ))}
                </span>
                <span className="t3">由 Agent 撰写一段概览放在开头</span>
                {overview && overviewCache == null && !peekCached && (
                  <button
                    type="button"
                    className="btn bordered sm"
                    data-testid="export-gen-overview"
                    disabled={overviewBusy}
                    onClick={() => void generateOverview()}
                  >
                    {overviewBusy ? '生成中…' : '生成概览'}
                  </button>
                )}
              </span>
            </label>
            <label className="gt-exp-ol" data-testid="export-opt-details">
              <input type="checkbox" checked={details} onChange={(e) => setDetails(e.target.checked)} />
              <span className="gt-exp-cb">{details ? <Ic name="check" size={11} w={2} /> : null}</span>
              <span className="gt-exp-olt">
                <span>附上论文详情解读</span>
                <span className="t3">每篇附完整解读，文件会明显变长</span>
              </span>
            </label>
            <div className="gt-exp-xh">按关系类型</div>
            <div className="t3" style={{ fontSize: 11.5, margin: '-2px 0 6px' }}>
              {types.size === 0 ? '至少选一种关系类型' : '可多选；含任一选中类型的关系都会导出'}
            </div>
            <div className="gt-exp-tags" data-testid="export-types">
              {ALL_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`gt-exp-xt ${types.has(t) ? 'on' : ''}`}
                  data-testid="export-type"
                  data-type={t}
                  onClick={() => toggleType(t)}
                >
                  <span className="gt-exp-cb">{types.has(t) ? <Ic name="check" size={10} w={2} /> : null}</span>
                  {RELATION_TYPE_LABELS[t]}
                </button>
              ))}
            </div>
            <div className="gt-exp-xh">参考文献</div>
            <label className="gt-exp-ol" data-testid="export-opt-references">
              <input type="checkbox" checked={references} onChange={(e) => setReferences(e.target.checked)} />
              <span className="gt-exp-cb">{references ? <Ic name="check" size={11} w={2} /> : null}</span>
              <span className="gt-exp-olt">
                <span>文末附参考文献列表</span>
                <span className="t3">每篇一行：作者, 年份, 标题；有 DOI 时附链接</span>
              </span>
            </label>
          </div>
          <div className="gt-exp-preview">
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)' }}>预览</span>
              <span className="t3" style={{ fontSize: 11.5 }}>
                {graphName}.md
              </span>
            </div>
            {previewError != null ? (
              <div className="hintbar" data-testid="export-preview-error">
                <Ic name="warn" size={14} />
                <span>{previewError}</span>
              </div>
            ) : empty ? (
              <div className="t3" data-testid="export-preview-empty" style={{ fontSize: 12.5 }}>
                {memberCount === 0 ? '这张图谱还没有论文，没有什么可导出的。' : '预览为空。'}
              </div>
            ) : (
              <pre className="gt-exp-pre" data-testid="export-preview">
                {overview && overviewCache == null && !peekCached && !previewError
                  ? stitchOverview(preview, '（概览将在导出时由 Agent 撰写）')
                  : preview}
              </pre>
            )}
            {previewing && <div className="t3" style={{ fontSize: 11, marginTop: 6 }}>预览更新中…</div>}
          </div>
        </div>
        <div className="gt-exp-foot">
          <div className="grow" />
          <button type="button" className="btn bordered" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn primary" data-testid="export-save" disabled={!canSave || saving} onClick={() => void save()}>
            {saving ? '导出中…' : '导出…'}
          </button>
        </div>
      </div>
    </div>
  )
}
