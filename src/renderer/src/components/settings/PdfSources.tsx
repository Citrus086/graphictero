import { useCallback, useEffect, useState } from 'react'
import { PdfSourceItemSchema, PdfSourcesSchema, type PdfSourceItem } from '../../../../shared/ipc/cand'
import { Ic } from '../../lib/icons'
import { ipcErrorMessage } from '../../lib/ipcError'
import { useNotify } from '../../lib/notify'
import { candApi } from '../../lib/candProgress'

/**
 * M6 lane/ui 批 1：设置页「PDF 来源」组（原型 05；D54/D65(7)/D131/D64）。
 *
 * - 有序来源列表：拖动排序 + 开关；open_access = 内建开放获取链（arXiv → OpenAlex →
 *   Unpaywall），custom = 用户 https {doi} 模板（校验对齐共享契约 zod：必须 https、
 *   必须含 {doi}；默认不预置任何非官方来源）。
 * - Unpaywall 联系邮箱（D131：只用于查找开放获取版本）；机构代理「后续版本」灰行（D64 → M8）。
 * - 保存经 cand:setPdfSources，保存后立即生效（重试查找按新顺序，D133）。
 */

const MAX_SOURCES = 20

/** 排序 DnD 的 dataTransfer 键（HTML5 标准模式：dragstart 写入、drop 读出，不依赖跨事件 state） */
const SRC_DND_MIME = 'application/x-graphictero-pdfsrc'

const SOURCE_NAME: Record<PdfSourceItem['kind'], string> = {
  open_access: '开放获取',
  custom: '自定义 URL 模板'
}
const SOURCE_DESC: Record<PdfSourceItem['kind'], string> = {
  open_access: 'arXiv / OpenAlex / Unpaywall 查到的合法开放版本',
  custom: '模板里用 {doi} 代表论文 DOI'
}

/**
 * 建议修 4：添加/保存前直接用共享契约 schema（冻结文件不改，渲染层 import 做 safeParse），
 * 不再维护手写第二份规则；zod issue 文案转成用户可读的 inline 提示。
 */
function schemaIssueMessage(e: { issues: Array<{ code: string; message: string; path: unknown }> }): string {
  const issue = e.issues[0]
  if (issue == null) return '内容不合法，请检查'
  const path = Array.isArray(issue.path) ? issue.path.map(String) : []
  if (issue.code === 'too_big') {
    return path.includes('unpaywallEmail') ? '邮箱过长（最多 500 字）' : '模板过长（最多 2000 字）'
  }
  if (issue.code === 'too_small') return '内容不能为空'
  return issue.message
}

