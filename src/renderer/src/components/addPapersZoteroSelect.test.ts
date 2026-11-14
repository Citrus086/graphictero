// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement as h } from 'react'

/**
 * uat14（D209）：添加论文弹窗「从 Zotero 导入」区支持按条目勾选——
 * 每行复选框（整行可点）、分类标题行「全选 / 取消全选」、切换分类清空勾选、
 * 底部统计 = 论文库勾选 + Zotero 勾选，点「添加」只导入所选 item keys。
 */

afterEach(cleanup)

const api = {
  listLibrary: vi.fn(async () => [
    { id: 11, title: '库内论文甲', firstAuthor: 'Wang', year: 2024, hasPdf: false, doi: null, arxivId: null, source: 'zotero', inGraph: false },
    { id: 12, title: '库内论文乙', firstAuthor: 'Li', year: 2023, hasPdf: true, doi: null, arxivId: null, source: 'zotero', inGraph: false }
  ]),
  getZoteroStatus: vi.fn(async () => ({ kind: 'local_api' as const })),
  listZoteroCollections: vi.fn(async () => [
    { key: 'C1', name: '分类一' },
    { key: 'C2', name: '分类二' }
  ]),
  listZoteroCollectionItems: vi.fn(),
  addPapersToGraph: vi.fn(async () => [11]),
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
  })),
  importZoteroItems: vi.fn(async () => ({
    imported: 1,
    updated: 0,
    addedToGraph: 1,
    addedToGraphIds: [101] as number[],
    failed: 0,
    pdfUnresolved: 0,
    pdfAdded: 0,
    hint: null
  }))
}

let AddPapersModal: typeof import('./AddPapersModal').AddPapersModal

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  api.listZoteroCollectionItems.mockReset()
  api.listZoteroCollectionItems.mockResolvedValue([
    { key: 'I1', title: '论文一', firstAuthor: 'Zhang', year: 2024, hasPdf: true },
    { key: 'I2', title: '论文二', firstAuthor: null, year: 2025, hasPdf: false, alreadyImported: true }
  ])
  Object.defineProperty(window, 'graphictero', { value: api, configurable: true })
  AddPapersModal = (await import('./AddPapersModal')).AddPapersModal
})

async function openWithItems(): Promise<HTMLElement> {
  render(h(AddPapersModal, { graphId: 1, onClose: () => {}, onChanged: async () => {} }))
  fireEvent.click(await screen.findByText('分类一'))
  const box = await screen.findByTestId('zotero-coll-items')
  await waitFor(() => expect(box.textContent).toContain('论文一'))
  return box
}

describe('AddPapersModal Zotero 条目勾选（uat14 D209）', () => {
  it('整行点击切换勾选；底部统计 = 论文库勾选 + Zotero 勾选', async () => {
    await openWithItems()
    // 勾一篇论文库 + 一篇 Zotero
    fireEvent.click(screen.getByText('库内论文甲'))
    const box = screen.getByTestId('zotero-coll-items')
    fireEvent.click(box.querySelector('[data-zkey="I1"]')!)
    expect(screen.getByText('已选 2 篇')).toBeTruthy()
    expect(screen.getByRole('button', { name: '添加 2 篇' })).toBeTruthy()
    // 再点同一行取消
    fireEvent.click(box.querySelector('[data-zkey="I1"]')!)
    expect(screen.getByText('已选 1 篇')).toBeTruthy()
  })

  it('点「添加」：论文库走 addPapersToGraph，Zotero 只导入所选 keys，onChanged 收合并 ids', async () => {
    const onChanged = vi.fn(async () => {})
    render(h(AddPapersModal, { graphId: 1, onClose: () => {}, onChanged }))
    fireEvent.click(await screen.findByText('分类一'))
    const box = await screen.findByTestId('zotero-coll-items')
    await waitFor(() => expect(box.textContent).toContain('论文一'))
    fireEvent.click(box.querySelector('[data-zkey="I1"]')!)
    fireEvent.click(box.querySelector('[data-zkey="I2"]')!)
    fireEvent.click(screen.getByText('库内论文乙'))
    fireEvent.click(screen.getByRole('button', { name: '添加 3 篇' }))
    await waitFor(() => expect(api.importZoteroItems).toHaveBeenCalledWith('C1', ['I1', 'I2'], 1))
    expect(api.addPapersToGraph).toHaveBeenCalledWith(1, [12])
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith([11, 101]))
    // 完成后勾选清空
    await waitFor(() => expect(screen.getByText('已选 0 篇')).toBeTruthy())
  })

  it('只勾 Zotero 时：不调 addPapersToGraph，importZoteroItems 只带所选 key', async () => {
    await openWithItems()
    const box = screen.getByTestId('zotero-coll-items')
    fireEvent.click(box.querySelector('[data-zkey="I1"]')!)
    fireEvent.click(screen.getByRole('button', { name: '添加 1 篇' }))
    await waitFor(() => expect(api.importZoteroItems).toHaveBeenCalledWith('C1', ['I1'], 1))
    expect(api.addPapersToGraph).not.toHaveBeenCalled()
  })

  it('全选 / 取消全选：文字按钮切换全部条目勾选', async () => {
    await openWithItems()
    fireEvent.click(screen.getByRole('button', { name: '全选' }))
    expect(screen.getByText('已选 2 篇')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消全选' }))
    expect(screen.getByText('已选 0 篇')).toBeTruthy()
  })

  it('切换分类清空 Zotero 勾选（论文库勾选保留）', async () => {
    await openWithItems()
    fireEvent.click(screen.getByText('库内论文甲'))
    const box = screen.getByTestId('zotero-coll-items')
    fireEvent.click(box.querySelector('[data-zkey="I1"]')!)
    expect(screen.getByText('已选 2 篇')).toBeTruthy()
    api.listZoteroCollectionItems.mockResolvedValue([
      { key: 'J1', title: '另一篇', firstAuthor: null, year: null, hasPdf: false }
    ])
    fireEvent.click(screen.getByText('分类二'))
    await waitFor(() => expect(screen.getByTestId('zotero-coll-items').textContent).toContain('另一篇'))
    expect(screen.getByText('已选 1 篇')).toBeTruthy() // 只剩论文库那篇
  })

  it('alreadyImported 的条目显示「已导入」灰字', async () => {
    const box = await openWithItems()
    const row = box.querySelector('[data-zkey="I2"]')!
    expect(row.textContent).toContain('已导入')
    expect(box.querySelector('[data-zkey="I1"]')!.textContent).not.toContain('已导入')
  })
})
