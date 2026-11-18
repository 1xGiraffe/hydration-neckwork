import { describe, expect, it } from 'vitest'
import {
  activeTrigger, altFromName, applyEdit, completeTrigger, continueList, indentLines, insertLink, insertPlaceholder,
  previewMedia, replacePlaceholder, selectionInList, toggleBullets, toggleCode, toggleHeading, toggleNumbered,
  toggleQuote, toggleWrap, uploadPlaceholder, type TextState,
} from '../src/markdown/editorCommands'
import { DRAFT_MAX_AGE_MS, DRAFT_PREFIX, clearDraft, loadDraft, pruneDrafts, saveDraft } from '../src/markdown/drafts'
import {
  MAX_UPLOAD_BYTES, ImagePrepError, UploadAborted, UploadError, checkImageBytes, fitSize, isAnimated, prepareImage,
  sniffImageType, uploadErrorMessage, uploadImage, type XhrLike,
} from '../src/markdown/imageUpload'

// The forum editor's rules that do not need a browser: the text transforms behind
// the toolbar and shortcuts, the local draft store, and the image checks and upload
// error wording. The component itself is exercised in the browser by e2e.

const at = (text: string, start: number, end = start): TextState => ({ text, start, end })
const sel = (text: string, part: string): TextState => { const i = text.indexOf(part); return at(text, i, i + part.length) }
const run = (s: TextState, e: ReturnType<typeof toggleWrap>) => applyEdit(s.text, e)

describe('inline formatting', () => {
  it('bolds the selection and selects the word', () => {
    const s = sel('make this loud', 'this')
    const r = run(s, toggleWrap(s, '**', 'bold text'))
    expect(r.text).toBe('make **this** loud')
    expect(r.text.slice(r.start, r.end)).toBe('this')
  })
  it('unbolds when the markers sit just outside the selection, and when selected with it', () => {
    const inner = sel('make **this** loud', 'this')
    expect(run(inner, toggleWrap(inner, '**', 'bold text')).text).toBe('make this loud')
    const whole = sel('make **this** loud', '**this**')
    expect(run(whole, toggleWrap(whole, '**', 'bold text')).text).toBe('make this loud')
  })
  it('inserts a selected placeholder with no selection', () => {
    const s = at('a  b', 2)
    const r = run(s, toggleWrap(s, '_', 'italic text'))
    expect(r.text).toBe('a _italic text_ b')
    expect(r.text.slice(r.start, r.end)).toBe('italic text')
  })
  it('keeps surrounding spaces outside the markers', () => {
    const s = at('say hi there', 3, 7)
    expect(run(s, toggleWrap(s, '**', 'x')).text).toBe('say **hi** there')
  })
  it('makes a fenced block for a multi-line code selection', () => {
    const s = at('x\nline1\nline2\ny', 2, 13)
    const r = run(s, toggleCode(s))
    expect(r.text).toBe('x\n```\nline1\nline2\n```\ny')
  })
})

describe('links', () => {
  it('wraps words and selects the URL slot', () => {
    const s = sel('see the docs now', 'the docs')
    const r = run(s, insertLink(s))
    expect(r.text).toBe('see [the docs](https://) now')
    expect(r.text.slice(r.start, r.end)).toBe('https://')
  })
  it('makes a selected URL the target and selects the link text', () => {
    const s = sel('see https://x.io/a now', 'https://x.io/a')
    const r = run(s, insertLink(s))
    expect(r.text).toBe('see [link text](https://x.io/a) now')
    expect(r.text.slice(r.start, r.end)).toBe('link text')
  })
})

