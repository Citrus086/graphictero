// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement as h } from 'react'
import type { RelationView } from '../../../shared/ipc'

/**
 * uat2b 渲染层测试：
 * - D151 关系生成入口两态：0 条关系 → 「生成关系」（无确认直接排队）；
 *   有关系 → 「重新生成关系…」点击先弹替换确认，确认后才触发。
 * - d) clampMenuPos：菜单靠近右/下边缘自动左/上翻，完整留在视口内。
 */

afterEach(cleanup)

let GraphPage: typeof import('./GraphPage')

beforeAll(async () => {
  // GraphPage 模块顶层捕获 window.graphictero——先装最小 mock 再动态 import
  ;(window as unknown as { graphictero: unknown }).graphictero = {
    getGraph: vi.fn(async () => null),
    listLibrary: vi.fn(async () => []),
    onGenerateProgress: () => () => {},
    onParseProgress: () => () => {},
    onMineruStatus: () => () => {},
    onLibraryChanged: () => () => {},
    onCandidates: () => () => {}
  }
  GraphPage = await import('./GraphPage')
})

describe('D151 关系生成入口', () => {
  it('0 条关系：显示「生成关系」，点击直接触发、不弹任何确认', () => {
    const onGenerate = vi.fn()
    render(h(GraphPage.GenerateRelationsEntry, { visible: true, running: false, onGenerate }))
    const btn = screen.getByTestId('gen-relations-entry')
    expect(btn.textContent).toContain('生成关系')
    expect(btn.className).not.toContain('dfill') // 无危险样式
    fireEvent.click(btn)
    expect(onGenerate).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.ov .modal.cfm')).toBeNull() // 无确认框
  })

  it('visible=false（有关系或非空图之外）不渲染入口', () => {
    const { container } = render(
      h(GraphPage.GenerateRelationsEntry, { visible: false, running: false, onGenerate: () => {} })
    )
    expect(container.querySelector('[data-testid="gen-relations-entry"]')).toBeNull()
  })

  it('生成进行中：入口禁用', () => {
    render(h(GraphPage.GenerateRelationsEntry, { visible: true, running: true, onGenerate: () => {} }))
    expect((screen.getByTestId('gen-relations-entry') as HTMLButtonElement).disabled).toBe(true)
  })

  it('有关系：「重新生成关系…」点击先弹替换确认，确认后才 onRegenerate；取消不触发', () => {
    const onRegenerate = vi.fn()
    render(h(GraphPage.RegenRelationsItem, { running: false, onRegenerate }))
    fireEvent.click(screen.getByTestId('menu-regen-relations'))
    const dlg = document.querySelector('.ov .modal.cfm')!
    expect(dlg.textContent).toContain('重新生成本图的关系？')
    expect(dlg.textContent).toContain('不能用 ⌘Z 撤销')
    expect(dlg.textContent).toContain('即使你编辑过') // uat2-fix1 D164 如实说明
    fireEvent.click(screen.getByText('取消'))
    expect(onRegenerate).not.toHaveBeenCalled()
    // 再次点击 → 确认 → 触发
    fireEvent.click(screen.getByTestId('menu-regen-relations'))
    fireEvent.click(screen.getByText('重新生成'))
    expect(onRegenerate).toHaveBeenCalledTimes(1)
  })

  it('生成进行中：菜单项禁用且点击不弹确认', () => {
    const onRegenerate = vi.fn()
    render(h(GraphPage.RegenRelationsItem, { running: true, onRegenerate }))
    fireEvent.click(screen.getByTestId('menu-regen-relations'))
    expect(onRegenerate).not.toHaveBeenCalled()
    expect(document.querySelector('.ov .modal.cfm')).toBeNull()
  })
})

