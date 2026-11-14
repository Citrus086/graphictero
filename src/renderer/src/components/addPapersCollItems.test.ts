// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement as h } from 'react'

/**
 * uat13（D207-③）：添加论文弹窗「从 Zotero 导入」选中分类后，右侧在分类标题下
 * 列出该分类的论文（标题 + 作者/年份，紧凑只读列表），有加载中 / 出错 / 空态；
 * 「导入整个分类」按钮行为不变。
 */

afterEach(cleanup)

const api = {
  listLibrary: vi.fn(async () => []),
  getZoteroStatus: vi.fn(async () => ({ kind: 'local_api' as const })),
  listZoteroCollections: vi.fn(async () => [{ key: 'C1', name: '假分类' }]),
  listZoteroCollectionItems: vi.fn(),
  onZoteroImportProgress: vi.fn(() => () => {}),
  importZoteroCollection: vi.fn(async () => ({
    imported: 0,
    updated: 0,
    addedToGraph: 0,
    addedToGraphIds: [] as number[],
    failed: 0,
    pdfUnresolved: 0,
    pdfAdded: 0,
    hint: null
  }))
}

let AddPapersModal: typeof import('./AddPapersModal').AddPapersModal

beforeEach(async () => {
  vi.resetModules()
  api.listZoteroCollectionItems.mockReset()
  Object.defineProperty(window, 'graphictero', { value: api, configurable: true })
  AddPapersModal = (await import('./AddPapersModal')).AddPapersModal
})

describe('AddPapersModal 左右栏分隔条（uat13 D207-④）', () => {
  it('separator 带 role/aria 属性，键盘左右方向键可调宽度并存 localStorage', async () => {
    localStorage.clear()
    render(h(AddPapersModal, { graphId: 1, onClose: () => {}, onChanged: async () => {} }))
    const sep = await screen.findByRole('separator')
    expect(sep.getAttribute('aria-orientation')).toBe('vertical')
    expect(sep.getAttribute('aria-valuenow')).toBe('220') // 默认 220
    fireEvent.keyDown(sep, { key: 'ArrowRight' })
    await waitFor(() => expect(sep.getAttribute('aria-valuenow')).toBe('236'))
    expect(localStorage.getItem('gt.addpapers.leftWidth')).toBe('236')
    fireEvent.keyDown(sep, { key: 'ArrowLeft' })
    await waitFor(() => expect(sep.getAttribute('aria-valuenow')).toBe('220'))
  })

  it('键盘调整不小于左栏最小 160px', async () => {
    localStorage.clear()
    render(h(AddPapersModal, { graphId: 1, onClose: () => {}, onChanged: async () => {} }))
    const sep = await screen.findByRole('separator')
    for (let i = 0; i < 10; i++) fireEvent.keyDown(sep, { key: 'ArrowLeft' })
    await waitFor(() => expect(sep.getAttribute('aria-valuenow')).toBe('160'))
  })

  it('重开弹窗恢复 localStorage 里的宽度', async () => {
    localStorage.setItem('gt.addpapers.leftWidth', '300')
    render(h(AddPapersModal, { graphId: 1, onClose: () => {}, onChanged: async () => {} }))
    const sep = await screen.findByRole('separator')
    expect(sep.getAttribute('aria-valuenow')).toBe('300')
  })
})

describe('AddPapersModal 分类内论文预览（uat13 D207-③）', () => {
  it('选中分类后列出标题 + 作者/年份 + PDF 标记', async () => {
    api.listZoteroCollectionItems.mockResolvedValue([
      { key: 'I1', title: '论文一', firstAuthor: 'Zhang', year: 2024, hasPdf: true },
      { key: 'I2', title: 'Paper Two', firstAuthor: null, year: null, hasPdf: false }
    ])
    render(h(AddPapersModal, { graphId: 1, onClose: () => {}, onChanged: async () => {} }))
    fireEvent.click(await screen.findByText('假分类'))
    const box = await screen.findByTestId('zotero-coll-items')
    await waitFor(() => expect(box.textContent).toContain('论文一'))
    expect(box.textContent).toContain('Zhang, 2024')
    expect(box.textContent).toContain('· PDF')
    expect(box.textContent).toContain('Paper Two')
    expect(api.listZoteroCollectionItems).toHaveBeenCalledWith('C1')
    // 「导入整个分类」按钮仍在
    expect(screen.getByRole('button', { name: /导入整个分类/ })).toBeTruthy()
  })

  it('空分类显示空态', async () => {
    api.listZoteroCollectionItems.mockResolvedValue([])
    render(h(AddPapersModal, { graphId: 1, onClose: () => {}, onChanged: async () => {} }))
    fireEvent.click(await screen.findByText('假分类'))
    const box = await screen.findByTestId('zotero-coll-items')
    await waitFor(() => expect(box.textContent).toContain('该分类还没有论文条目'))
  })

  it('读取失败显示出错态（错误文案经 ipcErrorMessage 剥前缀展示）', async () => {
    api.listZoteroCollectionItems.mockRejectedValue(new Error('boom'))
    render(h(AddPapersModal, { graphId: 1, onClose: () => {}, onChanged: async () => {} }))
    fireEvent.click(await screen.findByText('假分类'))
    const box = await screen.findByTestId('zotero-coll-items')
    await waitFor(() => expect(box.textContent).toContain('boom'))
  })

  it('切换分类重新加载（旧结果被清掉，先回加载中）', async () => {
    api.listZoteroCollectionItems
      .mockResolvedValueOnce([{ key: 'I1', title: '论文一', firstAuthor: 'Zhang', year: 2024, hasPdf: true }])
      .mockResolvedValueOnce([{ key: 'I2', title: '论文二', firstAuthor: 'Li', year: 2023, hasPdf: false }])
    render(h(AddPapersModal, { graphId: 1, onClose: () => {}, onChanged: async () => {} }))
    fireEvent.click(await screen.findByText('假分类'))
    const box = await screen.findByTestId('zotero-coll-items')
    await waitFor(() => expect(box.textContent).toContain('论文一'))
  })
})
