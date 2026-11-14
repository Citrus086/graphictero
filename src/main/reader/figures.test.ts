import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { figureNormUnion, mineruNormRectToPageRect, resolveFigureByNo } from '../../shared/ipc/pdf'
import { isSubFigureCaption, listFigures, parseFigureBlocks, parseFigureNo, trimLeadingSubFigureCaption } from './figures'

/** 「按 bbox 跳到图」（D27）：structured_content 图块解析 + 坐标换算（Q6 裁定口径） */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-fig-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const CONTENT = {
  pages: [
    {
      page_idx: 0,
      blocks: [
        { type: 'doc_title', bbox: [0.1, 0.04, 0.4, 0.07], content: 'T' },
        { type: 'image', bbox: [0.16, 0.09, 0.49, 0.24], content: '', captions: [{ bbox: [0.1, 0.25, 0.3, 0.27], content: '图 1 架构总览' }], image_source: 'images/page_0_image_1.jpg' },
        { type: 'text', bbox: [0.1, 0.3, 0.5, 0.4], content: '正文' },
        { type: 'image', bbox: [0.2, 0.5, 0.5, 0.7], captions: [], image_source: 'images/page_0_image_3.jpg' }
      ]
    },
    {
      page_idx: 2,
      blocks: [
        { type: 'image', bbox: [0.0, 0.0, 0.5, 0.5], captions: [{ content: '第二页' }, { content: '的图' }], image_source: 'images/page_2_image_1.jpg' }
      ]
    }
  ]
}

describe('parseFigureBlocks（MinerU structured_content）', () => {
  it('只取 image 块：页码 / 归一化 bbox / 图注拼接 / 图片路径，跨页按文档顺序', () => {
    const figs = parseFigureBlocks(CONTENT)
    expect(figs).toHaveLength(3)
    expect(figs[0]).toEqual({
      page: 0,
      bbox: [0.16, 0.09, 0.49, 0.24],
      caption: '图 1 架构总览',
      imageSource: 'images/page_0_image_1.jpg',
      figureNo: 1 // uat2：图注「图 1…」解析出论文自身图号
    })
    expect(figs[1].caption).toBeNull() // 无 captions
    expect(figs[1].figureNo).toBeNull() // uat2：无图注不按顺序硬塞图号
    expect(figs[2].page).toBe(2)
    expect(figs[2].caption).toBe('第二页 的图')
    expect(figs[2].figureNo).toBeNull() // 图注里没有 Figure N / 图 N 标号
  })

  it('非 image 块、坏 bbox、坏页结构都跳过不炸', () => {
    const figs = parseFigureBlocks({
      pages: [
        { page_idx: 0, blocks: [
          { type: 'image', bbox: 'bad' },
          { type: 'image', bbox: [0.5, 0.5, 0.2, 0.2] }, // x1<x0
          { type: 'text', bbox: [0, 0, 1, 1] }
        ] },
        { blocks: [] }, // 缺 page_idx
        'not-an-object'
      ]
    })
    expect(figs).toEqual([])
    expect(parseFigureBlocks(null)).toEqual([])
    expect(parseFigureBlocks({})).toEqual([])
  })
})

