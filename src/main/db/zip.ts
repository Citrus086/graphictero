import {
  appendFileSync,
  closeSync,
  createReadStream,
  createWriteStream,
  fstatSync,
  openSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type WriteStream
} from 'node:fs'
import { createDeflateRaw, createInflateRaw, deflateRawSync, inflateRawSync, type DeflateRaw, type InflateRaw } from 'node:zlib'

/**
 * 极简 ZIP 读写（不引第三方依赖）。
 *
 * 两条写入路径：
 * - `writeZip`（同步、store 不压缩、非 zip64）：旧 API 原样保留——存量测试
 *   （mineruParser.test.ts 等）与「旧格式兼容」用例继续用它构造旧格式包。
 * - `writeZipStreaming`（D162 新增，备份唯一使用）：流式写入，文件条目走
 *   createReadStream 分块（绝不 readFileSync 整块读），GPBF bit 3 + data
 *   descriptor，zip64 extra field（0x0001）+ Zip64 EOCD 支持，文本类条目用
 *   node:zlib deflateRaw 压缩，二进制 store。
 *
 * 压缩取舍（D162）：备份体积大头是 graphictero.db 与解析出的 .md（文本，可压），
 * PDF/图片已是压缩格式再压纯属浪费 CPU。.md/.json/.txt/.db/.sql/.csv/.xml/
 * .yml/.yaml/.log/.ts/.js 走 deflateRaw，其余一律 store。
 *
 * 读侧 `readZip`/`readZipEntries` 基于 fd（readSync 分块）而非整包 readFileSync，
 * 兼容：非 zip64 旧格式、zip64（Zip64 EOCD locator + Zip64 EOCD + 0x0001 extra）、
 * bit 3 data descriptor（条目数据长度以中央目录为准，天然跳过 descriptor）。
 * 文件名按 UTF-8 处理（GPBF bit 11），支持中文路径。
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/** 可增量更新的 CRC-32（流式边读边算）。 */
export class Crc32 {
  private c = 0xffffffff
  update(buf: Buffer | Uint8Array): this {
    let c = this.c
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    this.c = c >>> 0
    return this
  }
  digest(): number {
    return (this.c ^ 0xffffffff) >>> 0
  }
}

/** 一次性 CRC-32（旧导出，保持兼容）。 */
export function crc32(buf: Buffer): number {
  return new Crc32().update(buf).digest()
}

export interface ZipEntry {
  name: string
  data: Buffer
}

/** 流式写入的条目：source（文件路径）或 data（内存 Buffer）二选一。 */
export type ZipEntrySource = { name: string; source: string } | { name: string; data: Buffer }

function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  }
}

const UTF8_FLAG = 0x0800
const BIT3_DESCRIPTOR = 0x0008
const ZIP64_EXTRA_ID = 0x0001
const VERSION_ZIP64 = 45
const CHUNK = 64 * 1024

/** 文本类条目压缩；其余（.pdf/.png/.jpg/.jpeg/.gif/.webp/.zip/.sqlite 等）store（见文件头取舍说明）。 */
const COMPRESS_EXTS = new Set([
  '.md', '.json', '.txt', '.db', '.sql', '.csv', '.xml', '.yml', '.yaml', '.log', '.ts', '.js'
])

function isTextLike(name: string): boolean {
  const i = name.lastIndexOf('.')
  return i >= 0 && COMPRESS_EXTS.has(name.slice(i).toLowerCase())
}

/* ============================== 同步旧版写入（保持兼容） ============================== */

