import { useCallback, useEffect, useRef, useState } from 'react'
import { NotifyContext } from './lib/notify'
import { ChatDrawer } from './components/chat/ChatDrawer'
import { chatVisibleOnRoute, useAgentSession, type ChatEntry, type ChatHostLike } from './lib/useAgentSession'
import type { ContextRef } from '../../shared/ipc/agent'
import type { GraphChangePart } from '../../shared/parts'
import { GraphPage } from './pages/GraphPage'
import { Home } from './pages/Home'
import { FirstRunPage } from './pages/FirstRunPage'
import { PaperDetailPage } from './pages/PaperDetailPage'
import { SettingsPage } from './pages/SettingsPage'
import { useThemeSync } from './lib/themeSync'
import { useMineruStatus } from './lib/useMineruStatus'
import { installFailedText, isFirstRunGateState } from './lib/mineruStatus'
import { MotionPresence } from './components/MotionPresence'

// M4：paper 路由（论文详情页）类型由预备提交加入，页面渲染由 lane/detail 接线
export type Route =
  | { page: 'home' }
  | { page: 'graph'; graphId: number; openAdd?: boolean }
  | { page: 'settings'; section?: string }
  | { page: 'paper'; paperId: number; graphId?: number }

const LAST_GRAPH_KEY = 'graphictero.lastGraphId'

function sameEntry(a: ChatEntry, b: ChatEntry): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'paper' && b.type === 'paper') return a.paperId === b.paperId
  if (a.type === 'relation' && b.type === 'relation') return a.relationId === b.relationId
  return true
}

function readLastGraphId(): number | null {
  const v = localStorage.getItem(LAST_GRAPH_KEY)
  const n = v == null ? NaN : Number(v)
  return Number.isFinite(n) ? n : null
}

let toastSeq = 0