describe('parseFigureBlocks（uat2 图号修复：image + chart 收、table 不收、按图注图号寻址）', () => {
  it('chart 块收进来；table 块不当图（首个图类块是 Table 1 也不占图号）', () => {
    const figs = parseFigureBlocks({
      pages: [
        { page_idx: 0, blocks: [
          { type: 'table', bbox: [0.1, 0.1, 0.5, 0.4], captions: [{ content: 'Table 1 数据集统计' }], image_source: 'images/page_0_table_1.jpg' },
          { type: 'chart', bbox: [0.1, 0.5, 0.5, 0.8], captions: [{ content: 'Figure 1 准确率随轮数变化' }], image_source: 'images/page_0_chart_1.jpg' }
        ] }
      ]
    })
    expect(figs).toHaveLength(1)
    expect(figs[0]).toMatchObject({ caption: 'Figure 1 准确率随轮数变化', figureNo: 1 })
  })

  it('附录图（Figure S1/A1）解析为 null，不按顺序顶替正文图号（顺序错位修复）', () => {
    const figs = parseFigureBlocks({
      pages: [
        { page_idx: 0, blocks: [
          { type: 'image', bbox: [0, 0, 1, 1], captions: [{ content: 'Figure 1 总览' }], image_source: 'a' },
          { type: 'image', bbox: [0, 0, 1, 1], captions: [{ content: 'Figure S1 补充实验' }], image_source: 'b' },
          { type: 'image', bbox: [0, 0, 1, 1], captions: [{ content: 'Figure A1 附录架构' }], image_source: 'c' },
          { type: 'image', bbox: [0, 0, 1, 1], captions: [{ content: 'Figure 2 细节' }], image_source: 'd' }
        ] }
      ]
    })
    // 旧下标口径会把 Figure 2 错配到第三块（S1）；新口径按图注图号：Figure 2 = 第四块
    expect(figs.map((f) => f.figureNo)).toEqual([1, null, null, 2])
    expect(resolveFigureByNo(figs, 2)).toBe(figs[3])
    expect(resolveFigureByNo(figs, 3)).toBeNull() // 没有图 3：优雅降级占位，绝不显示错图
  })

  it('同一图号多块（Figure 2(a)(b)）：寻址取文档顺序第一块', () => {
    const figs = parseFigureBlocks({
      pages: [
        { page_idx: 0, blocks: [
          { type: 'image', bbox: [0, 0, 0.5, 0.5], captions: [{ content: 'Figure 2(a) 流程' }], image_source: 'a' },
          { type: 'image', bbox: [0.5, 0, 1, 0.5], captions: [{ content: 'Figure 2(b) 结果' }], image_source: 'b' }
        ] }
      ]
    })
    expect(figs.map((f) => f.figureNo)).toEqual([2, 2])
    expect(resolveFigureByNo(figs, 2)).toBe(figs[0])
  })

  it('论文无图：空列表；大小写/全半角/Fig. 缩写兼容', () => {
    expect(parseFigureBlocks({ pages: [{ page_idx: 0, blocks: [{ type: 'text', content: '正文' }] }] })).toEqual([])
    expect(parseFigureNo('FIGURE ３ 全角')).toBe(3)
    expect(parseFigureNo('fig. 4 缩写')).toBe(4)
    expect(parseFigureNo('Fig 5 无点')).toBe(5)
    expect(parseFigureNo('架构图 3 层这种不提图号')).toBeNull() // 中文「图 N」只认图注开头
    expect(parseFigureNo('(a) 子图示意，见 Figure 6')).toBe(6) // 开头无标号：正文里第一次 Figure N
    expect(parseFigureNo(null)).toBeNull()
  })
})

describe('mineruNormRectToPageRect（归一化 → PDF 页面坐标，Q6 裁定）', () => {
  it('按页宽/高线性换算，左上原点', () => {
    // 612x792 页上 [0.162,0.089,0.491,0.244] → 实测探针矩形 (100,72)-(300,192) 区域
    const [x, y, w, h] = mineruNormRectToPageRect([0.162, 0.089, 0.491, 0.244], 612, 792)
    expect(x).toBeCloseTo(99.1, 0)
    expect(y).toBeCloseTo(70.5, 0)
    expect(w).toBeCloseTo(201.3, 0)
    expect(h).toBeCloseTo(122.8, 0)
    expect(x + w).toBeCloseTo(0.491 * 612, 6) // 右下角对齐 x1*w
    expect(y + h).toBeCloseTo(0.244 * 792, 6)
  })
})

