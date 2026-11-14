// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement as h } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiKeyField } from './ApiKeyField'

afterEach(cleanup)

describe('ApiKeyField', () => {
  it('空输入不能保存，有内容才交给 onSave', async () => {
    const onSave = vi.fn(async () => {})
    render(h(ApiKeyField, { configured: false, tail: null, onSave, onClear: async () => {}, testId: 'k' }))
    const save = screen.getByTestId('k-save') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(screen.queryByTestId('k-clear')).toBeNull()
    fireEvent.change(screen.getByTestId('k-input'), { target: { value: '   ' } })
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByTestId('k-input'), { target: { value: '  oa-dummy  ' } })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('oa-dummy'))
  })

  it('已配置显示掩码；清除要确认，取消不调用', async () => {
    const onClear = vi.fn(async () => {})
    render(h(ApiKeyField, { configured: true, tail: 'abcd', onSave: async () => {}, onClear, testId: 'k' }))
    expect((screen.getByTestId('k-input') as HTMLInputElement).placeholder).toBe('已配置 · ••••abcd')
    fireEvent.click(screen.getByTestId('k-clear'))
    expect(screen.getByText('清除 API Key？')).toBeTruthy()
    const dialog = document.querySelector('.modal.cfm')
    expect(dialog?.querySelector('.dfill')).toBeNull()
    fireEvent.click(screen.getByText('取消'))
    expect(onClear).not.toHaveBeenCalled()
    expect(document.querySelector('.modal.cfm')).toBeNull()
    fireEvent.click(screen.getByTestId('k-clear'))
    const ok = [...document.querySelectorAll('.modal.cfm button')].find((b) => b.textContent === '清除')
    expect(ok).toBeTruthy()
    fireEvent.click(ok!)
    await waitFor(() => expect(onClear).toHaveBeenCalledTimes(1))
  })
})