describe('line formatting', () => {
  it('toggles headings and quotes on every selected line', () => {
    const s = at('one\ntwo', 0, 7)
    const q = run(s, toggleQuote(s))
    expect(q.text).toBe('> one\n> two')
    expect(run(q, toggleQuote(q)).text).toBe('one\ntwo')
    const h = run(at('# Title', 3), toggleHeading(at('# Title', 3)))
    expect(h.text).toBe('## Title')
  })
  it('numbers lines in order, turns bullets into numbers and back off', () => {
    const s = at('- a\n- b\n\nc', 0, 10)
    const n = run(s, toggleNumbered(s))
    expect(n.text).toBe('1. a\n2. b\n\n3. c')
    expect(run(n, toggleNumbered(n)).text).toBe('a\nb\n\nc')
  })
  it('bullets lines and removes bullets when all have them', () => {
    const s = at('1. a\n2. b', 0, 9)
    const b = run(s, toggleBullets(s))
    expect(b.text).toBe('- a\n- b')
    expect(run(b, toggleBullets(b)).text).toBe('a\nb')
  })
  it('keeps a caret on its line when a prefix is added', () => {
    const s = at('hello', 5)
    const r = run(s, toggleBullets(s))
    expect(r.text).toBe('- hello')
    expect(r.start).toBe(7)
  })
  it('indents and outdents list lines; Tab only claims list selections', () => {
    const s = at('- a\n- b', 0, 7)
    expect(selectionInList(s)).toBe(true)
    expect(selectionInList(at('plain', 2))).toBe(false)
    const i = run(s, indentLines(s, false))
    expect(i.text).toBe('  - a\n  - b')
    expect(run(i, indentLines(i, true)).text).toBe('- a\n- b')
  })
  it('continues a list on Enter and ends it on an empty item', () => {
    const b = at('- one', 5)
    const r = run(b, continueList(b)!)
    expect(r.text).toBe('- one\n- ')
    const n = at('9. nine', 7)
    expect(run(n, continueList(n)!).text).toBe('9. nine\n10. ')
    const empty = at('- one\n- ', 8)
    const ended = run(empty, continueList(empty)!)
    expect(ended.text).toBe('- one\n\n')
    expect(ended.start).toBe(7)
    expect(continueList(at('plain', 5))).toBeNull()
    expect(continueList(at('- mid line', 3))).toBeNull()
  })
})

describe('image placeholders', () => {
  it('cleans a file name into alt text', () => {
    expect(altFromName('Screen Shot [1](x).png')).toBe('Screen Shot 1 x')
    expect(altFromName('.png')).toBe('image')
  })
  it('inserts on its own line and replaces wherever it moved to', () => {
    const p = uploadPlaceholder('u1', 'pic.png')
    expect(p).toBe('![Uploading pic…](#upload-u1)')
    const s = at('before after', 6)
    const r = run(s, insertPlaceholder(s, p))
    expect(r.text).toBe(`before\n${p}\n after`)
    // The writer typed more in front while the upload ran; the caret is after it.
    const typed = { text: `XX${r.text}`, start: r.text.length + 2, end: r.text.length + 2 }
    const done = replacePlaceholder(typed, p, '![pic](/ipfs/bafyx)')!
    expect(done.text).toBe('XXbefore\n![pic](/ipfs/bafyx)\n after')
    expect(done.start).toBe(typed.start + ('![pic](/ipfs/bafyx)'.length - p.length))
  })
  it('removes a failed placeholder with its line and reports a deleted one', () => {
    const p = uploadPlaceholder('u2', 'x.gif')
    expect(replacePlaceholder(at(`a\n${p}\nb`, 0), p, '')!.text).toBe('a\nb')
    expect(replacePlaceholder(at('gone', 0), p, 'x')).toBeNull()
  })
  it('maps only our own /ipfs/ paths for the preview', () => {
    const cid = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy'
    expect(previewMedia(`![a](/ipfs/${cid}) ![b](https://evil.example/x.png) ![c](/ipfs/../x)`)).toEqual({ [`/ipfs/${cid}`]: `/ipfs/${cid}` })
  })
})