describe('uat4 必须修 5：同块多条图注拆分与归属（MinerU 把前一张图的图注挂到后一块 captions 上）', () => {
  it('同页两个 image 块、第二块 captions 含「Figure 4」与「Fig. 5」两条（分两条 captions）→ 图 4 归第一块、图 5 归第二块（各自 imageSource 正确）', () => {
    const figs = parseFigureBlocks({
      pages: [
        { page_idx: 0, blocks: [
          { type: 'image', bbox: [0.1, 0.1, 0.4, 0.3], captions: [], image_source: 'images/fig4.jpg' },
          { type: 'image', bbox: [0.1, 0.4, 0.4, 0.6], captions: [{ content: 'Figure 4: 架构总览' }, { content: 'Fig. 5: 实验细节' }], image_source: 'images/fig5.jpg' }
        ] }
      ]
    })
    expect(figs).toHaveLength(2)
    expect(figs[0]).toMatchObject({ figureNo: 4, caption: 'Figure 4: 架构总览', imageSource: 'images/fig4.jpg' })
    expect(figs[1]).toMatchObject({ figureNo: 5, caption: 'Fig. 5: 实验细节', imageSource: 'images/fig5.jpg' })
    expect(resolveFigureByNo(figs, 4)).toBe(figs[0]) // 「图 4」指向第一块的图，不再错指图 5
    expect(resolveFigureByNo(figs, 5)).toBe(figs[1]) // 「图 5」现在能找到
  })

  it('两条图注合并在一个 captions 条目里（uat 实测形态）也按标号拆开；全半角/大小写同口径', () => {
    const figs = parseFigureBlocks({
      pages: [
        { page_idx: 0, blocks: [
          { type: 'image', bbox: [0.1, 0.1, 0.4, 0.3], captions: [], image_source: 'images/fig4.jpg' },
          { type: 'image', bbox: [0.1, 0.4, 0.4, 0.6], captions: [{ content: 'Ｆigure ４: 架构总览 Fig. 5: 实验细节' }], image_source: 'images/fig5.jpg' }
        ] }
      ]
    })
    expect(figs.map((f) => f.figureNo)).toEqual([4, 5])
    expect(figs[0].caption).toBe('Ｆigure ４: 架构总览') // 原文保留，只按归一化文本切位置
    expect(figs[1].caption).toBe('Fig. 5: 实验细节')
  })

  it('三条图注两个块：分不出去的中段图注不硬塞，该图号寻址不命中（占位，绝不显示错图）', () => {
    const figs = parseFigureBlocks({
      pages: [
        { page_idx: 0, blocks: [
          { type: 'image', bbox: [0.1, 0.1, 0.4, 0.3], captions: [], image_source: 'images/a.jpg' },
          { type: 'image', bbox: [0.1, 0.4, 0.4, 0.6], captions: [{ content: 'Figure 1: 甲' }, { content: 'Figure 2: 乙' }, { content: 'Figure 3: 丙' }], image_source: 'images/b.jpg' }
        ] }
      ]
    })
    expect(figs.map((f) => f.figureNo)).toEqual([1, 3]) // Figure 2 归属不明：不进任何块
    expect(resolveFigureByNo(figs, 1)).toBe(figs[0])
    expect(resolveFigureByNo(figs, 3)).toBe(figs[1])
    expect(resolveFigureByNo(figs, 2)).toBeNull() // 不命中 → 渲染层「图 2 未找到」占位
  })

  it('块顺序里没有前置无图注块：多余图注不硬塞（后续的无图注块不算前置），寻址不命中', () => {
    const figs = parseFigureBlocks({
      pages: [
        { page_idx: 0, blocks: [
          { type: 'image', bbox: [0.1, 0.4, 0.4, 0.6], captions: [{ content: 'Figure 1: 甲' }, { content: 'Figure 2: 乙' }], image_source: 'images/b.jpg' },
          { type: 'image', bbox: [0.1, 0.1, 0.4, 0.3], captions: [], image_source: 'images/a.jpg' }
        ] }
      ]
    })
    expect(figs).toHaveLength(2)
    expect(figs[0].figureNo).toBe(2) // 本块保留最后一条（离本块最近的才是自己的图注）
    expect(figs[1].figureNo).toBeNull() // 后面的无图注块不参与拆分归属
    expect(resolveFigureByNo(figs, 1)).toBeNull()
  })

  it('uat4-fix1 D173：跨页不回填——同页没有无图注块时子图注丢掉，前页空块保持无图注（归属不确定→占位）', () => {
    const figs = parseFigureBlocks({
      pages: [
        { page_idx: 0, blocks: [
          { type: 'image', bbox: [0.1, 0.1, 0.4, 0.3], captions: [], image_source: 'images/a.jpg' }
        ] },
        { page_idx: 1, blocks: [
          { type: 'image', bbox: [0.1, 0.4, 0.4, 0.6], captions: [{ content: 'Figure 6: 甲' }, { content: 'Figure 7: 乙' }], image_source: 'images/b.jpg' }
        ] }
      ]
    })
    // 不跨页回填：前页空块不再吃到后页的 Figure 6（旧测试期望跨页退回文档序，D173 改为占位）
    expect(figs[0]).toMatchObject({ figureNo: null, caption: null, imageSource: 'images/a.jpg' })
    expect(figs[1]).toMatchObject({ figureNo: 7, imageSource: 'images/b.jpg' })
    expect(resolveFigureByNo(figs, 6)).toBeNull() // 图 6 归属不确定 → 寻址不命中 → 占位
    expect(resolveFigureByNo(figs, 7)).toBe(figs[1])
  })

  it('uat4-fix1 M3：三图三注不对调——同页三个块、最后一块挂三条图注，图 1/2/3 各归其位', () => {
    const figs = parseFigureBlocks({
      pages: [
        { page_idx: 0, blocks: [
          { type: 'image', bbox: [0.1, 0.05, 0.4, 0.25], captions: [], image_source: 'images/f1.jpg' },
          { type: 'image', bbox: [0.1, 0.3, 0.4, 0.5], captions: [], image_source: 'images/f2.jpg' },
          { type: 'image', bbox: [0.1, 0.55, 0.4, 0.75], captions: [{ content: 'Figure 1: 甲' }, { content: 'Figure 2: 乙' }, { content: 'Figure 3: 丙' }], image_source: 'images/f3.jpg' }
        ] }
      ]
    })
    expect(figs.map((f) => f.figureNo)).toEqual([1, 2, 3])
    // 先远后近：第 1 条多余的（Figure 1）给最远的空块，第 2 条（Figure 2）给较近的空块；
    // 若按「就近先贴」赋值，图 1 与图 2 会对调
    expect(figs[0]).toMatchObject({ figureNo: 1, imageSource: 'images/f1.jpg' })
    expect(figs[1]).toMatchObject({ figureNo: 2, imageSource: 'images/f2.jpg' })
    expect(figs[2]).toMatchObject({ figureNo: 3, imageSource: 'images/f3.jpg' })
    expect(resolveFigureByNo(figs, 1)).toBe(figs[0])
    expect(resolveFigureByNo(figs, 2)).toBe(figs[1])
    expect(resolveFigureByNo(figs, 3)).toBe(figs[2])
  })
})

