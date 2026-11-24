// Whether a URL points into the reader's own network or machine. Dependency-free on
// purpose: the explorer's renderer (render.ts) shows such links as inert text, and the
// api refuses them in native writes with a copy of this file
// (api/src/services/localNetwork.ts) — api/tests/forumLocalLinks.test.ts pins the two
// copies byte-identical. Change both or neither.

/** Names that never leave the reader's own network or machine. */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.localdomain', '.internal', '.intranet', '.lan', '.home', '.home.arpa', '.corp', '.private']

function privateIpv4(h: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
}

function privateIpv6(h: string): boolean {
  const v = h.replace(/^\[|\]$/g, '').toLowerCase()
  if (v === '::' || v === '::1') return true
  if (/^f[cd][0-9a-f]{0,2}:/.test(v) || /^fe[89ab][0-9a-f]?:/.test(v)) return true // ULA fc00::/7, link-local fe80::/10
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v)
  if (mapped) return privateIpv4(mapped[1])
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v) // the URL parser's form of a mapped IPv4
  if (hex) { const n = (parseInt(hex[1], 16) << 16 >>> 0) + parseInt(hex[2], 16); return privateIpv4(`${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`) }
  return false
}

/**
 * Whether an http(s) URL points into the reader's own network or machine rather than
 * the public web: localhost, a private, loopback, link-local or shared IP (any
 * spelling the URL parser normalizes: decimal, hex, IPv4-mapped IPv6), a bare
 * one-label name (`printer`, `printer.`), a local-only suffix (`.local`,
 * `.internal`, …), or an explicit port other than 80/443. Such a link in a stranger's
 * text can only probe the reader's network, so it is rendered as inert text. Pure.
 */
export function isLocalNetworkHref(href: string): boolean {
  let url: URL
  try { url = new URL(href) } catch { return false }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.port !== '') return true
  const host = url.hostname.toLowerCase().replace(/\.+$/, '')
  if (host === '' || !host.includes('.') && !host.startsWith('[')) return true
  if (host.startsWith('[')) return privateIpv6(host)
  if (privateIpv4(host)) return true
  return host === 'localhost' || LOCAL_SUFFIXES.some(sfx => host.endsWith(sfx))
}
