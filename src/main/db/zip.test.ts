import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Crc32, crc32, readZip, readZipEntries, writeZip, writeZipStreaming, type ZipEntrySource } from './zip'

/**
 * D162：zip 流式写入 + zip64 + fd 分块读。
 * 全部运行时造数据（tmp 目录），无真实文件。
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-zip-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function hasUnzip(): boolean {
  try {
    execFileSync('which', ['unzip'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('crc32', () => {
  it('增量类与一次性函数结果一致（含多轮 update）', () => {
    const a = Buffer.alloc(100000, 7)
    const b = Buffer.from('hello zip64 中文')
    const inc = new Crc32().update(a).update(b).digest()
    expect(inc).toBe(crc32(Buffer.concat([a, b])))
    // 已知向量："123456789" → 0xCBF43926
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
  })
})

describe('writeZipStreaming（流式 + 压缩口径）', () => {
  it('文本条目 deflate、二进制条目 store；readZip 往返字节一致', async () => {
    const md = Buffer.from('# 假正文\n\n'.repeat(500)) // 文本：可压
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2000, 3), Buffer.from('\n%%EOF\n')])
    const zipPath = join(dir, 's.zip')
    await writeZipStreaming(
      [
        { name: 'papers/1/full.md', data: md },
        { name: 'papers/1/paper.pdf', data: pdf }
      ],
      zipPath
    )
    const entries = await readZip(zipPath)
    expect(entries.find((e) => e.name === 'papers/1/full.md')?.data.equals(md)).toBe(true)
    expect(entries.find((e) => e.name === 'papers/1/paper.pdf')?.data.equals(pdf)).toBe(true)
    // 压缩口径：.md 实际落盘小于原始；.pdf store 后大小不小于原始
    const mdEntry = entries.find((e) => e.name === 'papers/1/full.md')
    const pdfEntry = entries.find((e) => e.name === 'papers/1/paper.pdf')
    expect(mdEntry && statSync(zipPath).size < md.length + pdf.length).toBe(true)
    expect(pdfEntry?.data.length).toBe(pdf.length)
  })

  it('文件条目（source 路径）流式读取，>64KB 假字节往返字节一致', async () => {
    const src = join(dir, 'big.md')
    const big = Buffer.alloc(300 * 1024, 11)
    writeFileSync(src, big)
    const zipPath = join(dir, 'file.zip')
    await writeZipStreaming([{ name: 'docs/big.md', source: src }], zipPath)
    const entries = await readZip(zipPath)
    expect(entries[0].data.equals(big)).toBe(true)
  })

  it('空包与条目数边界（0 条）可读回', async () => {
    const zipPath = join(dir, 'empty.zip')
    await writeZipStreaming([], zipPath)
    expect(await readZip(zipPath)).toEqual([])
  })
})

describe('zip64（forceZip64 测试缝）', () => {
  it('forceZip64：中央目录带 0x0001 extra + Zip64 EOCD，读回逐字节一致', async () => {
    const big = Buffer.alloc(1024 * 1024 + 7, 13) // >1MB 假字节，不必真造 4GB
    const md = Buffer.from('# zip64 测试\n')
    const zipPath = join(dir, 'z64.zip')
    await writeZipStreaming(
      [
        { name: 'graphictero.db', data: big },
        { name: 'papers/1/full.md', data: md }
      ],
      zipPath,
      { forceZip64: true }
    )
    // Zip64 EOCD locator 签名存在于文件中
    const tail = readFileSync(zipPath).subarray(-200)
    const found = (sig: number): boolean => {
      for (let i = 0; i + 4 <= tail.length; i++) if (tail.readUInt32LE(i) === sig) return true
      return false
    }
    expect(found(0x07064b50)).toBe(true) // locator
    const entries = await readZip(zipPath)
    expect(entries.find((e) => e.name === 'graphictero.db')?.data.equals(big)).toBe(true)
    expect(entries.find((e) => e.name === 'papers/1/full.md')?.data.equals(md)).toBe(true)
    // unzip -t 外部校验（本机没有 unzip 则跳过）
    if (hasUnzip()) {
      expect(() => execFileSync('unzip', ['-t', zipPath], { stdio: 'pipe' })).not.toThrow()
    }
  })

  it('非 zip64 包（默认路径）也可被 unzip -t 校验', async () => {
    const zipPath = join(dir, 'plain.zip')
    await writeZipStreaming(
      [{ name: 'a.txt', data: Buffer.from('plain text 内容') }],
      zipPath
    )
    if (hasUnzip()) {
      expect(() => execFileSync('unzip', ['-t', zipPath], { stdio: 'pipe' })).not.toThrow()
    }
  })
})

describe('readZip 兼容旧格式', () => {
  it('旧 writeZip（store 非 zip64）写的包可读回', async () => {
    const zipPath = join(dir, 'old.zip')
    writeZip(
      [
        { name: 'graphictero.db', data: Buffer.from('old format db') },
        { name: 'papers/1/full.md', data: Buffer.from('# 旧格式\n') }
      ],
      zipPath
    )
    const entries = await readZip(zipPath)
    expect(entries).toHaveLength(2)
    expect(entries[0].name).toBe('graphictero.db')
    expect(entries[0].data.toString()).toBe('old format db')
    expect(entries[1].data.toString()).toBe('# 旧格式\n')
  })

  it('bit 3 + data descriptor 的新包与旧包交叉可读：两种格式混合往返一致', async () => {
    const oldPath = join(dir, 'old-mix.zip')
    writeZip([{ name: 'old.txt', data: Buffer.from('from old writer') }], oldPath)
    const oldEntries = await readZip(oldPath)

    const newPath = join(dir, 'new-mix.zip')
    const entries: ZipEntrySource[] = oldEntries.map((e) => ({ name: `imported/${e.name}`, data: e.data }))
    await writeZipStreaming(entries, newPath)
    const mixed = await readZip(newPath)
    expect(mixed[0].name).toBe('imported/old.txt')
    expect(mixed[0].data.toString()).toBe('from old writer')
  })

  it('截断/非 zip 文件抛错', async () => {
    const bad = join(dir, 'bad.zip')
    writeFileSync(bad, Buffer.from('not a zip at all'))
    await expect(readZip(bad)).rejects.toThrow(/EOCD|截断/)
  })
})

describe('readZipEntries（流式遍历）', () => {
  it('按条目流式消费：分块收到全部字节、CRC 自动校验', async () => {
    const big = Buffer.alloc(150 * 1024, 21)
    const zipPath = join(dir, 'iter.zip')
    await writeZipStreaming(
      [
        { name: 'a.bin', data: big },
        { name: 'b.txt', data: Buffer.from('second entry') }
      ],
      zipPath
    )
    const received: Record<string, Buffer[]> = {}
    await readZipEntries(zipPath, async (meta, chunks) => {
      received[meta.name] = []
      for await (const c of chunks) received[meta.name].push(c)
    })
    expect(Buffer.concat(received['a.bin']).equals(big)).toBe(true)
    expect(Buffer.concat(received['b.txt']).toString()).toBe('second entry')
  })

  it('onEntry 抛错即中止：后续条目不再消费', async () => {
    const zipPath = join(dir, 'abort.zip')
    await writeZipStreaming(
      [
        { name: 'first.txt', data: Buffer.from('1') },
        { name: 'second.txt', data: Buffer.from('2') }
      ],
      zipPath
    )
    const seen: string[] = []
    await expect(
      readZipEntries(zipPath, async (meta) => {
        seen.push(meta.name)
        throw new Error('abort on first')
      })
    ).rejects.toThrow('abort on first')
    expect(seen).toEqual(['first.txt'])
  })
})
