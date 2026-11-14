import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

/**
 * 真实 MinerU 集成冒烟专用配置（*.it.ts 不进默认 pnpm test）。
 * 跑：`pnpm smoke:mineru`（本地免费；需主仓库 venv，见 mineru.smoke.it.ts 头注）。
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^better-sqlite3$/, replacement: resolve(__dirname, 'node_modules/.bs3-node') }
    ]
  },
  test: {
    environment: 'node',
    include: ['src/**/*.it.ts']
  }
})
