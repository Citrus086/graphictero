import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

/**
 * 终审建议修 3：CSP 的 ws/http localhost connect-src 只在 dev 生效。
 * index.html 里的占位符 %CSP_DEV_CONNECT%：dev server 替换为 HMR 需要的
 * localhost 白名单；构建产物替换为空（最小权限）。
 */
function cspDevPlugin(): Plugin {
  return {
    name: 'graphictero-csp-dev',
    transformIndexHtml(html: string, ctx: { server?: unknown }) {
      const devExtra = ctx.server ? ' ws://localhost:* http://localhost:*' : ''
      return html.replaceAll('%CSP_DEV_CONNECT%', devExtra)
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    // zod 不外置、内联进 bundle：沙箱 preload 运行时只能 require electron，
    // 共享契约（如 shared/ipc/agent.ts 的输入 zod schema）值引入 zod 后，
    // 外置会变成 require("zod") 直接崩（M5 预备提交实测）。
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    plugins: [react(), cspDevPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    }
  }
})
