import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

// GET /v1/stats/platform. TVL comes from the shared pool service (the same model
// the explorer's /liquidity page renders), so it is mocked here: this test pins
// how the stats endpoint COMPOSES the two sources, not how poolService values a
// pool, which its own tests cover.
type Row = Record<string, unknown>

function result(rows: Row[]) {
  return { json: vi.fn(async () => rows) }
}

const OMNIPOOL_TVL = 11_088_705.84
// Compositions carry the aToken legs the pools themselves supply to the money
// market — the inverse fold. asset 1001 is aDOT, 1007 aETH (ATOKEN_UNDERLYING_ID).
const leg = (assetId: number, usd: number | null) => ({ asset: { assetId }, amount: '0', usd, sharePct: null })
const POOLS_INDEX = {
  totalTvlUsd: 29_572_407.11,
  pools: [
    { kind: 'omnipool', poolId: null, name: 'Omnipool', tvlUsd: OMNIPOOL_TVL, sharePct: null, composition: [leg(1001, 2_000_000), leg(5, 1_000)], hasPegs: false },
    { kind: 'stableswap', poolId: 690, name: '2-Pool-GDOT', tvlUsd: 18_000_000, sharePct: null, composition: [leg(1001, 500_000), leg(15, 17_500_000)], hasPegs: false },
    { kind: 'stableswap', poolId: 102, name: '2-Pool', tvlUsd: 353_575.94, sharePct: null, composition: [leg(1007, 100_000)], hasPegs: false },
    // An unpriced pool contributes nothing rather than making the venue unknown —
    // so neither its aToken leg nor its share token may be folded out.
    { kind: 'stableswap', poolId: 999, name: 'dead', tvlUsd: null, sharePct: null, composition: [leg(1001, 9_000_000)], hasPegs: false },
    { kind: 'xyk', poolId: 123, name: 'HDX / DOT', tvlUsd: 130_125.33, sharePct: null, composition: [], hasPegs: false },
  ],
}
/** aDOT 2 000 000 + 500 000 and aETH 100 000, all inside priced pools. */
const POOLED_ATOKEN_USD = 2_600_000

// No getOmnipoolDetail: the Omnipool's TVL is already in the pool index, computed
// by the same rule, and calling that model would drag a whole-table history
// GROUP BY and the tag/identity caches into a process that has neither.
vi.mock('../../src/services/poolService.ts', () => ({
  initPoolService: vi.fn(),
  getPoolsIndex: vi.fn(async () => POOLS_INDEX),
}))

const ASSET_ROWS: Row[] = [
  { asset_id: 0, symbol: 'HDX', name: 'HDX', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachain_id: 0, origin_ecosystem: 'polkadot', origin_chain_id: '0', origin_asset_id: null },
]

const ANCHOR_ROW: Row = { legs: '4200', anchor: '2026-08-12 18:22:36', block_height: 9123456 }
const ANCHOR_ISO = '2026-08-12T18:22:36.000Z'

// One money-market reserve, still listed: 1 000 DOT supplied (10 decimals) at
// $0.75, plus one the reserve map has dropped, which must not reach the total.
const PRICE_ROWS: Row[] = [{ asset_id: 5, price: '0.75' }]
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
    reserve_address: '0x0000000000000000000000000000000100000005',
    market_key: 'core', atoken: '0xaa00000000000000000000000000000000000005',
    block_height: 8000000, block_timestamp: '2026-01-01 00:00:00',
    supplied: '99000000000000', debt: '0', listed: 0,
  },
]

interface Seen { query: string; params: Record<string, unknown> }

type Answer = Row[] | ((params: Record<string, unknown>) => Row[])

