import { accountIdOfAddress } from './authors.js'
import { ADDRESS_RE, subsquarePathTarget, type ExplorerTarget, type MotionResolver } from './explorerPaths.js'

// Links in imported text that point at Subsquare, rewritten so no Subsquare page is
// linked or named: Hydration's pages become the explorer page showing the same record
// (explorerPaths.ts), which the renderer treats as an internal link; other chains'
// Subsquare pages have no counterpart here and lose the link. Applied where the sync
// builds a row from the source (rows.ts) and to stored imported rows (normalise.ts);
// the result is a fixed point, so running it again changes nothing.
//
//   [text](https://hydration.subsquare.io/referenda/12)  → [text](/referendum/opengov/12)
//   https://hydradx.subsquare.io/posts/45 (bare or <…>) → [Discussion #45](/discussions/s45)
//   [@Alice](7KTF…cohVos-hydradx)  (Subsquare mention)  → [@Alice](/account/7KTF…cohVos)
//   [@bob](/user/<address>)                             → [@bob](/account/<address>)
//   [@bob](/user/bob)   (a legacy username, no account) → @bob           (unlinked)
//   <a href="https://hydradx.subsquare.io/posts/199">…  → <a href="/discussions/s199">…
//   [vote](https://polkadot.subsquare.io/referenda/854)  → vote          (unlinked)
//   https://bifrost.subsquare.io/posts/44               → Bifrost discussion #44 (text)
//
// A mention keeps the name its author saw (an account link, as the renderer draws an
// `@address` mention). Image URLs (static.subsquare.io, the IPFS gateways) are left
// byte-identical: the image map (forum_media_urls) is keyed on them. A query string is
// dropped; a fragment naming a comment by its Subsquare id becomes our `#c-s<id>`
// permalink, any other fragment (Subsquare's `#<n>` comment position) is dropped. A
// link with its own text to a Hydration page the explorer has no counterpart for keeps
// its text, unlinked; a bare URL to one becomes a link to the closest page.

export interface LinkRewriteOptions {
  /** A council/TC motion named `<block>_<hash>` → our id (from the sync's inventory). */
  resolveMotion?: MotionResolver
}

