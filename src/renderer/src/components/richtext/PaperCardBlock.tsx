import { useEffect, useRef, useState } from 'react'
import type { CardLiveState } from '../../../../shared/ipc/agent'
import type { CandProgressEvent } from '../../../../shared/ipc/cand'
import type { PaperCardPart } from '../../../../shared/parts'
import { usePartsHost } from './PartsHostContext'
import { Ic } from '../../lib/icons'
import { ipcErrorMessage } from '../../lib/ipcError'
import { useNotify } from '../../lib/notify'
import { CAND_IMPORTING_PHASES, CAND_PHASE_LABEL, candidateIdOfPartId, candApi } from '../../lib/candProgress'
import { displayCandidateReason } from '../../../../shared/candidateReason'

/**
 * M5 lane/chat 批 3：data-paper-card 候选论文卡片（D32/D30，原型对话内卡片）。
 * M6 lane/ui 批 1：库外候选确认实装 + 入库链路四态（D124/D130）+ 点击跳论文。
 *
 * - 展示：标题 / 作者 · 年份 · 出处 / 推荐理由 / 状态徽标（经宿主 candidateStatusOf 同步
 *   画布侧确认/忽略的最新状态）。
 * - 四态（event:cand:progress，按 part.id=`c${候选id}` 匹配，M5 9a797a6 口径）：
 *   入库中（importing/locating/downloading/parsing）→ 失败可重试（failed）→
 *   无 PDF（no_pdf，可再试查找/打开论文）→ 已入库（done，点击跳 03/03e）。
 * - 操作：「已在库中」（existingPaperId）→ 确认 = 加入图谱（宿主回调，M5 口径）；
 *   库外候选 → 确认 = cand:importConfirm（立即返回，进度走事件，D124）；忽略 always 可用。
 * - 跳论文：已入库/在库中的卡片点击标题或「打开论文」→ window 事件 'gt:open-paper'
 *   （App 监听开 03；无图谱归属时 graphId 缺省，与首页入口同口径）。
 */
