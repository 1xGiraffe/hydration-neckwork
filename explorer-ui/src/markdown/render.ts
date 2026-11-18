import markdownIt, { type MarkdownIt, type StateCore, type Token } from 'markdown-it'
import DOMPurify from 'dompurify'

// The ONE renderer for user-authored forum text (posts, comments, revisions,
// previews). Every byte of it is hostile: Subsquare's imported set holds live XSS
// probes, and sessions are bearer tokens in localStorage, so an XSS here is an
// account takeover. Nothing else in the app may put forum text into the DOM as
// markup — titles, names and excerpts are React text.
//
// The pipeline:
//   1. markdown-it with `html: false`, so raw HTML in markdown is escaped, never
//      parsed (legacy `html` bodies skip this step and go straight to 2);
//   2. DOMPurify with an explicit allow-list (tags, attributes, URI schemes) and
//      no `style`/`class` from the input, in a dedicated instance;
//   3. a policy pass over the sanitized, still-inert fragment:
//      - an image renders only when the body's URL is in the post's `media` map
//        (re-hosted on our IPFS node, same origin) — any other image becomes a
//        plain link, so a reader's browser never hotlinks a stranger's host;
//      - a link keeps only an http(s) or same-origin path target (a link to the
//        replaced forum's host becomes the same path here); an external one
//        opens in a new tab with rel="noopener noreferrer nofollow ugc"; any other
//        scheme loses its href and reads as text;
//      - a paragraph that is only a typed run of dashes becomes an <hr>;
//      - headings move one level down (h1 → h2 … h5 → h6), as the page's own title
//        is its one h1;
//      - a link to an account page whose text is an @name reads as a mention.
// `#N` becomes a referendum link only where it cannot mean something else (see
// RefContext): never in text imported from elsewhere unless it names its kind.
// The result is a DocumentFragment the <Markdown> component mounts with
// replaceChildren — never innerHTML / dangerouslySetInnerHTML.

export type BodyFormat = 'markdown' | 'html' | string

/**
 * What a `#N` in the text may refer to. Without it, no `#N` is linked.
 * - `native`: the text was written here (after OpenGov began), so a bare `#N` is
 *   OpenGov referendum N — unless it sits in a GitHub-style context ("in #1042",
 *   "PR #12", a line that links github.com), where it is an issue or pull request.
 *   Text imported from the forum this one replaced (`native: false`) is linked only
 *   where it names its kind: "OpenGov referendum #N" or "democracy referendum #N".
 * - `maxOpenGov` / `maxDemocracy`: the highest index of each; a number above it is
 *   not a referendum and stays text. Unknown (null) links nothing of that kind.
 */
export interface RefContext {
  native: boolean
  maxOpenGov: number | null
  maxDemocracy: number | null
}

export interface RenderInput {
  body: string
  format: BodyFormat
  /** Original image URL (as written in the body) → `/ipfs/<cid>`, from the API. */
  media?: Record<string, string>
  refs?: RefContext
}

