// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement as h } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { RelationView } from '../../../shared/ipc'

/**
 * uat3 D153：关系面板论文标题可点击，进入该论文详情页（导航，非 D69 证据回原文）。
 * RelationPanel 导出渲染；mock window.graphictero.relationDetail（面板加载来源信息）。
 */

afterEach(cleanup)

let RelationPanel: typeof import('./GraphPage').RelationPanel

beforeAll(async () => {
  ;(window as unknown as { graphictero: unknown }).graphictero = {
    relationDetail: vi.fn(async () => null)
  }
  RelationPanel = (await import('./GraphPage')).RelationPanel
})

const REL = {
  id: 7,
  paperLow: 11,
  paperHigh: 22,
  srcPaper: 11,
  dstPaper: undefined, // RelationView 无该字段，dst 经 dstOf(paperLow/paperHigh) 取
  llmTypes: ['based_on'],
  autoTypes: [],
  statement: '',
  createdAt: '',
  sourceType: 'session'
} as unknown as RelationView

const paperById = new Map<number, import('../../../shared/ipc').PaperSummary>([
  [11, { id: 11, title: '源论文 A', authors: 'X', year: 2020, venue: null, hasPdf: true } as never],
  [22, { id: 22, title: '目标论文 B', authors: 'Y', year: 2021, venue: null, hasPdf: false } as never]
])

function renderPanel(onOpenPaper?: (id: number) => void): ReturnType<typeof render> {
  return render(
    h(RelationPanel, {
      rel: REL,
      paperById,
      saving: false,
      onToggleType: () => {},
      onSaveStatement: () => {},
      onDelete: () => {},
      onOpenPaper,
      onClose: () => {}
    })
  )
}

describe('uat3 D153：关系面板论文标题导航', () => {
  it('点击源/目标论文标题 → onOpenPaper 收到对应 paperId', () => {
    const onOpenPaper = vi.fn()
    renderPanel(onOpenPaper)
    fireEvent.click(screen.getByTestId('rel-src-title'))
    expect(onOpenPaper).toHaveBeenCalledWith(11)
    fireEvent.click(screen.getByTestId('rel-dst-title'))
    expect(onOpenPaper).toHaveBeenCalledWith(22)
  })

  it('未注入 onOpenPaper 时标题不挂点击样式、点击不触发', () => {
    renderPanel()
    const t = screen.getByTestId('rel-src-title')
    expect(t.className).not.toContain('lk')
    fireEvent.click(t) // 不崩即可
  })
})
