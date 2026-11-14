// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement as h } from 'react'
import type { CardLiveKind } from '../../../../shared/ipc/agent'
import type { PaperCardPart } from '../../../../shared/parts'
import type { CandProgressEvent } from '../../../../shared/ipc/cand'
import { PartsHostContext } from './PartsHostContext'

afterEach(cleanup)

// 组件模块在 import 时捕获 window.graphictero——先装 mock 再动态 import
let PaperCardBlock: typeof import('./PaperCardBlock').PaperCardBlock

type CandCb = (e: CandProgressEvent) => void

let candCb: CandCb | null = null
let importConfirmCalls: number[] = []
let retryFindPdfCalls: number[] = []
let confirmActions: string[] = []
let ignored = 0
let located: PaperCardPart[] = []
/** 为 true 时 importConfirm 先挂起，用来制造「事件先于 .then」 */
let holdImport = false
let releaseImport: ((v: { paperId: number; jobId: number }) => void) | null = null
let rejectImport: ((e: Error) => void) | null = null

const HOST = {
  onCandidateAction: (_part: PaperCardPart, action: 'confirm' | 'ignore') => {
    if (action === 'confirm') confirmActions.push('confirm')
    else ignored++
  },
  onLocateCandidate: (part: PaperCardPart) => {
    located.push(part)
  },
  candidateStatusOf: () => null
}

function part(over: Partial<PaperCardPart> = {}): PaperCardPart {
  return {
    type: 'data-paper-card',
    id: 'c42',
    status: 'done',
    title: '外部候选论文',
    authors: ['张三'],
    year: 2025,
    reason: '方法高度相关',
    cardStatus: 'candidate',
    ...over
  } as PaperCardPart
}

function installMock(): void {
  candCb = null
  importConfirmCalls = []
  retryFindPdfCalls = []
  confirmActions = []
  ignored = 0
  ;(window as unknown as { graphictero: unknown }).graphictero = {
    onCandProgress: vi.fn((cb: CandCb) => {
      candCb = cb
      return () => {
        candCb = null
      }
    }),
    importConfirm: vi.fn((input: { candidateId: number }) => {
      importConfirmCalls.push(input.candidateId)
      if (holdImport) {
        return new Promise<{ paperId: number; jobId: number }>((resolve, reject) => {
          releaseImport = resolve
          rejectImport = reject
        })
      }
      return Promise.resolve({ paperId: 900, jobId: 1 })
    }),
    retryFindPdf: vi.fn(async (input: { paperId: number }) => {
      retryFindPdfCalls.push(input.paperId)
    })
  }
}

function fire(e: CandProgressEvent): void {
  act(() => candCb?.(e))
}

function renderCard(p: PaperCardPart = part()): void {
  render(h(PartsHostContext.Provider, { value: HOST }, h(PaperCardBlock, { part: p })))
}

