import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import https from 'node:https'
import type { IncomingMessage } from 'node:http'
import { USER_AGENT } from './client.js'

// The SSRF guard for re-hosting imported images. The URLs come from strangers'
// posts, so an image URL like `http://clickhouse:8123/?query=…` or a hostname that
// resolves to 10.0.0.5 must be harmless:
//   - https on port 443 only; a hostname, never an IP literal;
//   - DNS resolved HERE (within the fetch's timeout), every answer checked against the
//     non-public ranges (loopback, RFC 1918, link-local, CGNAT, ULA, multicast, the
//     docker bridge ranges, the IPv6 tunnelling and documentation blocks, …), and
//     the connection made to the vetted address with SNI and certificate validation
//     for the hostname — the socket's own lookup is replaced by one that returns that
//     address, so a second resolution cannot rebind it;
//   - at most 2 redirects, each re-checked the same way;
//   - 10 s for the whole fetch, a 5 MiB cap enforced while streaming, Accept: image/*.

export class SafeFetchError extends Error {
  constructor(readonly reason: string, message?: string) { super(message ?? reason); this.name = 'SafeFetchError' }
}

export const SAFE_FETCH_MAX_BYTES = 5 * 1024 * 1024

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0)
}
const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]

function v4Public(ip: string): boolean {
  const n = v4ToInt(ip)
  return !V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return ((n & mask) >>> 0) === ((v4ToInt(base) & mask) >>> 0)
  })
}

/** Expands an IPv6 address to its eight 16-bit groups (embedded IPv4 tails included). */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0]
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (v4) {
    const n = v4ToInt(v4[1])
    s = s.slice(0, -v4[1].length) + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16)
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 && missing !== 0) return null
  if (missing < 0) return null
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail].map(g => parseInt(g, 16))
  return groups.length === 8 && groups.every(g => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null
}

/** Non-public blocks inside 2000::/3, as [first groups, prefix length]. */
const V6_BLOCKED: Array<[number[], number]> = [
  [[0x2001, 0x0000], 32], // Teredo — tunnels to an arbitrary IPv4
  [[0x2001, 0x0002, 0x0000], 48], // benchmarking
  [[0x2001, 0x0010], 28], // ORCHID (deprecated)
  [[0x2001, 0x0020], 28], // ORCHIDv2
  [[0x2001, 0x0db8], 32], // documentation
  [[0x2002], 16], // 6to4 — tunnels to an arbitrary IPv4
  [[0x3fff, 0x0000], 20], // documentation
]

function v6InPrefix(g: number[], prefix: number[], bits: number): boolean {
  for (let i = 0; i * 16 < bits; i++) {
    const take = Math.min(16, bits - i * 16)
    const mask = (0xffff << (16 - take)) & 0xffff
    if ((g[i] & mask) !== ((prefix[i] ?? 0) & mask)) return false
  }
  return true
}

function v6Public(ip: string): boolean {
  const g = v6Groups(ip)
  if (!g) return false
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96): judge the embedded IPv4.
  const embedded = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return v4Public(embedded)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return v4Public(embedded)
  if (V6_BLOCKED.some(([prefix, bits]) => v6InPrefix(g, prefix, bits))) return false
  // Only global unicast (2000::/3) is public; ::, ::1, fc00::/7 (ULA), fe80::/10
  // (link-local), ff00::/8 (multicast) and every other reserved block are not.
  return (g[0] & 0xe000) === 0x2000
}

/** Whether a resolved address may be connected to. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip)
  if (family === 4) return v4Public(ip)
  if (family === 6) return v6Public(ip)
  return false
}

export interface ResolvedTarget { url: URL; address: string; family: 4 | 6 }

export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>
const defaultResolver: Resolver = hostname => dnsLookup(hostname, { all: true, verbatim: true })

/** `p`, or a `timeout` refusal as soon as `signal` aborts: a lookup that never answers cannot hold the fetch. */
function untilAborted<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new SafeFetchError('timeout'))
    if (signal.aborted) { onAbort(); return }
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      v => { signal.removeEventListener('abort', onAbort); resolve(v) },
      e => { signal.removeEventListener('abort', onAbort); reject(e) },
    )
  })
}

