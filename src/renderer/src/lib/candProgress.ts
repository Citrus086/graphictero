import type {
  AttachPdfInput,
  CandApi,
  CandProgressEvent,
  PdfAttemptView,
  PdfSources,
  RetryFindPdfInput,
  ImportConfirmInput
} from '../../../shared/ipc/cand'

/**
 * M6 lane/ui 批 1：候选入库 / PDF 查找进度（event:cand:progress）的渲染层共用口径。
 * 03e 进度行、候选卡四态（PaperCardBlock）、画布虚线节点（GraphPage CandidateNode）
 * 三处共用，避免文案漂移。
 */

/** 相位中文标签（phase → 展示文案） */
export const CAND_PHASE_LABEL: Record<CandProgressEvent['phase'], string> = {
  importing: '正在入库',
  locating: '正在查找 PDF',
  downloading: '正在下载 PDF',
  parsing: '正在解析',
  done: '完成',
  no_pdf: '未找到 PDF',
  failed: '入库失败'
}

/** 进行中的相位（卡片「入库中」态 = 四态之一） */
export const CAND_IMPORTING_PHASES: ReadonlySet<CandProgressEvent['phase']> = new Set([
  'importing',
  'locating',
  'downloading',
  'parsing'
])

/**
 * 卡片 part → 候选 id：产出端已定 part.id = `c${CandidateView.id}`（M5 9a797a6，
 * 见 ChatDrawer.resolveCandidate）；非该形态（mock 的 'card-*' 等）返回 null。
 */
export function candidateIdOfPartId(partId: string | undefined): number | null {
  if (partId != null && partId.startsWith('c')) {
    const id = Number(partId.slice(1))
    if (Number.isInteger(id) && id > 0) return id
  }
  return null
}

// ── candApi()：渲染层统一 cand 通道访问点（对齐 M5 agentApi() 先例）──
// ?smoke=1 时用内存 mock 接管（preload 的 contextBridge 对象在渲染层不可改写，
// 冒烟步骤经 window.__gtSmokeCand 驱动进度事件、断言调用入参）；真实环境直通 window.graphictero。

const SMOKE_MODE = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('smoke')

export interface SmokeCandMock extends CandApi {
  /** 冒烟驱动：推进度事件给所有订阅者 */
  fire(e: CandProgressEvent): void
  /** 调用记录（断言用） */
  calls: { attach: AttachPdfInput[]; retry: RetryFindPdfInput[]; import: ImportConfirmInput[]; saved: PdfSources[] }
  /** 可配置的返回值 */
  attempts: PdfAttemptView[]
  sources: PdfSources
}

function createSmokeCandMock(): SmokeCandMock {
  const listeners = new Set<(e: CandProgressEvent) => void>()
  const mock: SmokeCandMock = {
    calls: { attach: [], retry: [], import: [], saved: [] },
    attempts: [],
    sources: { sources: [{ kind: 'open_access', enabled: true }], unpaywallEmail: 'smoke@example.edu' },
    fire(e) {
      listeners.forEach((cb) => cb(e))
    },
    importConfirm(input) {
      mock.calls.import.push(input)
      return Promise.resolve({ paperId: 500, jobId: 1 })
    },
    retryFindPdf(input) {
      mock.calls.retry.push(input)
      return Promise.resolve()
    },
    attachPdf(input) {
      mock.calls.attach.push(input)
      return Promise.resolve()
    },
    pdfAttempts() {
      return Promise.resolve([...mock.attempts])
    },
    getPdfSources() {
      return Promise.resolve({ ...mock.sources, sources: mock.sources.sources.map((s) => ({ ...s })) })
    },
    setPdfSources(input) {
      mock.calls.saved.push(input)
      mock.sources = input
      return Promise.resolve()
    },
    onCandProgress(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
  if (typeof window !== 'undefined') {
    ;(window as unknown as { __gtSmokeCand?: SmokeCandMock }).__gtSmokeCand = mock
  }
  return mock
}

let smokeCand: SmokeCandMock | null = null

// smoke 模式模块加载即建 mock（与 richtext smokeEntry 同思路）：冒烟步骤在任何 UI
// 挂载前就能经 window.__gtSmokeCand 配数据源 / 驱动进度事件
if (SMOKE_MODE) smokeCand ??= createSmokeCandMock()

/** cand 通道访问点：smoke 模式内存 mock（与组件共享同一实例），真实环境 window.graphictero */
export function candApi(): CandApi {
  if (SMOKE_MODE) {
    smokeCand ??= createSmokeCandMock()
    return smokeCand
  }
  return window.graphictero
}
