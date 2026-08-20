// Pure message renderer. Every outbound notification — push payload, Telegram
// message, inbox row — is built here from the same match payload, so the three
// surfaces can never disagree about how an account, an amount or a link reads.
// Nothing in this module touches ClickHouse, a channel, or a clock.

// The explorer origin links point at. Read per call rather than frozen at
// import so a test (and a differently-hosted deployment) can set it without
// module-load ordering mattering.
const DEFAULT_EXPLORER_URL = 'https://hydration-explorer.neckwork.net'
export function explorerBaseUrl(): string {
  return (process.env.EXPLORER_PUBLIC_URL?.trim() || DEFAULT_EXPLORER_URL).replace(/\/+$/, '')
}
export function explorerUrl(path: string): string {
  return `${explorerBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`
}

/* ============ shared rough number scale ============ */
// A server-side port of the explorer's `compactAmount` (explorer-ui/src/
// components/ui.tsx): ~3 significant digits with k/M/B/T/Q compaction, ~3
// significant decimals below 1, and subscript-zero notation for very small
// fractions. Messages must round the same way the page they link to does.
const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉'
const subscript = (n: number) => String(n).split('').map(d => SUBSCRIPT[+d]).join('')
const BIG_UNITS = ['M', 'B', 'T', 'Q']
const sig3 = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)).replace(/\.0+$|(\.\d*[1-9])0+$/, '$1')
// Round to 3 significant digits BEFORE picking a unit tier so a value in the
// carry band tiers up (999.6M → "1B") instead of rendering as "1000M".
const round3 = (n: number) => Number(n.toPrecision(3))

function tinyPrice(price: number): string {
  const leadingZeros = -Math.floor(Math.log10(price)) - 1
  const factor = 10 ** (leadingZeros + 4)
  let sig = String(Math.round(price * factor))
  if (sig.length !== 4) return price.toFixed(leadingZeros + 4).replace(/\.?0+$/, '')
  sig = sig.replace(/0+$/, '') || '0'
  return '0.0' + subscript(leadingZeros - 1) + sig
}

function bigCompact(v: number): string {
  let n = round3(v / 1e6)
  let u = 0
  while (n >= 1000 && u < BIG_UNITS.length - 1) { n /= 1000; u++ }
  if (n >= 1000) return v.toExponential(2)
  return sig3(n) + BIG_UNITS[u]
}

export function compactAmount(v: number): string {
  if (!Number.isFinite(v)) return '—'
  const sign = v < 0 ? '-' : ''
  const a = Math.abs(v)
  if (a === 0) return '0'
  const r = a >= 1 ? round3(a) : a
  if (r >= 1e6) return sign + bigCompact(r)
  if (r >= 1000) return sign + sig3(r / 1000) + 'k'
  if (r >= 1) return sign + sig3(r)
  if (a >= 0.001) return sign + parseFloat(a.toPrecision(3)).toString()
  return sign + tinyPrice(a)
}

// USD counterpart of the same scale (mirrors `F.usd`): whole dollars from $100
// up, k/M compaction above, ~3 significant decimals below.
export function compactUsd(v: number): string {
  if (!Number.isFinite(v)) return '—'
  const sign = v < 0 ? '-' : ''
  const a = Math.abs(v)
  if (a === 0) return '$0'
  const r = a >= 100 ? round3(a) : a
  if (r >= 1e6) return `${sign}$${bigCompact(r)}`
  if (r >= 1e3) return `${sign}$${sig3(r / 1e3)}k`
  if (r >= 100) return `${sign}$${r.toFixed(0)}`
  if (a >= 0.01) return `${sign}$${parseFloat(a.toPrecision(3)).toString()}`
  return `${sign}$${tinyPrice(a)}`
}

/* ============ account notation ============ */

// The subset of the api's AccountRef this module reads, plus the viewer's own
// resolved list tag — which the server holds per recipient (userListService's
// tag map) rather than on the shared ref, exactly like AddrPill resolves it
// client-side. Keeping it a parameter is what keeps this module pure.
export interface RenderAccount {
  accountId: string
  address: string
  emoji?: string
  userTag?: { name: string } | null
  tag?: { name: string } | null
  profile?: { name: string } | null
  identity?: { display?: string | null; verified?: boolean } | null
  contractName?: string | null
}

