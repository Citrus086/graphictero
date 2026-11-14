import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { remarkCjkBold } from '../components/richtext/cjkBold'
import { pdfOriginLabel } from '../lib/pdfOriginLabel'
import type { PaperSummary } from '../../../shared/ipc'
import type { ContextRef } from '../../../shared/ipc/agent'
import type { CandProgressEvent, PdfAttemptView } from '../../../shared/ipc/cand'
import type { PaperMetaView, DetailView } from '../../../shared/ipc/detail'
import type { PaperProcessStatusView } from '../../../shared/ipc/pdf'
import { CAND_IMPORTING_PHASES, CAND_PHASE_LABEL, candApi } from '../lib/candProgress'
import { PartsView } from '../components/richtext/PartsView'
import { PartsHostContext } from '../components/richtext/PartsHostContext'
import { PdfReader } from '../components/PdfReader'
import { ConfirmDialog } from '../components/Modal'
import { relTime } from '../lib/format'
import { Ic } from '../lib/icons'
import { useNotify } from '../lib/notify'
import { ipcErrorMessage } from '../lib/ipcError'
import { stepLabel, usePapersStatus } from '../lib/usePapersStatus'
import { progressLine, useParseProgress } from '../lib/useParseProgress'
import { useMineruStatus } from '../lib/useMineruStatus'
import { mineruUnavailableReason } from '../lib/mineruStatus'
import { MotionPresence } from '../components/MotionPresence'

const api = window.graphictero

/** 03b/03h/03d 共用的三步骤（D85：一篇论文一个合并任务） */
const STEPS = ['parse', 'card', 'detail'] as const