describe('uat4 建议修 8：多子图一并显示（兄弟子块并入带编号图的 subBboxes）', () => {
  it('同页相邻两个无图注 image 块 + 带「图 2」图注块 → 合并成一块，subBboxes 为两兄弟 bbox（并集高亮）', () => {
    const figs = parseFigureBlocks({
      pages: [
        { page_idx: 0, blocks: [
          { type: 'image', bbox: [0.05, 0.1, 0.45, 0.3], captions: [], image_source: 'images/sub_a.jpg' },
          { type: 'image', bbox: [0.5, 0.1, 0.9, 0.3], captions: [], image_source: 'images/sub_b.jpg' },
          { type: 'image', bbox: [0.05, 0.35, 0.9, 0.7], captions: [{ content: '图 2 总览（a）（b）' }], image_source: 'images/fig2.jpg' }
        ] }
      ]
    })
    expect(figs).toHaveLength(1) // 兄弟子块不单独成项
    expect(figs[0]).toMatchObject({ figureNo: 2, page: 0, bbox: [0.05, 0.35, 0.9, 0.7] })
    expect(figs[0].subBboxes).toEqual([
      [0.05, 0.1, 0.45, 0.3],
      [0.5, 0.1, 0.9, 0.3]
    ])
    expect(resolveFigureByNo(figs, 2)).toBe(figs[0])
    // 阅读器「跳到图」定位矩形 = 并集
    expect(figureNormUnion(figs[0])).toEqual([0.05, 0.1, 0.9, 0.7])
    expect(figureNormUnion({ bbox: [0.1, 0.2, 0.3, 0.4] })).toEqual([0.1, 0.2, 0.3, 0.4]) // 无兄弟：返回自身
  })

  it('中间隔了 text 块 → 只并紧邻的兄弟，被隔断的不并（不猜）', () => {
    const figs = parseFigureBlocks({
      pages: [
        { page_idx: 0, blocks: [
          { type: 'image', bbox: [0.05, 0.05, 0.45, 0.25], captions: [], image_source: 'images/far.jpg' },
          { type: 'text', bbox: [0.05, 0.3, 0.9, 0.4], content: '正文隔断' },
          { type: 'image', bbox: [0.5, 0.45, 0.9, 0.65], captions: [], image_source: 'images/near.jpg' },
          { type: 'image', bbox: [0.05, 0.7, 0.9, 0.95], captions: [{ content: '图 2 总览' }], image_source: 'images/fig2.jpg' }
        ] }
      ]
    })
    expect(figs).toHaveLength(2)
    expect(figs[0]).toMatchObject({ figureNo: null, caption: null }) // 被隔断的子块照旧单独显示
    expect(figs[1]).toMatchObject({ figureNo: 2 })
    expect(figs[1].subBboxes).toEqual([[0.5, 0.45, 0.9, 0.65]]) // 只有紧邻的一块并入
  })

  it('跨页 → 不合并：前页的无图注块保持独立，后页带编号图无 subBboxes', () => {
    const figs = parseFigureBlocks({
      pages: [
        { page_idx: 0, blocks: [
          { type: 'image', bbox: [0.05, 0.1, 0.45, 0.3], captions: [], image_source: 'images/p0.jpg' }
        ] },
        { page_idx: 1, blocks: [
          { type: 'image', bbox: [0.05, 0.1, 0.9, 0.5], captions: [{ content: '图 2 总览' }], image_source: 'images/fig2.jpg' }
        ] }
      ]
    })
    expect(figs).toHaveLength(2)
    expect(figs[0].figureNo).toBeNull()
    expect(figs[1].figureNo).toBe(2)
    expect(figs[1].subBboxes).toBeUndefined()
  })
})

