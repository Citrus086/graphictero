import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: [
      // 测试跑在 Node 下，用 Node ABI 的 better-sqlite3 副本（见
      // scripts/prepare-better-sqlite3-node.mjs）；Electron 侧仍用 node_modules 里的绑定
      { find: /^better-sqlite3$/, replacement: resolve(__dirname, 'node_modules/.bs3-node') }
    ]
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'probes/**/*.test.mjs']
  }
})