describe('mention and referendum triggers', () => {
  it('finds an @query or #digits right before the caret', () => {
    expect(activeTrigger('hi @ali', 7)).toEqual({ kind: '@', query: 'ali', from: 3 })
    expect(activeTrigger('see #45', 7)).toEqual({ kind: '#', query: '45', from: 4 })
    expect(activeTrigger('mail a@b.io', 11)).toBeNull()
    expect(activeTrigger('@a', 2)).toBeNull()
  })
  it('replaces the trigger with the chosen token', () => {
    const s = at('hi @ali', 7)
    expect(run(s, completeTrigger(s, 3, '@7Kx')).text).toBe('hi @7Kx ')
  })
})

// ---- drafts ----

function memoryStore() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v) },
    removeItem: (k: string) => { m.delete(k) },
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() { return m.size },
    raw: m,
  }
}

describe('drafts', () => {
  it('saves, restores and clears', () => {
    const s = memoryStore()
    saveDraft('thread:1', 'half a thought', s, 1000)
    expect(loadDraft('thread:1', s, 2000)).toEqual({ text: 'half a thought', savedAt: 1000 })
    clearDraft('thread:1', s)
    expect(loadDraft('thread:1', s, 2000)).toBeNull()
  })
  it('removes a draft saved empty', () => {
    const s = memoryStore()
    saveDraft('k', 'x', s, 1)
    saveDraft('k', '   ', s, 2)
    expect(s.raw.has(`${DRAFT_PREFIX}k`)).toBe(false)
  })
  it('discards drafts older than 30 days, and malformed ones', () => {
    const s = memoryStore()
    saveDraft('old', 'stale', s, 0)
    saveDraft('new', 'fresh', s, DRAFT_MAX_AGE_MS)
    s.setItem(`${DRAFT_PREFIX}bad`, '{nope')
    s.setItem('unrelated', 'keep')
    pruneDrafts(s, DRAFT_MAX_AGE_MS + 1)
    expect(s.raw.has(`${DRAFT_PREFIX}old`)).toBe(false)
    expect(s.raw.has(`${DRAFT_PREFIX}bad`)).toBe(false)
    expect(loadDraft('new', s, DRAFT_MAX_AGE_MS + 1)?.text).toBe('fresh')
    expect(s.raw.get('unrelated')).toBe('keep')
  })
})

// ---- images ----

const bytes = (...parts: Array<number[] | string>) => {
  const out: number[] = []
  for (const p of parts) out.push(...(typeof p === 'string' ? [...p].map(c => c.charCodeAt(0)) : p))
  return new Uint8Array(out)
}
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const chunk = (type: string, len = 0) => [0, 0, 0, len, ...[...type].map(c => c.charCodeAt(0)), ...new Array(len).fill(0), 0, 0, 0, 0]
const png = (...types: string[]) => bytes(PNG_SIG, ...types.map(t => chunk(t, t === 'IHDR' ? 13 : t === 'acTL' ? 8 : 0)))
// GIF89a 1x1, no global table, N frames.
const gif = (frames: number) => bytes('GIF89a', [1, 0, 1, 0, 0, 0, 0], ...Array.from({ length: frames }, () => [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 1, 0, 0]), [0x3b])
const webp = (vp8xFlags: number | null) => vp8xFlags == null
  ? bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8 ', [0, 0, 0, 0])
  : bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8X', [10, 0, 0, 0], [vp8xFlags, 0, 0, 0, 0, 0, 0, 0, 0, 0])