/** 写 zip（store 方法，非 zip64）。旧格式写入路径，仅供存量测试/旧包构造使用。 */
export function writeZip(entries: ZipEntry[], outPath: string, now = new Date()): void {
  // 中央目录/EOCD 的条目数是 UInt16：超限静默溢出会导致读端错位，先断言
  if (entries.length > 65535) throw new Error(`zip 条目数 ${entries.length} 超过 65535 上限`)
  const { time, date } = dosDateTime(now)
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const crc = crc32(e.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(UTF8_FLAG, 6)
    local.writeUInt16LE(0, 8) // method: store
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(e.data.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28) // extra len
    chunks.push(local, name, e.data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4) // version made by
    cd.writeUInt16LE(20, 6) // version needed
    cd.writeUInt16LE(UTF8_FLAG, 8)
    cd.writeUInt16LE(0, 10)
    cd.writeUInt16LE(time, 12)
    cd.writeUInt16LE(date, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(e.data.length, 20)
    cd.writeUInt32LE(e.data.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(0, 30) // extra + comment len
    cd.writeUInt32LE(0, 34) // disk + internal attrs
    cd.writeUInt32LE(0, 38) // external attrs
    cd.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([cd, name]))
    offset += local.length + name.length + e.data.length
  }

  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  writeFileSync(outPath, Buffer.concat([...chunks, cdBuf, eocd]))
}

/* ============================== 流式写入（D162，备份使用） ============================== */

export interface WriteZipOptions {
  now?: Date
  /** 测试缝：强制全部条目走 zip64（extra field + Zip64 EOCD），不必真造 4GB 数据。 */
  forceZip64?: boolean
}

interface WrittenEntry {
  nameBuf: Buffer
  crc: number
  method: number
  compSize: number
  uncompSize: number
  localOffset: number
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function writeOut(out: WriteStream, buf: Buffer, written: { n: number }): Promise<void> {
  written.n += buf.length
  if (!out.write(buf)) await new Promise<void>((resolve) => out.once('drain', resolve))
}

/** zlib 流泵：写入端 write() 喂数据，读取端 read() 异步迭代产出分块（背压安全）。 */
class ZlibPump {
  private chunks: Buffer[] = []
  private waiters: Array<() => void> = []
  private ended = false
  private error: Error | null = null
  constructor(private stream: DeflateRaw | InflateRaw) {
    stream.on('data', (c: Buffer) => {
      this.chunks.push(c)
      this.notify()
    })
    stream.on('end', () => {
      this.ended = true
      this.notify()
    })
    stream.on('error', (e: Error) => {
      this.error = e
      this.ended = true
      this.notify()
    })
  }
  private notify(): void {
    const w = this.waiters.splice(0)
    for (const f of w) f()
  }
  async write(buf: Buffer): Promise<void> {
    if (!this.stream.write(buf)) await new Promise<void>((r) => this.stream.once('drain', r))
  }
  end(): void {
    this.stream.end()
  }
  async *read(): AsyncGenerator<Buffer> {
    for (;;) {
      while (this.chunks.length) yield this.chunks.shift() as Buffer
      if (this.error) throw this.error
      if (this.ended) return
      await new Promise<void>((r) => this.waiters.push(r))
    }
  }
}

/**
 * 流式写 zip：逐条目 local header（size/crc 置 0 + bit 3）→ 分块写数据（边算 CRC、
 * 文本类 deflateRaw 压缩）→ data descriptor。文件条目用 createReadStream 64KB 分块，
 * 绝不 readFileSync 整块读。超 32 位或 forceZip64 时写 zip64 extra + Zip64 EOCD。
 */
export async function writeZipStreaming(
  entries: ZipEntrySource[],
  outPath: string,
  opts: WriteZipOptions = {}
): Promise<void> {
  const { time, date } = dosDateTime(opts.now ?? new Date())
  const forceZip64 = opts.forceZip64 ?? false
  const out = createWriteStream(outPath, { flags: 'w' })
  const written: { n: number } = { n: 0 }
  const writtenEntries: WrittenEntry[] = []
  let failed = true
  try {
    for (const e of entries) {
      const nameBuf = Buffer.from(e.name, 'utf8')
      const compress = isTextLike(e.name)
      const crc = new Crc32()
      const localOffset = written.n

      // local header：bit 3（data descriptor 跟在数据后），size/crc 置 0，
      // 真实值在 descriptor 与中央目录里——文件大小写入前未知，这是流式的关键。
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(forceZip64 ? VERSION_ZIP64 : 20, 4)
      local.writeUInt16LE(UTF8_FLAG | BIT3_DESCRIPTOR, 6)
      local.writeUInt16LE(compress ? 8 : 0, 8) // method: deflateRaw / store
      local.writeUInt16LE(time, 10)
      local.writeUInt16LE(date, 12)
      local.writeUInt32LE(0, 14) // crc: 见 descriptor
      local.writeUInt32LE(0, 18) // comp size: 见 descriptor
      local.writeUInt32LE(0, 22) // uncomp size: 见 descriptor
      local.writeUInt16LE(nameBuf.length, 26)
      local.writeUInt16LE(0, 28) // extra len
      await writeOut(out, local, written)
      await writeOut(out, nameBuf, written)

      let uncompSize = 0
      let compSize = 0
      const feed = async (chunk: Buffer): Promise<void> => {
        crc.update(chunk)
        uncompSize += chunk.length
        await writeOut(out, chunk, written)
        compSize += chunk.length
      }
      if (compress) {
        const pump = new ZlibPump(createDeflateRaw())
        const drain = (async () => {
          for await (const c of pump.read()) {
            await writeOut(out, c, written)
            compSize += c.length
          }
        })()
        if ('source' in e) {
          for await (const chunk of createReadStream(e.source, { highWaterMark: CHUNK })) {
            crc.update(chunk)
            uncompSize += chunk.length
            await pump.write(chunk)
          }
        } else {
          crc.update(e.data)
          uncompSize += e.data.length
          await pump.write(e.data)
        }
        pump.end()
        await drain
      } else if ('source' in e) {
        for await (const chunk of createReadStream(e.source, { highWaterMark: CHUNK })) {
          await feed(chunk)
        }
      } else {
        await feed(e.data)
      }

      // data descriptor（bit 3 的约定）：尺寸超 32 位或 forceZip64 时用 8 字节 zip64 版
      const zip64Entry = forceZip64 || uncompSize > 0xffffffff || compSize > 0xffffffff
      const dd = Buffer.alloc(zip64Entry ? 24 : 16)
      dd.writeUInt32LE(0x08074b50, 0)
      dd.writeUInt32LE(crc.digest(), 4)
      if (zip64Entry) {
        dd.writeBigUInt64LE(BigInt(compSize), 8)
        dd.writeBigUInt64LE(BigInt(uncompSize), 16)
      } else {
        dd.writeUInt32LE(compSize, 8)
        dd.writeUInt32LE(uncompSize, 12)
      }
      await writeOut(out, dd, written)

      writtenEntries.push({ nameBuf, crc: crc.digest(), method: compress ? 8 : 0, compSize, uncompSize, localOffset })
      await tick() // 让出事件循环，不阻塞主进程（D162）
    }
    failed = false
  } finally {
    await new Promise<void>((resolve, reject) => {
      out.end(() => resolve())
      out.on('error', reject)
    })
    if (failed) {
      // 写失败留半成品没意义
      try {
        unlinkSync(outPath)
      } catch {
        /* 清理失败忽略 */
      }
    }
  }

  // 中央目录 + EOCD：整体尺寸已知，append 到文件尾（单独一段写，简单且低频）
  const count = writtenEntries.length
  const anyZip64 = forceZip64 || writtenEntries.some((w) => w.uncompSize > 0xffffffff || w.compSize > 0xffffffff)
  const needZip64 = anyZip64 || count > 65535
  // 先算中央目录总大小（zip64 extra 是否插入影响每条 28 字节）
  const cdSize = writtenEntries.reduce((acc, w) => {
    const entryZip64 = forceZip64 || w.uncompSize > 0xffffffff || w.compSize > 0xffffffff || w.localOffset > 0xffffffff
    return acc + 46 + w.nameBuf.length + (entryZip64 ? 28 : 0)
  }, 0)
  // 中央目录起始偏移 = 数据区大小；自身落盘也要判断 zip64
  const cdOffset = statSync(outPath).size
  const zip64 = needZip64 || cdOffset > 0xffffffff || cdSize > 0xffffffff

  const central: Buffer[] = []
  for (const w of writtenEntries) {
    const entryZip64 =
      forceZip64 || w.uncompSize > 0xffffffff || w.compSize > 0xffffffff || w.localOffset > 0xffffffff
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(entryZip64 ? VERSION_ZIP64 : 20, 4) // version made by
    cd.writeUInt16LE(entryZip64 ? VERSION_ZIP64 : 20, 6) // version needed
    cd.writeUInt16LE(UTF8_FLAG | BIT3_DESCRIPTOR, 8)
    cd.writeUInt16LE(w.method, 10)
    cd.writeUInt16LE(time, 12)
    cd.writeUInt16LE(date, 14)
    cd.writeUInt32LE(w.crc, 16)
    cd.writeUInt32LE(Math.min(w.compSize, 0xffffffff), 20)
    cd.writeUInt32LE(Math.min(w.uncompSize, 0xffffffff), 24)
    cd.writeUInt16LE(w.nameBuf.length, 28)
    cd.writeUInt16LE(entryZip64 ? 28 : 0, 30) // extra len（zip64: 2×u16 id/size + 3×u64）
    cd.writeUInt16LE(0, 32) // comment len
    cd.writeUInt16LE(0, 34) // disk
    cd.writeUInt16LE(0, 36) // internal attrs
    cd.writeUInt32LE(0, 38) // external attrs
    cd.writeUInt32LE(Math.min(w.localOffset, 0xffffffff), 42)
    central.push(cd, w.nameBuf)
    if (entryZip64) {
      const extra = Buffer.alloc(28)
      extra.writeUInt16LE(ZIP64_EXTRA_ID, 0)
      extra.writeUInt16LE(24, 2) // data size: 3 × u64
      extra.writeBigUInt64LE(BigInt(w.uncompSize), 4)
      extra.writeBigUInt64LE(BigInt(w.compSize), 12)
      extra.writeBigUInt64LE(BigInt(w.localOffset), 20)
      central.push(extra)
    }
  }
  const cdBuf = Buffer.concat(central)

  const tail: Buffer[] = []
  if (zip64) {
    // Zip64 EOCD record（76 字节，第 1 个字段后 44 字节为「record 其余部分」长度）
    const z64 = Buffer.alloc(56)
    z64.writeUInt32LE(0x06064b50, 0)
    z64.writeBigUInt64LE(44n, 4) // size of zip64 EOCD（不含前 12 字节）
    z64.writeUInt16LE(VERSION_ZIP64, 12) // version made by
    z64.writeUInt16LE(VERSION_ZIP64, 14) // version needed
    z64.writeUInt32LE(0, 16) // disk number
    z64.writeUInt32LE(0, 20) // cd start disk
    z64.writeBigUInt64LE(BigInt(count), 24)
    z64.writeBigUInt64LE(BigInt(count), 32)
    z64.writeBigUInt64LE(BigInt(cdBuf.length), 40)
    z64.writeBigUInt64LE(BigInt(cdOffset), 48)
    // Zip64 EOCD locator
    const loc = Buffer.alloc(20)
    loc.writeUInt32LE(0x07064b50, 0)
    loc.writeUInt32LE(0, 4) // zip64 EOCD 所在盘
    loc.writeBigUInt64LE(BigInt(cdOffset + cdBuf.length), 8) // zip64 EOCD 偏移
    loc.writeUInt32LE(1, 16) // 总盘数
    tail.push(z64, loc)
  }
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(zip64 && count > 65535 ? 0xffff : count, 8)
  eocd.writeUInt16LE(zip64 && count > 65535 ? 0xffff : count, 10)
  eocd.writeUInt32LE(zip64 && cdBuf.length > 0xffffffff ? 0xffffffff : cdBuf.length, 12)
  eocd.writeUInt32LE(zip64 && cdOffset > 0xffffffff ? 0xffffffff : cdOffset, 16)
  eocd.writeUInt16LE(0, 20)
  tail.push(eocd)

  appendFileSync(outPath, Buffer.concat([cdBuf, ...tail]))
}

/* ============================== fd 读侧（zip64 + 流式） ============================== */

export interface ZipEntryMeta {
  name: string
  /** 解压后大小 */
  size: number
  compressedSize: number
  /** 0 = store，8 = deflateRaw */
  method: number
}

interface ZipCdRecord extends ZipEntryMeta {
  crc: number
  dataOffset: number
}

const EOCD_SIG = 0x06054b50
const ZIP64_EOCD_SIG = 0x06064b50
const ZIP64_LOCATOR_SIG = 0x07064b50
const CD_SIG = 0x02014b50
const EOCD_LEN = 22
const MAX_COMMENT = 65535

function readAt(fd: number, pos: number, len: number): Buffer {
  const buf = Buffer.alloc(len)
  let off = 0
  while (off < len) {
    const n = readSync(fd, buf, off, len - off, pos + off)
    if (n === 0) throw new Error('zip 文件被截断')
    off += n
  }
  return buf
}

/** 打开 zip 并解析中央目录（含 zip64 EOCD/locator 与 0x0001 extra）。 */
function openZip(zipPath: string): { fd: number; records: ZipCdRecord[] } {
  const fd = openSync(zipPath, 'r')
  try {
    const { size } = fstatSync(fd)
    if (size < EOCD_LEN) throw new Error('不是合法的 zip 文件（找不到 EOCD）')
    // EOCD 在尾部 22 字节 + 最长 65535 字节注释的窗口里，从尾部向前扫签名
    const tailLen = Math.min(size, EOCD_LEN + MAX_COMMENT)
    const tail = readAt(fd, size - tailLen, tailLen)
    let eocd = -1
    for (let i = tail.length - EOCD_LEN; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = size - tailLen + i
        break
      }
    }
    if (eocd < 0) throw new Error('不是合法的 zip 文件（找不到 EOCD）')

    let count = tail.readUInt16LE(eocd - (size - tailLen) + 10)
    let cdSize = tail.readUInt32LE(eocd - (size - tailLen) + 12)
    let cdOffset = tail.readUInt32LE(eocd - (size - tailLen) + 16)
    const base = eocd - (size - tailLen)

    // zip64：EOCD 前的 locator 指向 Zip64 EOCD（本目录/尺寸 16 位置 0xffffffff 哨兵）
    const needZip64 = count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff
    if (needZip64 || eocd >= 20) {
      const loc = readAt(fd, eocd - 20, 20)
      if (loc.readUInt32LE(0) === ZIP64_LOCATOR_SIG) {
        const z64Off = Number(loc.readBigUInt64LE(8))
        const z64 = readAt(fd, z64Off, 56)
        if (z64.readUInt32LE(0) !== ZIP64_EOCD_SIG) throw new Error('zip64 EOCD 损坏')
        count = Number(z64.readBigUInt64LE(32))
        cdSize = Number(z64.readBigUInt64LE(40))
        cdOffset = Number(z64.readBigUInt64LE(48))
      } else if (needZip64) {
        throw new Error('zip64 哨兵值但找不到 Zip64 EOCD locator')
      }
    }

    if (cdOffset + cdSize > size) throw new Error('中央目录超出文件末尾（zip 被截断）')
    const cd = readAt(fd, cdOffset, cdSize) // 中央目录相对数据区很小，一次读
    const records: ZipCdRecord[] = []
    let p = 0
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CD_SIG) throw new Error('中央目录损坏')
      const method = cd.readUInt16LE(p + 10)
      const crc = cd.readUInt32LE(p + 16)
      let compSize = cd.readUInt32LE(p + 20)
      let uncompSize = cd.readUInt32LE(p + 24)
      const nameLen = cd.readUInt16LE(p + 28)
      const extraLen = cd.readUInt16LE(p + 30)
      const commentLen = cd.readUInt16LE(p + 32)
      let localOffset = cd.readUInt32LE(p + 42)
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8')
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen)
      // 0x0001 zip64 extra：仅当对应基值是 0xffffffff 哨兵时才解析，顺序固定
      let ep = 0
      while (ep + 4 <= extra.length) {
        const id = extra.readUInt16LE(ep)
        const len = extra.readUInt16LE(ep + 2)
        if (ep + 4 + len > extra.length) break
        if (id === ZIP64_EXTRA_ID) {
          let xp = ep + 4
          if (uncompSize === 0xffffffff) {
            uncompSize = Number(extra.readBigUInt64LE(xp))
            xp += 8
          }
          if (compSize === 0xffffffff) {
            compSize = Number(extra.readBigUInt64LE(xp))
            xp += 8
          }
          if (localOffset === 0xffffffff) {
            localOffset = Number(extra.readBigUInt64LE(xp))
            xp += 8
          }
        }
        ep += 4 + len
      }
      // 本地头定位数据起点；尺寸以中央目录为准，bit 3 的 data descriptor 天然被跳过
      const lh = readAt(fd, localOffset, 30)
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`条目 ${name} 的本地头损坏`)
      const lNameLen = lh.readUInt16LE(26)
      const lExtraLen = lh.readUInt16LE(28)
      const dataOffset = localOffset + 30 + lNameLen + lExtraLen
      if (method !== 0 && method !== 8) throw new Error(`不支持的 zip 压缩方法 ${method}（条目 ${name}）`)
      records.push({ name, size: uncompSize, compressedSize: compSize, method, crc, dataOffset })
      p += 46 + nameLen + extraLen + commentLen
    }
    return { fd, records }
  } catch (e) {
    closeSync(fd)
    throw e
  }
}