describe('uat2b c) snapshotOf：⌘Z 快照存完整行', () => {
  const rel: RelationView = {
    id: 42,
    paperLow: 1,
    paperHigh: 2,
    srcPaper: 1,
    statement: 'B 基于 A。',
    llmTypes: ['based_on'] as RelationView['llmTypes'],
    autoTypes: ['cites'] as RelationView['autoTypes'],
    createdAt: '2026-10-27T00:00:00Z',
    updatedAt: '2026-10-27T01:00:00Z',
    sourceType: 'job' as const,
    sourceJobId: 7,
    sourceSessionId: null,
    model: 'deepseek-flash',
    promptVersion: 'relation-gen-v1',
    editedAt: null,
    noRefBasis: false
  }
  it('快照含 id + autoTypes + provenance（撤销编辑后来源/模型/任务 id 不变）', () => {
    const snap = GraphPage.snapshotOf(rel)
    expect(snap).toEqual({
      id: 42,
      srcPaperId: 1,
      dstPaperId: 2,
      statement: 'B 基于 A。',
      llmTypes: ['based_on'],
      autoTypes: ['cites'],
      sourceType: 'job',
      sourceJobId: 7,
      sourceSessionId: null,
      model: 'deepseek-flash',
      promptVersion: 'relation-gen-v1',
      editedAt: null,
      noRefBasis: false,
      updatedAt: '2026-10-27T01:00:00Z' // uat4-fix1 S2：快照带原时间戳
    })
  })
  it('方向取另一端（src 是 high 时 dst 为 low）', () => {
    const snap = GraphPage.snapshotOf({ ...rel, srcPaper: 2 })
    expect(snap.srcPaperId).toBe(2)
    expect(snap.dstPaperId).toBe(1)
  })
})

describe('shouldCloseLayerOn（建议修 2：只认 Escape）', () => {
  it('keydown：Escape 关，其它键不关', () => {
    expect(GraphPage.shouldCloseLayerOn(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true)
    expect(GraphPage.shouldCloseLayerOn(new KeyboardEvent('keydown', { key: 'a' }))).toBe(false)
    expect(GraphPage.shouldCloseLayerOn(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(false)
  })
  it('click：落在 .menu/.fpop 内部不关，外部关', () => {
    const pop = document.createElement('div')
    pop.className = 'fpop'
    const btn = document.createElement('button')
    pop.appendChild(btn)
    const pane = document.createElement('div')
    document.body.appendChild(pop)
    document.body.appendChild(pane)
    const capture = (el: HTMLElement): boolean => {
      let result: boolean | null = null
      const handler = (e: Event): void => {
        e.stopPropagation()
        result = GraphPage.shouldCloseLayerOn(e)
      }
      el.addEventListener('click', handler)
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      el.removeEventListener('click', handler)
      return result!
    }
    expect(capture(btn)).toBe(false) // 弹层内部点击不关
    expect(capture(pane)).toBe(true) // 外部（画布）点击关
    document.body.removeChild(pop)
    document.body.removeChild(pane)
  })
  it('blur 等其它事件：关', () => {
    expect(GraphPage.shouldCloseLayerOn(new Event('blur'))).toBe(true)
  })
})

describe('clampMenuPos（右键/更多菜单视口内翻转）', () => {
  it('位置充足时原样返回', () => {
    expect(GraphPage.clampMenuPos(100, 100, 230, 110, 1440, 900)).toEqual({ x: 100, y: 100 })
  })
  it('靠近右边缘：向左翻，右边留 margin', () => {
    const p = GraphPage.clampMenuPos(1400, 100, 230, 110, 1440, 900)
    expect(p.x + 230).toBeLessThanOrEqual(1440 - 8)
    expect(p.x).toBeGreaterThanOrEqual(8)
  })
  it('靠近底部：向上翻', () => {
    const p = GraphPage.clampMenuPos(100, 880, 230, 110, 1440, 900)
    expect(p.y + 110).toBeLessThanOrEqual(900 - 8)
    expect(p.y).toBeGreaterThanOrEqual(8)
  })
  it('视口比菜单还小：夹到 margin，不出负数', () => {
    const p = GraphPage.clampMenuPos(500, 500, 230, 110, 200, 100)
    expect(p).toEqual({ x: 8, y: 8 })
  })
})
