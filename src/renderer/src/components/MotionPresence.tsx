import { useEffect, useRef, useState, type ReactNode } from 'react'
import { currentMotionDisabled, MOTION_BASE_MS, MOTION_FAST_MS } from '../lib/motion'

export type MotionKind = 'pop' | 'drawer' | 'modal' | 'page' | 'view'
export type MotionPhase = 'entering' | 'open' | 'exiting'

export interface MotionPresenceProps {
  open: boolean
  children: ReactNode
  kind?: MotionKind
}

/**
 * D200：给条件渲染内容补退出生命周期。open=false 时暂存最后一帧 children，
 * 淡出结束才卸载；重新打开会取消旧计时器。display:contents 由 CSS 保持原布局。
 */
function AnimatedMotionPresence({
  open,
  children,
  kind = 'pop'
}: MotionPresenceProps): React.JSX.Element | null {
  const [present, setPresent] = useState(open)
  const [phase, setPhase] = useState<MotionPhase>(open ? 'entering' : 'open')
  const lastChildren = useRef<ReactNode>(null)
  const motionOff = currentMotionDisabled()
  if (open && children != null) lastChildren.current = children

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    if (open) {
      setPresent(true)
      if (currentMotionDisabled()) {
        setPhase('open')
      } else {
        setPhase('entering')
        timer = setTimeout(() => setPhase('open'), MOTION_BASE_MS)
      }
    } else if (present) {
      if (currentMotionDisabled()) {
        setPresent(false)
        setPhase('open')
      } else {
        setPhase('exiting')
        timer = setTimeout(() => {
          setPresent(false)
          setPhase('open')
        }, kind === 'page' ? MOTION_BASE_MS : MOTION_FAST_MS)
      }
    }
    return () => {
      if (timer != null) clearTimeout(timer)
    }
    // present 只需在 open 变化的当次闭包里读取；setPresent 不应重启退出计时。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // off / reduced 下关闭必须在本次 render 同步消失，否则外部点击后的重开会看到旧弹层。
  if (!open && motionOff) return null
  const content = open ? children : lastChildren.current
  if (content == null || (!present && !open)) return null
  // open=true 的当次 render 就挂载，保持既有交互时序；effect 只负责后续阶段与退出卸载。
  const shownPhase = open && (!present || phase === 'exiting') ? (motionOff ? 'open' : 'entering') : phase
  return (
    <div className={`gt-motion gt-motion-${kind}`} data-motion-state={shownPhase}>
      {content}
    </div>
  )
}

/** off / reduce 不走 hooks、不挂 wrapper、不跑退出计时，DOM 与既有条件渲染完全一致。 */
export function MotionPresence(props: MotionPresenceProps): React.JSX.Element | null {
  if (currentMotionDisabled()) return props.open ? <>{props.children}</> : null
  return <AnimatedMotionPresence {...props} />
}
