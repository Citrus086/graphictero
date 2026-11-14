import { useCallback, useEffect, useState } from 'react'
import type { GraphSummary, PaperSummary } from '../../../shared/ipc'
import { GraphThumb } from '../components/GraphThumb'
import { ConfirmDialog } from '../components/Modal'
import { localClock, paperMeta, relTime } from '../lib/format'
import { Ic } from '../lib/icons'
import { useNotify } from '../lib/notify'
import { StatusDot } from '../components/StatusDot'
import { failTitle, usePapersStatus } from '../lib/usePapersStatus'
import { mineruUnavailableReason } from '../lib/mineruStatus'
import { PaperProcessPanel } from '../components/PaperProcessPanel'
import { useMineruStatus } from '../lib/useMineruStatus'
import { MotionPresence } from '../components/MotionPresence'

const api = window.graphictero

function PaperRow({
  p,
  onClick,
  status,
  onStatusClick,
  waitParse
}: {
  p: PaperSummary
  onClick?: () => void
  status?: import('../../../shared/ipc/pdf').PaperProcessStatusView
  onStatusClick?: () => void
  /** uat1b D144：MinerU 不可用原因（有 PDF、未处理且在等解析组件时传，null 不显示） */
  waitParse?: string | null
}): React.JSX.Element {
  const proc =
    status?.state === 'queued' || status?.state === 'running' || status?.state === 'waiting' ? status.state : null
  return (
    <div className="prow" style={{ cursor: onClick ? 'pointer' : 'grab' }} onClick={onClick}>
      <div className="t">{p.title}</div>
      <div className="m">
        <span>
          {paperMeta(p)}
          {!p.hasPdf && <span className="nptag0">无 PDF</span>}
          {/* uat1b D144：MinerU 不可用期间，有 PDF 未处理的论文标「等待解析组件」，原因在 tooltip */}
          {p.hasPdf && status?.state === 'unprocessed' && waitParse && (
            <span className="nptag0" title={waitParse} data-testid="row-wait-parse">
              等待解析组件
            </span>
          )}
          {/* uat2：处理中蓝点（原型库行「处理中 + 蓝点」）；queued 口径 = 排队中 */}
          {proc && (
            <span
              className="nptag0"
              data-testid="row-proc"
              title={proc === 'queued' ? '排队中 · 完成后自动补关系' : '处理中 · 完成后自动补关系'}
            >
              <span className="procdot" style={{ marginRight: 3, marginLeft: 0 }} />
              {proc === 'queued' ? '排队中' : '处理中'}
            </span>
          )}
          {status?.state === 'failed' && (
            <span
              className="faildot"
              style={{ cursor: 'pointer' }}
              title={`${failTitle(status)}（点击查看处理状态）`}
              onClick={(e) => {
                e.stopPropagation()
                onStatusClick?.()
              }}
            />
          )}
        </span>
      </div>
    </div>
  )
}

