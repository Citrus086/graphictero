import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ImportProgress, ImportSummary, PaperSummary, ZoteroCollectionItemView, ZoteroCollectionNode, ZoteroSourceStatus } from '../../../shared/ipc'
import { paperMeta } from '../lib/format'
import { Ic } from '../lib/icons'
import { ipcErrorMessage } from '../lib/ipcError'
import { useNotify } from '../lib/notify'
import { DialogHeader, Overlay } from './Modal'

const api = window.graphictero

/** uat13（D207-④）：Zotero 左右栏分隔条：左栏最小 160px、右栏至少 280px，宽度存 localStorage */
const Z_LEFT_MIN = 160
const Z_RIGHT_MIN = 280
const Z_LS_KEY = 'gt.addpapers.leftWidth'

function initialLeftWidth(): number {
  try {
    const v = Number(localStorage.getItem(Z_LS_KEY))
    if (Number.isFinite(v) && v >= Z_LEFT_MIN) return Math.round(v)
  } catch {
    // localStorage 不可用（如隐私模式）→ 默认
  }
  return 220
}

/** 添加论文弹窗（原型 /04）：上半区从论文库勾选，下半区从 Zotero 导入整个分类 */
export function AddPapersModal({
  graphId,
  onClose,
  onChanged
}: {
  graphId: number
  onClose: () => void
  /** 论文库有变动时回调；入参为本次真正加入图谱的 paperIds（建 6：据此决定是否自动整理） */
  onChanged: (addedIds: number[]) => void | Promise<void>
}): React.JSX.Element {
  const notify = useNotify()
  const [library, setLibrary] = useState<PaperSummary[] | null>(null)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [adding, setAdding] = useState(false)

  const [zoteroRowRef, setZoteroRowRef] = useState<HTMLDivElement | null>(null)
  const [leftW, setLeftW] = useState(initialLeftWidth)
  const [splitDragging, setSplitDragging] = useState(false)
  const splitDrag = useRef<{ startX: number; startW: number } | null>(null)

  // uat13（D207-④）：拖动 / 键盘调整左栏宽；双栏容器宽不够时优先保证右栏最小宽
  const clampLeft = useCallback((w: number): number => {
    // clientWidth 为 0（未测量 / jsdom）时只按左栏最小值约束
    const measured = zoteroRowRef?.clientWidth ?? 0
    const containerW = measured > 0 ? measured : Number.MAX_SAFE_INTEGER
    const maxW = Math.max(Z_LEFT_MIN, containerW - Z_RIGHT_MIN - 17) // 17 = 分隔条 1px + 两侧各 8px
    return Math.min(Math.max(Math.round(w), Z_LEFT_MIN), maxW)
  }, [zoteroRowRef])
  const applyLeft = useCallback((w: number): void => {
    setLeftW((prev) => {
      const next = clampLeft(w)
      if (next !== prev) {
        try {
          localStorage.setItem(Z_LS_KEY, String(next))
        } catch {
          // 存不下不影响本次使用
        }
      }
      return next
    })
  }, [clampLeft])
  const [zStatus, setZStatus] = useState<ZoteroSourceStatus | null>(null)
  const [collections, setCollections] = useState<ZoteroCollectionNode[] | null>(null)
  const [zError, setZError] = useState<string | null>(null)
  const [selKey, setSelKey] = useState<string | null>(null)
  // uat13（D207-③）：选中分类后在右侧列出其中的论文（标题 + 作者/年份，只读预览）
  const [collItems, setCollItems] = useState<ZoteroCollectionItemView[] | null>(null)
  // uat14（D209）：Zotero 条目勾选（按 item key；切换分类时清空）
  const [zSelected, setZSelected] = useState<Set<string>>(new Set())
  const [collItemsError, setCollItemsError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [result, setResult] = useState<ImportSummary | null>(null)

  const reloadLibrary = useCallback(async (): Promise<void> => {
    try {
      setLibrary(await api.listLibrary(graphId))
    } catch {
      notify('加载论文库失败')
    }
  }, [graphId, notify])

  useEffect(() => {
    void reloadLibrary()
    void (async () => {
      try {
        setZStatus(await api.getZoteroStatus())
      } catch {
        setZStatus(null)
      }
      try {
        setCollections(await api.listZoteroCollections())
      } catch (e) {
        setCollections([])
        setZError(ipcErrorMessage(e, '读取 Zotero 分类失败'))
      }
    })()
  }, [reloadLibrary])

  // uat2 建议修 5：Escape 关闭弹窗（导入进行中不响应，防误触中断）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !importing) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [importing, onClose])

  const candidates = useMemo(() => {
    const list = (library ?? []).filter((p) => !p.inGraph)
    const f = filter.trim().toLowerCase()
    if (!f) return list
    return list.filter((p) => `${p.title} ${p.firstAuthor ?? ''}`.toLowerCase().includes(f))
  }, [library, filter])

  const toggle = (id: number): void => {
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  // uat14（D209）：底部统计 = 论文库勾选 + Zotero 勾选
  const totalSelected = selected.size + zSelected.size

  const toggleZ = (key: string): void => {
    if (importing) return
    setZSelected((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  }

  const addSelected = async (): Promise<void> => {
    const libIds = [...selected]
    const zKeys = [...zSelected]
    if (libIds.length + zKeys.length === 0 || adding) return
    setAdding(true)
    const addedToGraphIds: number[] = []
    // 论文库部分：照旧 addPapersToGraph
    try {
      if (libIds.length > 0) addedToGraphIds.push(...(await api.addPapersToGraph(graphId, libIds)))
    } catch {
      notify('添加失败，请重试')
      setAdding(false)
      return
    }
    // Zotero 部分：只导入所选 item keys（与整分类导入同款编排，进度事件复用）
    if (zKeys.length > 0 && selKey) {
      setImporting(true)
      setProgress(null)
      setResult(null)
      const unsub = api.onZoteroImportProgress(setProgress)
      try {
        const summary = await api.importZoteroItems(selKey, zKeys, graphId)
        setResult(summary)
        addedToGraphIds.push(...summary.addedToGraphIds)
      } catch (e) {
        notify(ipcErrorMessage(e, '导入失败，请重试'))
      } finally {
        unsub()
        setImporting(false)
      }
    }
    notify(addedToGraphIds.length > 0 ? `已添加 ${addedToGraphIds.length} 篇到图谱` : '所选论文均已在图谱中')
    setSelected(new Set())
    setZSelected(new Set())
    await reloadLibrary()
    await onChanged(addedToGraphIds)
    setAdding(false)
  }

  const startImport = async (): Promise<void> => {
    if (!selKey || importing) return
    setImporting(true)
    setProgress(null)
    setResult(null)
    const unsub = api.onZoteroImportProgress(setProgress)
    try {
      const summary = await api.importZoteroCollection(selKey, graphId)
      setResult(summary)
      await onChanged(summary.addedToGraphIds)
      await reloadLibrary()
    } catch (e) {
      notify(ipcErrorMessage(e, '导入失败，请重试'))
    } finally {
      unsub()
      setImporting(false)
    }
  }

  // 分类树缩进深度：沿 parentKey 链向上数
  const depth = (c: ZoteroCollectionNode): number => {
    let d = 0
    let cur: ZoteroCollectionNode | undefined = c
    const byKey = new Map((collections ?? []).map((x) => [x.key, x]))
    while (cur?.parentKey) {
      d += 1
      cur = byKey.get(cur.parentKey)
      if (d > 8) break
    }
    return d
  }

  // 建 5：只列用户个人库（libraryID=1 或 Local API 的 users/0）；群组库分类不混入
  const personalCollections = useMemo(
    () => (collections ?? []).filter((c) => c.libraryID == null || c.libraryID === 1),
    [collections]
  )
  const groupCollectionCount = (collections?.length ?? 0) - personalCollections.length

  const selCollection = personalCollections.find((c) => c.key === selKey) ?? null

  // uat13（D207-③）：切换分类时拉取条目预览；加载中 / 出错 / 空态在右侧展示
  // uat14（D209）：切换分类同时清空 Zotero 勾选
  useEffect(() => {
    setCollItems(null)
    setCollItemsError(null)
    setZSelected(new Set())
    if (!selKey) return
    let disposed = false
    void (async () => {
      try {
        const items = await api.listZoteroCollectionItems(selKey)
        if (!disposed) setCollItems(items)
      } catch (e) {
        if (!disposed) setCollItemsError(ipcErrorMessage(e, '读取分类内论文失败'))
      }
    })()
    return () => {
      disposed = true
    }
  }, [selKey])

  return (
    <Overlay width={760}>
      <DialogHeader
        title="添加论文"
        sub={
          <>
            图谱独立于 Zotero 分类。论文从 Zotero 单向导入到本机论文库，不会写回 Zotero。
          </>
        }
        onClose={onClose}
      />
      <div className="dlg-b" style={{ flexDirection: 'column', overflowY: 'auto' }}>
        {/* 从论文库添加 */}
        <div style={{ padding: '12px 20px 4px', flex: 'none' }}>
          <div className="ghead" style={{ margin: '0 0 8px' }}>
            从论文库添加
          </div>
          <div className="field" style={{ marginBottom: 6 }}>
            <Ic name="search" size={14} />
            <input placeholder="搜索标题、作者" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <div style={{ maxHeight: 180, overflowY: 'auto' }}>
            {library === null ? (
              <div className="t3" style={{ fontSize: 12.5, padding: '10px 4px' }}>
                加载中…
              </div>
            ) : candidates.length === 0 ? (
              <div className="t3" style={{ fontSize: 12.5, padding: '10px 4px' }}>
                {filter ? '没有匹配的论文' : '论文库里的论文已全部在本图谱中'}
              </div>
            ) : (
              candidates.map((p) => (
                <div key={p.id} className="lrow" onClick={() => toggle(p.id)}>
                  <span className={`cb ${selected.has(p.id) ? 'on' : ''}`}>{selected.has(p.id) && <Ic name="check" size={11} w={2} />}</span>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="t">{p.title}</div>
                    <div className="m">
                      {paperMeta(p)}
                      {p.hasPdf ? ' · PDF' : ''}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* 从 Zotero 导入 */}
        <div style={{ borderTop: '1px solid var(--line)', padding: '12px 20px 14px', flex: 'none' }}>
          <div className="ghead" style={{ margin: '0 0 8px' }}>
            从 Zotero 导入
          </div>
          <div className="row" style={{ gap: 6, fontSize: 12, color: 'var(--text2)', marginBottom: 8 }}>
            <span className={`zdot ${zStatus?.kind === 'local_api' ? 'ok' : ''}`} />
            {zStatus?.kind === 'local_api'
              ? 'Zotero Local API · 运行中'
              : zStatus?.kind === 'sqlite'
                ? `Zotero 未运行 · 使用 zotero.sqlite 只读副本`
                : '正在检测 Zotero…'}
          </div>
          {zStatus?.kind === 'sqlite' && zStatus.hint && (
            <div className="hintbar warn" style={{ margin: '0 0 8px' }}>
              <Ic name="info" size={14} />
              <span>{zStatus.hint}</span>
            </div>
          )}
          {/* uat13（D207-④）：左右栏之间是可拖动分隔条；宽度存 localStorage，键盘可调 */}
          <div ref={setZoteroRowRef} className="row" style={{ alignItems: 'stretch', gap: 0 }}>
            <div style={{ width: leftW, flex: 'none', minWidth: Z_LEFT_MIN }}>
              <div className="cap" style={{ padding: '2px 8px 6px' }}>
                Zotero 文库
              </div>
              <div style={{ maxHeight: 150, overflowY: 'auto' }}>
                {collections === null ? (
                  <div className="t3" style={{ fontSize: 12, padding: '4px 8px' }}>
                    加载中…
                  </div>
                ) : zError ? (
                  <div className="t3" style={{ fontSize: 12, padding: '4px 8px' }}>
                    {zError}
                  </div>
                ) : personalCollections.length === 0 ? (
                  <div className="t3" style={{ fontSize: 12, padding: '4px 8px' }}>
                    {groupCollectionCount > 0 ? '没有个人库的分类' : '没有可读到的分类'}
                  </div>
                ) : (
                  personalCollections.map((c) => (
                    <div
                      key={c.key}
                      className={`sitem ${selKey === c.key ? 'on' : ''}`}
                      style={{ paddingLeft: 8 + depth(c) * 14 }}
                      onClick={() => setSelKey(c.key)}
                    >
                      <Ic name="folder" size={15} />
                      {c.name}
                    </div>
                  ))
                )}
              </div>
              {groupCollectionCount > 0 && (
                <div className="t3" style={{ fontSize: 11, padding: '4px 8px 0' }}>
                  已隐藏 {groupCollectionCount} 个群组库分类（暂只支持个人库）
                </div>
              )}
            </div>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-valuenow={leftW}
              aria-label="调整 Zotero 分类列表宽度"
              tabIndex={0}
              className={`zsplit${splitDragging ? ' drag' : ''}`}
              onPointerDown={(e) => {
                e.preventDefault()
                e.currentTarget.setPointerCapture(e.pointerId)
                splitDrag.current = { startX: e.clientX, startW: leftW }
                setSplitDragging(true)
              }}
              onPointerMove={(e) => {
                const d = splitDrag.current
                if (!d) return
                applyLeft(d.startW + e.clientX - d.startX)
              }}
              onPointerUp={() => {
                splitDrag.current = null
                setSplitDragging(false)
              }}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
                e.preventDefault()
                applyLeft(leftW + (e.key === 'ArrowRight' ? 16 : -16))
              }}
            />
            <div className="grow col" style={{ gap: 8, minWidth: Z_RIGHT_MIN, marginLeft: 16 }}>
              {selCollection ? (
                <>
                  <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {selCollection.name}
                    </span>
                    {/* uat14（D209）：全选 / 取消全选（文字按钮，克制灰阶）；「导入整个分类」行为不变 */}
                    <span className="row" style={{ gap: 10, flex: 'none' }}>
                      <button
                        type="button"
                        className="zselbtn"
                        disabled={importing || !collItems || collItems.length === 0}
                        onClick={() => setZSelected(new Set((collItems ?? []).map((i) => i.key)))}
                      >
                        全选
                      </button>
                      <button type="button" className="zselbtn" disabled={importing || zSelected.size === 0} onClick={() => setZSelected(new Set())}>
                        取消全选
                      </button>
                      <button className="btn bordered" disabled={importing} onClick={() => void startImport()}>
                        <Ic name="import" size={14} />
                        导入整个分类
                      </button>
                    </span>
                  </div>
                  {/* uat13（D207-③）：分类内的论文预览（只读列表；加载中 / 出错 / 空态） */}
                  <div data-testid="zotero-coll-items" style={{ maxHeight: 132, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 6 }}>
                    {collItemsError ? (
                      <div className="t3" style={{ fontSize: 12, padding: '8px 10px' }}>
                        {collItemsError}
                      </div>
                    ) : collItems === null ? (
                      <div className="t3" style={{ fontSize: 12, padding: '8px 10px' }}>
                        加载中…
                      </div>
                    ) : collItems.length === 0 ? (
                      <div className="t3" style={{ fontSize: 12, padding: '8px 10px' }}>
                        该分类还没有论文条目
                      </div>
                    ) : (
                      collItems.map((it) => (
                        // uat14（D209）：整行可点切换勾选；已在本机库的标「已导入」灰字
                        <div key={it.key} className="lrow" data-zkey={it.key} onClick={() => toggleZ(it.key)}>
                          <span className={`cb ${zSelected.has(it.key) ? 'on' : ''}`}>
                            {zSelected.has(it.key) && <Ic name="check" size={11} w={2} />}
                          </span>
                          <span className="grow" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {it.title || '（无标题）'}
                          </span>
                          {it.alreadyImported && (
                            <span className="t3" style={{ flex: 'none', fontSize: 11 }}>
                              已导入
                            </span>
                          )}
                          <span className="t3" style={{ flex: 'none', fontSize: 11.5 }}>
                            {[it.firstAuthor, it.year].filter(Boolean).join(', ')}
                            {it.hasPdf ? ' · PDF' : ''}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                  {importing && (
                    <div className="row" style={{ gap: 10, fontSize: 12, color: 'var(--text3)' }}>
                      <span style={{ flex: 'none' }}>正在导入{progress ? ` · ${progress.done}/${progress.total}` : '…'}</span>
                      <div className="prog">
                        <i style={{ width: progress && progress.total > 0 ? `${Math.round((progress.done / progress.total) * 100)}%` : '0%' }} />
                      </div>
                    </div>
                  )}
                  {result && (
                    <>
                      <div style={{ fontSize: 12.5, color: 'var(--text2)' }}>
                        {/* uat1 建议 7：有补 PDF 时主句点名「其中补齐 PDF M 篇」，不像「什么都没变」 */}
                        已新导入 {result.imported} 篇 · 已在库 {result.updated} 篇
                        {result.pdfAdded > 0 && <span style={{ color: 'var(--accent)' }}>（其中补齐 PDF {result.pdfAdded} 篇）</span>}
                        {' '}· {result.addedToGraph} 篇已加入图谱
                        {result.failed > 0 && <span style={{ color: 'var(--text2)' }}> · 失败 {result.failed} 篇</span>}
                      </div>
                      {result.failed > 0 && (
                        <div className="hintbar warn" style={{ margin: 0 }}>
                          <Ic name="info" size={14} />
                          <span>有 {result.failed} 篇导入失败，可重新导入该分类重试。</span>
                        </div>
                      )}
                      {result.pdfUnresolved > 0 && (
                        <div className="hintbar warn" style={{ margin: 0 }}>
                          <Ic name="info" size={14} />
                          <span>
                            {result.pdfUnresolved} 篇在 Zotero 里有 PDF 附件，但没找到对应文件（可能没下载到本机或已被移动），已先按「无 PDF」入库。可重新导入该分类补齐，或把 PDF 拖进论文详情页。
                          </span>
                        </div>
                      )}
                      {result.hint && (
                        <div className="hintbar warn" style={{ margin: 0 }}>
                          <Ic name="info" size={14} />
                          <span>{result.hint}</span>
                        </div>
                      )}
                    </>
                  )}
                </>
              ) : (
                <div className="t3" style={{ fontSize: 12, padding: '6px 0' }}>
                  在左侧选择一个分类，导入整个分类到本图谱。
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className="dlg-f">
        <span className="t3 grow" style={{ fontSize: 12.5 }}>
          已选 {totalSelected} 篇
        </span>
        <button className="btn bordered" onClick={onClose}>
          取消
        </button>
        <button className="btn primary" disabled={totalSelected === 0 || adding || importing} onClick={() => void addSelected()}>
          添加 {totalSelected} 篇
        </button>
      </div>
    </Overlay>
  )
}
