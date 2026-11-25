import { createHash } from 'node:crypto'
import { isLocalNetworkHref } from './localNetwork.ts'
import { normalizeAddress } from './addressIdentity.ts'

// The forum's text rules, shared by the write path (forumWrite.ts) and the forum
// notification lane: what a title or body may hold, how mentions and links are
// counted, and the content hash duplicate detection compares. Nothing here makes
// text SAFE — every stored byte stays hostile and is made safe only by the
// explorer's one renderer (explorer-ui/src/markdown/render.ts); these are limits and
// normalizations, never sanitization.

export const LIMITS = {
  titleChars: 160,
  postBodyChars: 50_000,
  commentBodyChars: 10_000,
  updateBodyChars: 10_000,
  tldrChars: 300,
  labelsPerPost: 3,
  labelChars: 32,
  mentionsPerItem: 10,
  /** Links per body for an account under LINK_FREE_HDX; above it, unlimited. */
  linksPerBodyLowBalance: 20,
  reportNoteChars: 500,
  linkedPerPost: 5,
} as const

// Bidi controls (LRE/RLE/PDF/LRO/RLO, LRI/RLI/FSI/PDI, LRM/RLM/ALM) and zero-width
// characters (ZWSP, ZWNJ, ZWJ, word joiner, BOM): stripped from titles, where they
// would let a title render as something other than what it says. Bodies keep them
// (scripts that need ZWJ/ZWNJ), but a body may not be ONLY invisible characters.
const BIDI_ZW_RE = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g
// C0/C1 control characters other than tab, newline and carriage return.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g

/** A title as stored: invisible and control characters removed, whitespace collapsed, trimmed. */
export function cleanTitle(raw: string): string {
  return raw.replace(BIDI_ZW_RE, '').replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim()
}

/** A body as stored: control characters (not tab/newline) removed, CRLF normalized, trailing whitespace trimmed. */
export function cleanBody(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').replace(CONTROL_RE, '').trimEnd()
}

/**
 * Whether raw text is too long to be worth cleaning, refused as 'too-long' before any
 * other work: cleaning only shortens it by carriage returns, control characters and
 * trailing whitespace, so honest text stays well inside `max` plus this slack.
 */
export function rawTooLong(raw: string, max: number): boolean {
  return raw.length > max + Math.max(1024, max >> 2)
}

/** True when a body has something visible in it. */
export function hasVisibleText(body: string): boolean {
  return body.replace(BIDI_ZW_RE, '').trim().length > 0
}

/** Topic labels the forum offers for new discussions (imported ones keep whatever Subsquare had). */
export const FORUM_TOPICS = ['Treasury', 'Protocol', 'Omnipool', 'Money market', 'HOLLAR', 'Community', 'Meta'] as const

/** Labels as stored: cleaned like titles, de-duplicated case-insensitively, empty ones dropped. */
export function cleanLabels(raw: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const l of raw) {
    const c = cleanTitle(l)
    if (!c || seen.has(c.toLowerCase())) continue
    seen.add(c.toLowerCase())
    out.push(c)
  }
  return out
}

// The renderer's mention and link grammar (render.ts MENTION_RE), restated so the
// server counts exactly what a reader will see as a mention.
const MENTION_RE = /(^|[\s(])@([1-9A-HJ-NP-Za-km-z]{46,48}|0x[0-9a-fA-F]{40})(?![0-9A-Za-z])/g

/** Account ids (canonical 0x + 64 hex) mentioned in a markdown body, de-duplicated, in order of first mention. */
export function mentionsIn(body: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of body.matchAll(MENTION_RE)) {
    const n = normalizeAddress(m[2])
    if (!n || seen.has(n.accountId)) continue
    seen.add(n.accountId)
    out.push(n.accountId)
  }
  return out
}

/** How many links a markdown body carries: inline/reference links, autolinks and bare URLs (images not counted). */
export function linkCount(body: string): number {
  // Inline links, as /(?<!!)\[[^\]]*\]\([^)]*\)/g counts them.
  let inline = 0
  {
    const close = forwardFinder(body, i => body.charCodeAt(i) === 0x5d)
    const paren = forwardFinder(body, i => body.charCodeAt(i) === 0x29)
    for (let p = body.indexOf('['); p >= 0;) {
      const end = body.charCodeAt(p - 1) === 0x21 ? -1 : bracketLinkEnd(body, p, close, paren)
      if (end > 0) { inline++; p = body.indexOf('[', end) } else p = body.indexOf('[', p + 1)
    }
  }
  // Bare URLs once every link and image is blanked, as
  // body.replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ') leaves them.
  const rest: string[] = []
  {
    const close = forwardFinder(body, i => body.charCodeAt(i) === 0x5d)
    const paren = forwardFinder(body, i => body.charCodeAt(i) === 0x29)
    let last = 0
    for (let p = body.indexOf('['); p >= 0;) {
      const end = bracketLinkEnd(body, p, close, paren)
      if (end > 0) {
        const start = p > last && body.charCodeAt(p - 1) === 0x21 ? p - 1 : p
        rest.push(body.slice(last, start), ' ')
        last = end
        p = body.indexOf('[', end)
      } else p = body.indexOf('[', p + 1)
    }
    rest.push(body.slice(last))
  }
  const bare = rest.join('').match(/\bhttps?:\/\/[^\s<>()]+/gi)?.length ?? 0
  return inline + bare
}

