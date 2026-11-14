import { describe, expect, it } from 'vitest'
import { mermaidTheme } from './MermaidBlock'

describe('Mermaid 深色主题（uat8-fix1 S6）', () => {
  it('data-theme=dark 用 dark，浅色与未设置用 default', () => {
    expect(mermaidTheme('dark')).toBe('dark')
    expect(mermaidTheme('light')).toBe('default')
    expect(mermaidTheme(null)).toBe('default')
    expect(mermaidTheme(undefined)).toBe('default')
  })
})
