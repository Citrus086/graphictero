import type { PaperSummary } from '../../../shared/ipc'

/** 论文行元信息：第一作者 · 年份（缺省不显示对应段） */
export function paperMeta(p: PaperSummary): string {
  return [p.firstAuthor ?? '—', p.year ? String(p.year) : null].filter(Boolean).join(' · ')
}

/** 首页卡片「更新于 …」：相对时间，解析失败回退 — */
export function relTime(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  const diff = Date.now() - t
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d} 天前`
  const dt = new Date(t)
  return `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()}`
}

/** 存储路径单行中间省略：拆成「可截断的前缀」+「完整保留的尾部」 */
export function splitPath(path: string): [string, string] {
  const i = path.lastIndexOf('/')
  if (i <= 0) return ['', path]
  return [path.slice(0, i + 1), path.slice(i + 1)]
}

/** 把绝对路径收成 ~ 开头。home 对不上就原样返回，不造路径。 */
export function tildePath(full: string, home: string): string {
  if (!full || !home) return full
  const norm = full.replace(/\\/g, '/')
  const h = home.replace(/\\/g, '/').replace(/\/$/, '')
  if (norm === h) return '~'
  if (norm.startsWith(h + '/')) return `~${norm.slice(h.length)}`
  return full
}

/** 目录路径：尾部带 /，供 pathm 的两段样式。 */
export function splitDirPath(display: string): [string, string] {
  const trimmed = display.replace(/\/$/, '')
  const [a, b] = splitPath(trimmed)
  return [a, b ? `${b}/` : b]
}

/** 中段省略。短于上限原样返回。 */
export function ellipsisMiddle(value: string, max = 42): string {
  if (value.length <= max) return value
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`
}

function shanghaiParts(d: Date): { ymd: string; hm: string } {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d)
  const hm = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(d)
  return { ymd, hm }
}

/** 北京时间 HH:MM。 */
export function beijingClock(now = new Date()): string {
  return shanghaiParts(now).hm
}

function shanghaiYesterday(now: Date): string {
  const [y, m, day] = shanghaiParts(now).ymd.split('-').map(Number)
  const utc = new Date(Date.UTC(y, m - 1, day))
  utc.setUTCDate(utc.getUTCDate() - 1)
  const yy = utc.getUTCFullYear()
  const mm = String(utc.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(utc.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

/** 今天 / 昨天 HH:MM，更早则 YYYY-MM-DD HH:MM。比较的是北京时间日历日。 */
export function formatCallTime(iso: string, now = new Date()): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'
  const parts = shanghaiParts(at)
  const today = shanghaiParts(now).ymd
  if (parts.ymd === today) return `今天 ${parts.hm}`
  if (parts.ymd === shanghaiYesterday(now)) return `昨天 ${parts.hm}`
  return `${parts.ymd} ${parts.hm}`
}

/** 本地时区的 HH:MM（备份 mtime 等「这台机器上的时间」）。 */
export function localClock(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'
  const y = at.getFullYear()
  const m = String(at.getMonth() + 1).padStart(2, '0')
  const d = String(at.getDate()).padStart(2, '0')
  const hm = at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const today = new Date()
  const sameDay = y === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate()
  if (sameDay) return `今天 ${hm}`
  const yest = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (y === yest.getFullYear() && at.getMonth() === yest.getMonth() && at.getDate() === yest.getDate()) return `昨天 ${hm}`
  return `${y}-${m}-${d} ${hm}`
}
