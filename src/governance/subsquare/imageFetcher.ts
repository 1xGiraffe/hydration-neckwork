import type { IncomingMessage, ServerResponse } from 'node:http'
import { SAFE_FETCH_MAX_BYTES, SafeFetchError, safeFetch, type SafeFetchOptions, type SafeFetchResult } from './safeFetch.js'

// The image fetcher: the one process that connects to URLs strangers wrote.
//
// The sync re-hosts the images imported text references. Its SSRF guard (safeFetch)
// refuses non-public targets, but the sync itself sits on the networks of everything it
// writes to — ClickHouse, the IPFS node's RPC — so a guard bug would put those in reach.
// This process runs the same guard in its own container (`governance-image-fetcher`),
// on a network with a route to the internet and NO route to any other service, holding
// no credentials. The sync asks it over that network (POST /fetch) and gets the bytes,
// or the guard's refusal reason, back. A URL that slipped past the guard would find
// nothing internal to reach. Only url and the three bounds cross the wire; everything
// else (resolver, request hooks) stays this process's own.
//
// The sync trusts the fetcher no further than the URLs it fetches: it asks for an
// uncompressed answer, refuses any Content-Encoding (a compressed body would be
// inflated before any cap could see it), and reads the body with a running cap —
// maxBytes for an image, 1 KiB for a refusal. The fetcher never compresses.

export const FETCHER_PORT = 8090
const MAX_REQUEST_BYTES = 16 * 1024
const MAX_URL_CHARS = 4096
const MAX_TIMEOUT_MS = 30_000
/** A refusal is `{"reason": "…"}`; nothing longer is read. */
const MAX_REFUSAL_BYTES = 1024

type Fetch = (url: string, options?: SafeFetchOptions) => Promise<SafeFetchResult>

function clamp(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : fallback
}

function reply(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
}

/** The fetcher's HTTP handler: POST /fetch {url, maxBytes?, timeoutMs?, maxRedirects?}. */
export function fetcherHandler(fetchImpl: Fetch = safeFetch) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method === 'GET' && req.url === '/health') { reply(res, 200, { ok: true }); return }
    if (req.method !== 'POST' || req.url !== '/fetch') { reply(res, 404, { reason: 'not-found' }); return }
    const chunks: Buffer[] = []
    let size = 0
    let refused = false
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_REQUEST_BYTES) { refused = true; reply(res, 413, { reason: 'request-too-large' }); req.destroy() } else chunks.push(c)
    })
    req.on('end', () => {
      if (refused) return
      let input: Record<string, unknown>
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { reply(res, 400, { reason: 'bad-request' }); return }
      const url = input?.url
      if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_CHARS) { reply(res, 400, { reason: 'bad-request' }); return }
      const options: SafeFetchOptions = {
        maxBytes: clamp(input.maxBytes, 1, SAFE_FETCH_MAX_BYTES, SAFE_FETCH_MAX_BYTES),
        timeoutMs: clamp(input.timeoutMs, 1, MAX_TIMEOUT_MS, 10_000),
        maxRedirects: clamp(input.maxRedirects, 0, 2, 2),
      }
      fetchImpl(url, options).then(r => {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'X-Content-Type': encodeURIComponent(r.contentType),
          'X-Final-Url': encodeURIComponent(r.finalUrl),
        }).end(r.bytes)
      }, (err: unknown) => {
        reply(res, 422, { reason: err instanceof SafeFetchError ? err.reason : 'fetch' })
      })
    })
  }
}

/** A response body, or null once it passes `cap` bytes (the rest is cancelled, never read). */
async function readCapped(res: Response, cap: number): Promise<Buffer | null> {
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > cap) { await reader.cancel().catch(() => undefined); return null }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/**
 * The sync's side: a drop-in for safeFetch that runs it in the fetcher. A refusal
 * comes back as the same SafeFetchError reason the local guard would give; a fetcher
 * that cannot be reached, or answers out of protocol (compressed, cut off), is
 * `fetcher` (retried like any transient failure).
 */
export function remoteSafeFetch(baseUrl: string, fetchImpl: typeof fetch = fetch): Fetch {
  const endpoint = baseUrl.replace(/\/+$/, '') + '/fetch'
  return async (url, options = {}) => {
    const body = JSON.stringify({ url, maxBytes: options.maxBytes, timeoutMs: options.timeoutMs, maxRedirects: options.maxRedirects })
    let res: Response
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' }, body,
        signal: AbortSignal.timeout((options.timeoutMs ?? 10_000) + 5_000),
      })
    } catch (err) {
      throw new SafeFetchError('fetcher', err instanceof Error ? err.message : String(err))
    }
    const encoding = (res.headers.get('content-encoding') ?? '').trim().toLowerCase()
    if (encoding !== '' && encoding !== 'identity') {
      await res.body?.cancel().catch(() => undefined)
      throw new SafeFetchError('fetcher', `fetcher sent Content-Encoding ${encoding.slice(0, 40)}`)
    }
    if (res.status === 422) {
      let j: { reason?: unknown } | null = null
      try {
        const text = await readCapped(res, MAX_REFUSAL_BYTES)
        j = text ? JSON.parse(text.toString('utf8')) : null
      } catch { j = null }
      throw new SafeFetchError(typeof j?.reason === 'string' && /^[a-z0-9:-]{1,40}$/.test(j.reason) ? j.reason : 'fetch')
    }
    if (res.status !== 200) { await res.body?.cancel().catch(() => undefined); throw new SafeFetchError('fetcher', `fetcher HTTP ${res.status}`) }
    const maxBytes = options.maxBytes ?? SAFE_FETCH_MAX_BYTES
    const declared = Number(res.headers.get('content-length') ?? NaN)
    if (Number.isFinite(declared) && declared > maxBytes) { await res.body?.cancel().catch(() => undefined); throw new SafeFetchError('too-large') }
    let bytes: Buffer | null
    try { bytes = await readCapped(res, maxBytes) } catch (err) {
      throw new SafeFetchError('fetcher', err instanceof Error ? err.message : String(err))
    }
    if (!bytes) throw new SafeFetchError('too-large')
    const dec = (h: string | null) => { try { return decodeURIComponent(h ?? '') } catch { return '' } }
    return { bytes, contentType: dec(res.headers.get('x-content-type')), finalUrl: dec(res.headers.get('x-final-url')) || url }
  }
}

export type ImageFetchMode = { mode: 'fetcher'; url: string } | { mode: 'in-process' } | { mode: 'off' }

/**
 * Where the sync's image fetches run: in the isolated fetcher (`IMAGE_FETCHER_URL`), or
 * in the sync's own process only when explicitly asked (`IMAGE_FETCH_IN_PROCESS=1`,
 * for local development, where there is no fetcher). With neither, the image pass does
 * not run — a missing setting never quietly moves strangers' URLs onto the sync's networks.
 */
export function imageFetchMode(env: Record<string, string | undefined>): ImageFetchMode {
  const url = (env.IMAGE_FETCHER_URL ?? '').trim()
  if (url) return { mode: 'fetcher', url }
  if ((env.IMAGE_FETCH_IN_PROCESS ?? '').trim() === '1') return { mode: 'in-process' }
  return { mode: 'off' }
}