/** Any Subsquare site's page host (`<chain>.subsquare.io`); the file host `static.` is an image host and is left alone. */
const HOST = String.raw`(?:www\.)?(?!static\.)[a-z0-9-]+\.subsquare\.io`
/** A URL on a Subsquare page host: with a scheme, protocol-relative, or a bare host (which linkify would link). */
const URL_SRC = String.raw`(?:(?:https?:)?\/\/|(?<![\w@.\/:-]))${HOST}(?![\w.-])(?:[\/?#][^\s<>"'\`\[\](){}|\\^]*)?`
const URL_ALL = new RegExp(URL_SRC, 'gi')
const URL_ONE = new RegExp(`^${URL_SRC}$`, 'i')
/** Punctuation a sentence puts after a URL, never part of a Subsquare path. */
const TRAIL = /[.,;:!?*_~'"]+$/

/** `<address>-<chain>`: Subsquare's mention target. */
const MENTION_DEST = /^([1-9A-HJ-NP-Za-km-z]{40,50}|0x[0-9a-fA-F]{40}|0x[0-9a-fA-F]{64})-[a-z0-9-]{1,32}$/
/** The Subsquare sections a relative link (written for Subsquare's own site) can name. */
const SUBSQUARE_SECTIONS = new Set(['referenda', 'posts', 'post', 'democracy', 'council', 'techcomm', 'tech-comm', 'treasury', 'calendar', 'user'])

/** Cheap pre-check: true when `text` may hold something this module rewrites. */
export function mayHoldSubsquareLink(text: string): boolean {
  return /subsquare\.io|\]\(|href/i.test(text)
}

const COMMENT_ID = /^#([0-9a-f]{24})$/i

const CHAIN_NAMES: Record<string, string> = {
  polkadot: 'Polkadot', kusama: 'Kusama', bifrost: 'Bifrost', 'bifrost-kusama': 'Bifrost', 'bifrost-polkadot': 'Bifrost', phala: 'Phala',
  khala: 'Khala', darwinia: 'Darwinia', darwinia2: 'Darwinia', crab: 'Crab', laos: 'LAOS', basilisk: 'Basilisk', centrifuge: 'Centrifuge',
  interlay: 'Interlay', kintsugi: 'Kintsugi', karura: 'Karura', acala: 'Acala', zeitgeist: 'Zeitgeist', astar: 'Astar', moonbeam: 'Moonbeam',
  westend: 'Westend', paseo: 'Paseo', collectives: 'Polkadot Collectives', vara: 'Vara', heima: 'Heima', litentry: 'Litentry',
}

/**
 * Plain text naming another chain's Subsquare page — "Polkadot referendum 854", else
 * the chain's name. No `#`: the renderer reads `#<n>` in text as an OpenGov
 * referendum of ours.
 */
export function foreignPageLabel(chain: string, pathname: string): string {
  const name = CHAIN_NAMES[chain] ?? (chain ? chain[0].toUpperCase() + chain.slice(1) : 'Subsquare')
  const p = pathname.split('/').filter(Boolean).map(x => x.toLowerCase())
  const id = (x: string | undefined) => (x && /^[0-9][\w-]{0,30}$/.test(x.replace(/[.,;:!?*_~'"]+$/, '')) ? x.replace(/[.,;:!?*_~'"]+$/, '').replace('_', '-') : null)
  const kinds: Array<[boolean, string | null, string]> = [
    [p[0] === 'referenda' && p[1] !== 'tracks', id(p[1] === 'referendum' ? p[2] : p[1]), 'referendum'],
    [p[0] === 'posts' || p[0] === 'post', id(p[1]), 'discussion'],
    [p[0] === 'democracy' && (p[1] === 'referenda' || p[1] === 'referendum'), id(p[2]), 'democracy referendum'],
    [p[0] === 'democracy' && (p[1] === 'proposals' || p[1] === 'proposal'), id(p[2]), 'democracy proposal'],
    [p[0] === 'council' && (p[1] === 'motions' || p[1] === 'motion'), id(p[2]), 'council motion'],
    [(p[0] === 'techcomm' || p[0] === 'tech-comm') && !!p[1], id(p[2]), 'technical committee motion'],
    [p[0] === 'treasury' && (p[1] === 'proposals' || p[1] === 'proposal'), id(p[2]), 'treasury proposal'],
    [p[0] === 'treasury' && (p[1] === 'spends' || p[1] === 'spend'), id(p[2]), 'treasury spend'],
    [p[0] === 'treasury' && p[1] === 'bounties', id(p[2]), 'bounty'],
    [p[0] === 'treasury' && p[1] === 'child-bounties', id(p[2]), 'child bounty'],
    [p[0] === 'fellowship' && p[1] === 'referenda', id(p[2]), 'Fellowship referendum'],
  ]
  for (const [match, n, kind] of kinds) if (match && n) return `${name} ${kind} ${n}`
  return name
}

/** The explorer target of an absolute Subsquare URL, with a comment fragment carried over; another chain's page has none. */
export function subsquareUrlTarget(url: string, opts: LinkRewriteOptions = {}): ExplorerTarget {
  const m = /^(?:(?:https?:)?\/\/)?([^/?#]+)([^?#]*)(?:\?[^#]*)?(#.*)?$/i.exec(url)
  const chain = /^(?:www\.)?([a-z0-9-]+)\.subsquare\.io$/i.exec(m?.[1] ?? '')?.[1]?.toLowerCase() ?? ''
  if (chain !== 'hydration' && chain !== 'hydradx') return { path: null, label: foreignPageLabel(chain, m?.[2] ?? ''), exact: false }
  const t = subsquarePathTarget(m?.[2] ?? '', opts.resolveMotion)
  const frag = m?.[3] && COMMENT_ID.exec(m[3])
  if (frag && t.path && t.exact && /^\/(discussions|referendum|governance)\//.test(t.path)) return { ...t, path: `${t.path}#c-s${frag[1]}` }
  return t
}

/** A Subsquare-relative link target (`/user/…`, `/referenda/…`, a mention's `<address>-<chain>`) → its explorer target; null when it is not one. */
function relativeTarget(dest: string, opts: LinkRewriteOptions): ExplorerTarget | null {
  const mention = MENTION_DEST.exec(dest)
  if (mention) return accountIdOfAddress(mention[1]) ? { path: `/account/${mention[1]}`, label: mention[1], exact: true } : null
  if (!dest.startsWith('/') || dest.startsWith('//')) return null
  const section = /^\/([^/?#]+)/.exec(dest)?.[1]?.toLowerCase()
  if (!section || !SUBSQUARE_SECTIONS.has(section)) return null
  const t = subsquareUrlTarget(`//hydration.subsquare.io${dest}`, opts)
  if (section === 'user') {
    const who = /^\/user\/([^/?#]+)/i.exec(dest)?.[1] ?? ''
    if (t.path && ADDRESS_RE.test(who) && accountIdOfAddress(who)) return t
    return { path: null, label: t.label, exact: false }
  }
  return t.exact ? t : { path: null, label: t.label, exact: false }
}

/** An absolute Subsquare URL as a link target, with an address the account page names checked. */
function absoluteTarget(url: string, opts: LinkRewriteOptions): ExplorerTarget {
  const t = subsquareUrlTarget(url, opts)
  if (t.path?.startsWith('/account/')) {
    const who = t.path.slice('/account/'.length)
    return accountIdOfAddress(who) ? t : { path: null, label: who, exact: false }
  }
  return t
}

/** Escapes what would make a label markup (labels are words, numbers, an address or a legacy username). */
const escapeMd = (s: string) => s.replace(/[\\`*_[\]<>]/g, c => `\\${c}`)
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Splits trailing sentence punctuation off a URL matched in running text. */
function splitTrail(raw: string): [string, string] {
  const trail = TRAIL.exec(raw)?.[0] ?? ''
  return [raw.slice(0, raw.length - trail.length), trail]
}

/** Text standing in for each Subsquare URL in plain text (a title, a link's own text). */
export function rewriteSubsquareText(text: string, opts: LinkRewriteOptions = {}): string {
  if (!/subsquare\.io/i.test(text)) return text
  return text.replace(URL_ALL, raw => {
    const [url, trail] = splitTrail(raw)
    return absoluteTarget(url, opts).label + trail
  })
}

// One left-to-right scan; at a position the earlier alternative wins, so a URL inside
// code, a link or an anchor is handled with its construct, never twice. Every
// alternative's cost is bounded by the text up to its own end, so a scan is linear: an
// anchor is matched by its opening tag alone (`aopen`, capped and stopping at the next
// `<`; a code span opens only at the start of its backtick run, taken whole) and
// closed by the first `</a>` after it, found in a list of close positions computed once
// (a lazy `<a …>…</a>` would re-scan to the end of the text from every unclosed `<a`).
const MD_SCAN = new RegExp([
  String.raw`(?<fence>^[ \t]{0,3}(?<fm>\`{3,}(?!\`)|~{3,}(?!~))[^\n]*\n[\s\S]*?(?:\n[ \t]{0,3}\k<fm>[ \t]*(?=\n|$)|$(?![\s\S])))`,
  String.raw`(?<code>(?<!\`)(?<tick>\`+)(?!\`)(?:[^\`\n]|\n(?![ \t]*\n))+?\k<tick>(?!\`))`,
  String.raw`(?<link>(?<bang>!?)\[(?<text>(?:[^[\]\\]|\\[\s\S]|\[(?:[^[\]\\]|\\[\s\S])*\])*)\]\([ \t]*(?<dest><[^<>\n]*>|[^\s()<>]*(?:\([^\s()]*\)[^\s()<>]*)*)(?<rest>(?:[ \t\n]+(?:"[^"]*"|'[^']*'|\([^()]*\)))?[ \t]*)\))`,
  String.raw`(?<auto><(?<autourl>https?:\/\/${HOST}(?:[\/?#][^\s<>]*)?)>)`,
  String.raw`(?<aopen><a\b(?<attrs>[^<>]{0,2000})>)`,
  String.raw`(?<url>${URL_SRC})`,
].join('|'), 'gim')

const HTML_SCAN = new RegExp([
  String.raw`(?<aopen><a\b(?<attrs>[^<>]{0,2000})>)`,
  String.raw`(?<tag><[^<>]{0,2000}>)`,
  String.raw`(?<url>${URL_SRC})`,
].join('|'), 'gi')

const A_CLOSE = /<\/a\s*>/gi

const HREF = /(\bhref\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i

/** An `<a>` element (in an HTML body, or written literally into markdown): its href mapped, its text's URLs labelled. */
function anchor(attrs: string, inner: string, opts: LinkRewriteOptions): string {
  const innerText = rewriteSubsquareText(inner, opts)
  const h = HREF.exec(attrs)
  if (!h) return `<a${attrs}>${innerText}</a>`
  const href = (h[2] ?? h[3] ?? h[4] ?? '').replace(/&amp;/g, '&').trim()
  const t = URL_ONE.test(href) ? absoluteTarget(href, opts) : relativeTarget(href, opts)
  if (!t) return `<a${attrs}>${innerText}</a>`
  // A link with its own text to a page the explorer has no counterpart for: the text stays, unlinked.
  if (!t.path || !t.exact) return innerText
  const at = h.index ?? 0
  return `<a${attrs.slice(0, at)}${h[1]}"${escapeHtml(t.path)}"${attrs.slice(at + h[0].length)}>${innerText}</a>`
}

/** An opening `<a …>` with no closing tag after it: kept as written, its href mapped or dropped like an anchor's. */
function unclosedAnchor(attrs: string, opts: LinkRewriteOptions): string {
  const h = HREF.exec(attrs)
  if (!h) return `<a${attrs}>`
  const href = (h[2] ?? h[3] ?? h[4] ?? '').replace(/&amp;/g, '&').trim()
  const t = URL_ONE.test(href) ? absoluteTarget(href, opts) : relativeTarget(href, opts)
  if (!t) return `<a${attrs}>`
  const at = h.index ?? 0
  const value = t.path && t.exact ? `${h[1]}"${escapeHtml(t.path)}"` : ''
  return `<a${attrs.slice(0, at)}${value}${attrs.slice(at + h[0].length)}>`
}

type Groups = Record<string, string | undefined>

/** Runs `scan` over `body`, replacing each match by `handle`'s text; an `aopen` match consumes through its closing tag. */
function scanReplace(body: string, scan: RegExp, opts: LinkRewriteOptions, handle: (g: Groups, whole: string) => string): string {
  const closes: Array<[number, number]> = []
  if (/<a\b/i.test(body)) for (const m of body.matchAll(A_CLOSE)) closes.push([m.index ?? 0, (m.index ?? 0) + m[0].length])
  let next = 0 // closes[next] is the first close not yet passed
  let out = ''
  let pos = 0
  scan.lastIndex = 0
  for (let m = scan.exec(body); m; m = scan.exec(body)) {
    const g = (m.groups ?? {}) as Groups
    const start = m.index
    let end = start + m[0].length
    let replacement: string
    if (g.aopen != null) {
      while (next < closes.length && closes[next][0] < end) next++
      if (next < closes.length) {
        const [cs, ce] = closes[next]
        replacement = anchor(g.attrs ?? '', body.slice(end, cs), opts)
        end = ce
      } else {
        replacement = unclosedAnchor(g.attrs ?? '', opts)
      }
    } else {
      replacement = handle(g, m[0])
    }
    out += body.slice(pos, start) + replacement
    pos = end
    scan.lastIndex = end
  }
  return out + body.slice(pos)
}

function rewriteMarkdown(body: string, opts: LinkRewriteOptions): string {
  return scanReplace(body, MD_SCAN, opts, (g, whole) => {
    if (g.fence != null || g.code != null) {
      // Code shows its text as written: a URL becomes the explorer path, unlinked.
      return whole.replace(URL_ALL, raw => { const [u, trail] = splitTrail(raw); const t = absoluteTarget(u, opts); return (t.path ?? t.label) + trail })
    }
    if (g.link != null) {
      const text = g.text ?? ''
      const destRaw = g.dest ?? ''
      const dest = destRaw.startsWith('<') ? destRaw.slice(1, -1).trim() : destRaw
      const abs = URL_ONE.test(dest)
      if (g.bang) {
        // An image: only a page URL standing where an image should be is touched.
        if (!abs) return whole
        const t = absoluteTarget(dest, opts)
        return t.path ? `![${text}](${t.path}${g.rest ?? ''})` : text
      }
      const t = abs ? absoluteTarget(dest, opts) : relativeTarget(dest, opts)
      // A link's own text cannot hold another link: its URLs become labels.
      const label = rewriteSubsquareText(text, opts)
      if (!t) return label === text ? whole : `[${label}](${destRaw}${g.rest ?? ''})`
      if (!t.path || !t.exact) return label
      return `[${label}](${t.path}${g.rest ?? ''})`
    }
    if (g.auto != null) {
      const t = absoluteTarget(g.autourl ?? '', opts)
      return t.path ? `[${t.label}](${t.path})` : escapeMd(t.label)
    }
    const [url, trail] = splitTrail(whole)
    const t = absoluteTarget(url, opts)
    return (t.path ? `[${t.label}](${t.path})` : escapeMd(t.label)) + trail
  })
}

function rewriteHtml(body: string, opts: LinkRewriteOptions): string {
  return scanReplace(body, HTML_SCAN, opts, (g, whole) => {
    if (g.tag != null) return whole
    const [url, trail] = splitTrail(whole)
    const t = absoluteTarget(url, opts)
    return (t.path ? `<a href="${escapeHtml(t.path)}">${escapeHtml(t.label)}</a>` : escapeHtml(t.label)) + trail
  })
}

/** An imported body with every Subsquare page link pointing at the explorer instead. Idempotent. */
export function rewriteSubsquareLinks(body: string, format: string, opts: LinkRewriteOptions = {}): string {
  if (!body || !mayHoldSubsquareLink(body)) return body
  return format === 'html' ? rewriteHtml(body, opts) : rewriteMarkdown(body, opts)
}