/** 条目数据的 fd 分块读取器（64KB），读完校验 CRC。 */
async function* entryChunks(fd: number, rec: ZipCdRecord): AsyncGenerator<Buffer> {
  const crc = new Crc32()
  let pos = rec.dataOffset
  let remaining = rec.compressedSize
  const emit = async function* (chunks: AsyncGenerator<Buffer>): AsyncGenerator<Buffer> {
    for await (const c of chunks) {
      crc.update(c)
      yield c
      await tick()
    }
  }
  const raw = (async function* (): AsyncGenerator<Buffer> {
    while (remaining > 0) {
      const n = Math.min(CHUNK, remaining)
      const buf = readAt(fd, pos, n)
      pos += n
      remaining -= n
      yield buf
    }
  })()
  if (rec.method === 0) {
    yield* emit(raw)
  } else {
    const pump = new ZlibPump(createInflateRaw())
    const feed = (async () => {
      for await (const c of raw) await pump.write(c)
      pump.end()
    })()
    yield* emit(pump.read())
    await feed
  }
  if (crc.digest() !== rec.crc) throw new Error(`zip 条目 CRC 校验失败：${rec.name}`)
}

/**
 * 流式遍历 zip 条目：onEntry 收到元信息与分块迭代器，边读边消费（恢复用），
 * 单个大文件不会整块进内存。onEntry 抛错即中止并关 fd。
 */
