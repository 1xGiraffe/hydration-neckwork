import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ImageError, MAX_IMAGE_BYTES, crc32, sanitizeImage } from '../src/services/imageSanitize.ts'

// The api's upload path and the Subsquare sync's re-hosting validate images with the
// SAME container walk. The api image builds from ./api alone, so the walk is a copy;
// this pins the two copies byte-identical — a fix made in one is a test failure until
// it is made in the other.
describe('imageSanitize copies', () => {
  it('the api copy is byte-identical to the sync copy', () => {
    const api = readFileSync(fileURLToPath(new URL('../src/services/imageSanitize.ts', import.meta.url)), 'utf8')
    const sync = readFileSync(fileURLToPath(new URL('../../src/governance/subsquare/imageSanitize.ts', import.meta.url)), 'utf8')
    expect(api).toBe(sync)
  })
})

const enc = (s: string) => Uint8Array.from(Buffer.from(s, 'latin1'))
const cat = (...parts: Array<Uint8Array | number[]>) => Uint8Array.from(Buffer.concat(parts.map(p => Buffer.from(p as Uint8Array))))
const u32be = (n: number) => [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
function pngChunk(type: string, data: Uint8Array | number[]): Uint8Array {
  const body = cat(enc(type), data)
  return cat(u32be(data.length), body, u32be(crc32(body)))
}
function png(width: number, height: number, extra: Uint8Array[] = []): Uint8Array {
  return cat([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], pngChunk('IHDR', [...u32be(width), ...u32be(height), 8, 6, 0, 0, 0]), ...extra, pngChunk('IDAT', [1, 2, 3]), pngChunk('IEND', []))
}
const reason = (f: () => unknown) => { try { f(); return null } catch (e) { return e instanceof ImageError ? e.reason : 'other' } }

describe('upload validation (what POST /user/forum/media refuses)', () => {
  it('refuses SVG and HTML', () => {
    expect(reason(() => sanitizeImage(enc('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')))).toBe('svg-or-markup')
    expect(reason(() => sanitizeImage(enc('<!doctype html><script>alert(1)</script>')))).toBe('svg-or-markup')
  })
  it('drops a polyglot payload appended after IEND and every text chunk', () => {
    const polyglot = cat(png(4, 4, [pngChunk('tEXt', enc('Comment\0<script>x</script>'))]), enc('<html><script>alert(1)</script>'))
    const out = sanitizeImage(polyglot)
    expect(Buffer.from(out.bytes).includes(Buffer.from('<script>'))).toBe(false)
    expect(out.bytes.length).toBeLessThan(polyglot.length)
  })
  it('refuses decompression-bomb dimensions from the header alone', () => {
    expect(reason(() => sanitizeImage(png(8193, 10)))).toBe('too-wide')
    expect(reason(() => sanitizeImage(png(8000, 8000)))).toBe('too-many-pixels')
  })
  it('refuses oversize input before walking it', () => {
    expect(reason(() => sanitizeImage(new Uint8Array(MAX_IMAGE_BYTES + 1)))).toBe('too-large')
  })
  it('refuses animation bombs: a frame outside its canvas, too many frames, too much animation', () => {
    const u16 = (n: number) => [n & 0xff, n >> 8]
    const gifFrames = (sw: number, sh: number, frames: Array<[number, number, number, number]>) => cat(
      enc('GIF89a'), [...u16(sw), ...u16(sh), 0, 0, 0],
      ...frames.map(([l, t, w, h]) => cat([0x2c, ...u16(l), ...u16(t), ...u16(w), ...u16(h), 0, 2, 2, 0x44, 0x01, 0])),
      [0x3b],
    )
    // The reviewer's probe: a 1×1 logical screen carrying a 9000×9000 frame.
    expect(reason(() => sanitizeImage(gifFrames(1, 1, [[0, 0, 9000, 9000]])))).toBe('too-wide')
    expect(reason(() => sanitizeImage(gifFrames(2, 2, [[1, 1, 2, 2]])))).toBe('gif-frame-outside')
    expect(reason(() => sanitizeImage(gifFrames(6000, 6000, Array.from({ length: 12 }, () => [0, 0, 1, 1] as [number, number, number, number]))))).toBe('too-much-animation')
    const fctl = (w: number, h: number, x: number, y: number) => pngChunk('fcTL', [...u32be(0), ...u32be(w), ...u32be(h), ...u32be(x), ...u32be(y), 0, 1, 0, 10, 0, 0])
    const actl = (n: number) => pngChunk('acTL', [...u32be(n), ...u32be(0)])
    expect(reason(() => sanitizeImage(png(4, 4, [actl(1), fctl(4, 4, 1, 0)])))).toBe('png-frame-outside')
    expect(reason(() => sanitizeImage(png(1, 1, [actl(5000)])))).toBe('too-many-frames')
    expect(reason(() => sanitizeImage(png(4, 4, [actl(1), fctl(4, 4, 0, 0)])))).toBeNull()
  })

  it('refuses a corrupted chunk CRC', () => {
    const p = png(2, 2)
    p[30] ^= 0xff
    expect(reason(() => sanitizeImage(p))).not.toBeNull()
  })
})
