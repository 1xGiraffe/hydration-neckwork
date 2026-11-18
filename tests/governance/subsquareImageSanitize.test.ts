import { describe, expect, it } from 'vitest'
import { ImageError, crc32, sanitizeImage, sniffImage } from '../../src/governance/subsquare/imageSanitize.js'

const enc = (s: string) => Uint8Array.from(Buffer.from(s, 'latin1'))
const cat = (...parts: Array<Uint8Array | number[]>) => Uint8Array.from(Buffer.concat(parts.map(p => Buffer.from(p as Uint8Array))))
const has = (hay: Uint8Array, needle: string) => Buffer.from(hay).includes(Buffer.from(needle, 'latin1'))
const u32be = (n: number) => [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
const u32le = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24]

function pngChunk(type: string, data: Uint8Array | number[]): Uint8Array {
  const body = cat(enc(type), data)
  return cat(u32be(data.length), body, u32be(crc32(body)))
}
function png(width: number, height: number, extra: Uint8Array[] = []): Uint8Array {
  const ihdr = [...u32be(width), ...u32be(height), 8, 6, 0, 0, 0]
  return cat([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], pngChunk('IHDR', ihdr), ...extra, pngChunk('IDAT', [1, 2, 3]), pngChunk('IEND', []))
}

function seg(marker: number, payload: Uint8Array | number[]): Uint8Array {
  const len = payload.length + 2
  return cat([0xff, marker, len >> 8, len & 0xff], payload)
}
function jpeg(): Uint8Array {
  return cat(
    [0xff, 0xd8],
    seg(0xe0, cat(enc('JFIF\0'), [1, 1, 0, 0, 1, 0, 1, 0, 0])),
    seg(0xe1, cat(enc('Exif\0\0'), enc('GPSLatitude=52.1'))),
    seg(0xfe, enc('secret comment')),
    seg(0xdb, new Array(65).fill(1)),
    seg(0xc0, [8, 0, 2, 0, 3, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]),
    seg(0xc4, [0, ...new Array(16).fill(0)]),
    seg(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]),
    [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56], // entropy data with a stuffed byte and a restart
    [0xff, 0xd9],
    enc('trailing junk after EOI'),
  )
}

function webpChunk(fourcc: string, data: number[] | Uint8Array): Uint8Array {
  const pad = data.length & 1 ? [0] : []
  return cat(enc(fourcc), u32le(data.length), data, pad)
}
function webp(): Uint8Array {
  const vp8x = webpChunk('VP8X', [0x08 | 0x04 | 0x10, 0, 0, 0, 99, 0, 0, 49, 0, 0]) // EXIF+XMP+alpha, canvas 100x50
  const bits = (100 - 1) | ((50 - 1) << 14)
  const vp8l = webpChunk('VP8L', [0x2f, ...u32le(bits), 0, 0])
  const exif = webpChunk('EXIF', enc('Exif GPS here'))
  const xmp = webpChunk('XMP ', enc('<x:xmpmeta/>'))
  const body = cat(enc('WEBP'), vp8x, vp8l, exif, xmp)
  return cat(enc('RIFF'), u32le(body.length), body)
}

function gif(): Uint8Array {
  return cat(
    enc('GIF89a'), [2, 0, 2, 0, 0, 0, 0], // 2x2, no global colour table
    [0x21, 0xfe, 6], enc('secret'), [0], // comment extension
    [0x21, 0xff, 11], enc('XMP DataXMP'), [3, 1, 2, 3, 0], // an application extension that is not NETSCAPE2.0
    [0x21, 0xff, 11], enc('NETSCAPE2.0'), [3, 1, 0, 0, 0], // loop count
    [0x21, 0xf9, 4, 0, 0, 0, 0, 0], // graphic control
    [0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0, 2, 2, 0x44, 0x01, 0], // image
    [0x3b],
  )
}