export function Home({
  lastGraphId,
  onOpenGraph,
  onOpenSettings,
  onOpenParseSettings,
  onOpenPaper
}: {
  lastGraphId: number | null
  onOpenGraph: (graphId: number, openAdd?: boolean) => void
  onOpenSettings: () => void
  /** uat1b D144：直达 设置 → PDF 解析（状态点「解析组件不可用 · 去设置」） */
  onOpenParseSettings: () => void
  /** M4 lane/detail 批 2（D113）：库行点击 → 论文详情页（无 PDF 行进 03e）；「阅读」入口已移除 */
  onOpenPaper: (paperId: number) => void
}): React.JSX.Element {
  const notify = useNotify()
  const [graphs, setGraphs] = useState<GraphSummary[] | null>(null)
  const [library, setLibrary] = useState<PaperSummary[]>([])
  const [showNew, setShowNew] = useState(false)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [gs, lib] = await Promise.all([
        api.listGraphs(),
        lastGraphId != null ? api.listLibrary(lastGraphId) : api.listLibrary()
      ])
      setGraphs(gs)
      setLibrary(lib)
    } catch {
      notify('加载失败，请重试')
    }
  }, [lastGraphId, notify])

  useEffect(() => {
    void reload()
  }, [reload])

  // uat2：重新导入（D75）补齐 PDF → 论文库即时刷新，「无 PDF」标记立即消失
  useEffect(() => {
    const off = api.onLibraryChanged?.(() => void reload())
    return () => off?.()
  }, [reload])

  const papersStatus = usePapersStatus(library.map((p) => p.id))
  const sidecar = useMineruStatus()
  // uat1b D144：MinerU 不可用原因（论文层「等待解析组件」标签）
  const mineruReason = mineruUnavailableReason(sidecar?.state)
  const [procPaper, setProcPaper] = useState<PaperSummary | null>(null)
  const [lastImportAt, setLastImportAt] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void api
      .getLastImport()
      .then((v) => {
        if (live) setLastImportAt(v.at)
      })
      .catch(() => {
        if (live) setLastImportAt(null)
      })
    return () => {
      live = false
    }
  }, [library])

  const openRecent = (): void => {
    const list = graphs ?? []
    const g = list.find((x) => x.id === lastGraphId)
    if (!g) {
      notify('还没有最近打开的图谱')
      return
    }
    onOpenGraph(g.id)
  }

  const focusLibrary = (): void => {
    document.getElementById('home-papers')?.scrollIntoView({ block: 'nearest' })
  }

  const create = async (): Promise<void> => {
    if (creating) return
    setCreating(true)
    try {
      const g = await api.createGraph(name.trim() || '未命名图谱')
      onOpenGraph(g.id)
    } catch {
      notify('新建图谱失败')
      setCreating(false)
    }
  }

  const importFromZotero = (): void => {
    const list = graphs ?? []
    // 有图谱但 localStorage 里没有最近打开记录时，落到第一个图谱，不误报（评审小 nit）
    const g = list.find((x) => x.id === lastGraphId) ?? list[0]
    if (!g) {
      notify('请先新建一个图谱')
      return
    }
    onOpenGraph(g.id, true)
  }

  const hasGraphs = (graphs?.length ?? 0) > 0
  const lastGraph = (graphs ?? []).find((g) => g.id === lastGraphId) ?? null
  const showTwoGroups = hasGraphs && lastGraph != null
  const inGraphPapers = showTwoGroups ? library.filter((p) => p.inGraph) : []
  const otherPapers = showTwoGroups ? library.filter((p) => !p.inGraph) : library

  return (
    <>
      <div className="sidebar">
        <div className="tlspace" />
        <div className="sbody">
          <div className="sitem on" data-testid="home-nav-all" onClick={() => document.querySelector('.homemain')?.scrollTo({ top: 0 })}>
            <Ic name="grid" />
            全部图谱
            <span className="n">{graphs == null ? '' : graphs.length}</span>
          </div>
          <div className="sitem" data-testid="home-nav-recent" onClick={openRecent}>
            <Ic name="clock" />
            最近打开
          </div>
          <div className="sitem" data-testid="home-nav-library" onClick={focusLibrary}>
            <Ic name="lib" />
            论文库
            <span className="n">{library.length}</span>
          </div>
          <div className="shead">
            <span className="cap">图谱</span>
          </div>
          {(graphs ?? []).map((g) => (
            <div key={g.id} className="sitem" data-testid="home-graph-row" onClick={() => onOpenGraph(g.id)}>
              <Ic name="tree" />
              {g.name}
              <span className="n">{g.paperCount}</span>
            </div>
          ))}
          <div className="grow" />
          <div style={{ borderTop: '1px solid var(--line)', margin: '6px 0' }} />
          {showTwoGroups ? (
            <div id="home-papers">
              <div className="shead" style={{ paddingTop: 6 }}>
                <span className="cap">本图谱</span>
              </div>
              {inGraphPapers.map((p) => (
                <PaperRow
                  key={p.id}
                  p={p}
                  status={papersStatus.get(p.id)}
                  onClick={() => onOpenPaper(p.id)}
                  onStatusClick={() => setProcPaper(p)}
                />
              ))}
              <div className="shead" style={{ marginTop: 4 }}>
                <span className="cap">论文库 · 其他</span>
              </div>
              {otherPapers.map((p) => (
                <PaperRow
                  key={p.id}
                  p={p}
                  status={papersStatus.get(p.id)}
                  waitParse={p.hasPdf && papersStatus.get(p.id)?.state === 'unprocessed' ? mineruReason : null}
                  onClick={() => onOpenPaper(p.id)}
                  onStatusClick={() => setProcPaper(p)}
                />
              ))}
            </div>
          ) : (
            <div id="home-papers">
              {library.map((p) => (
                <PaperRow
                  key={p.id}
                  p={p}
                  status={papersStatus.get(p.id)}
                  waitParse={p.hasPdf && papersStatus.get(p.id)?.state === 'unprocessed' ? mineruReason : null}
                  onClick={() => onOpenPaper(p.id)}
                  onStatusClick={() => setProcPaper(p)}
                />
              ))}
            </div>
          )}
        </div>
        <div className="sitem home-settings" data-testid="home-nav-settings" onClick={onOpenSettings}>
          <Ic name="sliders" />
          设置
        </div>
        <div className="zfoot">
          <Ic name="lib" size={14} />
          论文库 · {library.length} 篇 · 上次导入 {lastImportAt ? localClock(lastImportAt) : '—'}
        </div>
      </div>

      <div className="maincol">
        <div className="toolbar" style={{ gap: 8 }}>
          <span style={{ marginRight: 'auto', fontSize: 13, fontWeight: 600 }}>
            Graphictero
          </span>
          <StatusDot onOpenSettings={onOpenSettings} onOpenParseSettings={onOpenParseSettings} />
          <div className="field" style={{ width: 220 }}>
            <Ic name="search" size={14} />
            搜索图谱或论文
          </div>
          <button className="btn bordered" onClick={importFromZotero}>
            <Ic name="import" size={15} />
            从 Zotero 导入
          </button>
          <button className="btn primary" onClick={() => setShowNew(true)}>
            <Ic name="plus" size={15} w={1.6} />
            新建图谱
          </button>
        </div>
        <div className="homemain">
          <div style={{ margin: '28px 0 6px' }} className="h1">
            我的图谱
          </div>
          <div className="t3" style={{ fontSize: 13, marginBottom: 28 }}>
            图谱独立于 Zotero 分类。论文从 Zotero 单向导入到本机论文库，不会写回 Zotero。
          </div>
          <div className="grid" style={{ paddingBottom: 40 }}>
            {(graphs ?? []).map((g) => (
              <div key={g.id} className="gcard" onClick={() => onOpenGraph(g.id)}>
                <div className="pv">
                  <GraphThumb seed={g.id} />
                </div>
                <div className="nm">{g.name}</div>
                <div className="mt">
                  {g.paperCount} 篇论文 · {g.relationCount} 条关系 · 更新于 {relTime(g.updatedAt)}
                </div>
              </div>
            ))}
            <div>
              <div
                className="newc"
                onClick={() => {
                  setName('')
                  setShowNew(true)
                }}
              >
                <Ic name="plus" size={18} />
                新建空白图谱
              </div>
              <div className="mt t3" style={{ fontSize: 12, marginTop: 10 }}>
                从论文库挑选论文，或从 Zotero 导入整个分类
              </div>
            </div>
          </div>
        </div>
      </div>

      {procPaper && (
        <PaperProcessPanel
          paper={procPaper}
          status={papersStatus.get(procPaper.id)}
          sidecar={sidecar}
          onClose={() => setProcPaper(null)}
        />
      )}

      <MotionPresence open={showNew} kind="modal">
        {showNew ? (
        <ConfirmDialog title="新建空白图谱" okText="创建" okDisabled={creating} onOk={() => void create()} onClose={() => setShowNew(false)}>          <input
            className="tin"
            style={{ marginTop: 10 }}
            placeholder="图谱名称"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create()
            }}
          />
        </ConfirmDialog>
        ) : null}
      </MotionPresence>
    </>
  )
}