describe('image checks', () => {
  it('sniffs the type from magic bytes, not the name or declared type', () => {
    expect(sniffImageType(png('IHDR', 'IDAT', 'IEND'))).toBe('image/png')
    expect(sniffImageType(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageType(webp(null))).toBe('image/webp')
    expect(sniffImageType(gif(1))).toBe('image/gif')
    expect(sniffImageType(bytes('%PDF-1.7'))).toBeNull()
  })
  it('refuses SVG and markup, even dressed as an image', () => {
    expect(checkImageBytes(bytes('<?xml version="1.0"?><svg onload="x()"/>'))).toEqual({ ok: false, error: 'svg' })
    expect(checkImageBytes(bytes([0xef, 0xbb, 0xbf], '  <svg/>'))).toEqual({ ok: false, error: 'svg' })
    expect(checkImageBytes(bytes('MZ\x90\x00'))).toEqual({ ok: false, error: 'unsupported' })
    expect(checkImageBytes(new Uint8Array())).toEqual({ ok: false, error: 'empty' })
  })
  it('tells animations from stills', () => {
    expect(isAnimated(gif(1), 'image/gif')).toBe(false)
    expect(isAnimated(gif(3), 'image/gif')).toBe(true)
    expect(isAnimated(webp(0x02), 'image/webp')).toBe(true)
    expect(isAnimated(webp(0x10), 'image/webp')).toBe(false)
    expect(isAnimated(png('IHDR', 'acTL', 'IDAT', 'IEND'), 'image/png')).toBe(true)
    expect(isAnimated(png('IHDR', 'IDAT', 'IEND'), 'image/png')).toBe(false)
  })
  it('caps an animation at the upload limit (it is sent as-is)', () => {
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1)
    big.set(gif(2))
    expect(checkImageBytes(big)).toEqual({ ok: false, error: 'too-large-animated' })
  })
  it('fits to the long side without upscaling', () => {
    expect(fitSize(5120, 2560, 2560)).toEqual({ width: 2560, height: 1280 })
    expect(fitSize(800, 600, 2560)).toEqual({ width: 800, height: 600 })
  })
})

describe('preparing an image', () => {
  const webpOut = (size: number) => { const b = new Uint8Array(size); b.set(webp(null)); return new Blob([b], { type: 'image/webp' }) }
  it('re-encodes a still and steps down until it fits', async () => {
    const calls: Array<[number, number]> = []
    const out = await prepareImage(new Blob([png('IHDR', 'IDAT', 'IEND')]), async (_b, side, q) => {
      calls.push([side, q])
      return webpOut(calls.length < 3 ? MAX_UPLOAD_BYTES + 10 : 1000)
    })
    expect(out).toMatchObject({ type: 'image/webp', animated: false })
    expect(out.blob.size).toBe(1000)
    expect(calls.map(c => c[0])).toEqual([2560, 2560, 1920])
  })
  it('passes an animation through untouched', async () => {
    let called = false
    const out = await prepareImage(new Blob([gif(2)]), async () => { called = true; return webpOut(10) })
    expect(called).toBe(false)
    expect(out).toMatchObject({ type: 'image/gif', animated: true })
  })
  it('refuses SVG and undecodable images with a plain message', async () => {
    await expect(prepareImage(new Blob(['<svg/>']))).rejects.toThrow(/SVG/)
    const err = await prepareImage(new Blob([png('IHDR', 'IDAT', 'IEND')]), async () => { throw new Error('decode') }).catch(e => e)
    expect(err).toBeInstanceOf(ImagePrepError)
    expect(err.code).toBe('unreadable')
  })
})

class FakeXhr implements XhrLike {
  status = 0; responseText = ''; headers: Record<string, string> = {}; sent: Blob | null = null; reqHeaders: Record<string, string> = {}
  upload: XhrLike['upload'] = { onprogress: null }
  onload: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null
  open() {}
  setRequestHeader(n: string, v: string) { this.reqHeaders[n] = v }
  send(b: Blob) { this.sent = b }
  abort() { this.onabort?.() }
  getResponseHeader(n: string) { return this.headers[n] ?? null }
  respond(status: number, body: unknown, headers: Record<string, string> = {}) {
    this.status = status; this.responseText = JSON.stringify(body); this.headers = headers; this.onload?.()
  }
}

