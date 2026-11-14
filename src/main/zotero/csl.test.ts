import { describe, expect, it } from 'vitest'
import { cslExportId, itemToCsl, parseDateParts } from './csl'
import type { ZoteroItem } from './types'

/**
 * D61 验收：Zotero 字段映射为 CSL-JSON，与 Zotero 自带的 CSL JSON 导出逐字段一致。
 * 全部用合成样例数据；expected 按 Zotero 7 的 CSL JSON 导出行为手工构造。
 */

/** 逐字段比对：返回所有不一致的叶子路径（两边都多/少字段都算不一致）。 */
export function diffCsl(expected: unknown, actual: unknown, path = ''): string[] {
  if (expected === actual) return []
  if (expected == null || actual == null) return [`${path}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`]
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) return [`${path}: 数组长度 ${expected.length} != ${actual.length}`]
    return expected.flatMap((e, i) => diffCsl(e, actual[i], `${path}[${i}]`))
  }
  if (typeof expected === 'object' && typeof actual === 'object') {
    const keys = new Set([...Object.keys(expected as object), ...Object.keys(actual as object)])
    return [...keys].flatMap((k) =>
      diffCsl(
        (expected as Record<string, unknown>)[k],
        (actual as Record<string, unknown>)[k],
        path ? `${path}.${k}` : k
      )
    )
  }
  return [`${path}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`]
}

