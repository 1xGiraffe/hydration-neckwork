// Image validation and metadata stripping WITHOUT decoding pixels: a structural walk of
// the container, keeping the chunks/segments that carry the image and dropping
// everything else (EXIF with GPS, XMP, comments, text chunks, unknown extensions). No
// image decoder is ever run on untrusted bytes — the decoder attack surface is exactly
// what this avoids (the avatar precedent). PNG, JPEG, WebP and GIF only; SVG (a
// document that can carry script) and everything else is refused. Dimensions come
// from the header and bound a decompression bomb for viewers: no side over 8192 and
// no more than 40 megapixels. An animation (GIF, APNG) is bounded frame by frame too:
// every frame's rectangle must lie inside the canvas the header declares (a 1×1
// screen carrying a 9000×9000 frame is a bomb the header alone hides), at most
// MAX_FRAMES frames, and frames × canvas area at most MAX_ANIMATION_PIXELS — the
// pixels a viewer composites to play it once. An animated WebP is held to the same
// bounds through its ANMF frames.

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

export class ImageError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'ImageError' }
}

export interface SanitizedImage { bytes: Uint8Array; mime: ImageMime; width: number; height: number; animated: boolean }

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** A walk's result plus `end`: the offset just past the container's end marker. */
type Walked = Omit<SanitizedImage, 'mime'> & { end: number }
export const MAX_SIDE = 8192
export const MAX_PIXELS = 40_000_000
/** Frames in one animation (GIF image descriptors, APNG acTL/fcTL, WebP ANMF). */
export const MAX_FRAMES = 1000
/** Frames × canvas area: 400 MP, ten full-size 40 MP canvases or 1000 frames of 400k px. */
export const MAX_ANIMATION_PIXELS = 400_000_000

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n))

export function sniffImage(b: Uint8Array): ImageMime | null {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp'
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return 'image/gif'
  return null
}

function checkDims(width: number, height: number): void {
  if (!(width > 0 && height > 0)) throw new ImageError('no-dimensions')
  if (width > MAX_SIDE || height > MAX_SIDE) throw new ImageError('too-wide')
  if (width * height > MAX_PIXELS) throw new ImageError('too-many-pixels')
}

/** One animation frame's rectangle: within the caps itself, and wholly inside the declared canvas. */
function checkFrame(x: number, y: number, w: number, h: number, canvasW: number, canvasH: number, outside: string): void {
  checkDims(w, h)
  if (x + w > canvasW || y + h > canvasH) throw new ImageError(outside)
}

/** The animation as a whole: frame count, and frames × canvas area. */
function checkAnimation(frames: number, canvasW: number, canvasH: number): void {
  if (frames > MAX_FRAMES) throw new ImageError('too-many-frames')
  if (frames * canvasW * canvasH > MAX_ANIMATION_PIXELS) throw new ImageError('too-much-animation')
}

/** Validates and (by default) strips metadata. `strip: false` validates only and returns the original bytes. */
export function sanitizeImage(input: Uint8Array, opts: { strip?: boolean } = {}): SanitizedImage {
  if (input.length > MAX_IMAGE_BYTES) throw new ImageError('too-large')
  const mime = sniffImage(input)
  if (!mime) {
    const head = ascii(input, 0, Math.min(input.length, 512)).toLowerCase()
    throw new ImageError(head.includes('<svg') || head.trimStart().startsWith('<') ? 'svg-or-markup' : 'not-an-image')
  }
  const { end, ...walked } = mime === 'image/png' ? walkPng(input) : mime === 'image/jpeg' ? walkJpeg(input) : mime === 'image/webp' ? walkWebp(input) : walkGif(input)
  checkDims(walked.width, walked.height)
  // Kept as-is (an image pinned by its existing CID), the bytes ARE what is served:
  // anything after the container's end marker (IEND, EOI, the RIFF size, the GIF
  // trailer) would ride along unvalidated — a polyglot's payload — so it is refused.
  // A stripped image is rebuilt from the walked parts and drops it anyway.
  if (opts.strip === false && end !== input.length) throw new ImageError('trailing-bytes')
  return { ...walked, mime, bytes: opts.strip === false ? input : walked.bytes }
}

// ---- PNG ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(b: Uint8Array, start = 0, end = b.length): number {
  let c = 0xffffffff
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'acTL', 'fcTL', 'fdAT'])

