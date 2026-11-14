import { describe, expect, it } from 'vitest'
import { ipcErrorMessage } from './ipcError'

describe('ipcErrorMessage（评审建 7：剥 Electron invoke 前缀）', () => {
  it('剥掉「Error invoking remote method …: Error: 」前缀，保留主进程原文', () => {
    const e = new Error("Error invoking remote method 'zotero:import': Error: 没有找到在运行的 Zotero")
    expect(ipcErrorMessage(e, 'fallback')).toBe('没有找到在运行的 Zotero')
  })

  it('不带前缀的错误原样返回', () => {
    expect(ipcErrorMessage(new Error('普通错误'), 'fallback')).toBe('普通错误')
  })

  it('非 Error 入参转字符串；空消息回退 fallback', () => {
    expect(ipcErrorMessage('字符串错误', 'fallback')).toBe('字符串错误')
    expect(ipcErrorMessage(new Error(''), 'fallback')).toBe('fallback')
  })
})
