// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement as h } from 'react'

/**
 * uat1 建议 7：「添加论文」导入结果行在有补齐 PDF 时，主句要点名
 * 「已在库 N 篇（其中补齐 PDF M 篇）」——不能读起来像「什么都没变」。
 * 纯 UI 文案，行为不改。
 */

afterEach(cleanup)

let AddPapersModal: typeof import('./AddPapersModal').AddPapersModal

const summary = {
  imported: 1,
  updated: 3,
  addedToGraph: 2,
  addedToGraphIds: [] as number[],
  failed: 0,
  pdfUnresolved: 0,
  pdfAdded: 2, // 本次补齐 PDF 的论文数
  hint: null as string | null
}

beforeAll(async () => {
  const current = { ...summary }
  const api = {
    listLibrary: vi.fn(async () => []),
    getZoteroStatus: vi.fn(async () => ({ kind: 'local_api' as const })),
    listZoteroCollections: vi.fn(async () => [{ key: 'C1', name: '假分类' }]),
    // uat13（D207-③）：选中分类后的条目预览
    listZoteroCollectionItems: vi.fn(async () => [
      { key: 'I1', title: '论文一', firstAuthor: 'Zhang', year: 2024, hasPdf: true },
      { key: 'I2', title: 'Paper Two', firstAuthor: null, year: null, hasPdf: false }
    ]),
    onZoteroImportProgress: vi.fn(() => () => {}),
    importZoteroCollection: vi.fn(async () => ({ ...current }))
  }
  Object.defineProperty(window, 'graphictero', { value: api, configurable: true })
  AddPapersModal = (await import('./AddPapersModal')).AddPapersModal
})

describe('AddPapersModal 导入结果行（uat1 建议 7）', () => {
  it('有补齐 PDF 时：主句显示「已在库 3 篇（其中补齐 PDF 2 篇）」', async () => {
    render(h(AddPapersModal, { graphId: 1, onClose: () => {}, onChanged: async () => {} }))
    fireEvent.click(await screen.findByText('假分类')) // 先选分类
    fireEvent.click(screen.getByRole('button', { name: /导入整个分类/ }))
    await waitFor(() => expect(screen.getByText(/已新导入 1 篇/)).toBeTruthy())
    const line = screen.getByText(/已新导入 1 篇/).textContent ?? ''
    expect(line).toContain('已在库 3 篇')
    expect(line).toContain('（其中补齐 PDF 2 篇）')
    expect(line).toContain('2 篇已加入图谱')
  })
})
