import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inflateSync } from 'node:zlib'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { figureCropCachePayload } from '../../shared/figureCrop'
import { encodeRgbaPng } from './pngEncode'
import { figureCropHash, removeFigureCropCache, resolveFigureCardImage, type PdfRectRenderer } from './figureCrop'
import { pdfiumRenderCrop } from './pdfiumCrop'

/**
 * uat8a D189：裁图缓存、失败回退、pdfium 方向。临时目录，不提交 PDF / PNG。
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-figcrop-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const multi = {
  page: 0,
  bbox: [0.2, 0.3, 0.8, 0.9] as [number, number, number, number],
  subBboxes: [[0.05, 0.3, 0.25, 0.6] as [number, number, number, number]]
}

const single = {
  page: 0,
  bbox: [0.2, 0.3, 0.8, 0.9] as [number, number, number, number]
}

function writePdf(paperId: number, bytes: Buffer = Buffer.from('%PDF-1.4 fake')): void {
  const folder = join(dir, 'papers', String(paperId))
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'paper.pdf'), bytes)
}

function tinyPng(): Uint8Array {
  return encodeRgbaPng(1, 1, new Uint8ClampedArray([10, 20, 30, 255]))
}

function pngPixel(png: Uint8Array, x: number, y: number): [number, number, number, number] {
  const buf = Buffer.from(png)
  let off = 8
  let width = 0
  const idats: Buffer[] = []
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') width = data.readUInt32BE(0)
    else if (type === 'IDAT') idats.push(Buffer.from(data))
    else if (type === 'IEND') break
    off += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idats))
  const i = y * (width * 4 + 1) + 1 + x * 4
  return [raw[i]!, raw[i + 1]!, raw[i + 2]!, raw[i + 3]!]
}

/** 上沿一条红、下沿一条蓝。PDF 用户坐标 y 向上，红在 y=692（页面顶部）。 */
function coloredPdf(): Buffer {
  const stream = '1 0 0 rg\n0 692 612 100 re f\n0 0 1 rg\n0 0 612 100 re f\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefPos = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`
  return Buffer.from(out, 'latin1')
}

