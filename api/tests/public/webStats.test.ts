import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

// GET /hydration-web/v1/stats — the hydration.net homepage feed.
//
// This is a drop-in for HydraDX-api's endpoint, so what is pinned here is
// everything a base-URL swap must not change (path, the five field names, JSON
// numbers) plus the three places this indexer's definitions deliberately differ:
// netted volume, the de-duplicated TVL, and an XCM figure that goes null rather
// than being estimated.

type Row = Record<string, unknown>

function result(rows: Row[]) {
  return { json: vi.fn(async () => rows) }
}

const ASSET_ROWS: Row[] = [
  { asset_id: 0, symbol: 'HDX', name: 'HDX', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachain_id: 0, origin_ecosystem: 'polkadot', origin_chain_id: '0', origin_asset_id: null },
  { asset_id: 69, symbol: 'GDOT', name: 'GDOT', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 690, symbol: '2-Pool-GDOT', name: '2-Pool-GDOT', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
]

// The Omnipool holds $250 of aDOT (asset 1001) — the inverse fold: the pool is
// itself a money-market supplier, so that value is inside the market's total too.
const leg = (assetId: number, usd: number | null) => ({ asset: { assetId }, amount: '0', usd, sharePct: null })
const POOLS_INDEX = {
  totalTvlUsd: 15_100,
  pools: [
    { kind: 'omnipool', poolId: null, name: 'Omnipool', tvlUsd: 10_000, sharePct: null, composition: [leg(1001, 250), leg(0, 9_750)], hasPegs: false },
    { kind: 'stableswap', poolId: 690, name: '2-Pool-GDOT', tvlUsd: 5_000, sharePct: null, composition: [leg(15, 5_000)], hasPegs: false },
    { kind: 'xyk', poolId: 123, name: 'HDX / DOT', tvlUsd: 100, sharePct: null, composition: [], hasPegs: false },
  ],
}

vi.mock('../../src/services/poolService.ts', () => ({
  initPoolService: vi.fn(),
  getPoolsIndex: vi.fn(async () => POOLS_INDEX),
}))

const ANCHOR_ROW: Row = { legs: '4200', anchor: '2026-08-12 18:22:36', block_height: 9123456 }

// DOT is ordinary collateral; the 2-Pool-GDOT position is a Stableswap SHARE token
// whose value is already inside the pool index's stableswap TVL.
const RESERVE_ROWS: Row[] = [
  {
    pool_address: '0x1b02e051683b5cfac5929c25e84adb26ecf87b38',
    reserve_address: '0x0000000000000000000000000000000100000005',
    market_key: 'core', atoken: '0xaa00000000000000000000000000000000000005',
    block_height: 9123400, block_timestamp: '2026-08-12 18:20:00',
    supplied: '10000000000000', debt: '0', listed: 1,
  },
  {
    pool_address: '0x1b02e051683b5cfac5929c25e84adb26ecf87b38',
    reserve_address: '0x00000000000000000000000000000001000002b2',
    market_key: 'core', atoken: '0xaa000000000000000000000000000000000002b2',
    block_height: 9123410, block_timestamp: '2026-08-12 18:21:00',
    supplied: '200000000000000000000', debt: '0', listed: 1,
  },
]
// $0.75 DOT; GDOT at $2.00 prices the 2-Pool-GDOT share token through its alias.
const PRICE_ROWS: Row[] = [{ asset_id: 5, price: '0.75' }, { asset_id: 69, price: '2.00' }]

const XCM_VOLUME = 23_748_747.0802
/** What the wire carries: the upstream double rounded to cents, like `tvl` and `vol_30d`. */
const XCM_VOLUME_ROUNDED = 23_748_747.08

function fakeClient(overrides: Record<string, Row[]> = {}) {
  const byMarker: Record<string, Row[]> = {
    '-- pub:vol:anchor': [ANCHOR_ROW],
    '-- pub:webstats:volume': [{ total_usd: '20252129.000501492452' }],
    '-- pub:webstats:accounts': [{ accounts: '115318' }],
    '-- mm:reserve-state': RESERVE_ROWS,
    'FROM price_data.prices': PRICE_ROWS,
    // /v1/stats/platform's volume half, so the reconciliation case can read the
    // TVL components this endpoint folds from.
    '-- pub:vol:omnipool': [{ scope: 'total', asset_id: '', volume_usd: '0.000000000000', fee_usd: '0.000000000000', protocol_fee_usd: '0.000000000000' }],
    '-- pub:vol:pool': [],
    '-- pub:vol:xyk-pools': [],
    '-- pub:vol:routed': [],
    ...overrides,
  }
  const seen: { query: string; params: Record<string, unknown> }[] = []
  return {
    seen,
    query: vi.fn(({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      seen.push({ query, params: query_params ?? {} })
      if (query.includes('FROM price_data.assets FINAL')) return result(ASSET_ROWS)
      if (query.includes('Bonds.TokenCreated')) return result([])
      for (const [marker, rows] of Object.entries(byMarker)) {
        if (query.includes(marker)) return result(rows)
      }
      throw new Error(`unexpected query: ${query.slice(0, 160)}`)
    }),
  }
}

/** Ocelloids' `transfers_total` answer, in its own shape. */
function ocelloidsOk() {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      items: [{
        current: 16375,
        volumeUsd: { current: XCM_VOLUME, previous: 28_064_985.3925, diff: -4_316_238.31 },
      }],
    }),
  }))
}

