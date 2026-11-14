import { describe, expect, it } from 'vitest'
import { pdfOriginLabel } from './pdfOriginLabel'

describe('PDF 来源展示', () => {
  it('开放获取列没有成功尝试时仍写开放获取', () => {
    expect(pdfOriginLabel('open_access', null)).toBe('开放获取')
    expect(
      pdfOriginLabel('open_access', [
        { source: 'arxiv', result: 'not_found' },
        { source: 'openalex', result: 'error' }
      ])
    ).toBe('开放获取')
  })

  it('最近一次成功尝试映射成 arXiv / OpenAlex / Unpaywall', () => {
    expect(
      pdfOriginLabel('open_access', [
        { source: 'openalex', result: 'ok' },
        { source: 'arxiv', result: 'ok' }
      ])
    ).toBe('arXiv')
    expect(pdfOriginLabel('open_access', [{ source: 'unpaywall', result: 'ok' }])).toBe('Unpaywall')
    expect(pdfOriginLabel('open_access', [{ source: 'custom:proxy', result: 'ok' }])).toBe('开放获取')
  })

  it('其它 pdf_source 不改口径', () => {
    expect(pdfOriginLabel('zotero', [{ source: 'arxiv', result: 'ok' }])).toBe('Zotero')
    expect(pdfOriginLabel('user_drop', null)).toBe('拖入文件')
    expect(pdfOriginLabel('custom', null)).toBe('自定义来源')
    expect(pdfOriginLabel('institution_proxy', null)).toBe('机构代理')
  })
})