describe('uploading', () => {
  const cid = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy'
  it('sends octet-stream with the bearer token and reports progress', async () => {
    const x = new FakeXhr()
    const seen: number[] = []
    const p = uploadImage(new Blob(['x']), { token: 'tok', xhr: () => x, onProgress: f => seen.push(f) })
    expect(x.reqHeaders).toEqual({ 'content-type': 'application/octet-stream', authorization: 'Bearer tok' })
    x.upload.onprogress!({ lengthComputable: true, loaded: 1, total: 2 })
    x.respond(200, { cid, url: `/ipfs/${cid}`, mime: 'image/webp', bytes: 1, width: 1, height: 1 })
    await expect(p).resolves.toMatchObject({ url: `/ipfs/${cid}` })
    expect(seen).toEqual([0.5])
  })
  it('refuses an answer whose url is not our own /ipfs/ path', async () => {
    const x = new FakeXhr()
    const p = uploadImage(new Blob(['x']), { token: 't', xhr: () => x })
    x.respond(200, { cid, url: 'https://evil.example/x.png' })
    await expect(p).rejects.toBeInstanceOf(UploadError)
  })
  it('maps a rate limit to minutes and drops a dead session', async () => {
    const x = new FakeXhr()
    const p = uploadImage(new Blob(['x']), { token: 't', xhr: () => x })
    x.respond(429, { error: 'slow down' }, { 'retry-after': '125' })
    await expect(p).rejects.toThrow('Try again in 3 min')
    let dropped = false
    const y = new FakeXhr()
    const q = uploadImage(new Blob(['x']), { token: 't', xhr: () => y, onUnauthorized: () => { dropped = true } })
    y.respond(401, { error: 'Not logged in' })
    await expect(q).rejects.toThrow(/Sign in again/)
    expect(dropped).toBe(true)
  })
  it('cancels through the signal', async () => {
    const x = new FakeXhr()
    const c = new AbortController()
    const p = uploadImage(new Blob(['x']), { token: 't', xhr: () => x, signal: c.signal })
    c.abort()
    await expect(p).rejects.toBeInstanceOf(UploadAborted)
  })
  it('words every api refusal plainly', () => {
    expect(uploadErrorMessage(413, null, null)).toMatch(/under 5 MB/)
    expect(uploadErrorMessage(415, { reason: 'svg-or-markup' }, null)).toMatch(/SVG/)
    expect(uploadErrorMessage(415, { reason: 'not-an-image' }, null)).toMatch(/PNG, JPEG, WebP or GIF/)
    expect(uploadErrorMessage(422, null, null)).toMatch(/8192 px/)
    expect(uploadErrorMessage(429, { reason: 'quota' }, null)).toMatch(/allowance/)
    expect(uploadErrorMessage(503, { reason: 'storage-full' }, null)).toMatch(/full.*text is kept/)
    expect(uploadErrorMessage(503, { reason: 'ipfs-unavailable' }, null)).toMatch(/unavailable.*text is kept/)
    expect(uploadErrorMessage(0, null, null)).toMatch(/connection/)
  })
})

describe('the editor shell', () => {
  it('renders labelled tabs, a formatting toolbar and the character count', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { createElement } = await import('react')
    const { MarkdownEditor } = await import('../src/markdown/MarkdownEditor')
    const html = renderToStaticMarkup(createElement(MarkdownEditor, { value: 'hello', onChange: () => {}, maxChars: 10, label: 'Your comment', canUpload: false }))
    expect(html).toContain('role="toolbar"')
    expect(html).toContain('aria-label="Bold (')
    expect(html).toContain('>Write<')
    expect(html).toContain('>Preview<')
    expect(html).toContain('aria-label="Your comment"')
    expect(html).toContain('5 / 10')
    expect(html).toContain('Add an image — Sign in to add images.')
    expect(html).toContain('aria-label="More formatting"')
  })
})