/**
 * Every module this endpoint touches keeps process-global state — the response
 * cache, the asset registry, and the XCM memo that deliberately outlives one
 * request — so each case is built on a fresh module graph.
 */
async function freshApp(client: unknown, fetchImpl: unknown) {
  vi.resetModules()
  vi.stubGlobal('fetch', fetchImpl)
  const assets = await import('../../src/services/explorerAssets.ts')
  await assets.loadExplorerAssets(client as never)
  const { buildPublicApp } = await import('../../src/public/app.ts')
  const app: FastifyInstance = await buildPublicApp({ client: client as never, logger: false })
  return { app, stop: assets.stopExplorerAssetsRefresh }
}

beforeAll(() => {
  // Read at module load, so it must be set before the first dynamic import.
  process.env.EXPLORER_OCELLOIDS_URL = 'https://ocelloids.test'
  process.env.EXPLORER_OCELLOIDS_TOKEN = 'test-token'
})

afterEach(() => { vi.unstubAllGlobals() })

describe('GET /hydration-web/v1/stats', () => {
  it('serves the incumbent\'s five fields, de-duplicating pool-share collateral out of TVL', async () => {
    const client = fakeClient()
    const fetchMock = ocelloidsOk()
    const { app, stop } = await freshApp(client, fetchMock)
    try {
      const res = await app.inject('/hydration-web/v1/stats')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        // Pools 15 100 + the money market's 1 150 supplied, LESS both folds: the
        // $400 of market collateral held as 2-Pool-GDOT (its pool is already in the
        // 15 100) and the $250 of aDOT the Omnipool supplies (already in the 1 150).
        tvl: 15_600,
        vol_30d: 20_252_129,
        // Rounded to cents at the wire: the upstream reports four decimals, and
        // its two sibling USD fields are cents.
        xcm_vol_30d: XCM_VOLUME_ROUNDED,
        assets_count: ASSET_ROWS.length,
        accounts_count: 115_318,
      })
      expect(res.headers['cache-control']).toBe('public, max-age=600')

      // The XCM figure is the incumbent's own query, not an approximation of it.
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }]
      expect(url).toBe('https://ocelloids.test/query/xcm')
      expect(JSON.parse(init.body)).toEqual({
        args: { op: 'transfers_total', criteria: { timeframe: '1 months', network: 'urn:ocn:polkadot:2034' } },
      })
    } finally { await app.close(); stop() }
  })

  // The compatibility contract, held separately from the values, because the
  // values are deliberately different and the SHAPE deliberately is not. Probed
  // on the incumbent 2026-08-13 — api.hydradx.io and api.nice.hydration.cloud
  // both answered {"tvl":64967260.62509527,"vol_30d":53445446.608999826,
  // "xcm_vol_30d":22342407.0776,"assets_count":443,"accounts_count":108920}:
  // five keys in that order, three USD floats and two integer counts.
  it('carries the incumbent\'s five keys, in its order, as JSON numbers', async () => {
    const client = fakeClient()
    const { app, stop } = await freshApp(client, ocelloidsOk())
    try {
      const res = await app.inject('/hydration-web/v1/stats')
      const body = res.json() as Record<string, unknown>
      // A JS object's key order IS its wire order, so this pins the serialized
      // document, not just the field set.
      expect(Object.keys(body)).toEqual(['tvl', 'vol_30d', 'xcm_vol_30d', 'assets_count', 'accounts_count'])
      for (const key of Object.keys(body)) expect([key, typeof body[key]]).toEqual([key, 'number'])
      // Numbers, never the decimal STRINGS the /v1 surfaces carry — this is one
      // of the inherited-contract exceptions to that convention.
      expect(res.body).not.toMatch(/"(tvl|vol_30d|xcm_vol_30d|assets_count|accounts_count)":\s*"/)
      // The two counts are integers on the wire, as the incumbent's 443 and
      // 108,920 are.
      expect(Number.isInteger(body.assets_count)).toBe(true)
      expect(Number.isInteger(body.accounts_count)).toBe(true)
    } finally { await app.close(); stop() }
  })

  it('folds the 30-day netted total in SQL, by the same rule nettedTradeScaled applies per trade', async () => {
    vi.resetModules()
    const { buildWebVolumeSql } = await import('../../src/public/services/webStats.ts')
    const { nettedTradeScaled, scaledUsd } = await import('../../src/public/services/poolVolumes.ts')
    const sql = buildWebVolumeSql()
    // A 30-day window returns ~200 k trades, well past the client's row cap, so the
    // netting max cannot be applied row by row in TS as the 24h surface does.
    expect(sql).toContain('greatest(side_in, side_out)')
    // aToken wrap round-trips are not swaps, exactly as the DefiLlama facade holds.
    expect(sql).toContain('HAVING min(all_aave) = 0')
    // Same rule on both sides of the boundary.
    const larger = (a: string, b: string) => (scaledUsd(a) > scaledUsd(b) ? scaledUsd(a) : scaledUsd(b))
    expect(nettedTradeScaled('1000.5', '999')).toBe(larger('1000.5', '999'))
    expect(nettedTradeScaled('500', '505.5')).toBe(larger('500', '505.5'))
  })

  it('serves xcm_vol_30d as null when the XCM query fails, and still serves the rest', async () => {
    const client = fakeClient()
    const failing = vi.fn(async () => { throw new Error('upstream down') })
    const { app, stop } = await freshApp(client, failing)
    try {
      const res = await app.inject('/hydration-web/v1/stats')
      expect(res.statusCode).toBe(200)
      expect(res.json().xcm_vol_30d).toBeNull()
      expect(res.json().vol_30d).toBe(20_252_129)
    } finally { await app.close(); stop() }
  })

  it('treats an empty Ocelloids result as a failure, because a bad query returns 200 with no items', async () => {
    vi.resetModules()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) })))
    const { xcmVolume30d, resetXcmCache } = await import('../../src/public/services/webStats.ts')
    resetXcmCache()
    expect(await xcmVolume30d()).toBeNull()
  })

  it('covers a failing XCM query with the last known figure, but only for a bounded grace window', async () => {
    vi.resetModules()
    let answer: () => unknown = () => ({ ok: true, status: 200, json: async () => ({ items: [{ volumeUsd: { current: 12 } }] }) })
    vi.stubGlobal('fetch', vi.fn(async () => answer()))
    const { xcmVolume30d, resetXcmCache } = await import('../../src/public/services/webStats.ts')
    resetXcmCache()

    const t0 = 1_000_000_000_000
    expect(await xcmVolume30d(t0)).toBe(12)
    // Inside the 10-minute TTL the upstream is not asked again at all.
    answer = () => { throw new Error('down') }
    expect(await xcmVolume30d(t0 + 60_000)).toBe(12)
    // Past the TTL the query runs, fails, and the last figure covers for it.
    expect(await xcmVolume30d(t0 + 900_000)).toBe(12)
    // Past the grace window a dead feed becomes an explicit null.
    expect(await xcmVolume30d(t0 + 1_900_000)).toBeNull()
  })

  it('reconciles to the cent with the components /v1/stats/platform publishes', async () => {
    const client = fakeClient()
    const { app, stop } = await freshApp(client, ocelloidsOk())
    try {
      const platform = (await app.inject('/v1/stats/platform')).json().tvl
      const headline = (await app.inject('/hydration-web/v1/stats')).json().tvl
      expect(platform).toMatchObject({
        totalUsd: '15100.00',
        moneyMarketSupplyUsd: '1150.00',
        moneyMarketFoldedUsd: '400.00',
        pooledATokenUsd: '250.00',
      })
      const n = (s: string) => Math.round(Number(s) * 100)
      // direct + custody = displayed + attributed custody, no remainder.
      expect(n(platform.totalUsd) + n(platform.moneyMarketSupplyUsd))
        .toBe(Math.round(headline * 100) + n(platform.moneyMarketFoldedUsd) + n(platform.pooledATokenUsd))
    } finally { await app.close(); stop() }
  })

  it('reports an empty leg projection as a null window, not a zero one', async () => {
    const client = fakeClient({ '-- pub:vol:anchor': [{ legs: '0', anchor: '2026-08-12 18:22:36', block_height: 0 }] })
    const { app, stop } = await freshApp(client, ocelloidsOk())
    try {
      expect((await app.inject('/hydration-web/v1/stats')).json().vol_30d).toBeNull()
    } finally { await app.close(); stop() }
  })
})