describe('uat6 S4：带 (a)/(b) 子图注的多面板图合并（子面板块带子图注而非 null）', () => {
  it('两子块带「(a) foo」「(b) bar」子图注（ordinal 紧邻）+ 紧随「Figure 1: xxx」→ 图 1 一块，subBboxes 为两子块 bbox，子块不单独成项', () => {
    const figs = parseFigureBlocks({
      pages: [
        { page_idx: 0, blocks: [
          { type: 'image', bbox: [0.05, 0.1, 0.45, 0.3], captions: [{ content: '(a) Ablation results.' }], image_source: 'images/sub_a.jpg' },
          { type: 'image', bbox: [0.5, 0.1, 0.9, 0.3], captions: [{ content: '(b) Overall architecture.' }], image_source: 'images/sub_b.jpg' },
          { type: 'image', bbox: [0.05, 0.35, 0.9, 0.7], captions: [{ content: 'Figure 1: xxx' }], image_source: 'images/fig1.jpg' }
        ] }
      ]
    })
    expect(figs).toHaveLength(1) // 子图注块与无图注块同等处理：不单独成项、不切断合并
    expect(figs[0]).toMatchObject({ figureNo: 1, page: 0, bbox: [0.05, 0.35, 0.9, 0.7], caption: 'Figure 1: xxx' })
    expect(figs[0].subBboxes).toEqual([
      [0.05, 0.1, 0.45, 0.3],
      [0.5, 0.1, 0.9, 0.3]
    ])
    expect(resolveFigureByNo(figs, 1)).toBe(figs[0])
  })

  it('子图注块与编号块之间隔了 text 块（ordinal 不连续）→ 不合并：子图注块被 flush 单独成项，保留原子图注原文、figureNo null（与无图注块被 flush 对称为 caption 保留）', () => {
    const figs = parseFigureBlocks({
      pages: [
        { page_idx: 0, blocks: [
          { type: 'image', bbox: [0.05, 0.05, 0.45, 0.25], captions: [{ content: '(a) foo' }], image_source: 'images/sub_a.jpg' },
          { type: 'text', bbox: [0.05, 0.3, 0.9, 0.4], content: '正文隔断' },
          { type: 'image', bbox: [0.5, 0.45, 0.9, 0.65], captions: [{ content: 'Figure 1: xxx' }], image_source: 'images/fig1.jpg' }
        ] }
      ]
    })
    expect(figs).toHaveLength(2)
    // 锁定的 flush 形态：子图注块单独成项时 caption 保留原文（非置 null）、figureNo null
    expect(figs[0]).toMatchObject({ figureNo: null, caption: '(a) foo', imageSource: 'images/sub_a.jpg' })
    expect(figs[1]).toMatchObject({ figureNo: 1 })
    expect(figs[1].subBboxes).toBeUndefined() // 隔断：不并入
  })

  it('「(b) 结果见 Figure 2」带子图标号但解得出图号 → 不当子块：它是编号图，紧邻其前的「(a) foo」子块并入它的 subBboxes', () => {
    expect(isSubFigureCaption('(b) 结果见 Figure 2')).toBe(false) // 能解出正文图号：编号图本身
    const figs = parseFigureBlocks({
      pages: [
        { page_idx: 0, blocks: [
          { type: 'image', bbox: [0.05, 0.1, 0.45, 0.3], captions: [{ content: '(a) foo' }], image_source: 'images/sub_a.jpg' },
          { type: 'image', bbox: [0.5, 0.1, 0.9, 0.3], captions: [{ content: '(b) 结果见 Figure 2' }], image_source: 'images/sub_b.jpg' }
        ] }
      ]
    })
    expect(figs).toHaveLength(1)
    // uat6c S5：「子图注 + 主图注」合并注的显示口径改为从主图注起头（子图注不前置）
    expect(figs[0]).toMatchObject({ figureNo: 2, caption: 'Figure 2' })
    expect(figs[0].subBboxes).toEqual([[0.05, 0.1, 0.45, 0.3]]) // 只有 (a) 子块并入
    expect(resolveFigureByNo(figs, 2)).toBe(figs[0])
  })

  it('纯中文子图注「（a）消融结果」同样识别为子块（全角括号），并入带编号图的 subBboxes', () => {
    expect(isSubFigureCaption('（a）消融结果')).toBe(true)
    const figs = parseFigureBlocks({
      pages: [
        { page_idx: 0, blocks: [
          { type: 'image', bbox: [0.05, 0.1, 0.45, 0.3], captions: [{ content: '（a）消融结果' }], image_source: 'images/sub_a.jpg' },
          { type: 'image', bbox: [0.5, 0.1, 0.9, 0.3], captions: [{ content: '（ｂ）总体架构' }], image_source: 'images/sub_b.jpg' }, // 全角字母也归一
          { type: 'image', bbox: [0.05, 0.35, 0.9, 0.7], captions: [{ content: '图 1 总览' }], image_source: 'images/fig1.jpg' }
        ] }
      ]
    })
    expect(figs).toHaveLength(1)
    expect(figs[0].figureNo).toBe(1)
    expect(figs[0].subBboxes).toEqual([
      [0.05, 0.1, 0.45, 0.3],
      [0.5, 0.1, 0.9, 0.3]
    ])
  })

  it('isSubFigureCaption 单元口径：子图标号起头且解不出图号才为 true', () => {
    expect(isSubFigureCaption('(a) foo')).toBe(true)
    expect(isSubFigureCaption('(C)')).toBe(true)
    expect(isSubFigureCaption(' （b） 总体架构')).toBe(true) // 前导空白容忍
    expect(isSubFigureCaption('(a) 见 Figure 3')).toBe(false) // 解得出图号：编号图
    expect(isSubFigureCaption('Figure 1: xxx')).toBe(false)
    expect(isSubFigureCaption('图 2 总览')).toBe(false)
    expect(isSubFigureCaption('示意图 (a) 结果')).toBe(false) // 非起头
    expect(isSubFigureCaption('正文')).toBe(false)
  })

  it('回归：无图注块（caption==null）的多子图合并路径照旧（uat4 建议修 8 行为不回退）', () => {
    const figs = parseFigureBlocks({
      pages: [
        { page_idx: 0, blocks: [
          { type: 'image', bbox: [0.05, 0.1, 0.45, 0.3], captions: [], image_source: 'images/sub_a.jpg' },
          { type: 'image', bbox: [0.5, 0.1, 0.9, 0.3], captions: [{ content: '图 2 总览' }], image_source: 'images/fig2.jpg' }
        ] }
      ]
    })
    expect(figs).toHaveLength(1)
    expect(figs[0]).toMatchObject({ figureNo: 2, subBboxes: [[0.05, 0.1, 0.45, 0.3]] })
  })
})

