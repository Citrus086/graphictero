// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement as h } from 'react'
import type { ExportOptions } from '../../../../shared/ipc/export'
import { NotifyContext } from '../../lib/notify'
import { ExportDialog, stitchOverview } from './ExportDialog'

afterEach(cleanup)

const BASE_OPTS: ExportOptions = {
  graphId: 1,
  overview: false,
  details: false,
  relationTypes: ['based_on', 'implements', 'compares', 'cites', 'same_author'],
  references: true
}

let previewCalls: ExportOptions[] = []
let saveCalls: ExportOptions[] = []
let overviewCalls: ExportOptions[] = []
let savePath: string | null = '/tmp/gt-export.md'
let failPreview = false
/** uat4 建议修 2：mock overview 返回 { text, cached }；cachedOverview=true 模拟缓存命中 */
let overviewCached = false
/** uat4-fix1 S4：mock peekOverview 返回 { cached }；true 模拟主进程已有概览缓存 */
let peekCached = false
let peekCalls: number[] = []

function installMock(): void {
  previewCalls = []
  saveCalls = []
  overviewCalls = []
  savePath = '/tmp/gt-export.md'
  failPreview = false
  overviewCached = false
  peekCached = false
  peekCalls = []
  const obj: Record<string, unknown> = {
    preview: (o: ExportOptions) => {
      previewCalls.push(o)
      if (failPreview) return Promise.reject(new Error('预览失败'))
      return Promise.resolve(`# 冒烟图谱\n\n[details=${o.details} refs=${o.references} types=${o.relationTypes.length}]\n`)
    },
    save: (o: ExportOptions) => {
      saveCalls.push(o)
      return Promise.resolve(savePath)
    },
    overview: (o: ExportOptions) => {
      overviewCalls.push(o)
      return Promise.resolve({ text: '这条线围绕「搜索智能体何时停止」展开……\n', cached: overviewCached })
    },
    peekOverview: (graphId: number) => {
      peekCalls.push(graphId)
      return Promise.resolve({ cached: peekCached })
    }
  }
  firstMock ??= obj
  ;(window as unknown as { graphictero: unknown }).graphictero = firstMock
}

let firstMock: Record<string, unknown> | null = null
let ExportDialogMod: typeof import('./ExportDialog').ExportDialog

function renderDialog(): { toasts: string[]; onClose: () => void } {
  const toasts: string[] = []
  const onClose = vi.fn()
  render(
    h(
      NotifyContext.Provider,
      { value: (m) => toasts.push(m) },
      h(ExportDialogMod, { graphId: 1, graphName: '冒烟图谱', memberCount: 4, onClose })
    )
  )
  return { toasts, onClose }
}

