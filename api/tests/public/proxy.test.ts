import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { ClickHouseClient } from '../../src/db/client.ts'
import { buildPublicApp } from '../../src/public/app.ts'
import {
  PROXY_UPSTREAMS,
  UPSTREAM_TIMEOUT_MS,
  proxyTargetUrl,
  proxyUpstream,
} from '../../src/public/services/proxyUpstreams.ts'

// The /proxy/* passthrough is host compatibility for the data lake's proxy
// handlers (indexers/liquidity-pools/src/apiSupport/api/rest/proxyApiHandlers/):
// the same paths must reach the same upstreams, so the mapping table below is the
// contract. Everything else here pins the two properties the data-lake handlers
// only got half right: an allow-list that cannot be walked out of, and a cache
// that never holds a failure.
let app: FastifyInstance

function fakeClient() {
  return { query: vi.fn(() => { throw new Error('the proxy must not touch ClickHouse') }) } as unknown as ClickHouseClient
}

function upstreamReply(status: number, body: string, contentType: string | null = 'application/json') {
  return {
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  }
}

function stubFetch(...replies: Array<ReturnType<typeof upstreamReply> | Error>) {
  // The parameters are declared so `mock.calls[n]` is typed: this suite asserts
  // the exact upstream URL and the exact request init on nearly every case.
  const mock = vi.fn(async (_url: string, _init: unknown) => {
    const next = replies.length > 1 ? replies.shift()! : replies[0]
    if (next instanceof Error) throw next
    return next
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

// A distinct id per case, so no two tests share a cache key (the TTL cache in
// src/services/cache.ts is process-global).
let seq = 0
function uuid(): string {
  seq += 1
  return `747c1d2a-c668-4682-b9f9-${String(seq).padStart(12, '0')}`
}

beforeAll(async () => {
  app = await buildPublicApp({ client: fakeClient(), logger: false })
  await app.ready()
})

afterAll(async () => {
  await app?.close()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('proxy upstream mapping', () => {
  // Copied from the data-lake clone, handler by handler. A change here is a
  // change to what a data-lake-compatible consumer reaches.
  const MAPPING: Array<[string, string, string]> = [
    ['defillama', 'yields/chart/747c1d2a-c668-4682-b9f9-296708a3dd90', 'https://yields.llama.fi/chart/747c1d2a-c668-4682-b9f9-296708a3dd90'],
    ['defillama', 'api/v2/historicalChainTvl/HydraDX', 'https://api.llama.fi/v2/historicalChainTvl/HydraDX'],
    ['defillama', 'api/summary/dexs/hydration-dex', 'https://api.llama.fi/summary/dexs/hydration-dex'],
    ['kamino', 'yields/8bUpuHnfNaZoNMuP8gLxLXYnG8jsHXrsUpwbxPVwEg9v/history', 'https://api.kamino.finance/yields/8bUpuHnfNaZoNMuP8gLxLXYnG8jsHXrsUpwbxPVwEg9v/history'],
    ['subsquare', 'users/0x1234abcd/referenda/votes', 'https://hydration-api.subsquare.io/users/0x1234abcd/referenda/votes'],
    ['subsquare', 'gov2/referendums', 'https://hydration-api.subsquare.io/gov2/referendums'],
  ]

  it.each(MAPPING)('maps /proxy/%s/%s to its data-lake upstream', (name, path, expected) => {
    const upstream = proxyUpstream(name)!
    expect(upstream).toBeDefined()
    expect(proxyTargetUrl(upstream, path, '')).toBe(expected)
  })

  const REJECTED: Array<[string, string]> = [
    // Off the allow-list entirely.
    ['defillama', 'evil'],
    // Right shape, wrong value: the data lake pins the chain and the dex.
    ['defillama', 'api/v2/historicalChainTvl/Ethereum'],
    ['defillama', 'api/summary/dexs/uniswap'],
    // Only the history endpoint is exposed, not every kamino yields route.
    ['kamino', 'yields/8bUpuHnf/balances'],
    // The address segment may not carry a path of its own.
    ['subsquare', 'users/0x12/referenda/votes/extra'],
    // Traversal, absolute-URL and host-injection attempts.
    ['defillama', 'yields/chart/../../v2/protocols'],
    ['subsquare', 'gov2/referendums/../../../users/x'],
    ['kamino', 'yields/x@evil.example/history'],
  ]

  it.each(REJECTED)('refuses /proxy/%s/%s', (name, path) => {
    expect(proxyTargetUrl(proxyUpstream(name)!, path, '')).toBeNull()
  })

  it('forwards the query string and nothing that could rewrite the target', () => {
    const defillama = proxyUpstream('defillama')!
    expect(proxyTargetUrl(defillama, 'api/summary/dexs/hydration-dex', 'excludeTotalDataChart=true'))
      .toBe('https://api.llama.fi/summary/dexs/hydration-dex?excludeTotalDataChart=true')
    // A '#' in the query cannot open a fragment that hides the real path.
    expect(proxyTargetUrl(defillama, 'api/summary/dexs/hydration-dex', 'a=1#@evil.example/'))
      .toBe('https://api.llama.fi/summary/dexs/hydration-dex?a=1')
  })

  it('fills every base template placeholder from its allow rule', () => {
    // The table is only readable as a contract while each rule's capture groups
    // and its upstream's template agree; a mismatch would silently produce a URL
    // with a literal '{2}' in it.
    for (const upstream of PROXY_UPSTREAMS) {
      const placeholders = [...upstream.base.matchAll(/\{(\d+)\}/g)].map(m => Number(m[1]))
      expect(placeholders.length, `${upstream.name} base has no placeholder`).toBeGreaterThan(0)
      expect(placeholders, `${upstream.name} placeholders are not 1..n`).toEqual(
        Array.from({ length: placeholders.length }, (_, i) => i + 1),
      )
      for (const rule of upstream.allow) {
        // (?:…) groups do not count; every capture group must feed a placeholder.
        const groups = new RegExp(`${rule.source}|`).exec('')!.length - 1
        expect(groups, `${upstream.name} rule ${rule} captures ${groups} group(s)`).toBe(placeholders.length)
      }
      expect(upstream.ttlMs).toBeGreaterThan(0)
    }
  })

  it('declares the TTLs the spec fixed', () => {
    expect(proxyUpstream('defillama')!.ttlMs).toBe(600_000)
    expect(proxyUpstream('kamino')!.ttlMs).toBe(600_000)
    expect(proxyUpstream('subsquare')!.ttlMs).toBe(60_000)
  })
})

describe('proxy passthrough route', () => {
  it('passes an allow-listed response through with its content type, uncached by any shared cache', async () => {
    const id = uuid()
    const fetchMock = stubFetch(upstreamReply(200, '{"data":[{"apy":4.2}]}', 'application/json; charset=utf-8'))
    const res = await app.inject(`/proxy/defillama/yields/chart/${id}`)
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('{"data":[{"apy":4.2}]}')
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8')
    // /proxy responses are cached in-process, never in the nginx micro-cache.
    expect(res.headers['cache-control']).toBe('no-store')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(`https://yields.llama.fi/chart/${id}`)
  })

  it('serves a second identical request from the cache', async () => {
    const id = uuid()
    const fetchMock = stubFetch(upstreamReply(200, '{"data":1}'))
    const first = await app.inject(`/proxy/defillama/yields/chart/${id}`)
    const second = await app.inject(`/proxy/defillama/yields/chart/${id}`)
    expect(first.body).toBe('{"data":1}')
    expect(second.body).toBe('{"data":1}')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keys the cache on the query string', async () => {
    const id = uuid()
    const fetchMock = stubFetch(upstreamReply(200, '{"data":2}'))
    await app.inject(`/proxy/defillama/yields/chart/${id}`)
    await app.inject(`/proxy/defillama/yields/chart/${id}?span=30`)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toBe(`https://yields.llama.fi/chart/${id}?span=30`)
  })

  it('answers a path off the allow-list with 404 and never calls the upstream', async () => {
    const fetchMock = stubFetch(upstreamReply(200, 'never'))
    const res = await app.inject('/proxy/defillama/evil')
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('not_found')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers an unknown upstream with 404', async () => {
    const fetchMock = stubFetch(upstreamReply(200, 'never'))
    const res = await app.inject('/proxy/nope/x')
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('not_found')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports an upstream 5xx as 502 and never caches it', async () => {
    const id = uuid()
    const fetchMock = stubFetch(upstreamReply(500, 'upstream exploded', 'text/plain'))
    for (let i = 0; i < 3; i += 1) {
      const res = await app.inject(`/proxy/defillama/yields/chart/${id}`)
      expect(res.statusCode).toBe(502)
      expect(res.json().error.code).toBe('upstream_error')
      // The upstream's own body is not a public contract.
      expect(res.body).not.toContain('exploded')
    }
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('reports a transport failure as 502 and never caches it', async () => {
    const id = uuid()
    const fetchMock = stubFetch(new Error('fetch failed'))
    for (let i = 0; i < 2; i += 1) {
      const res = await app.inject(`/proxy/defillama/yields/chart/${id}`)
      expect(res.statusCode).toBe(502)
      expect(res.json().error.code).toBe('upstream_error')
    }
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('passes an upstream 4xx through unchanged and never caches it', async () => {
    // A 404 for an unknown pool id is the caller's answer, not our fault — but it
    // is still a failure, so the next request re-asks.
    const id = uuid()
    const fetchMock = stubFetch(upstreamReply(404, '{"message":"not found"}'))
    const first = await app.inject(`/proxy/defillama/yields/chart/${id}`)
    expect(first.statusCode).toBe(404)
    expect(first.body).toBe('{"message":"not found"}')
    await app.inject(`/proxy/defillama/yields/chart/${id}`)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('never re-labels an upstream body as HTML', async () => {
    // An upstream serving an HTML error page must not become a document rendered
    // from this origin. The body still passes through, as text.
    const id = uuid()
    stubFetch(upstreamReply(200, '<script>alert(1)</script>', 'text/html; charset=utf-8'))
    const res = await app.inject(`/proxy/defillama/yields/chart/${id}`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(res.body).toBe('<script>alert(1)</script>')
  })

  it('keeps a JSON content type verbatim, parameters and vendor suffix included', async () => {
    const id = uuid()
    stubFetch(upstreamReply(200, '{}', 'application/vnd.api+json;charset=UTF-8'))
    const res = await app.inject(`/proxy/defillama/yields/chart/${id}`)
    expect(res.headers['content-type']).toBe('application/vnd.api+json;charset=UTF-8')
  })

  it('sends no client cookies, credentials or other headers upstream', async () => {
    const id = uuid()
    const fetchMock = stubFetch(upstreamReply(200, '{}'))
    await app.inject({
      url: `/proxy/defillama/yields/chart/${id}`,
      headers: { cookie: 'session=secret', authorization: 'Bearer secret', 'x-api-key': 'secret', host: 'evil.example' },
    })
    const headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers
    const names = Object.keys(headers).map(h => h.toLowerCase())
    expect(names).not.toContain('cookie')
    expect(names).not.toContain('authorization')
    expect(names).not.toContain('x-api-key')
    expect(names).not.toContain('host')
    expect(JSON.stringify(headers)).not.toContain('secret')
  })

  it('bounds every upstream call with a timeout', async () => {
    const id = uuid()
    const fetchMock = stubFetch(upstreamReply(200, '{}'))
    await app.inject(`/proxy/defillama/yields/chart/${id}`)
    const init = fetchMock.mock.calls[0][1] as { signal?: unknown; method?: string }
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.method).toBe('GET')
    expect(UPSTREAM_TIMEOUT_MS).toBe(10_000)
  })
})

describe('proxy method surface', () => {
  // The passthrough is read-only: the whole surface is GET, no route accepts a
  // body, and nothing a caller could POST reaches a third party.
  it('registers no write method on any upstream', async () => {
    const fetchMock = stubFetch(upstreamReply(200, '{"ok":1}'))
    for (const upstream of PROXY_UPSTREAMS) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        const res = await app.inject({ method, url: `/proxy/${upstream.name}/anything` })
        expect(res.statusCode, `${method} /proxy/${upstream.name}/* is routed`).toBe(404)
      }
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('proxy documentation', () => {
  it('documents every proxy route with a 200 response', async () => {
    const doc = (await app.inject('/openapi.json')).json()
    const paths = Object.keys(doc.paths ?? {}).filter(p => p.startsWith('/proxy/'))
    expect(paths.length).toBe(PROXY_UPSTREAMS.length)
    for (const upstream of PROXY_UPSTREAMS) {
      const path = paths.find(p => p.includes(`/proxy/${upstream.name}/`))
      expect(path, `${upstream.name} is undocumented`).toBeTruthy()
      const operations = doc.paths[path!]
      // GET is the whole surface, so the document must show exactly that.
      expect(Object.keys(operations), `${path} documents a non-GET method`).toEqual(['get'])
      expect(operations.get.responses['200']).toBeTruthy()
      expect(operations.get.description).toBeTruthy()
    }
  })
})