describe('uat9 M2：子图标题进入 D189 并集，主图注与正文不进入', () => {
  it('合成 middle/structured 片段：跨三栏 (a)/(b)/(c)，独立标签块与 captions 项都纳入；相邻正文和主图注排除', () => {
    const a = [0.05, 0.305, 0.3, 0.33] as [number, number, number, number]
    const b = [0.36, 0.305, 0.61, 0.33] as [number, number, number, number]
    const c = [0.67, 0.305, 0.95, 0.33] as [number, number, number, number]
    const figs = parseFigureBlocks({
      pages: [{ page_idx: 0, blocks: [
        { type: 'image', bbox: [0.05, 0.1, 0.3, 0.3], captions: [], image_source: 'images/a.jpg' },
        { type: 'image_caption', bbox: a, content: '(a) Average Search Calls' },
        { type: 'image', bbox: [0.36, 0.1, 0.61, 0.3], captions: [], image_source: 'images/b.jpg' },
        { type: 'text', bbox: b, content: '(b) Ratio of Low-Confidence Samples' },
        {
          type: 'image', bbox: [0.67, 0.1, 0.95, 0.3], image_source: 'images/c.jpg',
          captions: [
            { bbox: c, content: '(c) Adaptive Target Error Rate' },
            { bbox: [0.05, 0.36, 0.95, 0.42], content: 'Figure 2: Training dynamics and sensitivity analyses.' }
          ]
        },
        { type: 'text', bbox: [0.05, 0.43, 0.95, 0.47], content: '(d) 这一段是图后的相邻正文，不属于任何子图。' }
      ] }]
    })
    expect(figs).toHaveLength(1)
    expect(figs[0].caption).toBe('Figure 2: Training dynamics and sensitivity analyses.')
    expect(figs[0].subBboxes).toEqual([[0.05, 0.1, 0.3, 0.3], [0.36, 0.1, 0.61, 0.3]])
    expect(figs[0].subCaptionBboxes).toHaveLength(3)
    expect(figs[0].subCaptionBboxes).toEqual(expect.arrayContaining([a, b, c]))
    // y1 只到子图标题 0.33；主图注的 0.42 与正文的 0.47 都不得吞入。
    expect(figureNormUnion(figs[0])).toEqual([0.05, 0.1, 0.95, 0.33])
  })

  it('captions 中独立的纯子图项纳入；含 Figure N 的合并项与过远标签保守排除', () => {
    const a = [0.05, 0.305, 0.45, 0.34] as [number, number, number, number]
    const c = [0.5, 0.305, 0.9, 0.34] as [number, number, number, number]
    const figs = parseFigureBlocks({
      pages: [{ page_idx: 0, blocks: [
        { type: 'image', bbox: [0.05, 0.1, 0.45, 0.3], captions: [{ bbox: a, content: '(a) foo' }] },
        { type: 'image_caption', bbox: [0.05, 0.55, 0.45, 0.58], content: '(b) 距离过远，不归属本图' },
        {
          type: 'image', bbox: [0.5, 0.1, 0.9, 0.3], image_source: 'images/c.jpg',
          captions: [{ bbox: c, content: '(c) bar Figure 2: 主图注与子图注同一文本项，整项不纳入' }]
        }
      ] }]
    })
    expect(figs).toHaveLength(1)
    expect(figs[0].subCaptionBboxes).toEqual([a])
    expect(figureNormUnion(figs[0])).toEqual([0.05, 0.1, 0.9, 0.34])
  })

  it('uat10 评审建议 1：挂在 image captions 上的子图 bbox 也走距离过滤——紧贴面板下的纳入、远处的剔除', () => {
    const near = [0.05, 0.305, 0.45, 0.34] as [number, number, number, number]
    const far = [0.05, 0.6, 0.45, 0.63] as [number, number, number, number]
    const figs = parseFigureBlocks({
      pages: [{ page_idx: 0, blocks: [
        {
          type: 'image', bbox: [0.05, 0.1, 0.45, 0.3], image_source: 'images/a.jpg',
          captions: [{ bbox: near, content: '(a) near label' }, { bbox: far, content: '(b) far away label' }]
        },
        { type: 'image', bbox: [0.5, 0.1, 0.9, 0.3], captions: [{ content: 'Figure 3: 主图注' }], image_source: 'images/b.jpg' }
      ] }]
    })
    expect(figs).toHaveLength(1)
    expect(figs[0].subCaptionBboxes).toEqual([near]) // 远处 (b) 不吃进并集
    expect(figureNormUnion(figs[0])).toEqual([0.05, 0.1, 0.9, 0.34])
  })
})

