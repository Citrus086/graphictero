const PDF_SOURCE_LABEL: Record<string, string> = {
  zotero: 'Zotero',
  open_access: '开放获取',
  institution_proxy: '机构代理',
  custom: '自定义来源',
  user_drop: '拖入文件'
}

/** pdf_source 仍是 open_access 时，展示最近一次成功尝试的具体来源。 */
const OK_ATTEMPT_LABEL: Record<string, string> = {
  arxiv: 'arXiv',
  openalex: 'OpenAlex',
  unpaywall: 'Unpaywall'
}

export function pdfOriginLabel(
  pdfSource: string | null | undefined,
  attempts: Array<{ result: string; source: string }> | null | undefined
): string {
  if (!pdfSource) return ''
  if (pdfSource !== 'open_access') return PDF_SOURCE_LABEL[pdfSource] ?? pdfSource
  let ok: { source: string } | undefined
  for (const a of attempts ?? []) {
    if (a.result === 'ok') ok = a
  }
  if (!ok) return '开放获取'
  return OK_ATTEMPT_LABEL[ok.source] ?? '开放获取'
}