/** Longer than a DNS name (253) with userinfo and a port around it. */
const MAX_AUTHORITY_CHARS = 320

/**
 * Every http(s) URL in a text — markdown links and images, autolinks, bare URLs, HTML
 * attributes — that points into the reader's own network or machine (isLocalNetworkHref),
 * or whose authority is longer than any public name: a native write carrying one is
 * refused, since such a link can only probe whoever opens it.
 */
export function localNetworkUrls(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/https?:\/\/[^\s<>()"'`\[\]{}|\\^]+/gi)) {
    // Trailing sentence punctuation is not part of the URL (a loop, not /[.,;:!?]+$/,
    // which backtracks quadratically on a long run of it).
    let end = m[0].length
    while (end > 0 && '.,;:!?'.includes(m[0][end - 1])) end--
    const url = m[0].slice(0, end)
    // A longer authority is refused unparsed: no public host has one, and reading the
    // host of a long one costs time quadratic in its length.
    const authority = url.slice(url.indexOf('//') + 2).split(/[/?#]/, 1)[0]
    if (authority.length > MAX_AUTHORITY_CHARS || isLocalNetworkHref(url)) out.add(url)
  }
  return [...out]
}

/** The content hash duplicate detection compares: case- and whitespace-insensitive. */
export function contentHash(text: string): string {
  return createHash('sha256').update(text.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex')
}

/** Our own uploaded-image URLs in a body (`/ipfs/<cid>`, absolute or relative), as written. */
export function ownImageUrls(body: string, publicUrl: string): Array<{ url: string; cid: string }> {
  const out: Array<{ url: string; cid: string }> = []
  const seen = new Set<string>()
  const origin = publicUrl.replace(/\/+$/, '')
  for (const url of markdownImageTargets(body)) {
    const path = url.startsWith(origin + '/') ? url.slice(origin.length) : url
    const hit = /^\/ipfs\/([A-Za-z0-9]{46,121})$/.exec(path)
    if (hit && !seen.has(url)) { seen.add(url); out.push({ url, cid: hit[1] }) }
  }
  return out
}

// ---- linear scanners ----
//
// Every body is hostile and reaches these on each write and read, so each runs in time
// linear in its length. Each reproduces exactly the matches of the regular expression
// named in its comment; run as a regex, those backtrack quadratically on repetitions
// such as `[[[[`, `![](![](` or `<img<img`.

/** The code units JavaScript's `\s` matches. */
export function isSpaceCode(c: number): boolean {
  return c === 0x20 || (c >= 0x09 && c <= 0x0d) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a)
    || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
}

/**
 * The first index at or after `from` where `hit` holds, or -1. It remembers its last
 * answer, so a caller whose queries never move backwards looks at each index once.
 */
function forwardFinder(s: string, hit: (i: number) => boolean): (from: number) => number {
  let lo = Infinity, found = -1
  return from => {
    if (from >= lo && (found < 0 || from <= found)) return found
    let i = from
    while (i < s.length && !hit(i)) i++
    lo = from
    found = i < s.length ? i : -1
    return found
  }
}

/** Where `[…](…)` (/\[[^\]]*\]\([^)]*\)/) opening at `p` ends, or -1. */
function bracketLinkEnd(s: string, p: number, close: (from: number) => number, paren: (from: number) => number): number {
  const q = close(p + 1)
  if (q < 0 || s.charCodeAt(q + 1) !== 0x28) return -1
  const r = paren(q + 2)
  return r < 0 ? -1 : r + 1
}

/**
 * The targets of a body's markdown images, in order and with repeats, exactly as
 * /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g captures them.
 */
export function markdownImageTargets(body: string): string[] {
  const out: string[] = []
  let p = body.indexOf('![')
  if (p < 0) return out
  const n = body.length
  const code = (i: number) => body.charCodeAt(i)
  const isQuote = (c: number) => c === 0x22 || c === 0x27
  // A target is a run of anything but `)`, `>` and whitespace.
  const ends = (c: number) => c === 0x29 || c === 0x3e || isSpaceCode(c)
  const close = forwardFinder(body, i => code(i) === 0x5d)
  const paren = forwardFinder(body, i => code(i) === 0x29)
  const targetStart = forwardFinder(body, i => !isSpaceCode(code(i)))
  const targetEnd = forwardFinder(body, i => ends(code(i)))
  const tailStart = forwardFinder(body, i => !isSpaceCode(code(i)))
  // What follows a target ending at e — an optional `>`, an optional title, `)` — gives
  // the image's end, or -1. It is the same for every target ending at e, so it is worked
  // out once per e (and a title's closing quote once per closing paren).
  let tailFor = -1, tailEnd = -1, quoteFor = -1, lastBeforeParen = -1
  const tail = (e: number): number => {
    if (e === tailFor) return tailEnd
    tailFor = e
    tailEnd = -1
    const t = code(e) === 0x3e ? e + 1 : e
    const w0 = tailStart(t)
    const w = w0 < 0 ? n : w0
    // A title: whitespace, a quote, then up to the first `)`, whose last non-space before it is a quote.
    if (w > t && w < n && isQuote(code(w))) {
      const end = paren(w + 1)
      if (end >= 0) {
        if (end !== quoteFor) {
          quoteFor = end
          let j = end - 1
          while (j > w && isSpaceCode(code(j))) j--
          lastBeforeParen = j
        }
        if (lastBeforeParen > w && isQuote(code(lastBeforeParen))) tailEnd = end + 1
      }
    }
    if (tailEnd < 0 && w < n && code(w) === 0x29) tailEnd = w + 1
    return tailEnd
  }
  // The image the `](` at q opens — its target and end — the same for every `![` reaching q.
  let imageFor = -1
  let image: { url: string; end: number } | null = null
  const imageAt = (q: number) => {
    if (q === imageFor) return image
    imageFor = q
    image = null
    const r = targetStart(q + 2)
    if (r < 0) return image
    // `<?` takes a `<` only when a target follows it; otherwise the `<` starts the target.
    const s = code(r) === 0x3c && r + 1 < n && !ends(code(r + 1)) ? r + 1 : r
    if (ends(code(s))) return image
    const e0 = targetEnd(s)
    const e = e0 < 0 ? n : e0
    if (e >= n) return image
    const end = tail(e)
    if (end > 0) image = { url: body.slice(s, e), end }
    return image
  }
  while (p >= 0) {
    const q = close(p + 2)
    if (q < 0) break
    const img = code(q + 1) === 0x28 ? imageAt(q) : null
    if (img) { out.push(img.url); p = body.indexOf('![', img.end) } else p = body.indexOf('![', p + 1)
  }
  return out
}

/**
 * The `src` values of a body's HTML images, in order and with repeats, exactly as
 * /<img\b[^>]*?\bsrc\s*=\s*["']?([^"'\s>]+)/gi captures them.
 */
export function htmlImageSources(body: string): string[] {
  const out: string[] = []
  const n = body.length
  if (!/<img/i.test(body)) return out
  const code = (i: number) => body.charCodeAt(i)
  // ASCII letters only: a non-unicode case-insensitive regex folds nothing else onto them.
  const is = (i: number, lower: number) => (code(i) | 0x20) === lower
  const isWord = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f
  const valueEnds = (c: number) => c === 0x22 || c === 0x27 || c === 0x3e || isSpaceCode(c)
  // Where the value starts when a `src=` attribute opens at k (a word boundary, `src`,
  // `=` between optional spaces, an optional quote, then the value), else -1.
  const valueAt = (k: number): number => {
    if (!is(k, 0x73) || !is(k + 1, 0x72) || !is(k + 2, 0x63) || isWord(code(k - 1))) return -1
    let i = k + 3
    while (i < n && isSpaceCode(code(i))) i++
    if (code(i) !== 0x3d) return -1
    i++
    while (i < n && isSpaceCode(code(i))) i++
    if (code(i) === 0x22 || code(i) === 0x27) i++
    return i < n && !valueEnds(code(i)) ? i : -1
  }
  const src = forwardFinder(body, i => valueAt(i) >= 0)
  const gt = forwardFinder(body, i => code(i) === 0x3e)
  for (let p = body.indexOf('<'); p >= 0;) {
    if (is(p + 1, 0x69) && is(p + 2, 0x6d) && is(p + 3, 0x67) && !isWord(code(p + 4))) {
      // The tag's first `src=` before a `>`; with none left anywhere, nothing later matches either.
      const k = src(p + 4)
      if (k < 0) break
      const g = gt(p + 4)
      if (g < 0 || k < g) {
        const v = valueAt(k)
        let e = v
        while (e < n && !valueEnds(code(e))) e++
        out.push(body.slice(v, e))
        p = body.indexOf('<', e)
        continue
      }
    }
    p = body.indexOf('<', p + 1)
  }
  return out
}