describe('Zotero → CSL-JSON 逐字段比对（D61）', () => {
  it('期刊论文：journalArticle → article-journal，全字段', () => {
    // 合成 Zotero Local API 条目（形状与真实响应一致）
    const item: ZoteroItem = {
      key: 'ABCD2345',
      version: 42,
      itemType: 'journalArticle',
      title: 'Attention Is All You Need',
      creators: [
        { creatorType: 'author', firstName: 'Ashish', lastName: 'Vaswani' },
        { creatorType: 'author', firstName: 'Noam', lastName: 'Shazeer' }
      ],
      abstractNote: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.',
      publicationTitle: 'Advances in Neural Information Processing Systems',
      volume: '30',
      issue: '1',
      pages: '5998–6008',
      DOI: '10.48550/arXiv.1706.03762',
      url: 'https://arxiv.org/abs/1706.03762',
      date: '2017',
      language: 'en',
      ISSN: '1049-5258',
      extra: '',
      attachments: []
    }
    // 期望：Zotero 7 自带的 CSL JSON 导出结果
    const expected = {
      id: 'ABCD2345',
      type: 'article-journal',
      title: 'Attention Is All You Need',
      author: [
        { family: 'Vaswani', given: 'Ashish' },
        { family: 'Shazeer', given: 'Noam' }
      ],
      abstract:
        'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.',
      'container-title': 'Advances in Neural Information Processing Systems',
      volume: '30',
      issue: '1',
      page: '5998–6008',
      DOI: '10.48550/arXiv.1706.03762',
      URL: 'https://arxiv.org/abs/1706.03762',
      issued: { 'date-parts': [['2017']] },
      language: 'en',
      ISSN: '1049-5258'
    }
    expect(diffCsl(expected, itemToCsl(item))).toEqual([])
  })

  it('会议论文：conferencePaper → paper-conference，container-title 取 proceedingsTitle', () => {
    const item: ZoteroItem = {
      key: 'CONF0001',
      version: 7,
      itemType: 'conferencePaper',
      title: 'BERT: Pre-training of Deep Bidirectional Transformers',
      creators: [{ creatorType: 'author', firstName: 'Jacob', lastName: 'Devlin' }],
      proceedingsTitle: 'Proceedings of NAACL-HLT 2019',
      publisher: 'Association for Computational Linguistics',
      place: 'Minneapolis, Minnesota',
      pages: '4171–4186',
      DOI: '10.18653/v1/N19-1423',
      url: 'https://aclanthology.org/N19-1423',
      date: '2019-06-01',
      attachments: []
    }
    const expected = {
      id: 'CONF0001',
      type: 'paper-conference',
      title: 'BERT: Pre-training of Deep Bidirectional Transformers',
      author: [{ family: 'Devlin', given: 'Jacob' }],
      'container-title': 'Proceedings of NAACL-HLT 2019',
      publisher: 'Association for Computational Linguistics',
      'publisher-place': 'Minneapolis, Minnesota',
      page: '4171–4186',
      DOI: '10.18653/v1/N19-1423',
      URL: 'https://aclanthology.org/N19-1423',
      issued: { 'date-parts': [['2019', 6, 1]] }
    }
    expect(diffCsl(expected, itemToCsl(item))).toEqual([])
  })

  it('预印本：preprint → article，repository → publisher、archiveID → number、不导出 genre（D61 真实对照修正）', () => {
    const item: ZoteroItem = {
      key: 'PREP7777',
      version: 3,
      itemType: 'preprint',
      title: 'A Synthetic Survey of Test-time Compute',
      creators: [{ creatorType: 'author', firstName: 'Jane', lastName: 'Doe' }],
      date: 'March 2024',
      url: 'http://arxiv.org/abs/2403.00001',
      repository: 'arXiv',
      archiveID: 'arXiv:2403.00001',
      extra: '',
      attachments: []
    }
    const expected = {
      id: 'PREP7777',
      type: 'article',
      title: 'A Synthetic Survey of Test-time Compute',
      author: [{ family: 'Doe', given: 'Jane' }],
      URL: 'http://arxiv.org/abs/2403.00001',
      publisher: 'arXiv',
      number: 'arXiv:2403.00001',
      issued: { 'date-parts': [['2024', 3]] }
    }
    expect(diffCsl(expected, itemToCsl(item))).toEqual([])
  })

  it('extra → note（Zotero 通用映射，D61 真实对照修正）', () => {
    const item: ZoteroItem = {
      key: 'NOTE0001',
      version: 1,
      itemType: 'journalArticle',
      title: 'With Extra',
      extra: 'arXiv:2602.07549\n来源: 推荐',
      date: '2026',
      attachments: []
    }
    const csl = itemToCsl(item)
    expect(csl.note).toBe('arXiv:2602.07549\n来源: 推荐')
    expect(csl.genre).toBeUndefined()
  })

  it('书的章节：bookSection → chapter，container-title 取 bookTitle，editor 单独成桶', () => {
    const item: ZoteroItem = {
      key: 'CHAP1111',
      version: 5,
      itemType: 'bookSection',
      title: 'Deep Learning for NLP',
      creators: [
        { creatorType: 'author', firstName: 'Yann', lastName: 'LeCun' },
        { creatorType: 'editor', firstName: 'Chris', lastName: 'Manning' }
      ],
      bookTitle: 'Handbook of Natural Language Processing',
      publisher: 'CRC Press',
      pages: '123–145',
      date: '2020',
      ISBN: '978-0-123456-78-9',
      attachments: []
    }
    const expected = {
      id: 'CHAP1111',
      type: 'chapter',
      title: 'Deep Learning for NLP',
      author: [{ family: 'LeCun', given: 'Yann' }],
      editor: [{ family: 'Manning', given: 'Chris' }],
      'container-title': 'Handbook of Natural Language Processing',
      publisher: 'CRC Press',
      page: '123–145',
      issued: { 'date-parts': [['2020']] },
      ISBN: '978-0-123456-78-9'
    }
    expect(diffCsl(expected, itemToCsl(item))).toEqual([])
  })

  it('单字段创作者（机构名）→ literal；空字段不输出', () => {
    const item: ZoteroItem = {
      key: 'ORG00001',
      version: 1,
      itemType: 'report',
      title: 'Annual Model Evaluation',
      creators: [{ creatorType: 'author', name: 'OpenAI' }],
      date: '2023',
      publisher: 'OpenAI',
      attachments: []
    }
    const expected = {
      id: 'ORG00001',
      type: 'report',
      title: 'Annual Model Evaluation',
      author: [{ literal: 'OpenAI' }],
      issued: { 'date-parts': [['2023']] },
      publisher: 'OpenAI'
    }
    expect(diffCsl(expected, itemToCsl(item))).toEqual([])
  })
})