describe('导出 Markdown 弹窗（M6 lane/ui 批 2，原型 08；D31/D60/D132）', () => {
  beforeAll(async () => {
    installMock()
    ExportDialogMod = (await import('./ExportDialog')).ExportDialog
  })
  beforeEach(() => {
    // 重置调用记录（方法闭包引用本文件数组，对象保持稳定）
    previewCalls = []
    saveCalls = []
    overviewCalls = []
    savePath = '/tmp/gt-export.md'
    failPreview = false
    overviewCached = false
    peekCached = false
    peekCalls = []
  })

  it('渲染：概览默认不勾、关系类型 5 类全选、参考文献默认勾；预览经 export:preview 加载', async () => {
    renderDialog()
    expect((screen.getByTestId('export-opt-overview').querySelector('input') as HTMLInputElement).checked).toBe(false)
    expect(screen.getAllByTestId('export-type')).toHaveLength(5)
    expect(screen.getAllByTestId('export-type').every((t) => t.classList.contains('on'))).toBe(true)
    expect((screen.getByTestId('export-opt-references').querySelector('input') as HTMLInputElement).checked).toBe(true)
    await waitFor(() => expect(screen.getByTestId('export-preview').textContent).toContain('details=false'), { timeout: 2000 })
    expect(previewCalls.length).toBeGreaterThan(0)
    expect(previewCalls[0].overview).toBe(false)
  })

  it('改选项 → 防抖后预览更新（preview 收到新 options）', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('export-preview').textContent).toContain('# 冒烟图谱'), { timeout: 3000 })
    fireEvent.click(screen.getByTestId('export-opt-details').querySelector('input')!)
    await waitFor(() => expect(previewCalls.some((o) => o.details === true)).toBe(true), { timeout: 2000 })
    await waitFor(() => expect(screen.getByTestId('export-preview').textContent).toContain('details=true'), { timeout: 2000 })
  })

  it('D178：勾概览只显示中性模型调用说明；「生成概览」只调一次 overview，之后改选项不再重复调', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('export-preview').textContent).toContain('# 冒烟图谱'), { timeout: 3000 })
    fireEvent.click(screen.getByTestId('export-opt-overview').querySelector('input')!)
    expect(screen.getByTestId('export-opt-overview').textContent).toContain('会调用一次模型')
    expect(screen.getByTestId('export-opt-overview').textContent).not.toContain('¥')
    const genBtn = await screen.findByTestId('export-gen-overview')
    fireEvent.click(genBtn)
    await waitFor(() => expect(overviewCalls).toHaveLength(1), { timeout: 2000 })
    // 概览文本拼进预览
    await waitFor(
      () => expect(screen.getByTestId('export-preview').textContent).toContain('这条线围绕'),
      { timeout: 2000 }
    )
    // uat4-fix1 S4：刚计费生成完（cached=false）→ 显示「已生成」，不写「预计」也不写「缓存」
    await waitFor(() => expect(screen.getByTestId('export-opt-overview').textContent).toContain('已生成'), { timeout: 2000 })
    expect(screen.getByTestId('export-opt-overview').textContent).toContain('可直接使用')
    expect(screen.getByTestId('export-opt-overview').textContent).not.toContain('预计')
    expect(screen.getByTestId('export-opt-overview').textContent).not.toContain('缓存')
    // 再改别的选项：只有 preview 被调，overview 不重复（不重复花钱）
    fireEvent.click(screen.getByTestId('export-opt-details').querySelector('input')!)
    await waitFor(() => expect(previewCalls.some((o) => o.details === true)).toBe(true), { timeout: 2000 })
    expect(overviewCalls).toHaveLength(1)
  })

  it('uat4 建议修 2：纯函数估算——输入规模变化费用同量级；uat6 S7 起含推理放大（见下条）', async () => {
    const { estimateOverviewCostCny } = await import('./ExportDialog')
    const small = estimateOverviewCostCny(1, '图')
    const large = estimateOverviewCostCny(200, '图')
    expect(small).toBeGreaterThan(0)
    // 同量级：200 篇的估算仍在「分」级，不超过 1 元
    expect(large).toBeGreaterThan(small)
    expect(large).toBeLessThan(1)
  })

  it('uat6 S7：概览预估计入推理 token——含推理 ≥ 不含推理，且与 FLASH_PRICE 价目一致', async () => {
    const { estimateOverviewCostCny, OVERVIEW_REASONING_FACTOR } = await import('./ExportDialog')
    const { FLASH_PRICE } = await import('../../../../main/llm/pricing')
    const withReasoning = estimateOverviewCostCny(9, '冒烟图谱')
    const bodyOnly = estimateOverviewCostCny(9, '冒烟图谱', 1)
    expect(withReasoning).toBeGreaterThanOrEqual(bodyOnly)
    // 与 stub 价目一致：推理增量 = 400×(系数−1) output tokens × 输出高峰价（输入项两边相同）
    const reasoningDelta = ((400 * (OVERVIEW_REASONING_FACTOR - 1)) / 1e6) * FLASH_PRICE.output.peak
    expect(withReasoning - bodyOnly).toBeCloseTo(reasoningDelta, 10)
    expect(withReasoning).toBeGreaterThanOrEqual(0.0086 / 2) // uat4 实测 ¥0.0086（2013 output tokens）：预估同量级
  })

  it('uat4 建议修 1：关系类型全不勾 → 类型区提示「至少选一种关系类型」且导出禁用', async () => {
    renderDialog()
    await waitFor(() => expect((screen.getByTestId('export-save') as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 })
    for (const btn of screen.getAllByTestId('export-type')) fireEvent.click(btn)
    expect(screen.getAllByTestId('export-type').every((t) => !t.classList.contains('on'))).toBe(true)
    expect(screen.getByTestId('export-types').parentElement?.textContent ?? '').toContain('至少选一种关系类型')
    expect((screen.getByTestId('export-save') as HTMLButtonElement).disabled).toBe(true)
    // 恢复一类即可导出（预览防抖回来后可保存）
    fireEvent.click(screen.getAllByTestId('export-type')[0])
    await waitFor(() => expect((screen.getByTestId('export-save') as HTMLButtonElement).disabled).toBe(false), { timeout: 2000 })
  })

  it('保存：export:save 收到当前选项；返回路径 → toast + 关闭', async () => {
    const { toasts, onClose } = renderDialog()
    await waitFor(() => expect((screen.getByTestId('export-save') as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 })
    fireEvent.click(screen.getByTestId('export-save'))
    await waitFor(() => expect(saveCalls).toHaveLength(1), { timeout: 2000 })
    expect(saveCalls[0]).toMatchObject({ graphId: 1, references: true })
    expect(toasts.some((t) => t.includes('/tmp/gt-export.md'))).toBe(true)
    expect(onClose).toHaveBeenCalled()
  })

  it('保存取消（返回 null）：静默关闭，无 toast', async () => {
    savePath = null
    const { toasts, onClose } = renderDialog()
    await waitFor(() => expect((screen.getByTestId('export-save') as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 })
    fireEvent.click(screen.getByTestId('export-save'))
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 2000 })
    expect(toasts).toHaveLength(0)
  })

  it('预览失败：错误态展示且保存禁用', async () => {
    failPreview = true
    renderDialog()
    await screen.findByTestId('export-preview-error')
    expect(screen.getByTestId('export-preview-error').textContent).toContain('预览失败')
    expect((screen.getByTestId('export-save') as HTMLButtonElement).disabled).toBe(true)
  })

  it('同一 tick 连点「生成概览」和「保存」只各调一次', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('export-preview').textContent).toContain('# 冒烟图谱'), { timeout: 3000 })
    fireEvent.click(screen.getByTestId('export-opt-overview').querySelector('input')!)
    const genBtn = await screen.findByTestId('export-gen-overview')
    fireEvent.click(genBtn)
    fireEvent.click(genBtn)
    await waitFor(() => expect(overviewCalls).toHaveLength(1), { timeout: 2000 })
    await new Promise((r) => setTimeout(r, 40))
    expect(overviewCalls).toHaveLength(1)
    await waitFor(() => expect((screen.getByTestId('export-save') as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 })
    const saveBtn = screen.getByTestId('export-save')
    fireEvent.click(saveBtn)
    fireEvent.click(saveBtn)
    await waitFor(() => expect(saveCalls).toHaveLength(1), { timeout: 2000 })
    await new Promise((r) => setTimeout(r, 40))
    expect(saveCalls).toHaveLength(1)
  })

  it('D178：主进程已有缓存时显示「已生成，可直接使用」且无生成按钮、无金额', async () => {
    peekCached = true
    renderDialog()
    await waitFor(() => expect(peekCalls).toEqual([1]), { timeout: 2000 })
    fireEvent.click(screen.getByTestId('export-opt-overview').querySelector('input')!)
    const opt = screen.getByTestId('export-opt-overview')
    await waitFor(() => expect(opt.textContent).toContain('已生成，可直接使用'), { timeout: 2000 })
    expect(opt.textContent).not.toContain('预计')
    expect(screen.queryByTestId('export-gen-overview')).toBeNull() // 有缓存不再给生成按钮
    expect(overviewCalls).toHaveLength(0) // 不调 overview（不花钱）
  })

  it('D178：取消勾选清「本次已生成」态；再次生成命中服务端缓存时仍显示「已生成，可直接使用」', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('export-preview').textContent).toContain('# 冒烟图谱'), { timeout: 3000 })
    const ovInput = screen.getByTestId('export-opt-overview').querySelector('input')!
    fireEvent.click(ovInput) // 勾上
    const genBtn = await screen.findByTestId('export-gen-overview')
    fireEvent.click(genBtn) // 第一次：真实计费生成（mock cached=false）
    await waitFor(() => expect(screen.getByTestId('export-opt-overview').textContent).toContain('已生成，可直接使用'), { timeout: 2000 })
    fireEvent.click(ovInput) // 取消勾选
    expect(screen.getByTestId('export-opt-overview').textContent).not.toContain('已生成') // 态已清
    overviewCached = true // 模拟此时主进程已有缓存（再次生成将命中，不再计费）
    fireEvent.click(ovInput) // 再勾上
    const genBtn2 = await screen.findByTestId('export-gen-overview')
    fireEvent.click(genBtn2)
    await waitFor(() => expect(screen.getByTestId('export-opt-overview').textContent).toContain('已生成，可直接使用'), { timeout: 2000 })
    expect(screen.getByTestId('export-opt-overview').textContent).not.toContain('计入后台用量')
  })

  it('D178：无缓存时勾概览只显示模型调用说明（peek 被调一次）', async () => {
    peekCached = false
    renderDialog()
    await waitFor(() => expect(peekCalls).toEqual([1]), { timeout: 2000 })
    fireEvent.click(screen.getByTestId('export-opt-overview').querySelector('input')!)
    expect(screen.getByTestId('export-opt-overview').textContent).toContain('会调用一次模型')
    expect(screen.getByTestId('export-opt-overview').textContent).not.toContain('¥')
  })

  it('stitchOverview：概览块插在第一篇论文小节前；无小节时追加', () => {
    const md = '# 图名\n\n导出于 2026-10-27\n\n## 论文 A\n\n## 论文 B\n'
    const out = stitchOverview(md, '概览文本。')
    expect(out.indexOf('## 概览')).toBeGreaterThan(-1)
    expect(out.indexOf('## 概览')).toBeLessThan(out.indexOf('## 论文 A'))
    expect(out).toContain('概览文本。')
    const noSections = stitchOverview('# 只有标题\n', '概览文本。')
    expect(noSections).toContain('## 概览')
    expect(noSections).toContain('概览文本。')
  })
})
