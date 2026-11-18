// Images for forum posts: checked and cleaned in the browser, then uploaded to the
// api (POST /api/user/forum/media), which validates them again, pins them on the
// forum's IPFS node and answers with their `/ipfs/<cid>` path.
//
// In the browser:
//   - only PNG, JPEG, WebP and GIF, recognized by their magic bytes (a file's name and
//     declared type are not trusted); SVG is refused — it is a document that can carry
//     script;
//   - a still image is decoded and re-encoded as WebP, at most MAX_SIDE px on its long
//     side: that applies its EXIF orientation and drops EXIF, GPS and XMP metadata
//     before anything leaves the device;
//   - an animated GIF, WebP or PNG passes through unchanged (re-encoding would keep
//     only its first frame); the server strips its metadata;
//   - nothing over MAX_UPLOAD_BYTES is sent.
// No React here, and the decoder, the canvas and the XHR are injectable, so the rules
// are unit-tested.

export const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export type AcceptedType = typeof ACCEPTED_TYPES[number]
/** The `accept` attribute of the file picker. */
export const ACCEPT_ATTR = ACCEPTED_TYPES.join(',')

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024
/** A still is re-encoded smaller, so it may start larger than the upload cap — within reason. */
export const MAX_INPUT_BYTES = 40 * 1024 * 1024
export const MAX_SIDE = 2560

export type ImageCheckError = 'empty' | 'svg' | 'unsupported' | 'too-large' | 'too-large-animated' | 'unreadable'

export class ImagePrepError extends Error {
  readonly code: ImageCheckError
  constructor(code: ImageCheckError) { super(imageCheckMessage(code)); this.name = 'ImagePrepError'; this.code = code }
}

export function imageCheckMessage(code: ImageCheckError): string {
  switch (code) {
    case 'empty': return 'This file is empty.'
    case 'svg': return 'SVG images aren’t accepted. Export it as PNG or WebP and try again.'
    case 'unsupported': return 'This file isn’t a supported image. Use PNG, JPEG, WebP or GIF.'
    case 'too-large': return 'This image is too large. Images must be under 5 MB, even after shrinking.'
    case 'too-large-animated': return 'Animated images must be under 5 MB. Shorten or shrink it and try again.'
    case 'unreadable': return 'This image couldn’t be read. It may be damaged — try saving it again.'
  }
}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n))

/** The image type its first bytes declare, or null. The file's name and `File.type` are never consulted. */
export function sniffImageType(b: Uint8Array): AcceptedType | null {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp'
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return 'image/gif'
  return null
}

/** Markup rather than an image: SVG (or HTML) text, possibly after a BOM or an XML prolog. */
export function looksLikeMarkup(b: Uint8Array): boolean {
  const head = ascii(b, 0, Math.min(b.length, 512)).replace(/^(\u00EF\u00BB\u00BF|\uFEFF)/, '').trimStart().toLowerCase()
  return head.startsWith('<') || head.includes('<svg')
}

/**
 * Whether an image is animated: a GIF with more than one frame, a WebP whose VP8X
 * header sets the animation flag, a PNG carrying an acTL chunk before its data (APNG).
 */
export function isAnimated(b: Uint8Array, type: AcceptedType): boolean {
  if (type === 'image/gif') {
    // Image descriptors after the header: count frames by walking blocks.
    let at = 13
    if (b.length < 13) return false
    if (b[10] & 0x80) at += 3 * 2 ** ((b[10] & 0x07) + 1)
    let frames = 0
    const skipSubBlocks = (p: number): number => {
      while (p < b.length) { const n = b[p]; p += 1 + n; if (n === 0) return p }
      return b.length
    }
    while (at < b.length) {
      const tag = b[at]
      if (tag === 0x3b) break
      if (tag === 0x2c) {
        if (at + 10 > b.length) break
        let p = at + 10
        if (b[at + 9] & 0x80) p += 3 * 2 ** ((b[at + 9] & 0x07) + 1)
        at = skipSubBlocks(p + 1)
        if (++frames > 1) return true
        continue
      }
      if (tag === 0x21) { at = skipSubBlocks(at + 2); continue }
      break
    }
    return false
  }
  if (type === 'image/webp') {
    return b.length >= 21 && ascii(b, 12, 4) === 'VP8X' && (b[20] & 0x02) !== 0
  }
  if (type === 'image/png') {
    let at = 8
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
    while (at + 8 <= b.length) {
      const len = dv.getUint32(at)
      const t = ascii(b, at + 4, 4)
      if (t === 'acTL') return true
      if (t === 'IDAT' || t === 'IEND') return false
      at += 12 + len
    }
  }
  return false
}

