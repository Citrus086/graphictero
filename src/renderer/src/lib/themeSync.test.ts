// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ThemeView } from '../../../shared/ipc'
import { useThemeSync } from './themeSync'

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.theme
  vi.restoreAllMocks()
})

describe('useThemeSync 挂载兜底（uat9）', () => {
  it('挂载时调用 getTheme，并继续订阅主题广播', async () => {
    let listener: ((view: ThemeView) => void) | undefined
    const off = vi.fn()
    const getTheme = vi.fn(async () => ({ pref: 'dark', resolved: 'dark' }) satisfies ThemeView)
    ;(window as unknown as { graphictero: unknown }).graphictero = {
      getTheme,
      onTheme: vi.fn((cb: (view: ThemeView) => void) => {
        listener = cb
        return off
      })
    }
    const hook = renderHook(() => useThemeSync())
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'))
    expect(getTheme).toHaveBeenCalledTimes(1)

    listener?.({ pref: 'light', resolved: 'light' })
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBeNull())
    hook.unmount()
    expect(off).toHaveBeenCalledTimes(1)
  })

  it('较旧的 getTheme 结果不会覆盖挂载后收到的新广播', async () => {
    let resolveGet: ((view: ThemeView) => void) | undefined
    let listener: ((view: ThemeView) => void) | undefined
    ;(window as unknown as { graphictero: unknown }).graphictero = {
      getTheme: vi.fn(() => new Promise<ThemeView>((resolve) => { resolveGet = resolve })),
      onTheme: vi.fn((cb: (view: ThemeView) => void) => {
        listener = cb
        return () => {}
      })
    }
    renderHook(() => useThemeSync())
    listener?.({ pref: 'light', resolved: 'light' })
    resolveGet?.({ pref: 'dark', resolved: 'dark' })
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBeNull())
  })

  it('getTheme 失败不抛到 React，已有 preload 主题保持', async () => {
    document.documentElement.dataset.theme = 'dark'
    ;(window as unknown as { graphictero: unknown }).graphictero = {
      getTheme: vi.fn(async () => { throw new Error('unavailable') }),
      onTheme: vi.fn(() => () => {})
    }
    renderHook(() => useThemeSync())
    await waitFor(() => expect((window.graphictero as unknown as { getTheme: ReturnType<typeof vi.fn> }).getTheme).toHaveBeenCalled())
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})