export function PdfSources(): React.JSX.Element {
  const notify = useNotify()
  const [sources, setSources] = useState<PdfSourceItem[] | null>(null)
  const [savedSources, setSavedSources] = useState<PdfSourceItem[] | null>(null)
  const [email, setEmail] = useState('')
  const [savedEmail, setSavedEmail] = useState('')
  const [emailDirty, setEmailDirty] = useState(false)
  const [emailSaving, setEmailSaving] = useState(false)
  const [emailError, setEmailError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [adding, setAdding] = useState(false)
  const [tpl, setTpl] = useState('')
  const [tplError, setTplError] = useState<string | null>(null)
  const [dragFrom, setDragFrom] = useState<number | null>(null)

  useEffect(() => {
    let disposed = false
    candApi()
      .getPdfSources()
      .then((s) => {
        if (disposed) return
        setSources(s.sources)
        setSavedSources(s.sources)
        const loaded = s.unpaywallEmail ?? ''
        setEmail(loaded)
        setSavedEmail(loaded)
      })
      .catch(() => !disposed && setLoadError(true))
    return () => {
      disposed = true
    }
  }, [])

  const mutate = useCallback((next: PdfSourceItem[]): void => {
    setSources(next)
    setDirty(true)
  }, [])

  const toggle = (i: number): void => {
    if (!sources) return
    mutate(sources.map((s, idx) => (idx === i ? { ...s, enabled: !s.enabled } : s)))
  }

  const removeAt = (i: number): void => {
    if (!sources) return
    mutate(sources.filter((_, idx) => idx !== i))
  }

  const dropOn = (to: number, fromStr: string): void => {
    if (!sources) return
    const from = Number(fromStr)
    if (!Number.isInteger(from) || from < 0 || from >= sources.length || from === to) return
    const next = [...sources]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    mutate(next)
  }

  const addCustom = (): void => {
    if (!sources) return
    const item: PdfSourceItem = { kind: 'custom', enabled: true, template: tpl }
    const parsed = PdfSourceItemSchema.safeParse(item)
    if (!parsed.success) {
      setTplError(schemaIssueMessage(parsed.error))
      return
    }
    setTplError(null)
    mutate([...sources, parsed.data])
    setTpl('')
    setAdding(false)
  }

  const save = async (): Promise<void> => {
    if (!sources || saving) return
    // 来源列表的保存不带走尚未保存的邮箱编辑。
    const parsed = PdfSourcesSchema.safeParse({ sources, unpaywallEmail: savedEmail.trim() || undefined })
    if (!parsed.success) {
      notify(schemaIssueMessage(parsed.error))
      return
    }
    setSaving(true)
    try {
      await candApi().setPdfSources(parsed.data)
      setSavedSources(parsed.data.sources)
      setDirty(false)
      notify('PDF 来源已保存')
    } catch (e) {
      notify(ipcErrorMessage(e, '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  const saveEmail = async (): Promise<void> => {
    if (!savedSources || emailSaving || !emailDirty) return
    const parsed = PdfSourcesSchema.safeParse({ sources: savedSources, unpaywallEmail: email.trim() || undefined })
    if (!parsed.success) {
      setEmailError(schemaIssueMessage(parsed.error))
      return
    }
    setEmailError(null)
    setEmailSaving(true)
    try {
      await candApi().setPdfSources(parsed.data)
      const next = parsed.data.unpaywallEmail ?? ''
      setSavedEmail(next)
      setEmail(next)
      setEmailDirty(false)
      notify('联系邮箱已保存')
    } catch (e) {
      notify(ipcErrorMessage(e, '保存失败'))
    } finally {
      setEmailSaving(false)
    }
  }

  if (loadError) {
    return (
      <div className="hintbar" data-testid="pdfsrc-error">
        <Ic name="warn" size={14} />
        <span>读取 PDF 来源设置失败，请返回重进本页。</span>
      </div>
    )
  }
  if (sources == null) {
    return (
      <div className="t3" style={{ fontSize: 12.5, padding: '4px 4px 12px' }}>
        正在加载…
      </div>
    )
  }

  return (
    <div data-testid="pdfsrc">
      <div className="ghead">查找 PDF 的来源</div>
      {/* data-dragfrom：冒烟/测试可观测拖动态（HTML5 DnD 合成事件在 Chromium 下驱动用） */}
      <div className="group" style={{ padding: '6px 8px' }} data-dragfrom={dragFrom ?? ''}>
        {sources.map((s, i) => (
          <div
            key={`${s.kind}-${s.template ?? i}`}
            className={`srcrow${dragFrom === i ? ' dragging' : ''}`}
            data-testid="pdf-src-row"
            data-kind={s.kind}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              const from = e.dataTransfer.getData(SRC_DND_MIME)
              if (from) dropOn(i, from)
              setDragFrom(null)
            }}
          >
            <span
              className="hdl"
              title="拖动排序"
              draggable
              data-testid="pdf-src-handle"
              onDragStart={(e) => {
                e.dataTransfer.setData(SRC_DND_MIME, String(i))
                e.dataTransfer.effectAllowed = 'move'
                setDragFrom(i)
              }}
              onDragEnd={() => setDragFrom(null)}
            >
              <i />
              <i />
              <i />
            </span>
            <span className="no">{i + 1}</span>
            <div className="srcinfo">
              <div className="nm">
                {s.kind === 'custom' ? (s.template ?? '') : SOURCE_NAME[s.kind]}
                {!s.enabled && <span className="off">已停用</span>}
              </div>
              <div className="ds">{s.kind === 'custom' ? SOURCE_DESC.custom : SOURCE_DESC.open_access}</div>
            </div>
            {s.kind === 'custom' && (
              <button type="button" className="btn icon sm" data-testid="pdf-src-del" title="删除该来源" onClick={() => removeAt(i)}>
                <Ic name="trash" size={13} />
              </button>
            )}
            <button
              type="button"
              className={`psw${s.enabled ? ' on' : ''}`}
              data-testid="pdf-src-toggle"
              role="switch"
              aria-checked={s.enabled}
              title={s.enabled ? '停用该来源' : '启用该来源'}
              onClick={() => toggle(i)}
            >
              <i />
            </button>
          </div>
        ))}
        <div className="srcfoot">
          {adding ? (
            <div className="srcadd">
              <input
                className="tin"
                data-testid="pdf-src-template"
                style={{ flex: 1 }}
                placeholder="https://…/{doi}"
                value={tpl}
                onChange={(e) => {
                  setTpl(e.target.value)
                  setTplError(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addCustom()
                }}
              />
              <button type="button" className="btn primary sm" data-testid="pdf-src-add-ok" onClick={addCustom}>
                添加
              </button>
              <button
                type="button"
                className="btn sm"
                data-testid="pdf-src-add-cancel"
                onClick={() => {
                  setAdding(false)
                  setTpl('')
                  setTplError(null)
                }}
              >
                取消
              </button>
              {tplError && (
                <div className="srcerr" data-testid="pdf-src-error">
                  {tplError}
                </div>
              )}
            </div>
          ) : (
            <button
              type="button"
              className="btn bordered sm"
              data-testid="pdf-src-add"
              disabled={sources.length >= MAX_SOURCES}
              onClick={() => setAdding(true)}
            >
              <Ic name="plus" size={13} />
              添加自定义来源…
            </button>
          )}
          <span className="grow" />
          <button type="button" className={`btn sm ${dirty ? 'primary' : 'saved'}`} data-testid="pdf-src-save" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? '保存中…' : dirty ? '保存' : '已保存'}
          </button>
        </div>
      </div>
      <div className="note">没有 PDF 的论文会按上面的顺序逐个查找，找到即停止。拖动左侧手柄调整顺序。默认只有开放获取，不预置任何非官方来源。</div>

      <div className="later">机构代理 · 后续版本</div>

      <div className="ghead" style={{ marginTop: 22 }}>
        Unpaywall
      </div>
      <div className="group">
        <div className="grow-r" style={{ minHeight: 42, padding: '6px 16px' }}>
          <div className="k">联系邮箱</div>
          <div className="v">
            <input
              className="tin"
              data-testid="pdf-src-email"
              style={{ width: 320, maxWidth: '100%' }}
              placeholder="name@example.com"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value)
                setEmailDirty(true)
                setEmailError(null)
              }}
              onBlur={() => void saveEmail()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveEmail()
              }}
            />
            <button
              type="button"
              className={`btn sm ${emailDirty ? 'primary' : 'saved'}`}
              data-testid="pdf-src-email-save"
              disabled={!emailDirty || emailSaving}
              onClick={() => void saveEmail()}
            >
              {emailSaving ? '保存中…' : emailDirty ? '保存' : '已保存'}
            </button>
          </div>
        </div>
      </div>
      {emailError && (
        <div className="srcerr" data-testid="pdf-src-email-error">
          {emailError}
        </div>
      )}
      <div className="note">Unpaywall 要求每次查询附上一个邮箱，只用于查找开放获取版本。留空则使用本机已有的默认邮箱。</div>
    </div>
  )
}