describe('uat10 复测：图 tab 标签只来自图注，不用图内 OCR 文本', () => {
  it('captions 里 bbox 落在图块自身 bbox 内的项是图内文字（如「Query: tract…」）→ 剔除，标签取图注', () => {
    const figs = parseFigureBlocks({
      pages: [{ page_idx: 0, blocks: [
        {
          type: 'image', bbox: [0.1, 0.1, 0.9, 0.5], image_source: 'images/p8f1.jpg',
          captions: [
            { bbox: [0.12, 0.15, 0.5, 0.2], content: 'Query: tract volumes vs. latency' }, // 图内 OCR 文本
            { bbox: [0.1, 0.51, 0.9, 0.55], content: 'Figure 1: Overview of the retrieval pipeline.' } // 真图注（图下方）
          ]
        }
      ] }]
    })
    expect(figs).toHaveLength(1)
    expect(figs[0].caption).toBe('Figure 1: Overview of the retrieval pipeline.')
    expect(figs[0].figureNo).toBe(1)
    expect(figs[0].caption).not.toContain('Query')
  })

  it('图内文字项不含图号标号时本就不会解出图号；整项都是图内文字 → caption 为 null（阅读器回退「未编号图」）', () => {
    const figs = parseFigureBlocks({
      pages: [{ page_idx: 0, blocks: [
        {
          type: 'image', bbox: [0.1, 0.1, 0.9, 0.5], image_source: 'images/p8f2.jpg',
          captions: [{ bbox: [0.12, 0.15, 0.6, 0.22], content: 'Query: tract Recall@10' }]
        }
      ] }]
    })
    expect(figs).toHaveLength(1)
    expect(figs[0].caption).toBeNull() // 无真图注：不用图内文字当标签
    expect(figs[0].figureNo).toBeNull()
  })

  it('caption 项无 bbox 时无法判定位置，保持原样（历史 fixtures 与行为不回退）', () => {
    const figs = parseFigureBlocks({
      pages: [{ page_idx: 0, blocks: [
        { type: 'image', bbox: [0.1, 0.1, 0.9, 0.5], captions: [{ content: '图 1 架构总览' }], image_source: 'images/a.jpg' }
      ] }]
    })
    expect(figs[0].caption).toBe('图 1 架构总览')
    expect(figs[0].figureNo).toBe(1)
  })
})

describe('uat4 建议修 9：table 块带 Figure 图注也收成图块', () => {
  it('table 块 captions 以 Figure 起头 → 可寻址（「跳到图 N」/图引用）；Table/表 起头照旧不收', () => {
    const figs = parseFigureBlocks({
      pages: [
        { page_idx: 0, blocks: [
          { type: 'table', bbox: [0.1, 0.05, 0.9, 0.3], captions: [{ content: 'Figure 4: 消融结果' }], image_source: 'images/tab_as_fig.jpg' },
          { type: 'table', bbox: [0.1, 0.35, 0.9, 0.6], captions: [{ content: 'Table 3 数据集统计' }], image_source: 'images/real_table.jpg' },
          { type: 'table', bbox: [0.1, 0.65, 0.9, 0.9], captions: [{ content: '表 4 对比' }], image_source: 'images/real_table2.jpg' }
        ] }
      ]
    })
    expect(figs).toHaveLength(1) // 只有带 Figure 图注的 table 收成图块
    expect(figs[0]).toMatchObject({ figureNo: 4, caption: 'Figure 4: 消融结果', imageSource: 'images/tab_as_fig.jpg' })
    expect(resolveFigureByNo(figs, 4)).toBe(figs[0])
    expect(resolveFigureByNo(figs, 3)).toBeNull() // Table 3 不是图（D155 表格跳转不做）
  })
})