describe('resolveFigureCardImage（D189）', () => {
  it('缓存键含论文、图号、页、量化区域与 PDF 戳；第二次命中不再调渲染器', async () => {
    writePdf(5)
    let calls = 0
    const renderer: PdfRectRenderer = {
      renderCrop: async () => {
        calls += 1
        return tinyPng()
      }
    }
    const first = await resolveFigureCardImage({ dataDir: dir, paperId: 5, figureNo: 2, figure: multi, renderer })
    expect(first.mode).toBe('crop')
    expect(calls).toBe(1)
    if (first.mode !== 'crop') return
    expect(first.relPath.startsWith('cache/figure-crops/5/2-')).toBe(true)
    expect(existsSync(join(dir, ...first.relPath.split('/')))).toBe(true)

    const second = await resolveFigureCardImage({ dataDir: dir, paperId: 5, figureNo: 2, figure: multi, renderer })
    expect(second).toEqual(first)
    expect(calls).toBe(1)

    const stamp = '9:1'
    const payload = figureCropCachePayload({
      paperId: 5,
      figureNo: 2,
      page: 0,
      bbox: [0.05, 0.3, 0.8, 0.9],
      pdfStamp: stamp
    })
    expect(figureCropHash(payload)).toHaveLength(20)
    expect(figureCropHash(payload)).toBe(figureCropHash(payload))
    expect(figureCropHash(payload + 'x')).not.toBe(figureCropHash(payload))
  })

  it('渲染失败或 PNG 非法时回退 mineru，不留半截文件', async () => {
    writePdf(5)
    let calls = 0
    const renderer: PdfRectRenderer = {
      renderCrop: async () => {
        calls += 1
        throw new Error('pdfium down')
      }
    }
    const failed = await resolveFigureCardImage({ dataDir: dir, paperId: 5, figureNo: 2, figure: multi, renderer })
    expect(failed).toEqual({ mode: 'mineru' })
    expect(calls).toBe(1)
    expect(existsSync(join(dir, 'cache', 'figure-crops', '5'))).toBe(false)

    const bad: PdfRectRenderer = { renderCrop: async () => new Uint8Array([1, 2, 3, 4]) }
    const again = await resolveFigureCardImage({ dataDir: dir, paperId: 5, figureNo: 2, figure: multi, renderer: bad })
    expect(again).toEqual({ mode: 'mineru' })
  })

  it('PDF 缺失不调渲染器；单面板与子块未超出自身 bbox 也不调', async () => {
    let calls = 0
    const renderer: PdfRectRenderer = {
      renderCrop: async () => {
        calls += 1
        return tinyPng()
      }
    }
    expect(await resolveFigureCardImage({ dataDir: dir, paperId: 5, figureNo: 2, figure: multi, renderer })).toEqual({
      mode: 'mineru'
    })
    expect(calls).toBe(0)

    writePdf(5)
    expect(await resolveFigureCardImage({ dataDir: dir, paperId: 5, figureNo: 2, figure: single, renderer })).toEqual({
      mode: 'mineru'
    })
    const inside = {
      page: 0,
      bbox: [0, 0, 1, 1] as [number, number, number, number],
      subBboxes: [[0.2, 0.2, 0.4, 0.4] as [number, number, number, number]]
    }
    expect(await resolveFigureCardImage({ dataDir: dir, paperId: 5, figureNo: 2, figure: inside, renderer })).toEqual({
      mode: 'mineru'
    })
    expect(calls).toBe(0)
  })

  it('删除论文的裁图目录；非法 id 与缺目录都不抛，别的论文缓存还在', () => {
    const keep = join(dir, 'cache', 'figure-crops', '8')
    mkdirSync(join(dir, 'cache', 'figure-crops', '5'), { recursive: true })
    mkdirSync(keep, { recursive: true })
    writeFileSync(join(dir, 'cache', 'figure-crops', '5', '2-abc.png'), tinyPng())
    writeFileSync(join(keep, '1-def.png'), tinyPng())
    removeFigureCropCache(dir, 5)
    expect(existsSync(join(dir, 'cache', 'figure-crops', '5'))).toBe(false)
    expect(existsSync(join(keep, '1-def.png'))).toBe(true)
    expect(() => removeFigureCropCache(dir, 5)).not.toThrow()
    expect(() => removeFigureCropCache(dir, -1)).not.toThrow()
    expect(() => removeFigureCropCache(dir, 1.5)).not.toThrow()
    expect(existsSync(keep)).toBe(true)
  })
})

describe('encodeRgbaPng', () => {
  it('1×1 红像素能被读回', () => {
    const png = encodeRgbaPng(1, 1, new Uint8ClampedArray([255, 0, 0, 255]))
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(pngPixel(png, 0, 0)).toEqual([255, 0, 0, 255])
  })
})

describe('pdfiumRenderCrop（D189，本地 wasm，不联网）', () => {
  it('并集矩形按左上原点裁：页顶为红、页底为蓝', async () => {
    const pdf = coloredPdf()
    const top = await pdfiumRenderCrop({
      pdf,
      pageIndex: 0,
      normBbox: [0, 0, 1, 100 / 792]
    })
    const bottom = await pdfiumRenderCrop({
      pdf,
      pageIndex: 0,
      normBbox: [0, 692 / 792, 1, 1]
    })
    const topPx = pngPixel(top, 4, 4)
    const botPx = pngPixel(bottom, 4, 4)
    expect(topPx[0]).toBeGreaterThan(200)
    expect(topPx[1]).toBeLessThan(40)
    expect(topPx[2]).toBeLessThan(40)
    expect(botPx[2]).toBeGreaterThan(200)
    expect(botPx[0]).toBeLessThan(40)
  }, 60_000)
})