export function App(): React.JSX.Element {
  useThemeSync()
  const [route, setRoute] = useState<Route>({ page: 'home' })
  const [settingsFrom, setSettingsFrom] = useState<Route | null>(null)
  const [toasts, setToasts] = useState<Array<{ id: number; msg: string }>>([])
  const [chat, setChat] = useState<ChatHostLike | null>(null)
  /** 07「发给 agent」注入的待发送上下文（quote chip），ChatDrawer 消费后清空 */
  const [pendingChips, setPendingChips] = useState<ContextRef[]>([])
  /** D176：已选节点 pointer 拖入抽屉时的高亮（不是 HTML5 DnD） */
  const [chatDropActive, setChatDropActive] = useState(false)
  /** 改图小结「定位」请求（nonce 触发 GraphPage flash 高亮） */
  const [locateReq, setLocateReq] = useState<{ part: GraphChangePart; nonce: number } | null>(null)
  /** D182（uat6b）：「已在待确认候选中」卡片「定位」请求（nonce 触发画布高亮） */
  const [locateCandReq, setLocateCandReq] = useState<{ candidateId: number; paperId?: number | null; nonce: number } | null>(null)
  /** D201（uat12）：详情页「定位」请求（nonce 在画布就绪后消费一次：居中 + flash） */
  const [paperLocateReq, setPaperLocateReq] = useState<{ paperId: number; nonce: number } | null>(null)

  // M5 lane/chat 批 3 必须修 1：会话 hook 上提 App 级常驻——抽屉隐藏/换入口不卸载数据面，
  // 运行态与流式原样恢复；chat 为 null（无宿主）时 hook 静默不发 IPC
  const sess = useAgentSession({ graphId: chat?.graphId ?? null, entry: chat?.entry ?? null })

  // uat1 首启安装门（原型 00，D57/D82）：sidecar 需要安装 / 正在安装 / 安装失败时
  // 取代首页；安装成功（状态离开安装族）自动切回。「先跳过」只对本进程生效——
  // 失败态仍在设置页与状态点弹层持久可见，重开 App 会再见到本界面。
  const mineruStatus = useMineruStatus()
  const [installSkipped, setInstallSkipped] = useState(false)
  const firstRunGate = isFirstRunGateState(mineruStatus?.state) && !installSkipped

  const notify = useCallback((msg: string) => {
    const id = ++toastSeq
    setToasts((ts) => [...ts.slice(-2), { id, msg }])
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 2200)
  }, [])

  // uat1：安装失败时给一个通俗中文 toast（不是唯一入口——首启界面 / 设置页 / 状态点
  // 弹层都持久可见可重试）；只在迁入 install_failed 的那一刻弹一次
  const lastMineruState = useRef<string | null>(null)
  useEffect(() => {
    const s = mineruStatus?.state
    if (s != null && s !== lastMineruState.current) {
      if (s === 'install_failed' && mineruStatus?.error) {
        const t = installFailedText(mineruStatus.error)
        notify(`${t.title}${t.hint}`)
      }
      lastMineruState.current = s
    }
  }, [mineruStatus, notify])

  const openGraph = useCallback((graphId: number, openAdd = false) => {
    localStorage.setItem(LAST_GRAPH_KEY, String(graphId))
    setRoute({ page: 'graph', graphId, openAdd })
  }, [])

  const openHome = useCallback(() => setRoute({ page: 'home' }), [])
  /** M4 lane/detail：图谱节点点击 → 论文详情页（含返回图谱） */
  const openPaper = useCallback((paperId: number, graphId?: number) => {
    setRoute({ page: 'paper', paperId, graphId })
  }, [])
  // 评审建 8：设置页「返回」回到来源页（从画布进来就回画布，不丢图谱上下文）
  const openSettings = useCallback(() => {
    setSettingsFrom((from) => from ?? route)
    setRoute({ page: 'settings' })
  }, [route])
  /** uat1b D144：直达 设置 → PDF 解析（「等待解析组件」的「去设置」入口） */
  const openParseSettings = useCallback(() => {
    setSettingsFrom((from) => from ?? route)
    setRoute({ page: 'settings', section: 'parse' })
  }, [route])
  const backFromSettings = useCallback(() => {
    setRoute(settingsFrom ?? { page: 'home' })
    setSettingsFrom(null)
  }, [settingsFrom])

  /** 入口切换抽屉（同图谱同入口再点 = 收起；不同入口 = 换宿主） */
  const toggleChat = useCallback((graphId: number, entry: ChatEntry) => {
    setChat((c) => (c != null && c.open && c.graphId === graphId && sameEntry(c.entry, entry) ? { ...c, open: false } : { open: true, graphId, entry }))
  }, [])
  const closeChat = useCallback(() => {
    setChatDropActive(false)
    setChat((c) => (c ? { ...c, open: false } : c))
  }, [])

  /** D176：画布多选 / 菜单统一复用 App 级 pendingChips；ChatDrawer 内 addChip 去重。 */
  const addPaperChips = useCallback(
    (graphId: number, paperIds: number[]) => {
      const ids = [...new Set(paperIds)].filter((id) => Number.isInteger(id) && id > 0)
      if (ids.length === 0) return
      setChat({ open: true, graphId, entry: { type: 'graph' } })
      setPendingChips((prev) => [...prev, ...ids.map((paperId): ContextRef => ({ kind: 'paper', paperId }))])
      setChatDropActive(false)
      notify(`已添加 ${ids.length} 篇到对话上下文`)
    },
    [notify]
  )

  /** paper 路由的图谱归属：route.graphId ?? 最近打开的图谱（03 可从首页进） */
  const paperGraphId = route.page === 'paper' ? (route.graphId ?? readLastGraphId()) : null

  // M6 lane/ui 批 1：候选卡「打开论文」→ 论文详情（'gt:open-paper' window 事件，与
  // 'gt:graph-changed' 同模式；graphId 缺省走最近图谱，与首页库入口同口径）
  useEffect(() => {
    const onOpenPaper = (e: Event): void => {
      const paperId = (e as CustomEvent<number>).detail
      if (typeof paperId === 'number' && Number.isInteger(paperId) && paperId > 0) {
        openPaper(paperId, readLastGraphId() ?? undefined)
      }
    }
    window.addEventListener('gt:open-paper', onOpenPaper)
    return () => window.removeEventListener('gt:open-paper', onOpenPaper)
  }, [openPaper])

  /** 抽屉显示条件（纯函数在 useAgentSession.ts，规则见 lane-chat.md「批 2 前置设计」） */
  const chatVisible = chatVisibleOnRoute(chat, route, readLastGraphId())

  // 首启安装门：整页替换为原型 00 安装界面（不带侧栏/顶栏，与原型一致）；
  // toasts 容器两个分支都要有（安装失败的通俗 toast 在门内也要能显示）
  const toastNodes = (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          {t.msg}
        </div>
      ))}
    </div>
  )
  if (firstRunGate) {
    return (
      <NotifyContext.Provider value={notify}>
        <FirstRunPage onSkip={() => setInstallSkipped(true)} />
        {toastNodes}
      </NotifyContext.Provider>
    )
  }

  return (
    <NotifyContext.Provider value={notify}>
      <div className="appwin">
        <MotionPresence open={route.page === 'home'} kind="page">
          {route.page === 'home' ? (
          <Home
            lastGraphId={readLastGraphId()}
            onOpenGraph={openGraph}
            onOpenSettings={openSettings}
            onOpenParseSettings={openParseSettings}
            onOpenPaper={(paperId) => openPaper(paperId, readLastGraphId() ?? undefined)}
          />
          ) : null}
        </MotionPresence>
        <MotionPresence open={route.page === 'graph'} kind="page">
          {route.page === 'graph' ? (
          <GraphPage
            graphId={route.graphId}
            openAdd={route.openAdd}
            onHome={openHome}
            onOpenSettings={openSettings}
            onOpenParseSettings={openParseSettings}
            onOpenPaper={(paperId) => openPaper(paperId, route.graphId)}
            chatOpen={chatVisible}
            onToggleChat={(entry) => toggleChat(route.graphId, entry)}
            agentRunning={sess.anyRunning}
            locateRequest={locateReq}
            locateCandidateRequest={locateCandReq}
            paperLocateRequest={paperLocateReq}
            onAddPaperChips={(ids) => addPaperChips(route.graphId, ids)}
            onChatDragHover={setChatDropActive}
          />
          ) : null}
        </MotionPresence>
        <MotionPresence open={route.page === 'paper'} kind="page">
          {route.page === 'paper' ? (
          <PaperDetailPage
            paperId={route.paperId}
            graphId={route.graphId}
            onBack={() => (route.graphId != null ? openGraph(route.graphId) : openHome())}
            onOpenSettings={openParseSettings}
            chatOpen={chatVisible}
            onToggleChat={
              paperGraphId != null && route.page === 'paper'
                ? () => toggleChat(paperGraphId, { type: 'paper', paperId: route.paperId })
                : undefined
            }
            onLocate={
              paperGraphId != null && route.page === 'paper'
                ? () => {
                    // D201（uat12）：详情页「定位」→ 记录 nonce 后回到画布，画布就绪消费：居中 + flash
                    setPaperLocateReq({ paperId: route.paperId, nonce: Date.now() })
                    openGraph(paperGraphId)
                  }
                : undefined
            }
            onSendToAgent={
              paperGraphId != null
                ? (ref) => {
                    // D105-①：阅读器选区「发给 agent」→ paper 入口抽屉 + quote chip
                    setChat({ open: true, graphId: paperGraphId, entry: { type: 'paper', paperId: route.paperId } })
                    setPendingChips([ref])
                  }
                : undefined
            }
          />
          ) : null}
        </MotionPresence>
        <MotionPresence open={route.page === 'settings'} kind="page">
          {route.page === 'settings' ? <SettingsPage onBack={backFromSettings} initialSection={route.section} /> : null}
        </MotionPresence>
        <MotionPresence open={chatVisible && chat != null} kind="drawer">
          {chatVisible && chat ? (
          <ChatDrawer
            graphId={chat.graphId}
            entry={chat.entry}
            sess={sess}
            onClose={closeChat}
            pendingChips={pendingChips}
            onPendingChipsConsumed={() => setPendingChips([])}
            onLocateGraphChange={(part) => setLocateReq({ part, nonce: Date.now() })}
            onLocateCandidate={(part, paperId) => {
              const id = Number(part.id.replace(/^c/, ''))
              const candidateId = Number.isInteger(id) && id > 0 ? id : 0
              if (candidateId > 0 || (paperId != null && paperId > 0)) {
                setLocateCandReq({ candidateId, paperId: paperId ?? null, nonce: Date.now() })
              }
            }}
            agentRunning={sess.anyRunning}
            dropActive={chatDropActive}
          />
          ) : null}
        </MotionPresence>
        {toastNodes}
      </div>
    </NotifyContext.Provider>
  )
}