/**
 * Checks a URL and resolves its host; throws SafeFetchError naming why it is refused.
 * `signal` bounds the lookup (safeFetch passes its own timeout's).
 */
export async function vetUrl(raw: string, resolve: Resolver = defaultResolver, signal?: AbortSignal): Promise<ResolvedTarget> {
  let url: URL
  try { url = new URL(raw) } catch { throw new SafeFetchError('bad-url') }
  if (url.protocol !== 'https:') throw new SafeFetchError('scheme')
  if (url.port !== '' && url.port !== '443') throw new SafeFetchError('port')
  if (url.username || url.password) throw new SafeFetchError('credentials')
  // A fully qualified name's trailing dot names the same host: `localhost.` is localhost.
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  if (!host || isIP(host) || /^[\d.]+$/.test(host) || /^0x/i.test(host)) throw new SafeFetchError('ip-literal')
  if (!host.includes('.') || host.endsWith('.local') || host.endsWith('.internal') || host === 'localhost' || host.endsWith('.localhost')) throw new SafeFetchError('private-host')
  let answers: Array<{ address: string; family: number }>
  try { answers = await untilAborted(resolve(host), signal) } catch (err) { throw err instanceof SafeFetchError ? err : new SafeFetchError('dns') }
  if (!answers.length) throw new SafeFetchError('dns')
  // Every answer must be public: a name that also points inside is refused outright,
  // rather than gambling on which answer a retry would get.
  if (!answers.every(a => isPublicAddress(a.address))) throw new SafeFetchError('private-address')
  const pick = answers[0]
  return { url, address: pick.address, family: pick.family === 6 ? 6 : 4 }
}

export interface SafeFetchResult { bytes: Buffer; contentType: string; finalUrl: string }

export interface SafeFetchOptions {
  maxBytes?: number
  timeoutMs?: number
  maxRedirects?: number
  resolve?: Resolver
  /** For tests: performs the request against the vetted target. */
  request?: (target: ResolvedTarget, signal: AbortSignal) => Promise<IncomingMessage>
}

function requestVetted(target: ResolvedTarget, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: target.url.hostname,
      servername: target.url.hostname,
      port: 443,
      path: target.url.pathname + target.url.search,
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: 'image/*' },
      // The vetted address, whatever the socket asks: no second resolution.
      lookup: (_hostname: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => {
        if (options?.all) cb(null, [{ address: target.address, family: target.family }])
        else cb(null, target.address, target.family)
      },
      signal,
      agent: false,
    } as https.RequestOptions, resolve)
    req.on('error', reject)
    req.end()
  })
}

export async function safeFetch(raw: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const maxBytes = options.maxBytes ?? SAFE_FETCH_MAX_BYTES
  const maxRedirects = options.maxRedirects ?? 2
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000)
  const doRequest = options.request ?? requestVetted
  try {
    let current = raw
    for (let hop = 0; ; hop++) {
      const target = await vetUrl(current, options.resolve, controller.signal)
      let res: IncomingMessage
      try { res = await doRequest(target, controller.signal) } catch (err) {
        throw new SafeFetchError(controller.signal.aborted ? 'timeout' : 'connect', err instanceof Error ? err.message : String(err))
      }
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        if (hop >= maxRedirects) throw new SafeFetchError('redirects')
        current = new URL(res.headers.location, target.url).toString()
        continue
      }
      if (status !== 200) { res.resume(); throw new SafeFetchError(`http-${status}`) }
      const declared = Number(res.headers['content-length'])
      if (Number.isFinite(declared) && declared > maxBytes) { res.destroy(); throw new SafeFetchError('too-large') }
      const chunks: Buffer[] = []
      let size = 0
      try {
        for await (const chunk of res) {
          size += (chunk as Buffer).length
          if (size > maxBytes) { res.destroy(); throw new SafeFetchError('too-large') }
          chunks.push(chunk as Buffer)
        }
      } catch (err) {
        if (err instanceof SafeFetchError) throw err
        throw new SafeFetchError(controller.signal.aborted ? 'timeout' : 'read')
      }
      return { bytes: Buffer.concat(chunks), contentType: String(res.headers['content-type'] ?? ''), finalUrl: current }
    }
  } finally {
    clearTimeout(timer)
  }
}