describe('候选卡四态（M6 lane/ui 批 1，D124/D130）', () => {
  beforeAll(async () => {
    installMock()
    PaperCardBlock = (await import('./PaperCardBlock')).PaperCardBlock
  })

  beforeEach(() => {
    // 组件已捕获 mock 对象（方法闭包引用本文件数组）：每测试清零计数
    importConfirmCalls = []
    retryFindPdfCalls = []
    confirmActions = []
    ignored = 0
    located = []
    holdImport = false
    releaseImport = null
    rejectImport = null
  })

  it('默认候选态：库外确认可用（importConfirm 口径，乐观转「入库中」），忽略走宿主回调', () => {
    renderCard()
    const confirm = screen.getByTestId('card-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(false)
    expect(confirm.textContent).toBe('确认加入')
    fireEvent.click(screen.getByTestId('card-ignore'))
    expect(ignored).toBe(1)
    fireEvent.click(confirm)
    expect(importConfirmCalls).toEqual([42])
    expect(confirmActions).toEqual([])
    // 乐观「入库中」：进度行出现、按钮区被替换
    expect(screen.getByTestId('card-progress').textContent).toContain('入库')
  })

  it('uat5 必须修 4：importConfirm 成功后派发 gt:graph-changed（画布即时刷新）', async () => {
    let dispatched = 0
    const onChanged = (): void => {
      dispatched += 1
    }
    window.addEventListener('gt:graph-changed', onChanged)
    try {
      renderCard()
      fireEvent.click(screen.getByTestId('card-confirm'))
      await act(async () => {
        releaseImport?.({ paperId: 900, jobId: 1 })
      })
      expect(dispatched).toBe(1)
    } finally {
      window.removeEventListener('gt:graph-changed', onChanged)
    }
  })

  it('uat6b S4(a)：库内确认 busy 守到宿主 IPC 的 finally——同 tick 双击只发一次，IPC 慢于 400ms 也不放行', async () => {
    let release: () => void = () => {}
    let calls = 0
    const host = {
      onCandidateAction: () => {
        calls++
        return new Promise<void>((r) => {
          release = r
        })
      },
      candidateStatusOf: () => null
    }
    render(h(PartsHostContext.Provider, { value: host }, h(PaperCardBlock, { part: part({ id: 'c7', existingPaperId: 5, title: '库内论文' }) })))
    const confirm = screen.getByTestId('card-confirm') as HTMLButtonElement
    fireEvent.click(confirm)
    fireEvent.click(confirm) // 同 tick 双击：第二次被 ref 守卫挡住
    expect(calls).toBe(1)
    expect(confirm.disabled).toBe(true)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600))
    }) // 超过旧的 400ms 定时器窗口：旧实现会在这里错误放行
    fireEvent.click(screen.getByTestId('card-confirm')) // IPC 未 settle：仍被守卫挡住
    expect(calls).toBe(1)
    await act(async () => {
      release() // IPC finally：守卫解除
      await Promise.resolve()
    })
    expect((screen.getByTestId('card-confirm') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByTestId('card-confirm'))
    expect(calls).toBe(2) // settle 之后可以再次确认
  })

  it('D182（uat6b）：pendingDup 卡片显示「已在待确认候选中」提示 + 定位按钮（走宿主回调），确认加入仍可用', () => {
    renderCard(part({ id: 'c42', pendingDup: true }))
    expect(screen.getByTestId('card-pending-dup').textContent).toContain('已在待确认候选中')
    fireEvent.click(screen.getByTestId('card-locate'))
    expect(located).toHaveLength(1)
    expect(located[0].id).toBe('c42')
    // 确认加入仍走既有候选确认通路（同一 candidate id）
    fireEvent.click(screen.getByTestId('card-confirm'))
    expect(importConfirmCalls).toEqual([42])
  })

  it('uat6b-fix1 S2：pendingDup + 已在库中（existingPaperId）的卡片「确认加入」走宿主库内确认通路（同一 candidate id，不发 importConfirm）', () => {
    const calls: Array<{ id: string; action: string }> = []
    const host = {
      onCandidateAction: (p: PaperCardPart, action: 'confirm' | 'ignore') => {
        calls.push({ id: p.id, action })
      },
      onLocateCandidate: (p: PaperCardPart) => {
        located.push(p)
      },
      candidateStatusOf: () => null
    }
    render(h(PartsHostContext.Provider, { value: host }, h(PaperCardBlock, { part: part({ id: 'c42', pendingDup: true, existingPaperId: 5 }) })))
    const confirm = screen.getByTestId('card-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    expect(calls).toEqual([{ id: 'c42', action: 'confirm' }]) // 库内通路：宿主回调，candidate id 即卡片 id
    expect(importConfirmCalls).toEqual([]) // 不发库外 importConfirm
  })

  it('非 pendingDup 卡片不出「已在待确认候选中」提示与定位按钮', () => {
    renderCard()
    expect(screen.queryByTestId('card-pending-dup')).toBeNull()
    expect(screen.queryByTestId('card-locate')).toBeNull()
  })

  it('已在库中：确认 = 加入图谱（宿主回调），不触发 importConfirm；标题可跳详情', () => {
    renderCard(part({ id: 'c7', existingPaperId: 5, title: '库内论文' }))
    const confirm = screen.getByTestId('card-confirm') as HTMLButtonElement
    expect(confirm.textContent).toBe('确认加入')
    fireEvent.click(confirm)
    expect(confirmActions).toEqual(['confirm'])
    expect(importConfirmCalls).toEqual([])
    // 点击标题 → 'gt:open-paper' 事件（App 监听跳 03/03e）
    const events: number[] = []
    const onOpen = (e: Event): void => {
      events.push((e as CustomEvent<number>).detail)
    }
    window.addEventListener('gt:open-paper', onOpen)
    fireEvent.click(screen.getByText('库内论文'))
    window.removeEventListener('gt:open-paper', onOpen)
    expect(events).toEqual([5])
  })

  it('入库中：进度事件驱动，按钮禁用', () => {
    renderCard()
    fire({ candidateId: 42, paperId: 900, phase: 'downloading', message: 'openalex' })
    expect(screen.getByTestId('card-progress').textContent).toContain('下载 PDF')
    // 入库中：操作按钮被进度行替换
    expect(screen.queryByTestId('card-confirm')).toBeNull()
    fire({ candidateId: 42, paperId: 900, phase: 'parsing' })
    expect(screen.getByTestId('card-progress').textContent).toContain('解析')
  })

  it('失败态且 paperId 为 0：显示原因，「重试入库」再调 importConfirm（确认本身没入库）', () => {
    renderCard()
    fire({ candidateId: 42, paperId: 0, phase: 'failed', message: 'OpenAlex 超时' })
    expect(screen.getByTestId('card-retry')).toBeTruthy()
    expect(screen.getByTestId('part-paper-card').textContent).toContain('OpenAlex 超时')
    fireEvent.click(screen.getByTestId('card-retry'))
    expect(importConfirmCalls).toEqual([42])
    expect(retryFindPdfCalls).toEqual([])
  })

  it('失败态且 paperId > 0：重试走 retryFindPdf，不再 importConfirm', () => {
    renderCard()
    fire({ candidateId: 42, paperId: 900, phase: 'failed', message: '下载中断' })
    fireEvent.click(screen.getByTestId('card-retry'))
    expect(retryFindPdfCalls).toEqual([900])
    expect(importConfirmCalls).toEqual([])
  })

  it('importConfirm 返回时若相位已离开 importing，不把 done 打回正在入库', async () => {
    holdImport = true
    renderCard()
    fireEvent.click(screen.getByTestId('card-confirm'))
    expect(screen.getByTestId('card-progress').textContent).toContain('入库')
    fire({ candidateId: 42, paperId: 901, phase: 'done' })
    expect(screen.getByTestId('card-open')).toBeTruthy()
    await act(async () => {
      releaseImport?.({ paperId: 777, jobId: 1 })
    })
    expect(screen.queryByTestId('card-progress')).toBeNull()
    expect(screen.getByTestId('part-paper-card').textContent).toContain('已入库')
    const events: number[] = []
    window.addEventListener('gt:open-paper', (e) => events.push((e as CustomEvent<number>).detail))
    fireEvent.click(screen.getByTestId('card-open'))
    expect(events).toEqual([901])
  })

  it('importConfirm 失败时若相位已是 done，不清掉已入库', async () => {
    holdImport = true
    renderCard()
    fireEvent.click(screen.getByTestId('card-confirm'))
    fire({ candidateId: 42, paperId: 901, phase: 'done' })
    expect(screen.getByTestId('part-paper-card').textContent).toContain('已入库')
    await act(async () => {
      rejectImport?.(new Error('late fail'))
    })
    expect(screen.getByTestId('part-paper-card').textContent).toContain('已入库')
    expect(screen.queryByTestId('card-confirm')).toBeNull()
  })

  it('无 PDF 态：可「再试查找」（cand:retryFindPdf）与「打开论文」跳转', () => {
    renderCard()
    fire({ candidateId: 42, paperId: 900, phase: 'no_pdf' })
    expect(screen.getByTestId('part-paper-card').textContent).toContain('未找到 PDF')
    // 「打开论文」跳转（在点「再试查找」之前断言——点击后相位以事件为准）
    const events: number[] = []
    const onOpen = (e: Event): void => {
      events.push((e as CustomEvent<number>).detail)
    }
    window.addEventListener('gt:open-paper', onOpen)
    fireEvent.click(screen.getByTestId('card-open'))
    window.removeEventListener('gt:open-paper', onOpen)
    expect(events).toEqual([900])
    fireEvent.click(screen.getByTestId('card-retry-pdf'))
    expect(retryFindPdfCalls).toEqual([900])
  })

  it('已入库（done）：显示已入库 + 打开论文', () => {
    renderCard()
    fire({ candidateId: 42, paperId: 901, phase: 'done' })
    expect(screen.getByTestId('part-paper-card').textContent).toContain('已入库')
    const events: number[] = []
    const onOpen = (e: Event): void => {
      events.push((e as CustomEvent<number>).detail)
    }
    window.addEventListener('gt:open-paper', onOpen)
    fireEvent.click(screen.getByTestId('card-open'))
    window.removeEventListener('gt:open-paper', onOpen)
    expect(events).toEqual([901])
  })

  it('别人的进度事件不影响本卡（按 candidateId 过滤）', () => {
    renderCard()
    fire({ candidateId: 99, paperId: 1, phase: 'downloading' })
    expect(screen.queryByTestId('card-progress')).toBeNull()
    expect((screen.getByTestId('card-confirm') as HTMLButtonElement).disabled).toBe(false)
  })

  it('非 c{id} 形态的 part（mock card-*）：库外确认禁用，不崩', () => {
    renderCard(part({ id: 'card-1' }))
    expect((screen.getByTestId('card-confirm') as HTMLButtonElement).disabled).toBe(true)
  })

  it('uat6c M1：reason 为内部状态码 in_graph / 空串 / NULL → 不出现理由行，全文不含状态码（状态走「已在本图谱中」徽标）', () => {
    for (const r of ['in_graph', '', '   ', null] as Array<string | null>) {
      cleanup()
      renderCard(part({ reason: r as string, inGraph: true, existingPaperId: 5 }))
      const card = screen.getByTestId('part-paper-card')
      expect(card.querySelector('.gt-card-reason')).toBeNull()
      expect(card.textContent).not.toContain('in_graph')
      expect(card.textContent).toContain('已在本图谱中')
    }
  })

  it('uat6c M1：有正常中文理由时照常显示理由行', () => {
    renderCard(part({ reason: '与图中 SeekBench 同名同题，值得对照' }))
    const card = screen.getByTestId('part-paper-card')
    expect(card.querySelector('.gt-card-reason')!.textContent).toContain('同名同题')
  })

  it('uat6c S3 / D198：已在本图谱只显示顶部药丸，无确认按钮，也不再显示未核实', () => {
    renderCard(part({ inGraph: true, existingPaperId: 5, unverified: true }))
    expect(screen.queryByTestId('card-confirm')).toBeNull()
    expect(screen.queryByTestId('card-ignore')).toBeNull()
    expect(screen.queryByTestId('card-unverified')).toBeNull()
    expect(screen.getByTestId('part-paper-card').textContent).toContain('已在本图谱中')
  })

  it('uat6c S3：普通候选卡与 D182 pendingDup 卡的忽略按钮不受影响', () => {
    renderCard(part())
    expect(screen.getByTestId('card-ignore')).toBeDefined()
    cleanup()
    renderCard(part({ pendingDup: true }))
    expect(screen.getByTestId('card-ignore')).toBeDefined()
    expect(screen.getByTestId('card-confirm')).toBeDefined()
  })
})