export type CheckResult = { ok: true; type: AcceptedType; animated: boolean } | { ok: false; error: ImageCheckError }

/** The browser-side gate before anything is decoded or sent. */
export function checkImageBytes(b: Uint8Array): CheckResult {
  if (!b.length) return { ok: false, error: 'empty' }
  const type = sniffImageType(b)
  if (!type) return { ok: false, error: looksLikeMarkup(b) ? 'svg' : 'unsupported' }
  const animated = isAnimated(b, type)
  if (animated && b.length > MAX_UPLOAD_BYTES) return { ok: false, error: 'too-large-animated' }
  if (!animated && b.length > MAX_INPUT_BYTES) return { ok: false, error: 'too-large' }
  return { ok: true, type, animated }
}

/** Re-encodes a still image: decode (EXIF orientation applied), fit to `maxSide`, encode at `quality`. */
export type Reencode = (source: Blob, maxSide: number, quality: number) => Promise<Blob>

/** Fits (w, h) inside maxSide on the long side, never upscaling. */
export function fitSize(w: number, h: number, maxSide: number): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(w, h))
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) }
}

/** The browser's own decoder and canvas: createImageBitmap + OffscreenCanvas (or a DOM canvas), WebP out. */
export const browserReencode: Reencode = async (source, maxSide, quality) => {
  const bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' })
  try {
    const { width, height } = fitSize(bitmap.width, bitmap.height, maxSide)
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(width, height)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no 2d context')
      ctx.drawImage(bitmap, 0, 0, width, height)
      return await canvas.convertToBlob({ type: 'image/webp', quality })
    }
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.drawImage(bitmap, 0, 0, width, height)
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/webp', quality))
  } finally {
    bitmap.close()
  }
}

/** The sizes and qualities tried, in order, until one fits under the upload cap. */
export const REENCODE_STEPS: ReadonlyArray<{ side: number; quality: number }> = [
  { side: MAX_SIDE, quality: 0.9 },
  { side: MAX_SIDE, quality: 0.75 },
  { side: 1920, quality: 0.75 },
  { side: 1280, quality: 0.7 },
]

export interface PreparedImage { blob: Blob; type: string; animated: boolean }

/**
 * Checks a file and makes it ready to send: a still is re-encoded (metadata gone,
 * orientation applied, ≤ MAX_SIDE), an animation passes through. Throws ImagePrepError
 * with a reader-facing message.
 */
export async function prepareImage(file: Blob, reencode: Reencode = browserReencode): Promise<PreparedImage> {
  if (file.size > MAX_INPUT_BYTES) throw new ImagePrepError('too-large')
  let bytes: Uint8Array
  try { bytes = new Uint8Array(await file.arrayBuffer()) } catch { throw new ImagePrepError('unreadable') }
  const check = checkImageBytes(bytes)
  if (!check.ok) throw new ImagePrepError(check.error)
  if (check.animated) return { blob: new Blob([bytes as BlobPart], { type: check.type }), type: check.type, animated: true }
  const source = new Blob([bytes as BlobPart], { type: check.type })
  for (const step of REENCODE_STEPS) {
    let out: Blob
    try { out = await reencode(source, step.side, step.quality) } catch { throw new ImagePrepError('unreadable') }
    // A browser that cannot encode WebP hands back PNG; still a clean, stripped image.
    const outType = sniffImageType(new Uint8Array(await out.slice(0, 16).arrayBuffer()))
    if (!outType) throw new ImagePrepError('unreadable')
    if (out.size <= MAX_UPLOAD_BYTES) return { blob: out.type === outType ? out : new Blob([out], { type: outType }), type: outType, animated: false }
  }
  throw new ImagePrepError('too-large')
}

// ---- the upload ----

export interface UploadResult { cid: string; url: string; mime: string; bytes: number; width: number; height: number }

export class UploadError extends Error {
  readonly status: number
  readonly reason: string | null
  readonly retryAfterSec: number | null
  constructor(message: string, status: number, reason: string | null, retryAfterSec: number | null) {
    super(message)
    this.name = 'UploadError'
    this.status = status
    this.reason = reason
    this.retryAfterSec = retryAfterSec
  }
}