describe('image container walk', () => {
  it('JPEG: keeps the image segments, drops EXIF (APP1), COM and trailing bytes', () => {
    const out = sanitizeImage(jpeg())
    expect(out).toMatchObject({ mime: 'image/jpeg', width: 3, height: 2 })
    expect(has(out.bytes, 'Exif')).toBe(false)
    expect(has(out.bytes, 'GPSLatitude')).toBe(false)
    expect(has(out.bytes, 'secret comment')).toBe(false)
    expect(has(out.bytes, 'trailing junk')).toBe(false)
    expect(has(out.bytes, 'JFIF')).toBe(true)
    expect(Buffer.from(out.bytes).subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]))
    expect(Buffer.from(out.bytes).includes(Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]))).toBe(true)
  })

  it('PNG: drops tEXt, verifies every CRC', () => {
    const src = png(4, 3, [pngChunk('tEXt', enc('Comment\0hello')), pngChunk('eXIf', enc('gps'))])
    const out = sanitizeImage(src)
    expect(out).toMatchObject({ mime: 'image/png', width: 4, height: 3 })
    expect(has(out.bytes, 'tEXt')).toBe(false)
    expect(has(out.bytes, 'eXIf')).toBe(false)
    expect(has(out.bytes, 'IDAT')).toBe(true)
    const bad = Uint8Array.from(src)
    bad[bad.length - 18] ^= 0xff // an IDAT data byte
    expect(() => sanitizeImage(bad)).toThrow(/png-crc/)
  })

  it('WebP: drops EXIF and XMP, clears their VP8X flags, fixes the RIFF size', () => {
    const out = sanitizeImage(webp())
    expect(out).toMatchObject({ mime: 'image/webp', width: 100, height: 50 })
    expect(has(out.bytes, 'EXIF')).toBe(false)
    expect(has(out.bytes, 'XMP ')).toBe(false)
    expect(out.bytes[20] & 0x0c).toBe(0) // VP8X flags byte
    expect(out.bytes[20] & 0x10).toBe(0x10) // alpha stays
    expect(Buffer.from(out.bytes).readUInt32LE(4)).toBe(out.bytes.length - 8)
  })

  it('GIF: drops comments and unknown application extensions, keeps the loop and timing', () => {
    const out = sanitizeImage(gif())
    expect(out).toMatchObject({ mime: 'image/gif', width: 2, height: 2, animated: false })
    expect(has(out.bytes, 'secret')).toBe(false)
    expect(has(out.bytes, 'XMP Data')).toBe(false)
    expect(has(out.bytes, 'NETSCAPE2.0')).toBe(true)
    expect(out.bytes[out.bytes.length - 1]).toBe(0x3b)
  })

  it('refuses SVG and anything that is not one of the four formats', () => {
    expect(() => sanitizeImage(enc('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'))).toThrow(/svg-or-markup/)
    expect(() => sanitizeImage(enc('<?xml version="1.0"?><svg/>'))).toThrow(/svg-or-markup/)
    expect(() => sanitizeImage(enc('%PDF-1.7'))).toThrow(/not-an-image/)
    expect(sniffImage(enc('GIF87a'))).toBe('image/gif')
  })

  it('refuses a decompression bomb: a side over 8192 or more than 40 MP', () => {
    expect(() => sanitizeImage(png(8193, 10))).toThrow(/too-wide/)
    expect(() => sanitizeImage(png(8000, 8000))).toThrow(/too-many-pixels/)
    expect(sanitizeImage(png(8192, 4000))).toMatchObject({ width: 8192 })
  })

  it('refuses an animation frame the canvas does not hold, too many frames, or too much animation', () => {
    const u16 = (n: number) => [n & 0xff, n >> 8]
    const gifFrames = (screenW: number, screenH: number, frames: Array<[number, number, number, number]>) => cat(
      enc('GIF89a'), [...u16(screenW), ...u16(screenH), 0, 0, 0],
      ...frames.map(([l, t, w, h]) => cat([0x2c, ...u16(l), ...u16(t), ...u16(w), ...u16(h), 0, 2, 2, 0x44, 0x01, 0])),
      [0x3b],
    )
    // The reviewer's probe: a 1×1 logical screen carrying a 9000×9000 frame.
    expect(() => sanitizeImage(gifFrames(1, 1, [[0, 0, 9000, 9000]]))).toThrow(ImageError)
    // A frame within the caps but outside the screen (offset overflow).
    expect(() => sanitizeImage(gifFrames(2, 2, [[1, 1, 2, 2]]))).toThrow(/gif-frame-outside/)
    expect(() => sanitizeImage(gifFrames(4, 4, [[0, 0, 4, 4], [3, 0, 2, 1]]))).toThrow(/gif-frame-outside/)
    expect(sanitizeImage(gifFrames(4, 4, [[0, 0, 4, 4], [2, 2, 2, 2]]))).toMatchObject({ width: 4, animated: true })
    expect(() => sanitizeImage(gifFrames(1, 1, Array.from({ length: 1001 }, () => [0, 0, 1, 1] as [number, number, number, number])))).toThrow(/too-many-frames/)
    // Frames × canvas area: 12 frames of a 6000×6000 canvas is 432 MP, over the 400 MP bound.
    expect(() => sanitizeImage(gifFrames(6000, 6000, Array.from({ length: 12 }, () => [0, 0, 1, 1] as [number, number, number, number])))).toThrow(/too-much-animation/)

    const fctl = (seq: number, w: number, h: number, x: number, y: number) => pngChunk('fcTL', [...u32be(seq), ...u32be(w), ...u32be(h), ...u32be(x), ...u32be(y), 0, 1, 0, 10, 0, 0])
    const actl = (frames: number) => pngChunk('acTL', [...u32be(frames), ...u32be(0)])
    expect(() => sanitizeImage(png(4, 4, [actl(1), fctl(0, 4, 4, 1, 0)]))).toThrow(/png-frame-outside/)
    expect(() => sanitizeImage(png(1, 1, [actl(1), fctl(0, 9000, 9000, 0, 0)]))).toThrow(ImageError)
    expect(() => sanitizeImage(png(1, 1, [actl(5000)]))).toThrow(/too-many-frames/)
    expect(() => sanitizeImage(png(6000, 6000, [actl(12)]))).toThrow(/too-much-animation/)
    expect(sanitizeImage(png(4, 4, [actl(2), fctl(0, 4, 4, 0, 0), fctl(1, 2, 2, 2, 2)]))).toMatchObject({ animated: true })
  })

  it('validates without stripping when the bytes must keep their CID', () => {
    const src = png(4, 3, [pngChunk('tEXt', enc('Comment\0hello'))])
    expect(sanitizeImage(src, { strip: false }).bytes).toBe(src)
  })
})

describe('an image kept as-is (pinned by its own CID)', () => {
  // The unstripped bytes are what /ipfs/<cid> serves, so nothing may follow the
  // container's end marker: a polyglot's payload would ride along unvalidated.
  it('refuses bytes after IEND, EOI, the RIFF size or the GIF trailer', () => {
    // The stripped forms are clean containers (the jpeg() fixture carries a tail of its own).
    for (const img of [png(4, 4), jpeg(), webp(), gif()].map(x => sanitizeImage(x).bytes)) {
      expect(sanitizeImage(img, { strip: false }).bytes).toBe(img)
      const tail = cat(img, enc('<script>alert(1)</script>'))
      expect(() => sanitizeImage(tail, { strip: false })).toThrow(/trailing-bytes/)
      // Stripping rebuilds the image from its parts, which drops the tail.
      expect(has(sanitizeImage(tail).bytes, '<script>')).toBe(false)
    }
  })
})