describe('D191 旧卡片按当前状态重渲染', () => {
  beforeAll(async () => {
    installMock()
    PaperCardBlock = (await import('./PaperCardBlock')).PaperCardBlock
  })

  function renderLive(kind: CardLiveKind, extra: Partial<PaperCardPart> = {}): { located: Array<number | null | undefined> } {
    const hits: Array<number | null | undefined> = []
    const host = {
      ...HOST,
      cardLiveOf: () => ({ key: 'c9', kind, paperId: kind === 'in_graph' ? 77 : null, candidateId: 9 }),
      onLocateCandidate: (_part: PaperCardPart, paperId?: number | null) => {
        hits.push(paperId)
      }
    }
    render(h(PartsHostContext.Provider, { value: host }, h(PaperCardBlock, {
      part: part({
        id: 'c9',
        title: 'Self-RAG',
        pendingDup: true,
        doi: '10.1/self',
        arxivId: '2401.00001',
        ...extra
      })
    })))
    return { located: hits }
  }

  it('待确认：定位 / 确认加入 / 忽略，并保留去重与未核实提示', () => {
    renderLive('pending', { unverified: true })
    expect(screen.getByTestId('card-pending-dup')).toBeTruthy()
    expect(screen.getByTestId('card-unverified')).toBeTruthy()
    expect(screen.getByTestId('card-locate')).toBeTruthy()
    expect(screen.getByTestId('card-confirm')).toBeTruthy()
    expect(screen.getByTestId('card-ignore')).toBeTruthy()
  })

  it('D199：原先待确认、后来才入图 → 与快照本就在图同一顶部药丸「已在本图谱中」，只剩定位；未核实也消失', () => {
    const { located } = renderLive('in_graph', { unverified: true })
    expect(screen.queryByTestId('card-pending-dup')).toBeNull()
    expect(screen.queryByTestId('card-unverified')).toBeNull()
    const card = screen.getByTestId('part-paper-card')
    expect(card.textContent).toContain('已在本图谱中')
    expect(screen.queryByTestId('card-live-joined')).toBeNull() // 底部灰字「已加入图谱」不再出现
    expect(card.textContent).not.toContain('已加入图谱')
    expect(screen.queryByTestId('card-confirm')).toBeNull()
    expect(screen.queryByTestId('card-ignore')).toBeNull()
    fireEvent.click(screen.getByTestId('card-locate'))
    expect(located).toEqual([77])
  })

  it('D199：两种来源（快照本就在图 / 原先待确认后来入图）渲染同一药丸元素与 class', () => {
    renderLive('in_graph', { inGraph: true, existingPaperId: 77 })
    const snapshotBadge = document.querySelector('.gt-card-intag')
    expect(snapshotBadge?.textContent).toContain('已在本图谱中')
    const snapshotHtml = screen.getByTestId('part-paper-card').querySelector('.gt-card-title')!.innerHTML
    cleanup()
    renderLive('in_graph', { existingPaperId: 77 }) // 快照未写 inGraph：原先待确认、后来才入图
    const joinedBadge = document.querySelector('.gt-card-intag')
    expect(joinedBadge?.textContent).toContain('已在本图谱中')
    const joinedHtml = screen.getByTestId('part-paper-card').querySelector('.gt-card-title')!.innerHTML
    expect(joinedHtml).toBe(snapshotHtml) // 同组件 / 同 class / 同文案
  })

  it('快照本来就是「已在本图谱中」且当前仍在：徽标保留，不给确认 / 忽略 / 未核实', () => {
    renderLive('in_graph', { inGraph: true, existingPaperId: 77, unverified: true })
    expect(screen.getByTestId('part-paper-card').textContent).toContain('已在本图谱中')
    expect(screen.queryByTestId('card-unverified')).toBeNull()
    expect(screen.queryByTestId('card-live-joined')).toBeNull()
    expect(screen.queryByTestId('card-confirm')).toBeNull()
    expect(screen.queryByTestId('card-ignore')).toBeNull()
    expect(screen.getByTestId('card-locate')).toBeTruthy()
  })

  it('D199：快照状态 confirmed（live 不可用）同样只显示「已在本图谱中」药丸，无灰字、无未核实', () => {
    const host = { ...HOST } // 无 cardLiveOf：live 不可用，走消息快照
    render(h(PartsHostContext.Provider, { value: host }, h(PaperCardBlock, {
      part: part({
        id: 'c9',
        title: 'Self-RAG',
        cardStatus: 'confirmed',
        existingPaperId: 77,
        unverified: true
      })
    })))
    const card = screen.getByTestId('part-paper-card')
    expect(card.textContent).toContain('已在本图谱中')
    expect(card.textContent).not.toContain('已加入图谱')
    expect(screen.queryByTestId('card-unverified')).toBeNull()
    expect(screen.queryByTestId('card-confirm')).toBeNull()
    expect(screen.queryByTestId('card-ignore')).toBeNull()
    expect(screen.getByTestId('card-open')).toBeTruthy() // 快照路径保留「打开论文」
  })

  it('已从本图谱移除但仍在库：只留 DOI / arXiv，没有重新加入', () => {
    renderLive('in_library')
    const card = screen.getByTestId('part-paper-card')
    expect(screen.getByTestId('card-live-removed').textContent).toContain('已从本图谱移除')
    expect(card.textContent).toContain('DOI')
    expect(card.textContent).toContain('arXiv')
    expect(screen.queryByTestId('card-confirm')).toBeNull()
    expect(screen.queryByTestId('card-ignore')).toBeNull()
    expect(screen.queryByTestId('card-locate')).toBeNull()
    expect(card.textContent).not.toContain('重新加入')
  })

  it('已从论文库删除：无操作、无链接', () => {
    renderLive('deleted')
    const card = screen.getByTestId('part-paper-card')
    expect(screen.getByTestId('card-live-deleted').textContent).toContain('已从论文库删除')
    expect(card.textContent).not.toContain('DOI')
    expect(screen.queryByTestId('card-confirm')).toBeNull()
    expect(screen.queryByTestId('card-locate')).toBeNull()
  })

  it('已忽略', () => {
    renderLive('ignored')
    expect(screen.getByTestId('card-live-ignored').textContent).toContain('已忽略')
    expect(screen.getByTestId('part-paper-card').textContent).toContain('DOI')
    expect(screen.queryByTestId('card-confirm')).toBeNull()
    expect(screen.queryByTestId('card-ignore')).toBeNull()
  })

  it('同一张卡从待确认重渲染到已加入图谱', () => {
    const kind = { current: 'pending' as CardLiveKind }
    const host = {
      ...HOST,
      cardLiveOf: () => ({ key: 'c9', kind: kind.current, paperId: 77, candidateId: 9 })
    }
    const view = render(h(PartsHostContext.Provider, { value: host }, h(PaperCardBlock, {
      part: part({ id: 'c9', pendingDup: true, title: 'Self-RAG' })
    })))
    expect(screen.getByTestId('card-confirm')).toBeTruthy()
    kind.current = 'in_graph'
    view.rerender(h(PartsHostContext.Provider, { value: { ...host } }, h(PaperCardBlock, {
      part: part({ id: 'c9', pendingDup: true, title: 'Self-RAG' })
    })))
    expect(screen.queryByTestId('card-confirm')).toBeNull()
    expect(screen.getByTestId('part-paper-card').textContent).toContain('已在本图谱中')
    expect(screen.queryByTestId('card-live-joined')).toBeNull()
  })
})
