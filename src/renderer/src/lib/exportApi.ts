import type { ExportApi, ExportOptions } from '../../../shared/ipc/export'

/**
 * M6 lane/ui 批 2：export: 通道的渲染层统一访问点（对齐 M5 agentApi() / M6 candApi()
 * 先例）。真实环境直通 window.graphictero；?smoke=1 时内存 mock（模块加载即建，
 * window.__gtSmokeExport 驱动/断言），不触主进程「未实现」桩、零真实网络。
 */

const SMOKE_MODE = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('smoke')

export interface SmokeExportMock extends ExportApi {
  calls: { preview: ExportOptions[]; save: ExportOptions[]; overview: ExportOptions[]; peek: number[] }
  /** mock 返回值（冒烟可改写） */
  previewText: string
  overviewText: string
  /** uat4：true 模拟主进程缓存命中（overview 返回 cached=true，不再计费） */
  overviewCached: boolean
  savePath: string | null
  /** 置 true 模拟预览失败（错误态冒烟用） */
  failPreview: boolean
}

function createSmokeExportMock(): SmokeExportMock {
  const mock: SmokeExportMock = {
    calls: { preview: [], save: [], overview: [], peek: [] },
    // 预览文本带选项标记——冒烟据此断言「改选项 → 预览更新」
    previewText: '# 冒烟图谱\n\n（预览）\n',
    overviewText: '（冒烟：研究线概览）这条线围绕「搜索智能体何时停止」展开……\n',
    overviewCached: false,
    savePath: '/tmp/gt-export-smoke.md',
    failPreview: false,
    preview(options) {
      mock.calls.preview.push(options)
      if (mock.failPreview) return Promise.reject(new Error('生成预览失败（冒烟）'))
      return Promise.resolve(
        `# 冒烟图谱\n\n导出于 smoke\n\n` +
          `[overview=${options.overview} details=${options.details} refs=${options.references} types=${options.relationTypes.join(',')}]\n`
      )
    },
    save(options) {
      mock.calls.save.push(options)
      return Promise.resolve(mock.savePath)
    },
    overview(options) {
      mock.calls.overview.push(options)
      // 第二次起视为缓存命中（第一次计费生成，之后不再计费）
      return Promise.resolve({ text: mock.overviewText, cached: mock.overviewCached || mock.calls.overview.length > 1 })
    },
    peekOverview(graphId: number) {
      mock.calls.peek.push(graphId)
      return Promise.resolve({ cached: mock.overviewCached })
    }
  }
  if (typeof window !== 'undefined') {
    ;(window as unknown as { __gtSmokeExport?: SmokeExportMock }).__gtSmokeExport = mock
  }
  return mock
}

let smokeExport: SmokeExportMock | null = null
if (SMOKE_MODE) smokeExport ??= createSmokeExportMock()

/** export: 通道访问点：smoke 模式内存 mock，真实环境 window.graphictero */
export function exportApi(): ExportApi {
  if (SMOKE_MODE) {
    smokeExport ??= createSmokeExportMock()
    return smokeExport
  }
  return window.graphictero
}