// "modl" pallet account: 0x6d6f646c + the ASCII PalletId, zero-padded.
export function moduleName(accountId: string): string | null {
  if (!accountId.startsWith('0x6d6f646c')) return null
  const hex = accountId.slice(10)
  let s = ''
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16)
    if (code >= 32 && code <= 126) s += String.fromCharCode(code); else break
  }
  return s.replace(/[^\x20-\x7e]+$/, '').trim() || null
}

// ShortAddr's rule: SS58 keeps 4 leading characters, an 0x address keeps 6;
// both keep the last 5 (of which the UI highlights the last 3 — plain text
// keeps the characters and drops the styling).
export function shortAddress(addr: string): string {
  const head = addr.startsWith('0x') ? 6 : 4
  if (addr.length <= head + 6) return addr
  return `${addr.slice(0, head)}…${addr.slice(-5)}`
}

// A hash is not an address. The explorer shortens one to 8 leading + 6 trailing
// characters (`F.shortHash` in ui.tsx), so a proposal hash in a message reads
// exactly as it does on the page the message links to; ShortAddr's 4/6 + 5 rule
// above is for accounts only.
export function shortHash(hash: string): string {
  return hash.length > 18 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash
}

export interface AccountNotation { emoji: string; label: string | null; short: string }

// AddrPill's label precedence, verbatim: the recipient's own list tag, then the
// system tag, module account, self-set profile name, on-chain identity (with ✓
// only when registrar-verified), a verified contract's name with its address
// tail (contract names are not unique), and finally the short address alone.
export function accountNotation(account: RenderAccount): AccountNotation {
  const short = shortAddress(account.address)
  const emoji = account.emoji || '👤'
  if (account.userTag?.name) return { emoji, label: account.userTag.name, short }
  if (account.tag?.name) return { emoji, label: account.tag.name, short }
  const mod = moduleName(account.accountId)
  if (mod) return { emoji: '⚙️', label: mod, short }
  if (account.profile?.name) return { emoji, label: account.profile.name, short }
  if (account.identity?.display) {
    return { emoji, label: account.identity.verified ? `${account.identity.display} ✓` : account.identity.display, short }
  }
  if (account.contractName) return { emoji, label: `${account.contractName}·${account.address.slice(-3)}`, short }
  return { emoji, label: null, short }
}

// The three characters the UI highlights at the end of an address. A NAMED
// account already says which account it is, so repeating a truncated address
// beside the name is noise — the tail is there to disambiguate two accounts
// sharing a name, not to be read as an address.
export const addressTail = (addr: string): string => addr.slice(-3)

// Plain-text form: a named account shows its label with the address tail in
// parentheses; a bare one has nothing else to identify it and keeps the short
// address in full.
export function accountText(account: RenderAccount): string {
  const n = accountNotation(account)
  return n.label ? `${n.emoji} ${n.label} (${addressTail(account.address)})` : `${n.emoji} ${n.short}`
}

/* ============ Telegram HTML ============ */
// Telegram's HTML parse mode needs &, < and > escaped in every text node, and
// `"` on top of those because the same helper escapes values that land in an
// `href` attribute. Everything a rule can carry is user- or chain-derived
// (identity displays, tag names, contract names, call names, the account
// emoji), so escaping happens at the single point where text becomes markup
// rather than at each call site.
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function accountHtml(account: RenderAccount): string {
  const n = accountNotation(account)
  const href = escapeHtml(explorerUrl(`/account/${encodeURIComponent(account.address)}`))
  // The linked run is whatever the text form shows: the tail for a named
  // account, the whole short address for a bare one.
  const shown = n.label ? addressTail(account.address) : n.short
  // A plain link, NOT <code>: Telegram renders a code span as a tap-to-COPY
  // entity, which wins over the anchor wrapping it — so the address tail copied
  // instead of opening the account. Monospace is not worth losing the link.
  const link = `<a href="${href}">${escapeHtml(shown)}</a>`
  const emoji = escapeHtml(n.emoji)
  return n.label ? `${emoji} <b>${escapeHtml(n.label)}</b> (${link})` : `${emoji} ${link}`
}