function walkPng(b: Uint8Array): Walked {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const parts: Uint8Array[] = [b.subarray(0, 8)]
  let at = 8, width = 0, height = 0, animated = false, sawEnd = false, first = true, declaredFrames = 0, frames = 0
  while (at + 12 <= b.length) {
    const len = dv.getUint32(at)
    const type = ascii(b, at + 4, 4)
    const end = at + 12 + len
    if (len > b.length || end > b.length) throw new ImageError('png-truncated')
    if (!/^[A-Za-z]{4}$/.test(type)) throw new ImageError('png-bad-chunk')
    if (crc32(b, at + 4, at + 8 + len) !== dv.getUint32(at + 8 + len)) throw new ImageError('png-crc')
    if (first && type !== 'IHDR') throw new ImageError('png-no-ihdr')
    first = false
    if (type === 'IHDR') { if (len !== 13) throw new ImageError('png-bad-ihdr'); width = dv.getUint32(at + 8); height = dv.getUint32(at + 12) }
    if (type === 'acTL') {
      if (len !== 8) throw new ImageError('png-bad-actl')
      animated = true
      declaredFrames = dv.getUint32(at + 8)
      checkAnimation(declaredFrames, width, height)
    }
    if (type === 'fcTL') {
      if (len !== 26) throw new ImageError('png-bad-fctl')
      checkFrame(dv.getUint32(at + 20), dv.getUint32(at + 24), dv.getUint32(at + 12), dv.getUint32(at + 16), width, height, 'png-frame-outside')
      checkAnimation(++frames, width, height)
    }
    if (PNG_KEEP.has(type)) parts.push(b.subarray(at, end))
    at = end
    if (type === 'IEND') { sawEnd = true; break }
  }
  if (!sawEnd) throw new ImageError('png-no-iend')
  checkAnimation(Math.max(declaredFrames, frames), width, height)
  return { bytes: concat(parts), width, height, animated, end: at }
}

// ---- JPEG ----

function isSof(m: number): boolean {
  return m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc
}
// Kept: APP0 (JFIF), APP14 (Adobe colour transform), DQT, SOF*, DHT, DAC, DRI, SOS.
// Dropped: APP1 (EXIF, XMP), APP2–APP13, APP15, COM and anything unknown.
function jpegKeeps(m: number): boolean {
  return m === 0xe0 || m === 0xee || m === 0xdb || isSof(m) || m === 0xc4 || m === 0xcc || m === 0xdd || m === 0xda
}

function walkJpeg(b: Uint8Array): Walked {
  const parts: Uint8Array[] = [b.subarray(0, 2)]
  let at = 2, width = 0, height = 0, sawSos = false, sawSof = false
  while (at < b.length) {
    if (b[at] !== 0xff) throw new ImageError('jpeg-bad-marker')
    while (at < b.length && b[at] === 0xff) at++ // fill bytes
    if (at >= b.length) break
    const m = b[at]
    at++
    if (m === 0xd9) { parts.push(Uint8Array.of(0xff, 0xd9)); return { ...finishJpeg(parts, width, height, sawSof, sawSos), end: at } }
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { parts.push(Uint8Array.of(0xff, m)); continue }
    if (at + 2 > b.length) throw new ImageError('jpeg-truncated')
    const len = (b[at] << 8) | b[at + 1]
    if (len < 2 || at + len > b.length) throw new ImageError('jpeg-truncated')
    const seg = b.subarray(at - 2, at + len)
    if (isSof(m)) {
      if (len < 8) throw new ImageError('jpeg-bad-sof')
      height = (b[at + 3] << 8) | b[at + 4]
      width = (b[at + 5] << 8) | b[at + 6]
      sawSof = true
    }
    if (jpegKeeps(m)) parts.push(seg)
    at += len
    if (m === 0xda) {
      sawSos = true
      // Entropy-coded data runs to the next marker that is neither a stuffed 0x00 nor a restart.
      const start = at
      while (at + 1 < b.length && !(b[at] === 0xff && b[at + 1] !== 0x00 && !(b[at + 1] >= 0xd0 && b[at + 1] <= 0xd7))) at++
      if (at + 1 >= b.length) throw new ImageError('jpeg-no-eoi')
      parts.push(b.subarray(start, at))
    }
  }
  throw new ImageError('jpeg-no-eoi')
}

function finishJpeg(parts: Uint8Array[], width: number, height: number, sof: boolean, sos: boolean): Omit<SanitizedImage, 'mime'> {
  if (!sof || !sos) throw new ImageError('jpeg-incomplete')
  return { bytes: concat(parts), width, height, animated: false }
}

// ---- WebP ----

const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ANIM', 'ANMF', 'ALPH', 'ICCP'])

