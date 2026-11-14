// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement as h } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { PaperSummary, RelationView } from '../../../shared/ipc'

/**
 * uat4 GraphPage 显示组：
 *  必须修6：保存编辑后「已编辑」标记不关面板即出现（来源随 editedAt 变化 / gt:graph-changed 重取）
 *  D166：对称关系（对比 / 同一作者）面板用对称文案，无方向性措辞
 *  建议修13：画布边标签对 noRefBasis 关系低调追加「无引用依据」
 *  建议修14a：界面显示层把旧陈述里的 P0x 换成《短标题》/「作者, 年份」（数据库不改）
 */

afterEach(cleanup)

let RelationPanel: typeof import('./GraphPage').RelationPanel
let edgeLabelOf: typeof import('./GraphPage').edgeLabelOf
let shortIdReplaceForDisplay: typeof import('./GraphPage').shortIdReplaceForDisplay
const relationDetail = vi.fn()

beforeAll(async () => {
  ;(window as unknown as { graphictero: unknown }).graphictero = { relationDetail }
  const mod = await import('./GraphPage')
  RelationPanel = mod.RelationPanel
  edgeLabelOf = mod.edgeLabelOf
  shortIdReplaceForDisplay = mod.shortIdReplaceForDisplay
})

function relOf(partial: Partial<RelationView>): RelationView {
  return {
    id: 7,
    paperLow: 11,
    paperHigh: 22,
    srcPaper: 11,
    statement: '',
    llmTypes: ['based_on'],
    autoTypes: [],
    createdAt: '',
    sourceType: 'job',
    sourceJobId: 3,
    sourceSessionId: null,
    model: 'deepseek-flash',
    promptVersion: 'v1',
    editedAt: null,
    noRefBasis: false,
    ...partial
  } as RelationView
}

const paperById = new Map<number, PaperSummary>([
  [11, { id: 11, title: '源论文 A', firstAuthor: 'X', year: 2020, hasPdf: true } as never],
  [22, { id: 22, title: '目标论文 B', firstAuthor: 'Y', year: 2021, hasPdf: false } as never]
])

function panelProps(rel: RelationView): ComponentProps<typeof RelationPanel> {
  return {
    rel,
    paperById,
    saving: false,
    onToggleType: () => {},
    onSaveStatement: () => {},
    onSwapDirection: () => {},
    onDelete: () => {},
    onClose: () => {}
  }
}

describe('uat4 必须修6：保存编辑后来源重取（不关面板）', () => {
  it('保存编辑（rel.editedAt 变化）后不重开面板即出现「已编辑」标记', async () => {
    relationDetail.mockReset()
    relationDetail.mockResolvedValue({ sourceType: 'job', editedAt: null, noRefBasis: false })
    const view = render(h(RelationPanel, panelProps(relOf({}))))
    await screen.findByText('自动生成')
    expect(relationDetail).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('rel-edited-tag')).toBeNull()
    // 保存编辑 → 父组件 reload 带回新 editedAt，面板收到更新后的 rel → 重取来源
    relationDetail.mockResolvedValue({ sourceType: 'job', editedAt: '2026-10-27T01:00:00.000Z', noRefBasis: false })
    view.rerender(h(RelationPanel, panelProps(relOf({ editedAt: '2026-10-27T01:00:00.000Z' }))))
    await screen.findByTestId('rel-edited-tag')
    expect(relationDetail).toHaveBeenCalledTimes(2)
  })

  it('gt:graph-changed 时面板开着也重取当前关系来源', async () => {
    relationDetail.mockReset()
    relationDetail.mockResolvedValue({ sourceType: 'session', editedAt: null, noRefBasis: false })
    render(h(RelationPanel, panelProps(relOf({}))))
    await vi.waitFor(() => expect(relationDetail).toHaveBeenCalledTimes(1))
    window.dispatchEvent(new CustomEvent('gt:graph-changed'))
    await vi.waitFor(() => expect(relationDetail).toHaveBeenCalledTimes(2))
  })
})

describe('uat4 D166：对称关系面板文案', () => {
  it('对比关系：方向行用「A 与 B 对比」，不出现「基于 / 针对」，无调换方向按钮', () => {
    render(h(RelationPanel, panelProps(relOf({ llmTypes: ['compares'] }))))
    const dir = screen.getByTestId('rel-direction')
    expect(dir.textContent).toContain('「源论文 A」与「目标论文 B」对比')
    expect(dir.textContent).not.toContain('基于 / 针对')
    expect(screen.queryByTestId('rel-swap')).toBeNull()
  })

  it('同一作者：方向行用对称文案（「为同一作者」），不出现方向箭头说明', () => {
    render(h(RelationPanel, panelProps(relOf({ llmTypes: [], autoTypes: ['same_author'] }))))
    const dir = screen.getByTestId('rel-direction')
    expect(dir.textContent).toContain('「源论文 A」与「目标论文 B」为同一作者')
    expect(dir.textContent).not.toContain('基于 / 针对')
  })

  it('基于/改进等方向性关系保持原有方向文案与调换方向按钮', () => {
    render(h(RelationPanel, panelProps(relOf({ llmTypes: ['based_on'] }))))
    expect(screen.getByTestId('rel-direction').textContent).toContain('基于 / 针对')
    expect(screen.getByTestId('rel-swap')).toBeTruthy()
  })
})