export function PaperCardBlock({ part }: { part: PaperCardPart }): React.JSX.Element {
  const host = usePartsHost()
  const notify = useNotify()
  const status = host.candidateStatusOf?.(part) ?? part.cardStatus
  const inLibrary = part.existingPaperId != null
  const inGraph = part.inGraph === true
  const liveRaw = host.cardLiveOf?.(part) ?? null
  const live = liveRaw && liveRaw.kind !== 'unknown' ? liveRaw : null
  const act = host.onCandidateAction
  const candidateId = candidateIdOfPartId(part.id)
  const [prog, setProg] = useState<CandProgressEvent | null>(null)

  useEffect(() => {
    if (candidateId == null) return
    return candApi().onCandProgress((e) => {
      if (e.candidateId === candidateId) setProg(e)
    })
  }, [candidateId])

  const importing = prog != null && CAND_IMPORTING_PHASES.has(prog.phase)
  const failed = prog?.phase === 'failed'
  const noPdf = prog?.phase === 'no_pdf'
  const importedDone = prog?.phase === 'done'
  /** 跳转目标：入库链路给的 paperId 优先，其次「已在库中」的 existingPaperId */
  const jumpPaperId = (noPdf || importedDone) && prog && prog.paperId > 0 ? prog.paperId : (part.existingPaperId ?? null)

  const openPaper = (): void => {
    if (jumpPaperId != null) window.dispatchEvent(new CustomEvent('gt:open-paper', { detail: jumpPaperId }))
  }

  /** 库外确认：cand:importConfirm（立即返回 {paperId, jobId}，进度走事件）。 */
  /** 本次 importConfirm 的票。失败时只清掉仍停在这次「入库中」的进度，done 先到则保留。 */
  const importTicket = useRef(0)
  const importConfirm = (): void => {
    if (candidateId == null) return
    const ticket = ++importTicket.current
    setProg({ candidateId, paperId: 0, phase: 'importing' })
    candApi()
      .importConfirm({ candidateId })
      .then((r) => {
        setProg((cur) => (cur?.phase === 'importing' ? { candidateId, paperId: r.paperId, phase: 'importing' } : cur))
        notify('已确认加入')
        // uat5 必须修 4：卡片确认后画布即时刷新（画布候选节点 / 顶栏计数不必等入库进度）
        window.dispatchEvent(new CustomEvent('gt:graph-changed'))
      })
      .catch((e: unknown) => {
        setProg((cur) => (ticket === importTicket.current && cur?.phase === 'importing' ? null : cur))
        notify(ipcErrorMessage(e, '入库失败，请重试'))
      })
  }

  /** 失败重试：论文已经入库（paperId > 0）走 retryFindPdf；确认本身没入库才再 importConfirm
   *  （review_lane_fetch1 合并注意 7：再 importConfirm 会得到空 jobId，卡片停在「正在入库」） */
  const retryFailed = (): void => {
    if (prog != null && prog.paperId > 0) {
      const paperId = prog.paperId
      candApi()
        .retryFindPdf({ paperId })
        .catch((e: unknown) => notify(ipcErrorMessage(e, '查找失败，请重试')))
      return
    }
    importConfirm()
  }

  /** uat6b S4(a)：库内确认（加入图谱）busy——ref 守卫守到宿主 IPC 的 finally：
   *  与画布 importGuard 同口径挡住同 tick 双击；慢于 400ms 的 IPC 也不会被提前放行 */
  const confirmBusyRef = useRef(false)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const confirm = (): void => {
    if (inLibrary) {
      if (!act || confirmBusyRef.current) return
      confirmBusyRef.current = true
      setConfirmBusy(true)
      let r: void | Promise<void>
      try {
        r = act(part, 'confirm')
      } catch (e) {
        confirmBusyRef.current = false
        setConfirmBusy(false)
        throw e
      }
      if (r != null && typeof (r as Promise<void>).finally === 'function') {
        void (r as Promise<void>).finally(() => {
          confirmBusyRef.current = false
          setConfirmBusy(false)
        })
      } else {
        // 宿主同步实现：只挡同 tick，同步返回即放行
        confirmBusyRef.current = false
        setConfirmBusy(false)
      }
      return
    }
    importConfirm()
  }

  /** 无 PDF 态：按当前来源顺序再查一次（D133）；进度以事件为准，不做乐观相位 */
  const retryFindPdf = (): void => {
    if (prog == null || prog.paperId <= 0 || candidateId == null) return
    const paperId = prog.paperId
    candApi().retryFindPdf({ paperId }).catch((e: unknown) => {
      notify(ipcErrorMessage(e, '查找失败，请重试'))
    })
  }

  const titleCls = jumpPaperId != null && live?.kind !== 'deleted' ? 'gt-card-jump' : undefined
  // uat6c M1：状态码 / 空理由不显示理由行（状态走「已在本图谱中」徽标等独立表达）
  const reasonText = displayCandidateReason(part.reason)
  const progressOpen = importing || failed || noPdf || importedDone
  const liveNow = live != null && !progressOpen ? live : null
  // D199：只要当前已在本图谱（live 在图、快照 inGraph、或快照状态 confirmed——确认即入图），
  // 都显示同一个顶部药丸「已在本图谱中」，不再用底部灰字「已加入图谱」区分。
  const snapshotInGraph = status === 'confirmed'
  const showInGraphBadge = liveNow ? liveNow.kind === 'in_graph' : inGraph || snapshotInGraph
  const currentlyInGraph = liveNow ? liveNow.kind === 'in_graph' : inGraph || snapshotInGraph
  const showLibraryBadge = liveNow ? false : !inGraph && inLibrary
  const showPendingHint = part.pendingDup === true && (liveNow == null || liveNow.kind === 'pending')

  const locate = (paperId?: number | null): void => {
    host.onLocateCandidate?.(part, paperId)
  }

  return (
    <div className="gt-part-card" data-testid="part-paper-card" data-status={status} data-live={liveNow?.kind}>
      <div className="gt-card-title">
        <Ic name="doc" size={13} />
        <b className={titleCls} title={jumpPaperId != null && live?.kind !== 'deleted' ? '打开论文详情' : undefined} onClick={live?.kind === 'deleted' ? undefined : openPaper}>
          {part.title}
        </b>
        {showInGraphBadge ? (
          <span className="gt-card-intag" title="这篇论文已在本图谱中">
            已在本图谱中
          </span>
        ) : (
          showLibraryBadge && (
            <span className="gt-card-intag" title="这篇论文已在论文库中">
              已在论文库中
            </span>
          )
        )}
      </div>
      <div className="gt-card-meta">
        {part.authors.length > 0 && <span>{part.authors.join(', ')}</span>}
        {part.year != null && <span>· {part.year}</span>}
        {part.venue && <span>· {part.venue}</span>}
      </div>
      {live?.kind === 'deleted' ? null : <CardLinks part={part} />}
      {showPendingHint && (
        <div className="gt-card-hint" data-testid="card-pending-dup">
          已在待确认候选中 · #{candidateId ?? '—'}
        </div>
      )}
      {part.titleDup && <div className="gt-card-hint">可能是已有论文的另一版本</div>}
      {part.unverified && !currentlyInGraph && (
        <div className="gt-card-hint gt-card-unverified" data-testid="card-unverified">
          {part.doi || part.arxivId ? '未核实' : '未找到可核实的记录'}
        </div>
      )}
      {reasonText && <div className="gt-card-reason">{reasonText}</div>}
      <div className="gt-card-actions">
        {importing ? (
          <span className="gt-card-prog" data-testid="card-progress">
            <span className="gt-pd-spin" />
            {prog ? CAND_PHASE_LABEL[prog.phase] : ''}
            {prog?.message ? ` · ${prog.message}` : ''}
          </span>
        ) : failed ? (
          <>
            <button type="button" className="btn bordered sm" data-testid="card-retry" onClick={retryFailed}>
              重试入库
            </button>
            <span className="gt-card-warn">{prog?.message ?? '入库失败'}</span>
          </>
        ) : noPdf ? (
          <>
            <span className="gt-card-done">已入库 · 未找到 PDF</span>
            <button
              type="button"
              className="btn bordered sm"
              data-testid="card-retry-pdf"
              disabled={prog == null || prog.paperId <= 0}
              onClick={retryFindPdf}
            >
              再试查找
            </button>
            {jumpPaperId != null && (
              <button type="button" className="btn bordered sm gt-card-open" data-testid="card-open" onClick={openPaper}>
                <Ic name="doc" size={12} />
                打开论文
              </button>
            )}
          </>
        ) : importedDone ? (
          <>
            <span className="gt-card-done">已入库</span>
            {jumpPaperId != null && (
              <button type="button" className="btn bordered sm gt-card-open" data-testid="card-open" onClick={openPaper}>
                <Ic name="doc" size={12} />
                打开论文
              </button>
            )}
          </>
        ) : liveNow ? (
          <LiveCardActions
            live={liveNow}
            part={part}
            candidateId={candidateId}
            inLibrary={inLibrary}
            confirmBusy={confirmBusy}
            act={act}
            confirm={confirm}
            locate={locate}
          />
        ) : status === 'candidate' ? (
          <>
            {part.pendingDup && (
              <button
                type="button"
                className="btn bordered sm"
                data-testid="card-locate"
                title="在画布上高亮该候选节点"
                disabled={candidateId == null}
                onClick={() => host.onLocateCandidate?.(part)}
              >
                定位
              </button>
            )}
            {!inGraph && (
              <button
                type="button"
                className="btn bordered sm"
                data-testid="card-confirm"
                disabled={inLibrary ? !act || confirmBusy : candidateId == null}
                title={inLibrary ? (act ? '用库里的这篇论文加入图谱（确认入库）' : undefined) : '确认后入库到论文库，并自动查找 PDF'}
                onClick={confirm}
              >
                确认加入
              </button>
            )}
            {/* uat6c S3：已在本图谱中的卡片没有任何确认类操作（含「忽略」）——D169 已收起，忽略无语义 */}
            {!inGraph && (
              <button
                type="button"
                className="btn bordered sm"
                data-testid="card-ignore"
                disabled={!act}
                onClick={() => act?.(part, 'ignore')}
              >
                忽略
              </button>
            )}
          </>
        ) : (
          <>
            {/* D199：confirmed 快照只留「打开论文」，状态统一走标题行药丸；ignored 保留灰字 */}
            {status !== 'confirmed' && <span className="gt-card-done">已忽略</span>}
            {status === 'confirmed' && jumpPaperId != null && (
              <button type="button" className="btn bordered sm gt-card-open" data-testid="card-open" onClick={openPaper}>
                <Ic name="doc" size={12} />
                打开论文
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function LiveCardActions({
  live,
  part,
  candidateId,
  inLibrary,
  confirmBusy,
  act,
  confirm,
  locate
}: {
  live: CardLiveState
  part: PaperCardPart
  candidateId: number | null
  inLibrary: boolean
  confirmBusy: boolean
  act: ((part: PaperCardPart, action: 'confirm' | 'ignore') => void | Promise<void>) | undefined
  confirm: () => void
  locate: (paperId?: number | null) => void
}): React.JSX.Element {
  if (live.kind === 'deleted') {
    return <span className="gt-card-done" data-testid="card-live-deleted">已从论文库删除</span>
  }
  if (live.kind === 'ignored') {
    return <span className="gt-card-done" data-testid="card-live-ignored">已忽略</span>
  }
  if (live.kind === 'in_library') {
    return <span className="gt-card-hint" data-testid="card-live-removed">已从本图谱移除</span>
  }
  const locateBtn = (
    <button
      type="button"
      className="btn bordered sm"
      data-testid="card-locate"
      title="在画布上定位"
      disabled={candidateId == null && (live.paperId == null || live.kind !== 'in_graph')}
      onClick={() => locate(live.kind === 'in_graph' ? live.paperId : null)}
    >
      定位
    </button>
  )
  if (live.kind === 'in_graph') {
    // D199：状态统一走标题行「已在本图谱中」顶部药丸；操作区只留「定位」。
    return locateBtn
  }
  return (
    <>
      {locateBtn}
      <button
        type="button"
        className="btn bordered sm"
        data-testid="card-confirm"
        disabled={inLibrary ? !act || confirmBusy : candidateId == null}
        title={inLibrary ? '用库里的这篇论文加入图谱（确认入库）' : '确认后入库到论文库，并自动查找 PDF'}
        onClick={confirm}
      >
        确认加入
      </button>
      <button type="button" className="btn bordered sm" data-testid="card-ignore" disabled={!act} onClick={() => act?.(part, 'ignore')}>
        忽略
      </button>
    </>
  )
}

function openHttp(url: string): void {
  void window.graphictero?.openExternal?.(url)
}

function CardLinks({ part }: { part: PaperCardPart }): React.JSX.Element | null {
  const doi = part.doi?.trim()
  const arxiv = part.arxivId?.trim()
  const oa = part.oaUrl?.trim()
  const links: Array<{ label: string; url: string }> = []
  if (doi) links.push({ label: 'DOI', url: /^https?:\/\//i.test(doi) ? doi : `https://doi.org/${doi}` })
  if (arxiv) links.push({ label: 'arXiv', url: /^https?:\/\//i.test(arxiv) ? arxiv : `https://arxiv.org/abs/${arxiv}` })
  if (oa && /^https?:\/\//i.test(oa)) links.push({ label: oa.replace(/^https?:\/\//, ''), url: oa })
  if (links.length === 0) return null
  return (
    <div className="gt-card-links">
      {links.map((l) => (
        <button key={l.label} type="button" className="gt-card-link" title={l.url} onClick={() => openHttp(l.url)}>
          {l.label}
        </button>
      ))}
    </div>
  )
}