describe('parseDateParts（Zotero 口径）', () => {
  it.each([
    ['2017', [2017]],
    ['2023-05-01', [2023, 5, 1]],
    ['2023/5/1', [2023, 5, 1]],
    ['March 2023', [2023, 3]],
    ['2023 Mar', [2023, 3]],
    // 美式/英式全日期（出版商导入的常见形态，评审必须修 3）
    ['May 1, 2023', [2023, 5, 1]],
    ['May 1st, 2023', [2023, 5, 1]],
    ['1 May 2023', [2023, 5, 1]],
    ['1st May 2023', [2023, 5, 1]],
    // 带时间的 accessDate：sqlite "2023-05-01 12:00:00"、Local API ISO "2023-05-01T12:00:00Z"
    ['2023-05-01 12:00:00', [2023, 5, 1]],
    ['2023-05-01T12:00:00Z', [2023, 5, 1]],
    ['2023-05-01T12:00:00+08:00', [2023, 5, 1]]
  ])('%s → %j', (input, expected) => {
    expect(parseDateParts(input)).toEqual(expected)
  })

  it('无法解析的日期不输出 issued', () => {
    expect(parseDateParts('n.d.')).toBeNull()
    expect(parseDateParts('')).toBeNull()
    expect(parseDateParts(undefined)).toBeNull()
  })
})

describe('accessed（accessDate → CSL，评审必须修 3 补用例）', () => {
  it('sqlite 形态带时间的 accessDate 解析出 accessed', () => {
    const item: ZoteroItem = {
      key: 'WEB00001',
      version: 2,
      itemType: 'webpage',
      title: 'A Web Resource',
      url: 'https://example.org/page',
      accessDate: '2023-05-01 12:00:00',
      attachments: []
    }
    expect(itemToCsl(item).accessed).toEqual({ 'date-parts': [['2023', 5, 1]] })
  })

  it('Local API 形态 ISO 带 Z 的 accessDate 解析出 accessed；issued 美式全日期', () => {
    const item: ZoteroItem = {
      key: 'WEB00002',
      version: 2,
      itemType: 'webpage',
      title: 'Another Web Resource',
      url: 'https://example.org/other',
      date: 'May 1, 2023',
      accessDate: '2023-05-01T12:00:00Z',
      attachments: []
    }
    const csl = itemToCsl(item)
    expect(csl.issued).toEqual({ 'date-parts': [['2023', 5, 1]] })
    expect(csl.accessed).toEqual({ 'date-parts': [['2023', 5, 1]] })
  })

  it('英式全日期 "1 May 2023" → issued', () => {
    const item: ZoteroItem = {
      key: 'WEB00003',
      version: 1,
      itemType: 'journalArticle',
      title: 'British Date Paper',
      date: '1 May 2023',
      attachments: []
    }
    expect(itemToCsl(item).issued).toEqual({ 'date-parts': [['2023', 5, 1]] })
  })
})

describe('cslExportId（D97：导出时拼完整 URI，库里只存裸 itemKey）', () => {
  it('用户库：拼 http://zotero.org/users/<userID>/items/<itemKey>', () => {
    expect(cslExportId('X7HW99IN', 'user', 21786651)).toBe(
      'http://zotero.org/users/21786651/items/X7HW99IN'
    )
    // 数字 userID 与真实 Zotero 导出逐字节一致（D61 对照口径）
    expect(cslExportId('ABCD2345', 'user', '21786651')).toBe(
      'http://zotero.org/users/21786651/items/ABCD2345'
    )
  })

  it('群组库：拼 http://zotero.org/groups/<groupID>/items/<itemKey>', () => {
    expect(cslExportId('GROUP001', 'group', 12345)).toBe(
      'http://zotero.org/groups/12345/items/GROUP001'
    )
  })

  it('itemToCsl 存的是裸 itemKey（不做拼接，与库里 csl_json 一致）', () => {
    const item: ZoteroItem = {
      key: 'X7HW99IN',
      version: 1,
      itemType: 'journalArticle',
      title: 'Bare Key Paper',
      attachments: []
    }
    expect(itemToCsl(item).id).toBe('X7HW99IN')
  })
})