describe('uat4 建议修13：画布边标签「无引用依据」', () => {
  it('noRefBasis=true 追加低调后缀；false 不追加；未定类型同样适用', () => {
    expect(edgeLabelOf(relOf({ llmTypes: ['based_on'], noRefBasis: true }))).toBe('基于/改进 · 无引用依据')
    expect(edgeLabelOf(relOf({ llmTypes: ['based_on'], noRefBasis: false }))).toBe('基于/改进')
    expect(edgeLabelOf(relOf({ llmTypes: [], autoTypes: [], noRefBasis: true }))).toBe('未定类型 · 无引用依据')
    expect(edgeLabelOf(relOf({ llmTypes: ['compares', 'implements'], noRefBasis: true }))).toBe('具体实现 · 对比 · 无引用依据')
  })
})

describe('uat4-fix2 M1：说明框一律用库内原文（D173①）', () => {
  const original = 'P01 的方法被 P02 改进。'
  const display = '《源论文 A》的方法被 《目标论文 B》改进。' // uat6 S2：》后紧跟中文收紧

  it('可编辑文本框初值 = 库内原文（含 P0x），展示版只读渲染在文本框外', () => {
    render(
      h(RelationPanel, {
        ...panelProps(relOf({ statement: original })),
        displayStatement: display
      })
    )
    const ta = document.querySelector('textarea') as HTMLTextAreaElement
    expect(ta.value).toBe(original) // 可编辑框是原文，不是《短标题》展示串
    const ro = screen.getByTestId('rel-statement-display')
    expect(ro.textContent).toContain(display) // 展示版在文本框外只读出现
    const btn = screen.getByText('保存').closest('button') as HTMLButtonElement
    expect(btn.disabled).toBe(true) // 未改动禁用
  })

  it('在原文上改一个字保存 → 写入「原文 + 那处改动」，不含《短标题》替换、库内 P0x 保留', () => {
    const onSave = vi.fn()
    render(
      h(RelationPanel, {
        ...panelProps(relOf({ statement: original })),
        displayStatement: display,
        onSaveStatement: onSave
      })
    )
    const ta = document.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'P01 的方法被 P02 大幅改进。' } }) // 只加两个字
    const btn = screen.getByText('保存').closest('button') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(onSave).toHaveBeenCalledTimes(1)
    const saved = onSave.mock.calls[0][0] as string
    expect(saved).toBe('P01 的方法被 P02 大幅改进。') // 原文 + 用户键入
    expect(saved).not.toContain('《') // 绝不把《短标题》写回
    expect(saved).toMatch(/\bP0\d\b/) // 库内 P0x 仍在
  })

  it('展示串与原文相同（无 P0x）时不渲染只读行；编辑后保存键入内容', () => {
    const onSave = vi.fn()
    render(
      h(RelationPanel, {
        ...panelProps(relOf({ statement: '普通陈述，无内部编号。' })),
        displayStatement: '普通陈述，无内部编号。',
        onSaveStatement: onSave
      })
    )
    expect(screen.queryByTestId('rel-statement-display')).toBeNull()
    const ta = document.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '用户全新的陈述。' } })
    fireEvent.click(screen.getByText('保存'))
    expect(onSave).toHaveBeenCalledWith('用户全新的陈述。')
  })
})

describe('uat4 建议修14a：界面显示层 P0x 替换', () => {
  const members = [
    { paper: { id: 22, title: '目标论文 B', firstAuthor: 'Y', year: 2021 } as PaperSummary },
    { paper: { id: 11, title: '源论文 A', firstAuthor: 'X', year: 2020 } as PaperSummary }
  ]

  it('P01/P02 换成《短标题》（成员按论文 id 升序编号）', () => {
    const replace = shortIdReplaceForDisplay(members)
    expect(replace('P01 的方法被 P02 改进。')).toBe('《源论文 A》的方法被《目标论文 B》改进。') // uat6 S2 / uat6c S4：》后与《前紧跟中文都收紧
  })

  it('越界编号 / NEW / #N 一律剔除，结果无 P0x 残留', () => {
    const replace = shortIdReplaceForDisplay(members)
    const out = replace('P01 与 P06 是同期工作，P99 无关，NEW 与 #3 也剔除。')
    expect(out).toContain('《源论文 A》')
    expect(out).not.toMatch(/\bP\d{2}\b/)
    expect(out).not.toMatch(/\bNEW\b/)
  })

  it('无标题论文回退「作者, 年份」；对不上的编号剔除不留空洞记号', () => {
    const replace = shortIdReplaceForDisplay([
      { paper: { id: 11, title: '', firstAuthor: 'X', year: 2020 } as PaperSummary },
      { paper: { id: 12, title: '', firstAuthor: null, year: null } as PaperSummary }
    ])
    expect(replace('P01 指出 P02 的问题。')).toBe('X, 2020 指出 的问题。')
    expect(replace('P01 指出 P02 的问题。')).not.toMatch(/\bP\d{2}\b/)
  })
})