/* ============ match payload ============ */

export type RenderPart =
  | { kind: 'text'; text: string }
  | { kind: 'account'; account: RenderAccount }
  | { kind: 'amount'; value: number; symbol?: string }
  | { kind: 'usd'; value: number }
  | { kind: 'code'; text: string }

export const text = (t: string): RenderPart => ({ kind: 'text', text: t })
export const account = (a: RenderAccount): RenderPart => ({ kind: 'account', account: a })
export const amount = (value: number, symbol?: string): RenderPart => ({ kind: 'amount', value, symbol })
export const usd = (value: number): RenderPart => ({ kind: 'usd', value })
export const code = (t: string): RenderPart => ({ kind: 'code', text: t })

export interface RenderInput {
  /** Single-line headline; parts are joined with a space. */
  title: string | RenderPart[]
  /** Body lines; each line's parts are joined with a space, lines with '\n'. */
  body?: (string | RenderPart[])[]
  /** Explorer-relative canonical path for this match, e.g. `/account/…`. */
  path: string
}

export interface RenderedNotification {
  title: string
  body: string
  /**
   * Site-relative canonical path. This is what the inbox row stores and the SPA
   * router navigates to; an absolute URL there would be prefixed with '/' by
   * the router's own normalization and resolve to nothing.
   */
  path: string
  /** Absolute URL, for the surfaces that leave the site: push payloads and Telegram. */
  url: string
  telegramHtml: string
}

function partText(part: RenderPart): string {
  switch (part.kind) {
    case 'text': return part.text
    case 'account': return accountText(part.account)
    case 'amount': return part.symbol ? `${compactAmount(part.value)} ${part.symbol}` : compactAmount(part.value)
    case 'usd': return compactUsd(part.value)
    case 'code': return part.text
  }
}

function partHtml(part: RenderPart): string {
  switch (part.kind) {
    case 'account': return accountHtml(part.account)
    case 'code': return `<code>${escapeHtml(part.text)}</code>`
    default: return escapeHtml(partText(part))
  }
}

const lineParts = (line: string | RenderPart[]): RenderPart[] => (typeof line === 'string' ? [text(line)] : line)
const joinText = (line: string | RenderPart[]) => lineParts(line).map(partText).join(' ').replace(/\s+([,.;:)])/g, '$1').trim()
const joinHtml = (line: string | RenderPart[]) => lineParts(line).map(partHtml).join(' ').trim()

// Text runs in the headline are bolded and carry the notification's own link —
// the headline IS the way into the explorer, so the message needs no separate
// "open" line. An account keeps its own notation (which already bolds its
// label and links its address) rather than being wrapped a second time.
const titleHtml = (line: string | RenderPart[], url: string) => {
  // The headline is ONE way into the explorer, so CONSECUTIVE text runs share a
  // single anchor. Wrapping each run separately produced an anchor per run — and
  // a link around punctuation like the bare em-dash in "Health factor 1.06 —
  // <account>". A non-text part (an account) ends the run: it links elsewhere.
  const out: string[] = []
  let run: string[] = []
  const flush = () => {
    if (!run.length) return
    out.push(`<a href="${escapeHtml(url)}"><b>${escapeHtml(run.join(' '))}</b></a>`)
    run = []
  }
  for (const part of lineParts(line)) {
    if (part.kind === 'text') run.push(part.text)
    else { flush(); out.push(partHtml(part)) }
  }
  flush()
  return out.join(' ').trim()
}

export function renderNotification(input: RenderInput): RenderedNotification {
  const title = joinText(input.title)
  const lines = (input.body ?? []).map(joinText).filter(Boolean)
  const path = input.path.startsWith('/') ? input.path : `/${input.path}`
  const url = explorerUrl(path)
  const htmlLines = (input.body ?? []).map(joinHtml).filter(Boolean)
  const telegramHtml = [titleHtml(input.title, url), ...htmlLines].join('\n')
  return { title, body: lines.join('\n'), path, url, telegramHtml }
}