export async function readZipEntries(
  zipPath: string,
  onEntry: (meta: ZipEntryMeta, chunks: AsyncIterable<Buffer>) => Promise<void>
): Promise<void> {
  const { fd, records } = openZip(zipPath)
  try {
    for (const rec of records) {
      await onEntry(rec, entryChunks(fd, rec))
    }
  } finally {
    closeSync(fd)
  }
}

/** 读 zip 全部条目（兼容旧签名；内部 fd 分块读 + CRC 校验，不整包 readFileSync）。 */
export async function readZip(zipPath: string): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = []
  await readZipEntries(zipPath, async (meta, chunks) => {
    const parts: Buffer[] = []
    let size = 0
    for await (const c of chunks) {
      parts.push(c)
      size += c.length
    }
    if (size !== meta.size) throw new Error(`zip 条目 ${meta.name} 大小不符`)
    entries.push({ name: meta.name, data: Buffer.concat(parts) })
  })
  return entries
}

/* ============ 兼容辅助：一次性解压（小数据用；读侧主体已走流式） ============ */

/** 解压单个 deflated 条目（inflateRawSync 的薄封装，保持旧导出兼容）。 */
export function inflateEntry(raw: Buffer): Buffer {
  return inflateRawSync(raw)
}

/** 压缩为 deflated 分块（deflateRawSync 薄封装，保持导出兼容）。 */
export function deflateEntry(data: Buffer): Buffer {
  return deflateRawSync(data)
}
