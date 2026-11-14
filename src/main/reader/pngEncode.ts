import { crc32, deflateSync } from 'node:zlib'

/**
 * RGBA → PNG（8-bit，filter None）。不引入 sharp / canvas。
 * 给 D189 的 pdfium ImageData 落盘用。
 */

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE((crc32(Buffer.concat([typeBuf, data])) >>> 0) as number, 0)
  return Buffer.concat([len, typeBuf, data, checksum])
}

export function encodeRgbaPng(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('png 尺寸不合法')
  }
  const stride = width * 4
  if (rgba.length < stride * height) throw new Error('png 像素不足')
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const dest = y * (stride + 1)
    raw[dest] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, dest + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))])
}