describe('listFigures（缓存读取）', () => {
  it('缓存存在：读出图块；缺失 / 坏 JSON：空列表不炸', () => {
    const paperDir = join(dir, 'papers', '7', 'mineru')
    expect(listFigures(dir, 7)).toEqual([])
    mkdirSync(paperDir, { recursive: true })
    writeFileSync(join(paperDir, 'structured_content.json'), '{bad json')
    expect(listFigures(dir, 7)).toEqual([])
    writeFileSync(join(paperDir, 'structured_content.json'), JSON.stringify(CONTENT))
    expect(listFigures(dir, 7)).toHaveLength(3)
  })
})

describe('uat6c S5：子图注前置的「(c) … Figure 2: …」合并注（详情图卡 caption 口径）', () => {
  it('trimLeadingSubFigureCaption：子图注起头且含更晚主图注 → 截到主图注起头；其它注原样', () => {
    expect(trimLeadingSubFigureCaption('(c) Adaptive Target Error Rate $( \\alpha _ { t } )$ Figure 2: 总体架构与结果。')).toBe(
      'Figure 2: 总体架构与结果。'
    )
    expect(trimLeadingSubFigureCaption('（b）总体架构 Figure 3: 流程。')).toBe('Figure 3: 流程。')
    // 不含主图注的纯子图注：原样（uat6 S4 flushed 子块口径不变）
    expect(trimLeadingSubFigureCaption('(a) Ablation results.')).toBe('(a) Ablation results.')
    // 主图注在开头：原样
    expect(trimLeadingSubFigureCaption('Figure 2: 主图注。')).toBe('Figure 2: 主图注。')
    // 无子图注前缀的普通注：原样
    expect(trimLeadingSubFigureCaption('消融结果见上图。Figure 2: 主图注。')).toBe('消融结果见上图。Figure 2: 主图注。')
    // uat6c-fix1 S4：子图注内部更早提到的「fig. N / 图N」不是截断点
    expect(trimLeadingSubFigureCaption('(c) 参见 fig. 1 的设定与 图 3 层结构 Figure 2: 主图注。')).toBe('Figure 2: 主图注。')
    // 无主图注形态时取最后一个普通标号（「(b) 结果见 Figure 2」）
    expect(trimLeadingSubFigureCaption('(b) 结果见 fig. 1 与 Figure 2')).toBe('Figure 2')
  })

  it('多面板图：(a)/(b) 子图注块并入，(c) 块带「子图注+主图注」合并注 → 编号块 caption 以主图注起头，figureNo 不变', () => {
    const figs = parseFigureBlocks({
      pages: [
        { page_idx: 0, blocks: [
          { type: 'image', bbox: [0.05, 0.1, 0.45, 0.3], captions: [{ content: '(a) Ablation results.' }], image_source: 'images/f2a.jpg' },
          { type: 'image', bbox: [0.5, 0.1, 0.9, 0.3], captions: [{ content: '(b) Overall architecture.' }], image_source: 'images/f2b.jpg' },
          {
            type: 'image',
            bbox: [0.05, 0.35, 0.9, 0.7],
            captions: [{ content: '(c) Adaptive Target Error Rate $( \\alpha _ { t } )$ Figure 2: 总体架构与结果。' }],
            image_source: 'images/f2c.jpg'
          }
        ] }
      ]
    })
    expect(figs).toHaveLength(1) // (a)/(b) 子图注块与 (c) 编号块并组
    expect(figs[0].figureNo).toBe(2)
    expect(figs[0].caption).toBe('Figure 2: 总体架构与结果。') // 子图注不前置（uat6c S5）
    expect(figs[0].subBboxes).toEqual([
      [0.05, 0.1, 0.45, 0.3],
      [0.5, 0.1, 0.9, 0.3]
    ])
    expect(resolveFigureByNo(figs, 2)).toBe(figs[0])
    // 阅读器「跳到图」并集口径不变
    expect(figureNormUnion(figs[0])).toEqual([0.05, 0.1, 0.9, 0.7])
  })

  it('(c) 块被 text 隔断单独成项时：caption 同样截到主图注起头，figureNo 仍可寻址', () => {
    const figs = parseFigureBlocks({
      pages: [
        { page_idx: 0, blocks: [
          { type: 'image', bbox: [0.05, 0.1, 0.45, 0.3], captions: [{ content: '(c) 细节' }], image_source: 'images/f2a.jpg' },
          { type: 'text', content: '隔断' },
          {
            type: 'image',
            bbox: [0.5, 0.1, 0.9, 0.3],
            captions: [{ content: '(c) Adaptive Target Error Rate Figure 2: 说明。' }],
            image_source: 'images/f2b.jpg'
          }
        ] }
      ]
    })
    expect(figs).toHaveLength(2)
    expect(figs[1].figureNo).toBe(2)
    expect(figs[1].caption).toBe('Figure 2: 说明。')
    expect(resolveFigureByNo(figs, 2)).toBe(figs[1])
  })
})
