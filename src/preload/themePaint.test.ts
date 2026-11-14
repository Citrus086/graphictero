// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const themeMock = vi.hoisted(() => ({ sendSync: vi.fn() }))
vi.mock('electron', () => ({ ipcRenderer: { sendSync: themeMock.sendSync } }))

function resetDocument(): void {
  if (!document.documentElement) document.appendChild(document.createElement('html'))
  document.documentElement.innerHTML = '<head></head><body></body>'
  delete document.documentElement.dataset.theme
}

beforeEach(() => {
  vi.resetModules()
  resetDocument()
  themeMock.sendSync.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetDocument()
})

describe('preload 首帧主题（D194① / uat9）', () => {
  it('documentElement 已存在时立即写 dark，light 会去掉旧属性', async () => {
    themeMock.sendSync.mockReturnValue({ pref: 'dark', resolved: 'dark' })
    await import('./themePaint')
    expect(document.documentElement.dataset.theme).toBe('dark')

    vi.resetModules()
    themeMock.sendSync.mockReturnValue({ pref: 'light', resolved: 'light' })
    await import('./themePaint')
    expect(document.documentElement.getAttribute('data-theme')).toBeNull()
  })

  it('documentElement 尚未创建时不丢属性：Observer 在 html 出现时立刻补写', async () => {
    document.removeChild(document.documentElement)
    themeMock.sendSync.mockReturnValue({ pref: 'dark', resolved: 'dark' })
    await import('./themePaint')
    expect(document.documentElement).toBeNull()

    document.appendChild(document.createElement('html'))
    await vi.waitFor(() => expect(document.documentElement?.dataset.theme).toBe('dark'))
  })

  it('无 MutationObserver 时 DOMContentLoaded 也能补写', async () => {
    vi.stubGlobal('MutationObserver', undefined)
    document.removeChild(document.documentElement)
    themeMock.sendSync.mockReturnValue({ pref: 'dark', resolved: 'dark' })
    await import('./themePaint')

    document.appendChild(document.createElement('html'))
    document.dispatchEvent(new Event('DOMContentLoaded'))
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('同步通道失败不阻断文档，留给 renderer getTheme 兜底', async () => {
    themeMock.sendSync.mockImplementation(() => { throw new Error('channel unavailable') })
    await expect(import('./themePaint')).resolves.toBeTruthy()
    expect(document.documentElement.getAttribute('data-theme')).toBeNull()
  })
})
