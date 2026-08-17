import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The public API takes its BATCH keys in the query string, so its documented
// maxima are request-line lengths at the edge, not just app-level caps. Three
// independent limits sit in front of the route, each with its own silent failure
// mode, and none of them is expressible in the app's own schemas:
//
//  * nginx `large_client_header_buffers` — the request LINE must fit in one
//    buffer, or nginx answers 414 before the app sees it.
//  * nginx `proxy_buffer_size` — holds the cache key ($request_uri) AND the
//    upstream response header block in ONE buffer. Too small and the request
//    either 502s ("upstream sent too big header") or silently leaves the shared
//    cache ("not enough for cache key").
//  * Node's `--max-http-header-size` — a bare 431 from the runtime, with none of
//    the API's error envelope.
//
// Measured on the live edge before these were raised: the 51-account request
// that must be a typed 400 was a deterministic 502, the documented 50-account
// maximum sat ~66 bytes below that cliff, and a `?pools=` list 414'd at ~160 ids
// and 431'd at ~250. This test pins the arithmetic so a config edit cannot walk
// any of them back under a documented maximum.

const nginxConf = readFileSync(new URL('../../../public-nginx/nginx.conf', import.meta.url), 'utf8')
const compose = readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8')

/** `8k` / `40k` / `32768` → bytes. */
function sizeToBytes(value: string): number {
  const m = /^(\d+)([kKmM]?)$/.exec(value.trim())
  if (!m) throw new Error(`not an nginx size: ${value}`)
  const unit = m[2].toLowerCase()
  return Number(m[1]) * (unit === 'k' ? 1024 : unit === 'm' ? 1024 * 1024 : 1)
}

function directive(conf: string, name: string): string[] {
  return [...conf.matchAll(new RegExp(`^\\s*${name}\\s+([^;]+);`, 'gm'))].map(m => m[1])
}

/** A hex account id plus its separating comma — accounts and XYK pool ids alike. */
const ID_BYTES = '0x'.length + 64 + ','.length
/** The batch maximum `/v1/accounts/balances` documents (routes/accounts.ts). */
const MAX_BALANCE_ACCOUNTS = 50
/** The `?pools=` list length the XYK volumes route must carry end to end: the whole venue (measured 289 pools) with room. */
const MIN_POOL_IDS = 300

describe('public edge request-size limits', () => {
  it('lets the whole request line of a documented batch through nginx', () => {
    const buffers = directive(nginxConf, 'large_client_header_buffers')
    expect(buffers).toHaveLength(1)
    const [count, size] = buffers[0].split(/\s+/)
    expect(Number(count)).toBeGreaterThanOrEqual(4)
    // The request line must fit in ONE buffer, so the pool list — the longest
    // supported query — is what sizes it.
    expect(sizeToBytes(size)).toBeGreaterThan(MIN_POOL_IDS * ID_BYTES)
  })

  it('sizes the cache-key buffer above the documented account batch, with header room', () => {
    // `proxy_buffer_size` in `location /`: the general case, whose largest
    // cache key is the 50-account batch.
    const sizes = directive(nginxConf, 'proxy_buffer_size').map(sizeToBytes)
    expect(sizes.length).toBeGreaterThanOrEqual(2)
    const general = Math.min(...sizes)
    const accountsKey = '/v1/accounts/balances?accounts='.length + MAX_BALANCE_ACCOUNTS * ID_BYTES
    // 2 kB of headroom for the response's own header block (ETag, Cache-Control,
    // CORS, the cache entry's own header) — the margin whose absence turned the
    // 51-account 400 into a 502.
    expect(general).toBeGreaterThan(accountsKey + 2048)
    // The pool-list route's own location raises it further, because its key alone
    // is larger than the general buffer.
    const poolsKey = '/v1/pools/xyk/volumes?pools='.length + MIN_POOL_IDS * ID_BYTES
    expect(Math.max(...sizes)).toBeGreaterThan(poolsKey)
    // Every body buffer is at least as large as the header buffer it accompanies,
    // so nginx's busy-buffer arithmetic stays coherent.
    for (const bufs of directive(nginxConf, 'proxy_buffers')) {
      const [, size] = bufs.split(/\s+/)
      expect(sizeToBytes(size)).toBeGreaterThanOrEqual(Math.min(...sizes))
    }
  })

  it('raises the api-public process header limit, and only that service', () => {
    const services = compose.split(/\n(?=\s{2}[a-z0-9-]+:\n)/)
    const apiPublic = services.find(s => /^\s{2}api-public:/m.test(s))
    expect(apiPublic).toBeDefined()
    const limit = /--max-http-header-size=(\d+)/.exec(apiPublic!)
    expect(limit, 'api-public must raise Node\'s 16 kB header limit').not.toBeNull()
    expect(Number(limit![1])).toBeGreaterThan(MIN_POOL_IDS * ID_BYTES)
    // The explorer API takes no such list, so it keeps the default.
    const explorerApi = services.find(s => /^\s{2}api:/m.test(s))
    expect(explorerApi).toBeDefined()
    expect(explorerApi).not.toContain('max-http-header-size')
  })
})