function fakeClient(byMarker: Record<string, Answer> = {}) {
  const seen: Seen[] = []
  const client = {
    seen,
    query: vi.fn(({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      const params = query_params ?? {}
      seen.push({ query, params })
      if (query.includes('FROM price_data.assets FINAL')) return result(ASSET_ROWS)
      if (query.includes('Bonds.TokenCreated')) return result([])
      for (const [marker, answer] of Object.entries(byMarker)) {
        if (query.includes(marker)) return result(typeof answer === 'function' ? answer(params) : answer)
      }
      throw new Error(`unexpected query: ${query.slice(0, 160)}`)
    }),
  }
  return client
}

/** Every source a full stats response reads. */
function fullClient() {
  return fakeClient({
    '-- pub:vol:anchor': [ANCHOR_ROW],
    '-- pub:vol:omnipool': [
      { scope: 'asset', asset_id: '5', volume_usd: '900.000000000000', fee_usd: '1.000000000000', protocol_fee_usd: '0.000000000000' },
      { scope: 'total', asset_id: '', volume_usd: '1500.000000000000', fee_usd: '0.000000000000', protocol_fee_usd: '0.000000000000' },
    ],
    '-- pub:vol:pool': params => (params.venue === 'stableswap'
      ? [
          { pool_key: '690', volume_usd: '250.250000000000', fee_usd: '0.100000000000' },
          { pool_key: '102', volume_usd: '10.000000000000', fee_usd: '0.004000000000' },
        ]
      : [{ pool_key: `0x${'a'.repeat(64)}`, volume_usd: '7.500000000000', fee_usd: '0.022500000000' }]),
    '-- pub:vol:xyk-pools': [],
    '-- pub:vol:routed': [
      { in_usd: '1000.000000000000', out_usd: '999.000000000000' },
      { in_usd: '500.000000000000', out_usd: '505.500000000000' },
    ],
    '-- mm:reserve-state': RESERVE_ROWS,
    'FROM price_data.prices': PRICE_ROWS,
  })
}

let stopAssets: () => void

beforeAll(async () => {
  const { loadExplorerAssets, stopExplorerAssetsRefresh } = await import('../../src/services/explorerAssets.ts')
  await loadExplorerAssets(fakeClient() as never)
  stopAssets = stopExplorerAssetsRefresh
})

afterAll(() => { stopAssets?.() })

// The money-market reader caches in services/cache.ts process-global state, and the
// asset registry is module state, so each case that reads it needs a fresh graph.
async function freshApp(client: unknown) {
  vi.resetModules()
  const assets = await import('../../src/services/explorerAssets.ts')
  await assets.loadExplorerAssets(client as never)
  const { buildPublicApp } = await import('../../src/public/app.ts')
  const app: FastifyInstance = await buildPublicApp({ client: client as never, logger: false })
  return { app, stop: assets.stopExplorerAssetsRefresh }
}

describe('GET /v1/stats/platform', () => {
  it('composes pool TVL with the 24h volume model', async () => {
    const client = fullClient()
    const { app, stop } = await freshApp(client)
    try {
      const res = await app.inject('/v1/stats/platform')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        asOf: ANCHOR_ISO,
        blockHeight: 9123456,
        tvl: {
          omnipoolUsd: '11088705.84',
          stableswapUsd: '18353575.94',
          xykUsd: '130125.33',
          // 1 000 DOT at $0.75. The delisted row's 9 900 DOT is not in it, and the
          // figure is NOT added to totalUsd, which stays the pooled sum.
          moneyMarketSupplyUsd: '750.00',
          // No pool-share collateral in this fixture's money market…
          moneyMarketFoldedUsd: '0.00',
          // …but the pools do hold aTokens, and the unpriced pool's 9 M is excluded.
          pooledATokenUsd: '2600000.00',
          totalUsd: '29572407.11',
        },
        // Both halves of the response carry the surface's 2-decimal USD shape.
        volume24h: {
          // The venue's fills, single-counted — not the sum of its per-asset rows.
          omnipoolUsd: '1500.00',
          stableswapUsd: '260.25',
          xykUsd: '7.50',
          // 1000 (in side wins) + 505.5 (out side wins)
          totalRoutedUsd: '1505.50',
        },
      })
      expect(res.headers['cache-control']).toBe('public, max-age=60')
    } finally { await app.close(); stop() }
  })

  it('reports an unsnapshotted money market as null, never as zero', async () => {
    const client = fakeClient({
      '-- pub:vol:anchor': [ANCHOR_ROW],
      '-- pub:vol:omnipool': [{ scope: 'total', asset_id: '', volume_usd: '0.000000000000', fee_usd: '0.000000000000', protocol_fee_usd: '0.000000000000' }],
      '-- pub:vol:pool': [],
      '-- pub:vol:xyk-pools': [],
      '-- pub:vol:routed': [],
      // The reserve-state view returns no rows at all while atoken_scaled_anchor
      // holds no snapshot — the one-way RPC failure the 007 header describes.
      '-- mm:reserve-state': [],
      'FROM price_data.prices': PRICE_ROWS,
    })
    const { app, stop } = await freshApp(client)
    try {
      const res = await app.inject('/v1/stats/platform')
      expect(res.json().tvl.moneyMarketSupplyUsd).toBeNull()
    } finally { await app.close(); stop() }
  })

  it('folds only pools that HAVE a TVL, in both directions', async () => {
    const { poolShareAssetIds, pooledATokenUsd } = await import('../../src/public/services/platformStats.ts')
    // The Omnipool has no share token; a stableswap pool's id IS its share asset
    // and an XYK pool's is its LP asset. Pool 999 is unpriced: it added nothing to
    // the pooled total, so nothing of it may be subtracted from the fold either —
    // the invariant is the POOL's price, not the money-market reserve's.
    expect(poolShareAssetIds(POOLS_INDEX.pools)).toEqual(new Set([690, 102, 123]))
    expect(poolShareAssetIds([{ kind: 'omnipool', poolId: null, tvlUsd: 1 }])).toEqual(new Set())

    // The inverse fold reads the same priced-pool set, so 999's 9 M aDOT is out.
    expect(pooledATokenUsd(POOLS_INDEX.pools)).toBe(POOLED_ATOKEN_USD)
    expect(pooledATokenUsd([{ kind: 'stableswap', poolId: 1, tvlUsd: null, composition: [leg(1001, 5)] }])).toBe(0)
    // A non-aToken leg is never folded.
    expect(pooledATokenUsd([{ kind: 'stableswap', poolId: 1, tvlUsd: 5, composition: [leg(5, 5)] }])).toBe(0)
  })

  it('balances the conservation equation to the published cent', async () => {
    const { tvlComponents, foldedPlatformTvl } = await import('../../src/public/services/platformStats.ts')
    const { formatUsd, decimalToScaled } = await import('../../src/public/services/accountBalances.ts')
    const reserves = [
      // Pool-share collateral: folded out (690 is a priced pool's share token).
      { assetId: 690, suppliedUsd: 4_000_000_000_000_000_000n },
      // Ordinary collateral: stays in.
      { assetId: 5, suppliedUsd: 1_000_000_000_000_000_000n },
      // The unpriced pool's share token: NOT folded, because it was never added.
      { assetId: 999, suppliedUsd: 7_000_000_000_000_000_000n },
    ]
    const components = tvlComponents(POOLS_INDEX.pools, { reserves, suppliedUsd: 12_000_000_000_000_000_000n, delistedCount: 0 } as never)
    expect(components.moneyMarketFoldedUsd).toBe('4000000.00')
    expect(components.pooledATokenUsd).toBe('2600000.00')

    // direct + custody = displayed + attributed custody, with no remainder.
    const cents = (value: string) => decimalToScaled(value, 12)
    const headline = foldedPlatformTvl(components) as bigint
    expect(cents(components.totalUsd as string) + cents(components.moneyMarketSupplyUsd as string))
      .toBe(headline + cents(components.moneyMarketFoldedUsd as string) + cents(components.pooledATokenUsd as string))
    // 29 572 407.11 + 12 000 000 − 4 000 000 − 2 600 000
    expect(formatUsd(headline)).toBe('34972407.11')

    // Null in, null out: an unknown component makes the headline unknown.
    expect(foldedPlatformTvl({ ...components, moneyMarketSupplyUsd: null })).toBeNull()
    expect(foldedPlatformTvl({ ...components, totalUsd: null })).toBeNull()
  })

  it('warns when a reserve is dropped as delisted, because nothing in a 200 would say so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const client = fullClient()
      const { app, stop } = await freshApp(client)
      try {
        await app.inject('/v1/stats/platform')
        // RESERVE_ROWS carries one row behind the map's newest generation.
        const messages = warn.mock.calls.map(args => String(args[0]))
        expect(messages.some(m => m.includes('1 money-market reserve(s) are behind') && m.includes('/lending/v1/caps'))).toBe(true)
      } finally { await app.close(); stop() }
    } finally { warn.mockRestore() }
  })

  it('reports a venue with no priced pool at all as unknown, never as zero', async () => {
    const { venueTvlUsd, sumKnownTvl } = await import('../../src/public/services/platformStats.ts')
    const pools = [
      { kind: 'stableswap', tvlUsd: null },
      { kind: 'xyk', tvlUsd: 130_125.33 },
      { kind: 'xyk', tvlUsd: null },
    ]
    // Not one stableswap pool could be priced: unknown, not zero.
    expect(venueTvlUsd(pools, 'stableswap')).toBeNull()
    // One unpriced XYK pool among priced ones contributes nothing and no null.
    expect(venueTvlUsd(pools, 'xyk')).toBe(130_125.33)
    // A venue with no pools at all really is zero.
    expect(venueTvlUsd([], 'stableswap')).toBe(0)
    // The platform total is unknown rather than short by a whole venue.
    expect(sumKnownTvl([1, null, 3])).toBeNull()
    expect(sumKnownTvl([1, 2, 3])).toBe(6)
  })
})