const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 'del', 's', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'img',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'sup', 'sub',
]
const ALLOWED_ATTR = ['href', 'title', 'src', 'alt']
// http(s), a same-origin path or a fragment; DOMPurify drops any other URI value. A
// path may not open with `//` or `/\` (browsers read both as another host), and the
// policy pass below re-checks every href with the URL parser.
const ALLOWED_URI_REGEXP = /^(?:https?:\/\/|\/(?![/\\])|#)/i

const EXTERNAL_REL = 'noopener noreferrer nofollow ugc'
const IPFS_PATH_RE = /^\/ipfs\/[A-Za-z0-9]{46,121}$/

let mdInstance: MarkdownIt | null = null

/** SS58 (Polkadot/Hydration/generic prefixes) or an H160, as written after an `@`. */
const MENTION_RE = /(^|[\s(])@([1-9A-HJ-NP-Za-km-z]{46,48}|0x[0-9a-fA-F]{40})(?![0-9A-Za-z])/g
/** `#450` (1–4 digits, standing alone). */
const REF_RE = /(^|[\s(])#(\d{1,4})(?![0-9A-Za-z_])/g
/** The words before a `#N` that make it a GitHub issue or pull request rather than a referendum. */
const GITHUB_BEFORE_RE = /(?:\bin|\bPR|\bpull(?: request)?|\bissues?|\bfix(?:es|ed)?|\bclose[sd]?|\bresolve[sd]?|\bmerged?)\s*$/i
/** A line or paragraph that talks GitHub: a link there, or a release-note "by @user in #N". */
const GITHUB_BLOCK_RE = /github\.com|\/pull\/\d|\/issues\/\d|\bby @[\w-]+ in #\d/i
/** The words before a `#N` that name its kind. */
const OPENGOV_BEFORE_RE = /\bopen\s?gov(?:\s+referend(?:um|a))?\s*$/i
const DEMOCRACY_BEFORE_RE = /\bdemocracy(?:\s+referend(?:um|a))?\s*$/i

/** Where `#N` in this text leads, if anywhere (see RefContext). */
export function refTarget(before: string, n: number, ctx: RefContext | undefined, blockText: string): string | null {
  if (!ctx) return null
  const tail = before.slice(-40)
  if (DEMOCRACY_BEFORE_RE.test(tail)) return ctx.maxDemocracy != null && n <= ctx.maxDemocracy ? `/referendum/democracy/${n}` : null
  if (OPENGOV_BEFORE_RE.test(tail)) return ctx.maxOpenGov != null && n <= ctx.maxOpenGov ? `/referendum/opengov/${n}` : null
  if (!ctx.native || GITHUB_BEFORE_RE.test(tail) || GITHUB_BLOCK_RE.test(blockText)) return null
  return ctx.maxOpenGov != null && n <= ctx.maxOpenGov ? `/referendum/opengov/${n}` : null
}

// Splits text tokens into text + internal link tokens for `@address` mentions and
// `#n` referendum references. Text inside an existing link is left alone.
function mentionsAndRefs(state: StateCore): void {
  const refs = (state.env as { refs?: RefContext } | undefined)?.refs
  for (const block of state.tokens) {
    if (block.type !== 'inline' || !block.children) continue
    const out: Token[] = []
    let linkDepth = 0
    // The whole inline run as plain text, for the context checks of `#N`.
    const blockText = block.content
    let seen = ''
    for (const tok of block.children) {
      if (tok.type === 'text' || tok.type === 'code_inline') seen += tok.content
      else if (tok.type === 'softbreak' || tok.type === 'hardbreak') seen += ' '
      if (tok.type === 'link_open') linkDepth++
      if (tok.type === 'link_close') linkDepth--
      if (tok.type !== 'text' || linkDepth > 0 || !/[@#]/.test(tok.content)) { out.push(tok); continue }
      const text = tok.content
      const hits: { start: number; end: number; href: string; label: string }[] = []
      for (const m of text.matchAll(MENTION_RE)) {
        const start = (m.index ?? 0) + m[1].length
        const addr = m[2]
        hits.push({ start, end: start + 1 + addr.length, href: `/account/${addr}`, label: `@${addr.slice(0, 6)}…${addr.slice(-4)}` })
      }
      for (const m of text.matchAll(REF_RE)) {
        const start = (m.index ?? 0) + m[1].length
        const before = seen.slice(0, seen.length - text.length) + text.slice(0, start)
        const href = refTarget(before, Number(m[2]), refs, blockText)
        if (href) hits.push({ start, end: start + 1 + m[2].length, href, label: `#${m[2]}` })
      }
      if (!hits.length) { out.push(tok); continue }
      hits.sort((a, b) => a.start - b.start)
      let pos = 0
      for (const h of hits) {
        if (h.start < pos) continue
        if (h.start > pos) { const t = new state.Token('text', '', 0); t.content = text.slice(pos, h.start); out.push(t) }
        const open = new state.Token('link_open', 'a', 1); open.attrs = [['href', h.href]]
        const label = new state.Token('text', '', 0); label.content = h.label
        out.push(open, label, new state.Token('link_close', 'a', -1))
        pos = h.end
      }
      if (pos < text.length) { const t = new state.Token('text', '', 0); t.content = text.slice(pos); out.push(t) }
    }
    block.children = out
  }
}

function md(): MarkdownIt {
  if (mdInstance) return mdInstance
  const m = markdownIt({ html: false, linkify: true, typographer: false, breaks: true })
  m.core.ruler.push('forum_mentions_refs', mentionsAndRefs)
  mdInstance = m
  return m
}

let purifier: ReturnType<typeof DOMPurify> | null = null
function purify(): ReturnType<typeof DOMPurify> {
  // A dedicated instance: the app's other code can never add a hook to this one.
  if (!purifier) purifier = DOMPurify(window)
  return purifier
}

/** Decodes the few entities a URL written into HTML carries, so `&amp;` keys match the parsed attribute. */
function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

/** The media map under every spelling a renderer may hand back for one URL. */
function mediaLookup(media: Record<string, string> | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (!media) return out
  const m = md()
  for (const [url, local] of Object.entries(media)) {
    if (!IPFS_PATH_RE.test(local)) continue // only our own same-origin image path, ever
    for (const key of [url, decodeEntities(url), m.normalizeLink(url), m.normalizeLink(decodeEntities(url))]) out.set(key, local)
  }
  return out
}

const REPLACED_FORUM = /^https:\/\/hydration\.subsquare\.io(\/[^\s\\#?]*)?(?:[?#][^\s\\]*)?$/i

/** `https://hydration.subsquare.io/posts/226` → `/posts/226` (which the router sends to its page here). */
export function localForumPath(href: string): string | null {
  const m = REPLACED_FORUM.exec(href)
  return m ? (m[1] && m[1] !== '/' ? m[1] : '/discussions') : null
}

/** An image on one of the replaced forum's hosts: its own domains and its IPFS gateway (the sync's images.ts reads the same set). */
export function isReplacedForumHost(href: string): boolean {
  try {
    const h = new URL(href).hostname.toLowerCase()
    return h === 'subsquare.io' || h.endsWith('.subsquare.io') || h === 'subsquare.infura-ipfs.io'
  } catch { return false }
}

export function isExternalHttp(href: string): boolean {
  return /^https?:\/\//i.test(href) && !/[\\\s]/.test(href)
}

/**
 * A same-origin path, as the URL parser reads it: backslashes and whitespace are
 * refused outright (`/\evil.com` is another host to a browser), and what remains must
 * resolve to this origin. Returns the normalized path, or null.
 */
export function sameOriginPath(href: string, origin = window.location.origin): string | null {
  if (!href.startsWith('/') || /[\\\s]/.test(href) || href.startsWith('//')) return null
  try {
    const url = new URL(href, origin)
    return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : null
  } catch { return null }
}

/** A paragraph that is only a run of dashes (or underscores, equals signs, asterisks): a divider its author typed. */
const TYPED_RULE_RE = /^[\s\u00a0]*(?:[-\u2013\u2014_=*][\s\u00a0]*){3,}$/

function enforcePolicy(root: DocumentFragment, media: Map<string, string>): void {
  const doc = root.ownerDocument
  // Imported HTML bodies carry typed dividers as `<p>------</p>`: drawn as the rule
  // they stand for. Only an element-free paragraph qualifies, and the <hr> is new.
  for (const p of Array.from(root.querySelectorAll('p'))) {
    if (!p.children.length && TYPED_RULE_RE.test(p.textContent ?? '')) p.replaceWith(doc.createElement('hr'))
  }
  // The page's title is its h1, so the text's own headings start one level below.
  for (const h of Array.from(root.querySelectorAll('h1, h2, h3, h4, h5'))) {
    const next = doc.createElement(`h${Number(h.tagName.slice(1)) + 1}`)
    next.append(...Array.from(h.childNodes))
    h.replaceWith(next)
  }
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? ''
    const local = media.get(src)
    if (local) {
      // Rebuilt rather than edited: only the attributes we set survive.
      const safe = doc.createElement('img')
      safe.setAttribute('src', local)
      safe.setAttribute('alt', img.getAttribute('alt') ?? '')
      safe.setAttribute('loading', 'lazy')
      safe.setAttribute('decoding', 'async')
      safe.className = 'md-img'
      img.replaceWith(safe)
      continue
    }
    // Not re-hosted: never fetched by the reader's browser. A link to it instead,
    // only when it is an http(s) URL; anything else is just its alt text.
    const alt = (img.getAttribute('alt') ?? '').trim()
    if (isExternalHttp(src) && isReplacedForumHost(src)) {
      // The replaced forum's own image hosts: the image is gone, and the reader is
      // never sent there for it.
      const span = doc.createElement('span')
      span.textContent = alt ? `Image unavailable: ${alt}` : 'Image unavailable'
      span.className = 'md-img-gone'
      img.replaceWith(span)
    } else if (isExternalHttp(src)) {
      const a = doc.createElement('a')
      a.setAttribute('href', src)
      a.textContent = alt ? `Image: ${alt}` : 'Image (external link)'
      a.className = 'md-img-link'
      img.replaceWith(a)
    } else {
      img.replaceWith(doc.createTextNode(alt))
    }
  }
  for (const a of Array.from(root.querySelectorAll('a'))) {
    const raw = (a.getAttribute('href') ?? '').trim()
    // A link to the forum this one replaced points at its page here: the router (and
    // nginx) answer that forum's paths, so the reader never leaves for it.
    const href = localForumPath(raw) ?? raw
    const title = a.getAttribute('title')
    const keepClass = a.className === 'md-img-link' ? 'md-img-link' : ''
    for (const attr of Array.from(a.attributes)) a.removeAttribute(attr.name)
    if (title) a.setAttribute('title', title)
    if (isExternalHttp(href)) {
      a.setAttribute('href', href)
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', EXTERNAL_REL)
      a.className = keepClass ? `${keepClass} md-ext` : 'md-ext'
    } else if (/^#[\w-]+$/.test(href)) {
      a.setAttribute('href', href)
    } else {
      const path = sameOriginPath(href)
      if (path) {
        a.setAttribute('href', path); a.setAttribute('data-internal', '1')
        // `[@name](/account/<address>)` and an `@address` typed here read alike: a mention.
        if (/^\/account\/[^/?#]+$/.test(path) && (a.textContent ?? '').trimStart().startsWith('@')) a.className = 'md-mention'
      }
    }
    // Any other scheme: no href, so it is inert text in an <a> with no target.
  }
}

/** Stage 1 alone: markdown to HTML with raw HTML escaped (pure; no DOM). */
export function markdownToHtml(body: string, refs?: RefContext): string {
  return md().render(body ?? '', { refs })
}

/**
 * Renders a forum body to a sanitized, inert DocumentFragment that obeys the image
 * and link policy above. Safe to mount with replaceChildren.
 */
export function renderForumBody(input: RenderInput): DocumentFragment {
  const html = input.format === 'html' ? input.body : markdownToHtml(input.body, input.refs)
  const fragment = purify().sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP,
    FORBID_ATTR: ['style', 'class', 'id'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    KEEP_CONTENT: true,
    RETURN_DOM_FRAGMENT: true,
  }) as DocumentFragment
  enforcePolicy(fragment, mediaLookup(input.media))
  return fragment
}

/** The same render as an HTML string — for tests and for measuring, never for innerHTML. */
export function renderForumBodyToString(input: RenderInput): string {
  const holder = document.createElement('div')
  holder.appendChild(renderForumBody(input))
  return holder.innerHTML
}