/** What the person is told for a failed upload, from the api's status, body and Retry-After. */
export function uploadErrorMessage(status: number, body: { error?: string; reason?: string } | null, retryAfterSec: number | null): string {
  // The api names an image refusal 'image:<why>' (its container walk's reason).
  const reason = body?.reason?.replace(/^image:/, '') ?? null
  switch (status) {
    case 0: return 'The upload didn’t reach the server. Check your connection and try again.'
    case 401: return 'Your sign-in has ended. Sign in again to add images — your text is kept.'
    case 403: return body?.error || 'Your account can’t add images right now.'
    case 413: return 'This image is too large. Images must be under 5 MB.'
    case 415: return reason === 'svg-or-markup' ? 'SVG images aren’t accepted. Export it as PNG or WebP and try again.' : 'This file isn’t a supported image. Use PNG, JPEG, WebP or GIF.'
    case 422: return 'This image has too many pixels. The limit is 8192 px per side and 40 megapixels.'
    case 429: {
      if (reason === 'quota') return body?.error || 'This account has used its image upload allowance. You can still post without images.'
      const mins = retryAfterSec != null && retryAfterSec > 0 ? Math.max(1, Math.ceil(retryAfterSec / 60)) : null
      return mins ? `You’ve reached the image upload limit. Try again in ${mins} min.` : 'You’ve reached the image upload limit. Try again later.'
    }
    case 503: return reason === 'storage-full'
      ? 'Image hosting is full right now. Your text is kept — try again later.'
      : 'Image hosting is temporarily unavailable. Your text is kept — try again in a few minutes.'
    default: return body?.error ? `The upload failed: ${body.error}` : `The upload failed (HTTP ${status}). Try again.`
  }
}

/** The XMLHttpRequest surface the upload uses (injectable for tests). */
export interface XhrLike {
  open(method: string, url: string): void
  setRequestHeader(name: string, value: string): void
  send(body: Blob): void
  abort(): void
  getResponseHeader(name: string): string | null
  status: number
  responseText: string
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null }
  onload: (() => void) | null
  onerror: (() => void) | null
  onabort: (() => void) | null
}

export interface UploadOptions {
  token: string | null
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
  /** Called on a 401 that carried a token: the session died server-side. */
  onUnauthorized?: () => void
  xhr?: () => XhrLike
  url?: string
}

export const UPLOAD_URL = '/api/user/forum/media'

export class UploadAborted extends Error {
  constructor() { super('Upload cancelled'); this.name = 'UploadAborted' }
}

/** Sends a prepared image; resolves with the pinned image's CID and path. Progress via XHR (fetch has no upload progress). */
export function uploadImage(blob: Blob, opts: UploadOptions): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) { reject(new UploadAborted()); return }
    const xhr = opts.xhr ? opts.xhr() : (new XMLHttpRequest() as unknown as XhrLike)
    const onAbort = () => xhr.abort()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const done = () => opts.signal?.removeEventListener('abort', onAbort)
    xhr.open('POST', opts.url ?? UPLOAD_URL)
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    if (opts.token) xhr.setRequestHeader('authorization', `Bearer ${opts.token}`)
    xhr.upload.onprogress = e => { if (e.lengthComputable && e.total > 0) opts.onProgress?.(Math.min(1, e.loaded / e.total)) }
    xhr.onload = () => {
      done()
      let body: unknown = null
      try { body = JSON.parse(xhr.responseText) } catch { body = null }
      if (xhr.status >= 200 && xhr.status < 300) {
        const r = body as Partial<UploadResult> | null
        if (r && typeof r.cid === 'string' && typeof r.url === 'string' && /^\/ipfs\/[A-Za-z0-9]{46,121}$/.test(r.url)) {
          resolve(r as UploadResult)
        } else {
          reject(new UploadError('The server’s answer was not understood. Try again.', xhr.status, null, null))
        }
        return
      }
      if (xhr.status === 401 && opts.token) opts.onUnauthorized?.()
      const retry = Number(xhr.getResponseHeader('retry-after'))
      const retryAfterSec = Number.isFinite(retry) && retry > 0 ? retry : null
      const b = body as { error?: string; reason?: string } | null
      reject(new UploadError(uploadErrorMessage(xhr.status, b, retryAfterSec), xhr.status, b?.reason ?? null, retryAfterSec))
    }
    xhr.onerror = () => { done(); reject(new UploadError(uploadErrorMessage(0, null, null), 0, null, null)) }
    xhr.onabort = () => { done(); reject(new UploadAborted()) }
    xhr.send(blob)
  })
}

/** The image files among a paste's or a drop's items (anything else is left to the browser). */
export function imageFilesFrom(list: FileList | File[] | null | undefined): File[] {
  if (!list) return []
  return Array.from(list).filter(f => f.size > 0 && (f.type.startsWith('image/') || f.type === '' || /\.(png|jpe?g|webp|gif|svg)$/i.test(f.name)))
}
