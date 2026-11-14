import { inflateRawSync } from 'node:zlib'

/**
 * 极简 zip 读取（解析器专用，对齐 src/main/db/zip.ts 的口径：store + deflated，
 * deflated 用 node:zlib；CRC-32 校验）。从 Buffer 读（MinerU zip 经 HTTP 拿到），
 * 不落临时文件。与 db/zip.ts 不共用是为了并行车道不挤核心文件（lane/pdf 只加不改）。
 */

export interface ZipEntryData {
  name: string
  data: Buffer
}

/** 解压体积上限（zip bomb 防护）：单条目未压缩大小 / 全包未压缩总量 */
export const ZIP_MAX_ENTRY_UNCOMPRESSED = 200 * 1024 * 1024
export const ZIP_MAX_TOTAL_UNCOMPRESSED = 1024 * 1024 * 1024

const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 从 Buffer 读 zip（EOCD 无注释口径，与备份 zip 一致） */
export function readZipBuffer(buf: Buffer): ZipEntryData[] {
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是合法的 zip 文件（找不到 EOCD）')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const entries: ZipEntryData[] = []
  let totalUncompressed = 0
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录损坏')
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const size = buf.readUInt32LE(p + 20) // 压缩尺寸（切片用）
    const uncompressedSize = buf.readUInt32LE(p + 24) // 未压缩尺寸（上限校验用，读数据前）
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    if (uncompressedSize > ZIP_MAX_ENTRY_UNCOMPRESSED) {
      throw new Error(`zip 条目超过解压上限（${name}：${uncompressedSize} 字节 > 单条目 ${ZIP_MAX_ENTRY_UNCOMPRESSED}）`)
    }
    totalUncompressed += uncompressedSize
    if (totalUncompressed > ZIP_MAX_TOTAL_UNCOMPRESSED) {
      throw new Error(`zip 包超过解压总量上限（${totalUncompressed} 字节 > ${ZIP_MAX_TOTAL_UNCOMPRESSED}）`)
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    const raw = buf.subarray(dataStart, dataStart + size)
    const data =
      method === 0
        ? Buffer.from(raw)
        : method === 8
          ? inflateRawSync(raw)
          : (() => {
              throw new Error(`不支持的 zip 压缩方法 ${method}`)
            })()
    if (crc32(data) !== crc) throw new Error(`zip 条目 CRC 校验失败：${name}`)
    entries.push({ name, data })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/**
 * 判断 zip 条目是否可安全解到 outDir 内（zip-slip 防护，对齐 fullBackup 的
 * safeJoin 口径）：拒绝绝对路径与 .. 分量。
 */
export function isSafeEntryName(name: string): boolean {
  if (!name || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false
  return name.split('/').every((seg) => seg !== '..' && seg !== '')
}
