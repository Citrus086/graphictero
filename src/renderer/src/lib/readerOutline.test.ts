import { describe, expect, it } from 'vitest'
import { PdfActionType, type PdfBookmarkObject } from '@embedpdf/models'
import { flattenBookmarks } from './readerOutline'

/**
 * 目录 tab（D105③ + uat3 必须修 4）：构造 outline 对象（destination 型 / action GoTo 型 /
 * named dest 型 / URI action / 嵌套 / 空标题），不触引擎/网络、不提交任何 PDF。
 */

const dest = (pageIndex: number): PdfBookmarkObject['target'] =>
  ({ type: 'destination', destination: { pageIndex } }) as PdfBookmarkObject['target']
const goto = (pageIndex: number): PdfBookmarkObject['target'] =>
  ({ type: 'action', action: { type: PdfActionType.Goto, destination: { pageIndex } } }) as PdfBookmarkObject['target']
const uri = (u: string): PdfBookmarkObject['target'] =>
  ({ type: 'action', action: { type: PdfActionType.URI, uri: u } }) as PdfBookmarkObject['target']

describe('flattenBookmarks（阅读器目录 tab，D105③）', () => {
  it('拍平嵌套书签树：title / 目标页 / 深度；无 target 页为 null', () => {
    const outline: PdfBookmarkObject[] = [
      {
        title: '1 Introduction',
        target: dest(0),
        children: [
          { title: '1.1 Background', target: dest(1) },
          { title: '1.2 Contributions' } // 无 target
        ]
      },
      { title: '2 Method', target: dest(3) },
      { title: '' } // 空标题过滤
    ]
    expect(flattenBookmarks(outline)).toEqual([
      { title: '1 Introduction', pageIndex: 0, depth: 0 },
      { title: '1.1 Background', pageIndex: 1, depth: 1 },
      { title: '1.2 Contributions', pageIndex: null, depth: 1 },
      { title: '2 Method', pageIndex: 3, depth: 0 }
    ])
  })

  it('uat3 必须修 4：action 型 GoTo（/A GoTo）解析到页', () => {
    expect(flattenBookmarks([{ title: 'A', target: goto(5) }])).toEqual([{ title: 'A', pageIndex: 5, depth: 0 }])
  })

  it('uat3 必须修 4：named destination 解析不到页（pageIndex=-1）→ null 不崩', () => {
    const named: PdfBookmarkObject['target'] = {
      type: 'destination',
      destination: { pageIndex: -1 }
    } as PdfBookmarkObject['target']
    expect(flattenBookmarks([{ title: 'Named', target: named }])).toEqual([{ title: 'Named', pageIndex: null, depth: 0 }])
    const namedGoto: PdfBookmarkObject['target'] = {
      type: 'action',
      action: { type: PdfActionType.Goto, destination: { pageIndex: -1 } }
    } as PdfBookmarkObject['target']
    expect(flattenBookmarks([{ title: 'Named2', target: namedGoto }])).toEqual([{ title: 'Named2', pageIndex: null, depth: 0 }])
  })

  it('uat3 必须修 4：外部 URI action / RemoteGoto 不当页内跳转（null）', () => {
    const remote: PdfBookmarkObject['target'] = {
      type: 'action',
      action: { type: PdfActionType.RemoteGoto, destination: { pageIndex: 0 } }
    } as PdfBookmarkObject['target']
    expect(flattenBookmarks([{ title: 'Site', target: uri('https://example.com') }])).toEqual([
      { title: 'Site', pageIndex: null, depth: 0 }
    ])
    expect(flattenBookmarks([{ title: 'Remote', target: remote }])).toEqual([{ title: 'Remote', pageIndex: null, depth: 0 }])
  })

  it('空/异常输入返回空列表（UI 显示「没有目录」空态）', () => {
    expect(flattenBookmarks([])).toEqual([])
    expect(flattenBookmarks(undefined as never)).toEqual([])
  })
})