function walkWebp(b: Uint8Array): Walked {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const riffSize = dv.getUint32(4, true)
  if (riffSize + 8 > b.length || riffSize < 4) throw new ImageError('webp-truncated')
  const end = 8 + riffSize
  const parts: Uint8Array[] = []
  let at = 12, width = 0, height = 0, animated = false, sawImage = false, frames = 0
  const u24 = (p: number) => b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)
  while (at + 8 <= end) {
    const fourcc = ascii(b, at, 4)
    const size = dv.getUint32(at + 4, true)
    const next = at + 8 + size + (size & 1)
    if (at + 8 + size > end) throw new ImageError('webp-truncated')
    const data = at + 8
    if (fourcc === 'VP8X') {
      if (size < 10) throw new ImageError('webp-bad-vp8x')
      const chunk = b.slice(at, Math.min(next, end))
      chunk[8] &= ~(0x08 | 0x04) // clear the EXIF and XMP flags: those chunks are dropped
      animated = (b[data] & 0x02) !== 0
      width = 1 + u24(data + 4)
      height = 1 + u24(data + 7)
      parts.push(chunk)
    } else {
      if (fourcc === 'VP8 ') {
        sawImage = true
        if (size < 10 || b[data + 3] !== 0x9d || b[data + 4] !== 0x01 || b[data + 5] !== 0x2a) throw new ImageError('webp-bad-vp8')
        if (!width) { width = dv.getUint16(data + 6, true) & 0x3fff; height = dv.getUint16(data + 8, true) & 0x3fff }
      } else if (fourcc === 'VP8L') {
        sawImage = true
        if (size < 5 || b[data] !== 0x2f) throw new ImageError('webp-bad-vp8l')
        if (!width) {
          const bits = dv.getUint32(data + 1, true)
          width = (bits & 0x3fff) + 1
          height = ((bits >>> 14) & 0x3fff) + 1
        }
      } else if (fourcc === 'ANMF') {
        sawImage = true
        // Frame header: X/2, Y/2, width-1, height-1 (24-bit little-endian each), duration, flags.
        // The frame must lie inside the VP8X canvas, so an ANMF without one is refused too.
        if (size < 16) throw new ImageError('webp-bad-anmf')
        checkFrame(2 * u24(data), 2 * u24(data + 3), 1 + u24(data + 6), 1 + u24(data + 9), width, height, 'webp-frame-outside')
        checkAnimation(++frames, width, height)
      }
      if (WEBP_KEEP.has(fourcc)) parts.push(b.subarray(at, Math.min(next, end)))
    }
    at = next
  }
  if (!sawImage) throw new ImageError('webp-no-image')
  const body = concat(parts)
  const out = new Uint8Array(12 + body.length)
  out.set(b.subarray(0, 12), 0)
  out.set(body, 12)
  new DataView(out.buffer).setUint32(4, out.length - 8, true)
  return { bytes: out, width, height, animated, end }
}

// ---- GIF ----

function walkGif(b: Uint8Array): Walked {
  if (b.length < 13) throw new ImageError('gif-truncated')
  const width = b[6] | (b[7] << 8)
  const height = b[8] | (b[9] << 8)
  let at = 13
  if (b[10] & 0x80) at += 3 * 2 ** ((b[10] & 0x07) + 1)
  if (at > b.length) throw new ImageError('gif-truncated')
  const parts: Uint8Array[] = [b.subarray(0, at)]
  let frames = 0
  const subBlocksEnd = (from: number): number => {
    let p = from
    while (true) {
      if (p >= b.length) throw new ImageError('gif-truncated')
      const n = b[p]
      p += 1 + n
      if (n === 0) return p
    }
  }
  while (at < b.length) {
    const tag = b[at]
    if (tag === 0x3b) { parts.push(Uint8Array.of(0x3b)); return { bytes: concat(parts), width, height, animated: frames > 1, end: at + 1 } }
    if (tag === 0x2c) {
      if (at + 10 > b.length) throw new ImageError('gif-truncated')
      // Image descriptor: left, top, width, height (little-endian u16 each).
      const left = b[at + 1] | (b[at + 2] << 8), top = b[at + 3] | (b[at + 4] << 8)
      const fw = b[at + 5] | (b[at + 6] << 8), fh = b[at + 7] | (b[at + 8] << 8)
      checkFrame(left, top, fw, fh, width, height, 'gif-frame-outside')
      checkAnimation(frames + 1, width, height)
      let p = at + 10
      if (b[at + 9] & 0x80) p += 3 * 2 ** ((b[at + 9] & 0x07) + 1)
      p += 1 // LZW minimum code size
      const end = subBlocksEnd(p)
      parts.push(b.subarray(at, end))
      frames++
      at = end
      continue
    }
    if (tag === 0x21) {
      if (at + 2 > b.length) throw new ImageError('gif-truncated')
      const label = b[at + 1]
      const end = subBlocksEnd(at + 2)
      // Graphic control (timing, transparency) and the NETSCAPE2.0 loop count are kept;
      // comments, plain text and every other application extension are dropped.
      const keep = label === 0xf9 || (label === 0xff && b[at + 2] === 11 && ascii(b, at + 3, 11) === 'NETSCAPE2.0')
      if (keep) parts.push(b.subarray(at, end))
      at = end
      continue
    }
    throw new ImageError('gif-bad-block')
  }
  throw new ImageError('gif-no-trailer')
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}
