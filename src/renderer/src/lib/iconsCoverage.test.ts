import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Ic } from './icons'

/**
 * uat4：图标覆盖静态回归——扫描 renderer 源码里所有 `<Ic name="...">` 字面量，
 * 断言都在 lib/icons.tsx 的图标表里（防空图标回归；uat2b 修过「更多」按钮后补的保险）。
 * 不引新依赖：fs 读文件 + 正则。
 */

/** 扫描根 = src/renderer/src（本文件在 lib/ 下；用 import.meta.url，不依赖 __dirname 垫片）。 */
const RENDERER_SRC = join(fileURLToPath(import.meta.url), '..', '..')

function collectTsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...collectTsxFiles(full))
    else if (entry.endsWith('.tsx')) out.push(full)
  }
  return out
}

/** 图标表：渲染出的 svg 有实际路径内容 = 表里有该名字（空路径渲染为空 svg）。 */
function iconTableHas(name: string): boolean {
  const html = renderToStaticMarkup(createElement(Ic, { name }))
  const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(html)?.[1] ?? ''
  return inner.trim().length > 0
}

describe('iconsCoverage（uat4）：所有 Ic 字面量都在图标表里', () => {
  it('扫描全部 tsx，<Ic name="..."> 字面量无空图标', () => {
    const files = collectTsxFiles(RENDERER_SRC).filter((f) => !f.endsWith(join('lib', 'icons.tsx')) && !f.endsWith(join('lib', 'iconsCoverage.test.tsx')))
    const used = new Set<string>()
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      const re = /<Ic\s+name=\{?["'`]([a-zA-Z0-9_-]+)["'`]\}?/g
      let m: RegExpExecArray | null
      while ((m = re.exec(src)) != null) used.add(m[1])
      // 动态 name（表达式）不在本静态检查口径内，跳过（如 ChatDrawer 按类型查表）
    }
    expect(used.size).toBeGreaterThan(0)
    const missing = [...used].filter((name) => !iconTableHas(name))
    expect(missing).toEqual([])
  })
})
