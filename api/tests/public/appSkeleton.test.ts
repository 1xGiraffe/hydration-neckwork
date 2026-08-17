import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'

// Contract tests for the public API skeleton: the three service routes, the
// asset registry, the error envelope, and the Cache-Control table. Template:
// tests/indexerRoute.test.ts — a fake ClickHouse client dispatching on SQL
// substrings, so no database is required.
type Row = Record<string, unknown>

function queryResult(rows: Row[]) {
  return { json: vi.fn(async () => rows) }
}

const ASSET_ROWS: Row[] = [
  { asset_id: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachain_id: 0, origin_ecosystem: 'polkadot', origin_chain_id: '0', origin_asset_id: null },
  { asset_id: 0, symbol: 'HDX', name: 'HDX', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
]

function fakeClient() {
  return {
    query: vi.fn(({ query }: { query: string }) => {
      if (query.includes('FROM price_data.assets FINAL')) return queryResult(ASSET_ROWS)
      if (query.includes('Bonds.TokenCreated')) return queryResult([])
      if (query.includes('FROM price_data.blocks')) {
        return queryResult([{ block_height: '100', block_timestamp: '2026-06-24 12:00:00' }])
      }
      if (query.includes('FROM price_data.raw_ingestion_state')) return queryResult([{ block_height: '105' }])
      throw new Error(`unexpected query: ${query}`)
    }),
  }
}

let app: FastifyInstance
let stopAssets: () => void

beforeAll(async () => {
  const { loadExplorerAssets, stopExplorerAssetsRefresh } = await import('../../src/services/explorerAssets.ts')
  const { buildPublicApp } = await import('../../src/public/app.ts')
  const client = fakeClient()
  // The public service loads the shared registry snapshot at boot, exactly as
  // src/public/server.ts does; /v1/assets then reads it in-process.
  await loadExplorerAssets(client as never)
  stopAssets = stopExplorerAssetsRefresh
  app = await buildPublicApp({ client: client as never, logger: false })
})

afterAll(async () => {
  await app?.close()
  stopAssets?.()
})

describe('public service routes', () => {
  it('reports health with an ISO-8601 UTC timestamp', async () => {
    const res = await app.inject('/rest/service/health')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'healthy' })
    expect(res.json().timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(res.headers['cache-control']).toBe('public, max-age=5')
  })

  it('serves the data-lake-compatible metadata probe', async () => {
    const res = await app.inject('/rest/service/metadata')
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.metadataVersion).toBe(1)
    expect(body.indexer.id).toBe('giraffe-neckwork-mainnet')
    expect(body.indexer.network).toBe('hydration')
    expect(body.indexer.master).toBe(true)
    expect(typeof body.indexer.version).toBe('string')
    expect(body.coverage.blockBounds).toEqual({ minBlockHeight: 0, maxBlockHeight: -1 })
    expect(res.headers['cache-control']).toBe('public, max-age=5')
  })

  // The metadata probe's incumbent is the Hydration data lake, which is not
  // reachable from this deployment (api.hydradx.io and api.nice.hydration.cloud
  // both 404 the path), so the reference is the shape the spec pins as normative
  // — docs/superpowers/specs/2026-08-12-public-rest-api-design.md § Service /
  // status — and it is pinned here as a serialized document because the UI's
  // provider-selection client reads it by path, not by schema.
  it('serves the metadata document in the data lake\'s own key order and types', async () => {
    const res = await app.inject('/rest/service/metadata')
    const body = res.json() as Record<string, Record<string, unknown>>
    // A JS object's key order IS its wire order, at every level.
    expect(Object.keys(body)).toEqual(['metadataVersion', 'indexer', 'coverage'])
    expect(Object.keys(body.indexer)).toEqual(['id', 'version', 'network', 'master'])
    expect(Object.keys(body.coverage)).toEqual(['blockBounds'])
    expect(Object.keys(body.coverage.blockBounds as object)).toEqual(['minBlockHeight', 'maxBlockHeight'])
    expect(Object.entries(body.indexer).map(([k, v]) => [k, typeof v])).toEqual([
      ['id', 'string'], ['version', 'string'], ['network', 'string'], ['master', 'boolean'],
    ])
    expect(typeof body.metadataVersion).toBe('number')
    // Both bounds are integer numbers, not strings: -1 is the lake's "no upper
    // bound, the indexer follows the head" sentinel, so a consumer comparing it
    // numerically must not receive "-1".
    for (const [key, value] of Object.entries(body.coverage.blockBounds as object)) {
      expect([key, typeof value, Number.isInteger(value)]).toEqual([key, 'number', true])
    }
    expect(res.body).not.toMatch(/"(metadataVersion|minBlockHeight|maxBlockHeight)":\s*"/)
  })

  it('reports indexer status from ClickHouse with an ISO timestamp and no RPC', async () => {
    const res = await app.inject('/v1/status')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      blockHeight: 100,
      // ClickHouse hands back 'YYYY-MM-DD hh:mm:ss'; the wire contract is ISO-8601 UTC.
      blockTimestamp: '2026-06-24T12:00:00.000Z',
      chainBlockHeight: 105,
      blocksBehindHead: 5,
    })
    expect(typeof res.json().lagSeconds).toBe('number')
    expect(res.headers['cache-control']).toBe('public, max-age=3')
  })
})

