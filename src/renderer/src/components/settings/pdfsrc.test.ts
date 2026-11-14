// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement as h } from 'react'
import type { PdfSources as PdfSourcesView } from '../../../../shared/ipc/cand'
import { PdfSources } from './PdfSources'

afterEach(cleanup)

const DEFAULT_SOURCES: PdfSourcesView = {
  sources: [
    { kind: 'open_access', enabled: true },
    { kind: 'custom', enabled: true, template: 'https://lib.example.edu/resolve?doi={doi}' },
    { kind: 'custom', enabled: false, template: 'https://oa.example.org/{doi}.pdf' }
  ],
  unpaywallEmail: 'me@example.edu'
}

let saved: PdfSourcesView[] = []

function installMock(initial: PdfSourcesView = DEFAULT_SOURCES): void {
  saved = []
  ;(window as unknown as { graphictero: unknown }).graphictero = {
    getPdfSources: vi.fn(async () => structuredClone(initial)),
    setPdfSources: vi.fn(async (s: PdfSourcesView) => {
      saved.push(s)
    })
  }
}

describe('设置 › PDF 来源（M6 lane/ui 批 1，原型 05）', () => {
  beforeEach(() => installMock())

  it('加载并渲染来源列表（顺序 / 停用标记 / Unpaywall 邮箱）', async () => {
    render(h(PdfSources))
    const rows = await screen.findAllByTestId('pdf-src-row')
    expect(rows).toHaveLength(3)
    expect(rows[0].getAttribute('data-kind')).toBe('open_access')
    expect(rows[0].textContent).toContain('开放获取')
    expect(rows[2].textContent).toContain('已停用')
    expect((screen.getByTestId('pdf-src-email') as HTMLInputElement).value).toBe('me@example.edu')
  })

  it('拖动排序 + 开关后保存：cand:setPdfSources 收到新顺序与开关态', async () => {
    render(h(PdfSources))
    const rows = await screen.findAllByTestId('pdf-src-row')
    // HTML5 DnD 标准模式：dragstart 写 dataTransfer、drop 读（合成事件可复现真实拖拽）
    const store: Record<string, string> = {}
    const dt = {
      effectAllowed: '',
      setData: (k: string, v: string) => {
        store[k] = v
      },
      getData: (k: string) => store[k] ?? ''
    }
    // 把第 3 行（下标 2）拖到第 1 位
    fireEvent.dragStart(rows[2].querySelector('[data-testid="pdf-src-handle"]')!, { dataTransfer: dt })
    fireEvent.dragOver(rows[0])
    fireEvent.drop(rows[0], { dataTransfer: dt })
    // 关掉「开放获取」开关（重排后它在第 2 行）
    const toggles = screen.getAllByTestId('pdf-src-toggle')
    fireEvent.click(toggles[1])
    fireEvent.click(screen.getByTestId('pdf-src-save'))
    await waitFor(() => expect(saved).toHaveLength(1))
    const s = saved[0]
    expect(s.sources[0].template).toBe('https://oa.example.org/{doi}.pdf')
    expect(s.sources[1].kind).toBe('open_access')
    expect(s.sources[1].enabled).toBe(false)
    expect(s.sources[2].enabled).toBe(true)
    expect(s.unpaywallEmail).toBe('me@example.edu')
  })

  it('添加自定义模板：非 https / 缺 {doi} 给内联错误，合法才入列', async () => {
    render(h(PdfSources))
    await screen.findAllByTestId('pdf-src-row')
    fireEvent.click(screen.getByTestId('pdf-src-add'))
    const input = screen.getByTestId('pdf-src-template')
    // 非 https（契约 zod superRefine 报错文案）
    fireEvent.change(input, { target: { value: 'http://x.example/{doi}' } })
    fireEvent.click(screen.getByTestId('pdf-src-add-ok'))
    expect(screen.getByTestId('pdf-src-error').textContent).toContain('https')
    expect(screen.getAllByTestId('pdf-src-row')).toHaveLength(3)
    // 缺 {doi}
    fireEvent.change(input, { target: { value: 'https://x.example/pdf' } })
    fireEvent.click(screen.getByTestId('pdf-src-add-ok'))
    expect(screen.getByTestId('pdf-src-error').textContent).toContain('{doi}')
    // 合法
    fireEvent.change(input, { target: { value: 'https://x.example/{doi}' } })
    fireEvent.click(screen.getByTestId('pdf-src-add-ok'))
    expect(screen.getAllByTestId('pdf-src-row')).toHaveLength(4)
    expect(screen.queryByTestId('pdf-src-error')).toBeNull()
  })

  it('删除自定义来源并保存', async () => {
    render(h(PdfSources))
    const rows = await screen.findAllByTestId('pdf-src-row')
    fireEvent.click(rows[1].querySelector('[data-testid="pdf-src-del"]')!)
    fireEvent.click(screen.getByTestId('pdf-src-save'))
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0].sources).toHaveLength(2)
    expect(saved[0].sources.every((s) => s.kind !== 'custom' || s.template !== 'https://lib.example.edu/resolve?doi={doi}')).toBe(true)
  })

  it('机构代理显示「后续版本」灰行', async () => {
    render(h(PdfSources))
    await screen.findAllByTestId('pdf-src-row')
    expect(screen.getByText('机构代理 · 后续版本')).toBeTruthy()
  })

  it('改邮箱失焦单独保存，不改来源列表', async () => {
    render(h(PdfSources))
    await screen.findAllByTestId('pdf-src-row')
    fireEvent.change(screen.getByTestId('pdf-src-email'), { target: { value: 'new@example.org' } })
    fireEvent.blur(screen.getByTestId('pdf-src-email'))
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0].unpaywallEmail).toBe('new@example.org')
    expect(saved[0].sources).toEqual(DEFAULT_SOURCES.sources)
  })

  it('来源列表的保存不带走尚未保存的邮箱', async () => {
    render(h(PdfSources))
    await screen.findAllByTestId('pdf-src-row')
    fireEvent.click(screen.getAllByTestId('pdf-src-toggle')[0])
    fireEvent.change(screen.getByTestId('pdf-src-email'), { target: { value: 'unsaved@example.org' } })
    fireEvent.click(screen.getByTestId('pdf-src-save'))
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0].unpaywallEmail).toBe('me@example.edu')
    expect(saved[0].sources[0].enabled).toBe(false)
  })

  it('超长模板（>2000 字）拒收并提示，不入列', async () => {
    render(h(PdfSources))
    await screen.findAllByTestId('pdf-src-row')
    fireEvent.click(screen.getByTestId('pdf-src-add'))
    fireEvent.change(screen.getByTestId('pdf-src-template'), { target: { value: `https://x.example/${'a'.repeat(2100)}{doi}` } })
    fireEvent.click(screen.getByTestId('pdf-src-add-ok'))
    expect(screen.getByTestId('pdf-src-error').textContent).toContain('模板过长')
    expect(screen.getAllByTestId('pdf-src-row')).toHaveLength(3)
  })

  it('超长邮箱（>500 字）保存被拒并提示，不发 IPC', async () => {
    render(h(PdfSources))
    await screen.findAllByTestId('pdf-src-row')
    fireEvent.change(screen.getByTestId('pdf-src-email'), { target: { value: `${'b'.repeat(510)}@x.edu` } })
    fireEvent.blur(screen.getByTestId('pdf-src-email'))
    const err = await screen.findByTestId('pdf-src-email-error')
    expect(err.textContent).toContain('邮箱过长')
    expect(err.textContent ?? '').not.toMatch(/template/i)
    expect(saved).toHaveLength(0)
  })

  it('邮箱占位中性、已保存是灰阶、机构代理在 Unpaywall 之前', async () => {
    render(h(PdfSources))
    await screen.findAllByTestId('pdf-src-row')
    const email = screen.getByTestId('pdf-src-email') as HTMLInputElement
    expect(email.placeholder).toBe('name@example.com')
    expect(document.body.textContent ?? '').not.toContain('OPENALEX_MAILTO')
    expect(document.body.textContent ?? '').not.toContain('.env')
    const savedBtn = screen.getByTestId('pdf-src-save')
    expect(savedBtn.className).toContain('saved')
    expect(savedBtn.className).not.toContain('primary')
    expect(savedBtn.textContent).toBe('已保存')
    const later = screen.getByText('机构代理 · 后续版本')
    const unpay = screen.getByText('Unpaywall')
    const note = screen.getByText(/没有 PDF 的论文会按上面的顺序/)
    expect(note.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(later.compareDocumentPosition(unpay) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('加载失败 → 错误提示，不白屏', async () => {
    ;(window as unknown as { graphictero: unknown }).graphictero = {
      getPdfSources: vi.fn(async () => {
        throw new Error('未实现')
      })
    }
    render(h(PdfSources))
    await waitFor(() => expect(screen.getByTestId('pdfsrc-error')).toBeTruthy())
  })
})