/** 摘要来源标签（03g：AI 生成要有小标记） */
function AbstractMarkdown({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="gt-pd-abt">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkCjkBold as never]}
        components={{
          a({ href, title, children }) {
            return (
              <a href={href} title={title ?? href} onClick={(e) => e.preventDefault()}>
                {children}
              </a>
            )
          }
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

function absTag(meta: PaperMetaView): { text: string; title?: string } | null {
  if (!meta.abstract) return null
  if (meta.abstractSource === 'ai') return { text: 'AI 生成', title: '论文元数据和 PDF 中没有找到原文 Abstract，由 Agent 根据正文生成' }
  if (meta.abstractSource === 'openalex') return { text: 'OpenAlex', title: '摘要来自 OpenAlex' }
  return { text: '原文 Abstract' }
}

export function PaperDetailPage({
  paperId,
  onBack,
  onOpenSettings,
  chatOpen,
  onToggleChat,
  onLocate,
  onSendToAgent
}: {
  paperId: number
  graphId?: number
  onBack: () => void
  /** uat1b D144：直达 设置 → PDF 解析（「等待解析组件」的「去设置」） */
  onOpenSettings?: () => void
  /** M5 lane/chat 批 2：D112 对话入口解禁（graphId 无法归属图谱时 App 不给回调，按钮保持禁用） */
  chatOpen?: boolean
  onToggleChat?: () => void
  /** D105-①：阅读器选区「发给 agent」→ quote chip（App 注入 paper 入口抽屉） */
  onSendToAgent?: (ref: ContextRef) => void
  /** D201（uat12）：详情页「定位」→ 回画布平滑 / 瞬时居中该节点并 flash（无图谱归属时 App 不给回调） */
  onLocate?: () => void
}): React.JSX.Element {
  const notify = useNotify()
  const [meta, setMeta] = useState<PaperMetaView | null | undefined>(undefined)
  const [detail, setDetail] = useState<DetailView | null>(null)
  const [detailLoaded, setDetailLoaded] = useState(false)
  const [readerOpen, setReaderOpen] = useState(false)
  /** onOpenFigure 打开阅读器时要定位的图号（1 基，与 data-figure 图号同口径）；null = 不定位 */
  const [readerFigureNo, setReaderFigureNo] = useState<number | null>(null)
  const [staleDismissed, setStaleDismissed] = useState(false)
  /** 03c 二次确认（D42：覆盖当前详情、不保留旧版） */
  const [regenConfirm, setRegenConfirm] = useState(false)

  // ── 03e（M6 lane/ui 批 1，D111/D133）：拖入 / 选择 / 再试一次 / 尝试记录 / 进度 ──
  /** 「尝试过的来源 + 结果 + 时间」（cand:pdfAttempts；null = 加载中） */
  const [nopdfAttempts, setNopdfAttempts] = useState<PdfAttemptView[] | null>(null)
  const [nopdfBusy, setNopdfBusy] = useState<'attach' | 'retry' | null>(null)
  const [nopdfDrag, setNopdfDrag] = useState(false)
  /** 本论文的入库/查 PDF 进度（event:cand:progress） */
  const [nopdfPhase, setNopdfPhase] = useState<CandProgressEvent | null>(null)
  const nopdfInputRef = useRef<HTMLInputElement>(null)
  /** done 后 1.5s 兜底重拉的句柄：换 paperId 或卸载时必须清掉，否则会把上一篇元数据写进新页 */
  const metaReloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearMetaReloadTimer = (): void => {
    if (metaReloadTimer.current != null) {
      clearTimeout(metaReloadTimer.current)
      metaReloadTimer.current = null
    }
  }

  const statusMap = usePapersStatus([paperId])
  const status: PaperProcessStatusView | undefined = statusMap.get(paperId)
  const progress = useParseProgress(status?.state === 'running' && status.currentStep === 'parse' ? paperId : null)
  // uat1b D144：MinerU 不可用原因（未处理视图显示「等待解析组件」+ 去设置）
  const mineruReason = mineruUnavailableReason(useMineruStatus()?.state)

  /** 换页后丢弃仍在途的 getPaperMeta / getDetail，避免旧论文写进新页 */
  const metaGen = useRef(0)
  const detailGen = useRef(0)
  const loadMeta = useCallback((): void => {
    const gen = ++metaGen.current
    api
      .getPaperMeta(paperId)
      .then((m) => {
        if (metaGen.current === gen) setMeta(m)
      })
      .catch(() => {
        if (metaGen.current === gen) setMeta(null)
      })
  }, [paperId])

  const loadDetail = useCallback((): void => {
    const gen = ++detailGen.current
    api
      .getDetail(paperId)
      .then((d) => {
        if (detailGen.current !== gen) return
        setDetail(d)
        setDetailLoaded(true)
      })
      .catch(() => {
        if (detailGen.current !== gen) return
        setDetail(null)
        setDetailLoaded(true)
      })
  }, [paperId])

  useEffect(() => {
    clearMetaReloadTimer()
    setMeta(undefined)
    setDetail(null)
    setDetailLoaded(false)
    setReaderOpen(false)
    setStaleDismissed(false)
    // 评审必须修 2：同一页换 paperId（gt:open-paper）时复位 03e 状态，
    // 避免上一篇的进度/尝试记录画在新论文上；pdfAttempts 先回到「加载中」
    setNopdfPhase(null)
    setNopdfAttempts(null)
    setNopdfBusy(null)
    setNopdfDrag(false)
    loadMeta()
    loadDetail()
  }, [paperId, loadMeta, loadDetail])

  // 重新生成完成（任务成功）→ 重拉详情
  const state = status?.state
  useEffect(() => {
    if (state === 'succeeded') loadDetail()
  }, [state, loadDetail])

  // M5 起主进程推送 event:detail:updated；批 1 先订阅（触发时重拉），完成推送的接线归批 2/维护者
  useEffect(() => api.onDetailUpdated((id) => {
    if (id === paperId) loadDetail()
  }), [paperId, loadDetail])

  // 03e：无 PDF，或开放获取 PDF（用来源尝试记录显示 arXiv / OpenAlex / Unpaywall）
  useEffect(() => {
    const want = meta != null && (meta.hasPdf === false || (meta.hasPdf && meta.pdfSource === 'open_access'))
    if (!want) return
    let disposed = false
    candApi()
      .pdfAttempts({ paperId })
      .then((list) => !disposed && setNopdfAttempts(list))
      .catch(() => !disposed && setNopdfAttempts([]))
    return () => {
      disposed = true
    }
  }, [meta?.hasPdf, meta?.pdfSource, paperId])

  // 03e：入库/查 PDF 进度（lane/fetch 推送；本批 UI 先订阅）。parsing/done 时重拉元数据——
  // hasPdf 翻真后视图自动切到正常详情（D111「成功后切到正常详情」）；done 后再兜底重拉一次，
  // 盖住「事件早于落库」的空窗（配合下方「完成，正在打开详情…」行，建议修 5）
  useEffect(() => {
    let disposed = false
    const unsub = candApi().onCandProgress((e) => {
      if (disposed || e.paperId !== paperId) return
      setNopdfPhase(e)
      if (e.phase === 'parsing' || e.phase === 'done') {
        loadMeta()
        if (e.phase === 'done') {
          clearMetaReloadTimer()
          metaReloadTimer.current = setTimeout(() => {
            metaReloadTimer.current = null
            loadMeta()
          }, 1500)
        }
      }
      if (e.phase === 'no_pdf' || e.phase === 'failed') {
        candApi()
          .pdfAttempts({ paperId })
          .then((list) => {
            if (!disposed) setNopdfAttempts(list)
          })
          .catch(() => {})
      }
    })
    return () => {
      disposed = true
      unsub()
      clearMetaReloadTimer()
    }
  }, [paperId, loadMeta])

  /** 03e 拖入 / 选择文件：只经 getPathForFile 拿路径传给 cand:attachPdf，不读字节（D111） */
  const nopdfAttach = async (f: File): Promise<void> => {
    if (nopdfBusy) return
    if (!f.name.toLowerCase().endsWith('.pdf')) {
      notify('只支持 PDF 文件')
      return
    }
    // 建议修 3：拿不到磁盘路径（合成 File / 非磁盘来源）直接提示，不发 IPC（契约 min(1) 会拒空串）
    let filePath = ''
    try {
      filePath = api.getPathForFile(f)
    } catch {
      filePath = ''
    }
    if (!filePath) {
      notify('没有拿到这个文件的路径，请用「选择文件…」重新选择 PDF')
      return
    }
    setNopdfBusy('attach')
    try {
      await candApi().attachPdf({ paperId, filePath })
      notify('已收到 PDF，开始处理')
    } catch (e) {
      notify(ipcErrorMessage(e, '拖入失败，请重试'))
    } finally {
      setNopdfBusy(null)
    }
  }

  /** 03e「再试一次查找」：按当前设置的来源顺序重跑（D133，顺序归设置页「PDF 来源」） */
  const nopdfRetry = async (): Promise<void> => {
    if (nopdfBusy) return
    setNopdfBusy('retry')
    try {
      await candApi().retryFindPdf({ paperId })
    } catch (e) {
      notify(ipcErrorMessage(e, '查找失败，请重试'))
    } finally {
      setNopdfBusy(null)
    }
  }

  const regenerate = async (): Promise<void> => {
    setRegenConfirm(false)
    try {
      await api.regenerateDetail(paperId)
      notify('已排队重新生成详情')
    } catch (e) {
      notify(ipcErrorMessage(e, '排队失败，请重试'))
    }
  }

  const retry = async (): Promise<void> => {
    if (!status?.jobId) return
    try {
      await api.retryJob(status.jobId)
      notify('已重新排队，从失败的那一步接着处理')
    } catch (e) {
      notify(ipcErrorMessage(e, '重试失败'))
    }
  }

  // ── 头部（原型 head()）：标题 + 作者 · 年份 · 出处 · DOI · Zotero item key ──
  const head = (m: PaperMetaView): React.JSX.Element => (
    <>
      <div className="gt-pd-title">{m.title || '（无标题）'}</div>
      <div className="gt-pd-meta">
        <span>{m.authors.length > 0 ? m.authors.join(', ') : '—'}</span>
        <span className="s">·</span>
        <span>{m.year ?? '—'}</span>
        <span className="s">·</span>
        <span>{m.venue ?? '发表于 —'}</span>
        <span className="s">·</span>
        <span>DOI {m.doi ?? '—'}</span>
        {m.zoteroItemKey && (
          <>
            <span className="s">·</span>
            {/* uat1b：item key 是开发者字段，收进 tooltip，不作主文案 */}
            <span className="s" title={`Zotero item key ${m.zoteroItemKey}`}>
              Zotero 导入
            </span>
          </>
        )}
        {/* uat1b：有 PDF 时来源行如实写 PDF 来自哪里 */}
        {m.hasPdf && m.pdfSource && (
          <>
            <span className="s">·</span>
            <span className="s">PDF 来自 {pdfOriginLabel(m.pdfSource, nopdfAttempts)}</span>
          </>
        )}
      </div>
    </>
  )

  const openPdf = (): void => {
    setReaderFigureNo(null) // 普通「打开 PDF」入口不定位（行为不变）
    setReaderOpen(true)
  }

  /** 图块点击（评审 review_lane_detail2 §6-2）：同一阅读器，定位到该图 */
  const openFigure = (figureNo: number): void => {
    setReaderFigureNo(figureNo)
    setReaderOpen(true)
  }

  /** PdfReader 只消费 id/title，用元数据拼一个最小 PaperSummary（D105①） */
  const readerPaper = (m: PaperMetaView): PaperSummary => ({
    id: m.paperId,
    title: m.title,
    firstAuthor: m.authors[0] ?? null,
    year: m.year,
    hasPdf: true,
    doi: m.doi,
    arxivId: null,
    source: m.source,
    inGraph: false
  })

  // ── 03b / 03h / 等待 / 未处理：一个合并任务的三步骤 ──
  const processingView = (m: PaperMetaView): React.JSX.Element => {
    const st = status?.state ?? 'unprocessed'
    const activeStep = status?.currentStep ?? null
    const stepState = (step: (typeof STEPS)[number]): 'done' | 'active' | 'pending' => {
      if (st === 'succeeded') return 'done'
      const idx = STEPS.indexOf(step)
      if (activeStep === step) return 'active'
      if (activeStep) {
        const activeIdx = STEPS.indexOf(activeStep as (typeof STEPS)[number])
        return activeIdx >= 0 && idx < activeIdx ? 'done' : 'pending'
      }
      return 'pending'
    }
    const waiting = st === 'queued' || st === 'waiting'
    const unprocessedWaiting = st === 'unprocessed' && mineruReason != null
    const title =
      st === 'running'
        ? activeStep === 'detail'
          ? '正在生成详情'
          : '正在解析 PDF'
        : waiting
          ? '排队中，等待处理'
          : unprocessedWaiting
            ? '等待解析组件'
            : '等待处理'
    return (
      <div className="gt-pd-col">
        {head(m)}
        <div className="gt-pd-bar">
          {/* 评审建 2：只在 MinerU 解析步禁用（PDF 尚在解析）；card/detail 步（03h）可打开 */}
          <button
            className="btn bordered"
            disabled={st === 'running' && activeStep === 'parse'}
            title={st === 'running' && activeStep === 'parse' ? '解析中暂不可打开' : '在内置阅读器中打开'}
            onClick={() => openPdf()}
          >
            <Ic name="doc" size={14} />
            打开 PDF
          </button>
        </div>
        <div className="gt-pd-taskbox">
          <div className="gt-pd-tasktitle">{title}</div>
          <div className="t3" style={{ fontSize: 12.5, lineHeight: '19px' }}>
            {st === 'running' && activeStep === 'parse' && progress
              ? `MinerU 任务状态：解析中 · ${progressLine(progress)}`
              : st === 'running'
                ? '解析完成后会自动生成详情，完成后这里直接显示。'
                : unprocessedWaiting
                  ? (
                    <span data-testid="pd-wait-parse">
                      {mineruReason}，可用后会自动开始处理。
                      {onOpenSettings && (
                        <button className="btn lnk" style={{ fontSize: 12.5 }} onClick={onOpenSettings}>
                          去设置（PDF 解析）
                        </button>
                      )}
                    </span>
                  )
                  : st === 'unprocessed'
                    ? '未处理：MinerU 可用后会自动开始处理。'
                    : (status?.error ? `等待中：${status.error}` : 'MinerU 解析 → 生成名片 → 生成详情')}
          </div>
          <div className="gt-pd-steps">
            {STEPS.map((s) => {
              const ss = stepState(s)
              return (
                <div key={s} className={`gt-pd-step ${ss}`}>
                  <span className="gt-pd-stepic">
                    {ss === 'done' ? <Ic name="check" size={13} /> : ss === 'active' ? <span className="gt-pd-spin" /> : null}
                  </span>
                  <span className="grow">{stepLabel(s)}</span>
                  <span className="gt-pd-steptxt">
                    {ss === 'done' ? '完成' : ss === 'active' ? (s === 'parse' ? '解析中' : '生成中…') : '等待'}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  // ── 03d / 03d2：处理失败（步骤、原因、时间、按步骤重试 D85）──
  const failedView = (m: PaperMetaView): React.JSX.Element => {
    const failedStep = status?.failedStep ?? null
    const isParse = failedStep === 'parse'
    // 评审建 1（03d2）：失败步骤之前的步骤实际已成功 → 显示「完成」，之后才是「等待」
    const failedIdx = failedStep ? STEPS.indexOf(failedStep as (typeof STEPS)[number]) : -1
    return (
      <div className="gt-pd-col">
        {head(m)}
        <div className="gt-pd-bar">
          <button className="btn bordered" disabled={!m.hasPdf} onClick={() => openPdf()}>
            <Ic name="doc" size={14} />
            打开 PDF
          </button>
        </div>
        <div className="gt-pd-taskbox">
          <div className="row" style={{ gap: 8, fontSize: 14, fontWeight: 600 }}>
            <span className="gt-pd-faildot" />
            处理失败{failedStep ? ` · ${stepLabel(failedStep)}` : ''}
            {status?.updatedAt && (
              <span className="t3" style={{ fontSize: 11, fontWeight: 400, marginLeft: 'auto' }}>
                {relTime(status.updatedAt)}
              </span>
            )}
          </div>
          {status?.error && (
            <div className="t3" style={{ fontSize: 12.5, lineHeight: '19px' }}>
              {status.error}
            </div>
          )}
          <div className="gt-pd-steps">
            {STEPS.map((s, idx) => {
              const st = s === failedStep ? 'failed' : idx >= 0 && idx < failedIdx ? 'done' : 'pending'
              return (
                <div key={s} className={`gt-pd-step ${st}`}>
                  <span className="gt-pd-stepic">
                    {st === 'failed' ? <Ic name="close" size={12} /> : st === 'done' ? <Ic name="check" size={13} /> : null}
                  </span>
                  <span className="grow">{stepLabel(s)}</span>
                  <span className="gt-pd-steptxt">{st === 'failed' ? '失败' : st === 'done' ? '完成' : '等待'}</span>
                </div>
              )
            })}
          </div>
          <div className="row" style={{ gap: 10 }}>
            <button className="btn primary" disabled={!status?.jobId} onClick={() => void retry()}>
              <Ic name="refresh" size={14} />
              重试
            </button>
            <span className="t3" style={{ fontSize: 11.5, lineHeight: '17px' }}>
              {!isParse && '该步骤已自动重试 3 次仍未成功，重试会从这一步接着做，前面的步骤不重做。'}
            </span>
          </div>
        </div>
      </div>
    )
  }

  // ── 03e（D111/M6 lane/ui 批 1）：元数据 + 摘要 + 拖入/选择 PDF + 再试一次 + 尝试过的来源 ──
  const noPdfView = (m: PaperMetaView): React.JSX.Element => {
    const tag = absTag(m)
    const importing = nopdfPhase != null && CAND_IMPORTING_PHASES.has(nopdfPhase.phase)
    const triedText =
      nopdfAttempts == null
        ? '加载中…'
        : nopdfAttempts.length === 0
          ? '还没有查找过，点「再试一次查找」按当前来源顺序查找。'
          : nopdfAttempts
              .map(
                (a) =>
                  `${a.source}（${a.result === 'ok' ? '已找到' : a.result === 'error' ? '出错' : '未找到'}${a.at ? `，${relTime(a.at)}` : ''}）`
              )
              .join('，')
    return (
      <div className="gt-pd-col">
        <div className="gt-pd-title">{m.title || '（无标题）'}</div>
        <div className="gt-pd-meta">
          <span className="nptag0">无 PDF</span>
          <span className="s">不参与关系生成，也没有详情解读</span>
        </div>
        <div className="gt-pd-kv">
          <span>作者</span>
          <span>{m.authors.length > 0 ? m.authors.join(', ') : '—'}</span>
          <span>年份</span>
          <span>{m.year ?? '—'}</span>
          <span>DOI</span>
          <span>{m.doi ?? '—'}</span>
          <span>发表于</span>
          <span>{m.venue ?? '—'}</span>
          <span>来源</span>
          {/* uat1b：按真实状态显示——附件没取到 ≠ 条目没有附件；item key 收进 tooltip。
              uat1-fix1 建议修 2：括号只描述 Zotero 条目，Agent 添加的论文没有 Zotero 条目 */}
          <span title={m.zoteroItemKey ? `Zotero item key ${m.zoteroItemKey}` : undefined}>
            {m.source === 'zotero' ? 'Zotero 导入' : 'Agent 添加'}
            {m.source === 'zotero'
              ? m.pdfUnresolved
                ? '（条目有 PDF 附件，但没找到文件）'
                : '（条目没有 PDF 附件）'
              : ''}
          </span>
        </div>
        {m.pdfUnresolved && (
          <div className="t3" style={{ fontSize: 12, lineHeight: '18px' }}>
            可重新导入该分类补齐，或把 PDF 拖进本页下方的拖入区（D133）。
          </div>
        )}
        {m.abstract && (
          <div className="gt-pd-abs">
            <div className="gt-pd-absh">
              <span>摘要</span>
              {tag && (
                <span className="gt-pd-aitag" title={tag.title}>
                  {tag.text}
                </span>
              )}
            </div>
            <AbstractMarkdown text={m.abstract} />
          </div>
        )}
        {/* M6 lane/ui 批 1（D111）：拖入 / 选择文件 → cand:attachPdf；只收 .pdf，dragover 高亮 */}
        <div
          className={`gt-pd-dropz${nopdfDrag ? ' over' : ''}`}
          data-testid="nopdf-drop"
          onDragOver={(e) => {
            e.preventDefault()
            setNopdfDrag(true)
          }}
          onDragLeave={() => setNopdfDrag(false)}
          onDrop={(e) => {
            e.preventDefault()
            setNopdfDrag(false)
            const f = e.dataTransfer.files?.[0]
            if (f) void nopdfAttach(f)
          }}
          onClick={() => nopdfInputRef.current?.click()}
        >
          <Ic name="import" size={22} w={1.3} />
          <div style={{ fontSize: 13.5, marginTop: 8 }}>把 PDF 拖到这里</div>
          <div className="t3" style={{ fontSize: 12, marginTop: 2 }}>
            或 <span className="gt-pd-linkbtn">选择文件…</span>
          </div>
          <div className="t3" style={{ fontSize: 12.5, marginTop: 14 }}>
            拖入并解析后，会自动生成详情，并为这篇论文补上关系。
          </div>
          {nopdfBusy === 'attach' && (
            <div className="t3" style={{ fontSize: 12, marginTop: 8, display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}>
              <span className="gt-pd-spin" />
              正在接收 PDF…
            </div>
          )}
          <input
            ref={nopdfInputRef}
            type="file"
            accept=".pdf,application/pdf"
            style={{ display: 'none' }}
            data-testid="nopdf-file-input"
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void nopdfAttach(f)
            }}
          />
        </div>
        {/* 进度行（event:cand:progress）；done 但 hasPdf 未翻真时显示「完成，正在打开详情…」
            （事件早于落库的空窗，建议修 5）；翻真后视图自动切走 */}
        {(importing ||
          nopdfPhase?.phase === 'failed' ||
          nopdfPhase?.phase === 'no_pdf' ||
          (nopdfPhase?.phase === 'done' && !m.hasPdf)) && (
          <div className="gt-pd-tried" data-testid="nopdf-progress">
            {importing ? (
              <span className="gt-pd-spin" />
            ) : (
              <Ic name={nopdfPhase?.phase === 'failed' ? 'warn' : 'info'} size={14} />
            )}
            <span className="grow">
              {nopdfPhase?.phase === 'done'
                ? '完成，正在打开详情…'
                : nopdfPhase
                  ? CAND_PHASE_LABEL[nopdfPhase.phase]
                  : ''}
              {nopdfPhase?.message && nopdfPhase.phase !== 'done' ? ` · ${nopdfPhase.message}` : ''}
            </span>
          </div>
        )}
        <div className="gt-pd-tried">
          <span className="grow" data-testid="nopdf-tried">
            尝试过的来源：{triedText}
          </span>
          <button
            className="btn bordered sm"
            data-testid="nopdf-retry"
            disabled={nopdfBusy != null || importing}
            onClick={() => void nopdfRetry()}
          >
            <Ic name="refresh" size={13} />
            再试一次查找
          </button>
        </div>
        <div className="t3" style={{ fontSize: 11.5 }}>
          查找顺序可在 设置 › PDF 来源 中调整。
        </div>
      </div>
    )
  }

  // ── 03 正文：头部 + dbar + 过期条 + 摘要 + PartsView ──
  const detailBody = (m: PaperMetaView): React.JSX.Element => {
    const tag = absTag(m)
    const staleText =
      detail?.staleReason === 'pdf'
        ? '可能已过期：PDF 已更换为新版本。详情不会自动更新。'
        : '可能已过期：详情生成 prompt 已更新。详情不会自动更新。'
    return (
      <div className="gt-pd-col">
        {head(m)}
        <div className="gt-pd-bar">
          <button className="btn bordered" disabled={!m.hasPdf} onClick={() => openPdf()}>
            <Ic name="doc" size={14} />
            打开 PDF
          </button>
          {/* D201（uat12）：回画布定位该论文（视口平滑 / 瞬时居中 + flash，画布就绪后消费一次） */}
          {onLocate && (
            <button className="btn bordered" data-testid="pd-locate" title="回到图谱并定位到该论文" onClick={onLocate}>
              定位
            </button>
          )}
          <div className="grow" />
          {/* M5 前置 2a：手动重新生成（detail_regen）进行中——顶栏转圈提示，正文仍是
              缓存详情（不切 03h 三步骤视图，名片早已就绪）；完成后 event:detail:updated
              刷新内容、指示器经 5s 兜底轮询消失 */}
          {status?.detailRegen != null && detail && (
            <span
              className="t3"
              data-testid="regen-indicator"
              style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}
            >
              <span className="gt-pd-spin" />
              重新生成中…
            </span>
          )}
          <span className="t3" style={{ fontSize: 12 }}>
            {detail ? `${detail.model} · 生成于 ${relTime(detail.generatedAt)}` : '还没有详情'}
          </span>
          <button className="btn" style={{ color: 'var(--text2)' }} onClick={() => setRegenConfirm(true)}>
            <Ic name="refresh" size={14} />
            重新生成
          </button>
        </div>
        {detail && detail.staleReason && !staleDismissed && (
          <div className="gt-pd-stale" data-testid="stale-bar">
            <Ic name="info" size={14} />
            <span className="grow">{staleText}</span>
            <span className="gt-pd-linkbtn" onClick={() => setRegenConfirm(true)}>
              重新生成
            </span>
            <span
              className="t3"
              style={{ cursor: 'pointer', display: 'flex' }}
              title="关闭提示"
              onClick={() => setStaleDismissed(true)}
            >
              <Ic name="close" size={13} />
            </span>
          </div>
        )}
        {m.abstract && (
          <div className="gt-pd-abs">
            <div className="gt-pd-absh">
              <span>摘要</span>
              {tag && (
                <span className="gt-pd-aitag" title={tag.title}>
                  {tag.text}
                </span>
              )}
            </div>
            <AbstractMarkdown text={m.abstract} />
          </div>
        )}
        {detail ? (
          <PartsHostContext.Provider value={{ paperId }}>
            <PartsView parts={detail.parts} onOpenFigure={openFigure} />
          </PartsHostContext.Provider>
        ) : (
          detailLoaded && (
            <div className="hintbar" style={{ marginTop: 12 }}>
              <Ic name="info" size={14} />
              <span>还没有详情：处理完成后会自动生成。</span>
            </div>
          )
        )}
      </div>
    )
  }

  let body: React.JSX.Element
  if (meta === undefined) {
    body = (
      <div className="gt-pd-col">
        <div className="t3" style={{ fontSize: 13 }}>正在加载…</div>
      </div>
    )
  } else if (meta === null) {
    body = (
      <div className="gt-pd-col">
        <div className="t3" style={{ fontSize: 13 }}>论文不存在或已从论文库删除。</div>
      </div>
    )
  } else if (status?.state === 'failed') {
    body = failedView(meta)
  } else if (status && ['queued', 'running', 'waiting'].includes(status.state)) {
    body = processingView(meta)
  } else if (status?.state === 'unprocessed' && meta.hasPdf) {
    // D95：从未入队（如 MinerU 未就绪期间的导入）→ 等待处理视图
    body = processingView(meta)
  } else if (!meta.hasPdf) {
    body = noPdfView(meta)
  } else {
    body = detailBody(meta)
  }

  return (
    <>
      <div className="maincol" data-testid="paper-detail-page">
        <div className="toolbar">
          {/* 红绿灯占位必须是顶栏第一个子元素（所有渲染状态共用本顶栏） */}
          <span className="tlinset" data-testid="pd-tlinset" />
          <button className="btn" style={{ color: 'var(--text2)', paddingLeft: 6 }} onClick={onBack}>
            <Ic name="back" size={15} />
            返回
          </button>
          <span className="t3" style={{ margin: '0 2px' }}>
            /
          </span>
          <span className="ttl" style={{ marginLeft: 4 }} title={meta?.title ?? ''}>
            {meta && meta !== null ? (meta.title.length > 30 ? `${meta.title.slice(0, 30)}…` : meta.title) : '论文详情'}
          </span>
          <div className="grow" />
          {/* D112：对话入口（M5 lane/chat 批 2 解禁）；graphId 无图谱归属时禁用 */}
          <button
            className={`btn icon${chatOpen ? ' gt-pd-chat-on' : ''}`}
            data-testid="pd-chat"
            disabled={!onToggleChat}
            title={onToggleChat ? '对话' : '先打开一张图谱后再使用对话'}
            onClick={onToggleChat}
          >
            <Ic name="chat" size={15} />
          </button>
        </div>
        <div className="ws">
          <div className="gt-pd-page">{body}</div>
        </div>
      </div>
      <MotionPresence open={readerOpen && meta != null} kind="modal">
        {readerOpen && meta ? (
        <PdfReader
          paper={readerPaper(meta)}
          initialFigureNo={readerFigureNo ?? undefined}
          onClose={() => {
            setReaderOpen(false)
            setReaderFigureNo(null)
          }}
          onSendToAgent={
            onSendToAgent
              ? (quote) => onSendToAgent({ kind: 'quote', paperId, page: quote.page, text: quote.text })
              : undefined
          }
          onOpenChat={onToggleChat}
        />
        ) : null}
      </MotionPresence>

      <MotionPresence open={regenConfirm} kind="modal">
        {regenConfirm ? (
        <ConfirmDialog title="重新生成详情？" okText="重新生成" okMuted onOk={() => void regenerate()} onClose={() => setRegenConfirm(false)}>
          会用当前 PDF 和 prompt 重新生成，并覆盖现在的详情。
          <div className="t3" style={{ fontSize: 11.5, lineHeight: '17px', marginTop: 8 }}>
            不保留旧版内容；不能用 ⌘Z 撤销。
          </div>
        </ConfirmDialog>
        ) : null}
      </MotionPresence>
    </>
  )
}