describe('public assets route', () => {
  it('serves the registry snapshot, asset-id ordered, with string ids', async () => {
    const res = await app.inject('/v1/assets')
    expect(res.statusCode).toBe(200)
    const { items } = res.json()
    expect(items).toEqual([
      { id: '0', symbol: 'HDX', name: null, decimals: 12, assetType: null, origin: null },
      {
        id: '5',
        symbol: 'DOT',
        name: 'Polkadot',
        decimals: 10,
        assetType: null,
        origin: { ecosystem: 'polkadot', chainId: '0', assetId: null },
      },
    ])
    expect(res.headers['cache-control']).toBe('public, max-age=300')
  })
})

describe('public error and cache defaults', () => {
  it('answers an unknown route with the error envelope', async () => {
    const res = await app.inject('/nope')
    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.error.code).toBe('not_found')
    expect(typeof body.error.message).toBe('string')
  })

  it('never leaves a response cacheable by accident', async () => {
    // A path with no rule in the table (here: a 404) must be no-store, so a new
    // route ships uncached rather than silently inheriting someone else's TTL.
    const missing = await app.inject('/nope')
    expect(missing.headers['cache-control']).toBe('no-store')
  })

  it('scopes every cache rule to the paths that are actually registered', async () => {
    const { PUBLIC_CACHE_CONTROL } = await import('../../src/public/cacheControl.ts')
    const maxAge = (path: string): number | null =>
      PUBLIC_CACHE_CONTROL.find(([pattern]) => pattern.test(path))?.[1] ?? null

    // The registered trade and DCA routes carry their declared freshness…
    for (const path of ['/v1/trades', '/v1/trades/routed', '/v1/dca/schedules',
      '/v1/dca/schedules/count', '/v1/dca/schedules/42/executions']) {
      expect([path, maxAge(path)]).toEqual([path, 3])
    }
    // …and a neighbouring path that does not exist yet inherits nothing. An
    // unanchored `/v1/trades` prefix would have handed a later /v1/trades-export
    // a 3 s shared-cache TTL it never declared.
    for (const path of ['/v1/trades-export', '/v1/trades/routed/csv', '/v1/dca',
      '/v1/dca/schedules-export', '/v1/dca/schedules/42', '/v1/dca/schedules/42/executions/7']) {
      expect([path, maxAge(path)]).toEqual([path, null])
    }
    // /proxy/* has no entry by design: those responses are cached in-process per
    // upstream and must never enter the shared cache.
    expect(maxAge('/proxy/defillama/pools')).toBeNull()
  })

  it('revalidates with a strong ETag instead of re-sending the body', async () => {
    // The sidecar's `proxy_cache_revalidate on` (public-nginx/nginx.conf) and
    // browsers both need a validator, or an expired entry costs a full transfer.
    const first = await app.inject('/v1/assets')
    const validator = first.headers.etag
    expect(validator).toMatch(/^"[^"]+"$/) // strong, not W/"…"

    const revalidated = await app.inject({ url: '/v1/assets', headers: { 'if-none-match': String(validator) } })
    expect(revalidated.statusCode).toBe(304)
    expect(revalidated.rawPayload.length).toBe(0)
    // A 304 is the cache entry being refreshed, so it must carry the route's own
    // freshness — not the no-store default, which would discard the body the
    // client just confirmed is current.
    expect(revalidated.headers['cache-control']).toBe('public, max-age=300')

    const stale = await app.inject({ url: '/v1/assets', headers: { 'if-none-match': '"not-the-current-body"' } })
    expect(stale.statusCode).toBe(200)
  })

  it('keeps one validator across content encodings', async () => {
    // The ETag hashes the uncompressed representation, and @fastify/compress adds
    // `Vary: Accept-Encoding`, so a shared cache never serves gzip bytes to an
    // identity client despite the shared validator — and a gzip client can
    // revalidate against it.
    // /openapi.json rather than the two-asset fixture: compress has a 1 kB
    // threshold, so only a realistically sized payload exercises this at all.
    const identity = await app.inject('/openapi.json')
    const gzipped = await app.inject({ url: '/openapi.json', headers: { 'accept-encoding': 'gzip' } })
    expect(gzipped.headers['content-encoding']).toBe('gzip')
    expect(gzipped.headers.vary).toContain('accept-encoding')
    expect(gzipped.headers.etag).toBe(identity.headers.etag)

    const revalidated = await app.inject({
      url: '/openapi.json',
      headers: { 'if-none-match': String(identity.headers.etag), 'accept-encoding': 'gzip' },
    })
    expect(revalidated.statusCode).toBe(304)
    expect(revalidated.headers['cache-control']).toBe('public, max-age=60')
  })

  it('publishes the OpenAPI document', async () => {
    const res = await app.inject('/openapi.json')
    expect(res.statusCode).toBe(200)
    expect(res.json().info.title).toBe('Hydration Public API')
  })

  it('labels caller errors as caller errors and hides internal ones', async () => {
    const { PUBLIC_ROUTE_PLUGINS, buildPublicApp } = await import('../../src/public/app.ts')
    const failing: FastifyPluginAsync<{ client: never }> = async fastify => {
      fastify.get('/v1/fixture/unsupported', async () => {
        throw Object.assign(new Error('unsupported media type'), { statusCode: 415 })
      })
      fastify.get('/v1/fixture/broken', async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.5:8123')
      })
    }
    PUBLIC_ROUTE_PLUGINS.push(failing as never)
    let probe: FastifyInstance | undefined
    try {
      probe = await buildPublicApp({ client: fakeClient() as never, logger: false })
      // Any 4xx other than 404/429 is still the caller's problem, so it must not
      // be reported as an internal fault.
      const caller = await probe.inject('/v1/fixture/unsupported')
      expect(caller.statusCode).toBe(415)
      expect(caller.json()).toEqual({ error: { code: 'bad_request', message: 'unsupported media type' } })

      // A 5xx says nothing about internals — the detail belongs in the log only.
      const internal = await probe.inject('/v1/fixture/broken')
      expect(internal.statusCode).toBe(500)
      expect(internal.json()).toEqual({ error: { code: 'internal', message: 'internal error' } })
      expect(internal.body).not.toContain('ECONNREFUSED')
      expect(internal.headers['cache-control']).toBe('no-store')
    } finally {
      PUBLIC_ROUTE_PLUGINS.pop()
      await probe?.close()
    }
  })
})
