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
  return raw.replace(/\r\n?/g, '\n').replace(CONTROL_RE, '').replace(/\s+$/, '')
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
  const inline = body.match(/(?<!!)\[[^\]]*\]\([^)]*\)/g)?.length ?? 0
  const bare = body.replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ').match(/\bhttps?:\/\/[^\s<>()]+/gi)?.length ?? 0
  return inline + bare
}

/**
 * Every http(s) URL in a text — markdown links and images, autolinks, bare URLs, HTML
 * attributes — that points into the reader's own network or machine (isLocalNetworkHref):
 * a native write carrying one is refused, since such a link can only probe whoever
 * opens it.
 */
export function localNetworkUrls(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/https?:\/\/[^\s<>()"'`\[\]{}|\\^]+/gi)) {
    const url = m[0].replace(/[.,;:!?]+$/, '')
    if (isLocalNetworkHref(url) && !out.includes(url)) out.push(url)
  }
  return out
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
  for (const m of body.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g)) {
    const url = m[1]
    const path = url.startsWith(origin + '/') ? url.slice(origin.length) : url
    const hit = /^\/ipfs\/([A-Za-z0-9]{46,121})$/.exec(path)
    if (hit && !seen.has(url)) { seen.add(url); out.push({ url, cid: hit[1] }) }
  }
  return out
}
