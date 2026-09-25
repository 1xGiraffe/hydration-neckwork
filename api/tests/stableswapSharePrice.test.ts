import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  stableswapSharePriceScaled, stableswapSharePrices, stableswapShareLegs, withStableswapSharePrices, xykReserveAssets,
  type StableswapSharePool,
} from '../src/services/lpMath.ts'

const USD = 10n ** 12n
const E18 = 10n ** 18n

describe('stableswapSharePriceScaled', () => {
  it('is the pro-rata redeemable value of one whole share, across leg decimals', () => {
    // 2 of an 18-dec asset at $1.50 + 3 of a 6-dec asset at $1.00 = $6.00, over 5 shares.
    const pool: StableswapSharePool = { poolId: 900, assetIds: [1, 2], reserves: [2n * E18, 3_000_000n], totalIssuance: 5n * E18 }
    expect(stableswapSharePriceScaled(pool, [1_500_000_000_000n, USD], [18, 6], 18)).toBe(1_200_000_000_000n)
  })

  it('matches valuing the legs stableswapShareLegs redeems, up to their per-leg floors', () => {
    // 2-Pool-apyUSD as measured: apyUSD at $1.386 is 21% of the pool, HOLLAR the rest.
    const pool: StableswapSharePool = {
      poolId: 146, assetIds: [46, 222],
      reserves: [196_538_082_793_764_763_985_257n, 732_027_163_074_036_108_817_509n],
      totalIssuance: 996_518_091_589_165_548_171_502n,
    }
    const prices = [1_386_020_395_486n, 998_941_897_743n]
    const price = stableswapSharePriceScaled(pool, prices, [18, 18], 18)!
    const legs = stableswapShareLegs(E18, pool.reserves, pool.totalIssuance)
    const viaLegs = legs.reduce((sum, amount, i) => sum + (amount * prices[i]) / E18, 0n)
    expect(price - viaLegs).toBeGreaterThanOrEqual(0n)
    expect(price - viaLegs).toBeLessThanOrEqual(2n)
    // ≈ $1.007 per share — not apyUSD's $1.386.
    expect(price / 10n ** 9n).toBe(1_007n)
  })

  it('is unpriced when any leg is unpriced, and for a pool with no issuance', () => {
    const pool: StableswapSharePool = { poolId: 900, assetIds: [1, 2], reserves: [E18, E18], totalIssuance: E18 }
    expect(stableswapSharePriceScaled(pool, [USD, null], [18, 18], 18)).toBeNull()
    expect(stableswapSharePriceScaled(pool, [USD, 0n], [18, 18], 18)).toBeNull()
    expect(stableswapSharePriceScaled(pool, [USD, USD], [18, null], 18)).toBeNull()
    expect(stableswapSharePriceScaled({ ...pool, totalIssuance: 0n }, [USD, USD], [18, 18], 18)).toBeNull()
  })
})

describe('stableswapSharePrices / withStableswapSharePrices', () => {
  const decimals = () => 18
  const pools: StableswapSharePool[] = [
    { poolId: 900, assetIds: [1, 2], reserves: [E18, 3n * E18], totalIssuance: 2n * E18 },
    // A pool holding another pool's share: priced through the derivation, not a feed.
    { poolId: 901, assetIds: [900, 1], reserves: [E18, E18], totalIssuance: E18 },
    // One leg without a price.
    { poolId: 902, assetIds: [1, 3], reserves: [E18, E18], totalIssuance: E18 },
  ]
  const feeds = new Map<number, bigint>([[1, 2n * USD], [2, USD]])

  it('prices a share leg by the same derivation, recursively, and leaves a partly unpriced pool null', () => {
    const out = stableswapSharePrices(pools, id => feeds.get(id), decimals, id => id >= 900)
    expect(out.get(900)).toBe(2_500_000_000_000n) // ($2 + $3) / 2
    expect(out.get(901)).toBe(4_500_000_000_000n) // $2.50 + $2.00
    expect(out.get(902)).toBeNull()
  })

  it('never lets a cycle recurse forever', () => {
    const cyclic: StableswapSharePool[] = [
      { poolId: 900, assetIds: [901], reserves: [E18], totalIssuance: E18 },
      { poolId: 901, assetIds: [900], reserves: [E18], totalIssuance: E18 },
    ]
    const out = stableswapSharePrices(cyclic, () => USD, decimals, id => id >= 900)
    expect(out.get(900)).toBeNull()
    expect(out.get(901)).toBeNull()
  })

  it('replaces a share token\'s own feed, drops a share that cannot be priced, and keeps every other entry', () => {
    // 900 has a feed of its own and 902 had one too (or an alias's): both are replaced.
    const withFeeds = new Map<number, bigint>([...feeds, [900, 99n * USD], [902, 7n * USD], [903, 5n * USD]])
    const out = withStableswapSharePrices(withFeeds, pools, id => withFeeds.get(id), decimals, id => id >= 900)
    expect(out.get(900)).toBe(2_500_000_000_000n)
    expect(out.get(901)).toBe(4_500_000_000_000n)
    expect(out.has(902)).toBe(false)
    // A share token the pool state does not hold is unpriced as well.
    expect(out.has(903)).toBe(false)
    expect(out.get(1)).toBe(2n * USD)
    expect(out.get(2)).toBe(USD)
    expect(withFeeds.get(900)).toBe(99n * USD) // input untouched
  })

  it('states every share unpriced when the pool state could not be read', () => {
    const withFeeds = new Map<number, bigint>([...feeds, [900, 99n * USD]])
    const out = withStableswapSharePrices(withFeeds, null, id => withFeeds.get(id), decimals, id => id >= 900)
    expect(out.has(900)).toBe(false)
    expect(out.get(1)).toBe(2n * USD)
  })
})

describe('currentPriceAssetId', () => {
  it('stops the alias walk at a share token, where priceAssetId walks on to the underlying', async () => {
    const assets = await import('../src/services/explorerAssets.ts')
    // 2-Pool-apyUSD: its own id for current value, apyUSD for candles.
    expect(assets.currentPriceAssetId(146)).toBe(146)
    expect(assets.priceAssetId(146)).toBe(46)
    // An aToken over a share token values through the share (a3-Pool → 3-Pool).
    assets.registerStableswapShareToken(103)
    expect(assets.currentPriceAssetId(1008)).toBe(103)
    // Ordinary aliases are unchanged: aDOT → DOT, GIGAHDX → stHDX → HDX.
    expect(assets.currentPriceAssetId(1001)).toBe(5)
    expect(assets.currentPriceAssetId(67)).toBe(0)
  })
})

describe('currentPriceOf — the one current lookup rule', () => {
  it('takes the asset\'s own entry first, else its currentPriceAssetId alias, and never walks a share on', async () => {
    const assets = await import('../src/services/explorerAssets.ts')
    assets.registerStableswapShareToken(103)
    const prices = new Map<number, string>([[5, 'DOT'], [103, '3-Pool share'], [1001, 'aDOT own feed']])
    // Own entry wins over the alias (an aToken with its own feed, e.g. GDOT over 2-Pool-GDOT).
    expect(assets.currentPriceOf(prices, 1001)).toBe('aDOT own feed')
    // No own entry: the alias — for an aToken over a share, the share's derived value.
    expect(assets.currentPriceOf(prices, 1008)).toBe('3-Pool share')
    expect(assets.currentPriceOf(new Map([[5, 'DOT']]), 1001)).toBe('DOT')
    // A share without an entry is unpriced, never its underlying (146 → apyUSD 46).
    expect(assets.currentPriceOf(new Map([[46, 'apyUSD']]), 146)).toBeUndefined()
  })

  it('is what the public API, the explorer and the Data API look prices up with', async () => {
    const { readFileSync } = await import('node:fs')
    const src = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')
    expect(src('public/services/accountBalances.ts')).toMatch(/export function priceFor\(prices: PriceMap, assetId: number\): bigint \{\n\s+return currentPriceOf\(prices, assetId\) \?\? 0n/)
    expect(src('services/explorerService.ts')).toMatch(/const u = currentPriceOf\(m, id\)\n\s+if \(u\) m\.set\(id, u\)/)
    expect(src('data/services/accountsCore.ts')).toContain('const price = currentPriceOf(prices, assetId)')
    // No surface restates the rule by hand.
    for (const path of ['public/services/accountBalances.ts', 'services/explorerService.ts', 'data/services/accountsCore.ts', 'data/services/assetsData.ts']) {
      expect(src(path)).not.toMatch(/\.get\(currentPriceAssetId\(/)
    }
  })
})

describe('currentStableswapShareState — the snapshot age bound', () => {
  const NOW = 1_800_000_000_000
  const row = (ts: number) => ({ ts, ss: JSON.stringify({ pools: [{ pool_id: 146, assets: [46, 222], reserves: ['1', '2'], amplification: '100', fee: 400, total_issuance: '3' }] }) })
  const clientOf = (rows: () => Row[]) => ({ query: vi.fn(async () => { const r = rows(); return result(r) }) })

  it('serves the pools with their block timestamp inside an hour, and none past it', async () => {
    vi.resetModules()
    const mod = await import('../src/services/stableswapSharePools.ts')
    const client = clientOf(() => [row(NOW / 1000 - 3_600)])
    expect(await mod.currentStableswapShareState(client as never, NOW)).toMatchObject({ blockTimestamp: NOW / 1000 - 3_600, pools: [{ poolId: 146, totalIssuance: 3n }] })
    expect(await mod.currentStableswapShareState(client as never, NOW + 1_000)).toBeNull()
  })

  it('ages the last good read out too: a failing read never keeps an old state current', async () => {
    vi.resetModules()
    const mod = await import('../src/services/stableswapSharePools.ts')
    const cache = await import('../src/services/cache.ts')
    let fail = false
    const client = { query: vi.fn(async () => { if (fail) throw new Error('down'); return result([row(NOW / 1000 - 60)]) }) }
    expect(await mod.currentStableswapShareState(client as never, NOW)).not.toBeNull()
    fail = true
    cache.resetCacheForTests()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await mod.currentStableswapShareState(client as never, NOW + 60_000)).not.toBeNull()
      expect(await mod.currentStableswapShareState(client as never, NOW + 3_600_000)).toBeNull()
    } finally { spy.mockRestore() }
  })
})

describe('xykReserveAssets', () => {
  it('pairs reserves by the snapshot order whenever the row carries ids, HDX (0) included', () => {
    // LP 1000438: registry (PoolCreated) order is (1000286, HDX), the snapshot's (HDX, 1000286).
    expect(xykReserveAssets(true, 0, 1000286, 1000286, 0)).toEqual([0, 1000286])
    expect(xykReserveAssets(true, 1000286, 0, 0, 1000286)).toEqual([1000286, 0])
    expect(xykReserveAssets(false, 0, 0, 1000286, 0)).toEqual([1000286, 0])
  })
})

// ── explorer wiring ─────────────────────────────────────────────────────────

type Row = Record<string, unknown>
const result = (rows: Row[]) => ({ json: async () => rows })
const assetRow = (asset_id: number, symbol: string, decimals: number): Row => ({
  asset_id, symbol, name: symbol, decimals, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null, evm_address: null,
})

function explorerClient(markers: Record<string, Row[]>) {
  return {
    query: vi.fn(async ({ query }: { query: string }) => {
      for (const [marker, rows] of Object.entries(markers)) if (query.includes(marker)) return result(rows)
      return result([])
    }),
  }
}

afterEach(() => { vi.resetModules() })

describe('explorer price map', () => {
  it('prices a share at its redeemable value, never at its own feed or its underlying, and leaves an unpriceable one absent', async () => {
    vi.resetModules()
    const assets = await import('../src/services/explorerAssets.ts')
    const explorer = await import('../src/services/explorerService.ts')
    const client = explorerClient({
      'FROM price_data.assets FINAL': [
        assetRow(5, 'DOT', 10), assetRow(15, 'vDOT', 10), assetRow(46, 'apyUSD', 18), assetRow(69, 'GDOT', 18),
        assetRow(146, '2-Pool-apyUSD', 18), assetRow(222, 'HOLLAR', 18), assetRow(690, '2-Pool-GDOT', 18), assetRow(1001, 'aDOT', 10),
      ],
      'stableswap_pool_state_history': [{ pool_id: 146, members: [46, 222] }, { pool_id: 690, members: [15, 1001] }],
      'max(block_height) AS head FROM price_data.blocks': [{ head: 1000 }],
      'min(block_height) AS h FROM price_data.blocks': [{ h: 900 }],
      'AS price_then_raw\n        FROM price_data.prices': [
        { asset_id: 5, price_raw: '4.000000000000', price_then_raw: '4.000000000000' },
        { asset_id: 46, price_raw: '1.386000000000', price_then_raw: '1.386000000000' },
        { asset_id: 69, price_raw: '1.250000000000', price_then_raw: '1.250000000000' },
        // 2-Pool-apyUSD's own (stale, wrong) feed — must not survive.
        { asset_id: 146, price_raw: '9.990000000000', price_then_raw: '9.990000000000' },
        { asset_id: 222, price_raw: '1.000000000000', price_then_raw: '1.000000000000' },
      ],
      '-- stableswap:share-pools': [{
        ts: Math.floor(Date.now() / 1000),
        ss: JSON.stringify({
          pools: [
            // $277.20 of apyUSD + $722.80 of HOLLAR over 1,000 shares = $1.00 a share.
            { pool_id: 146, assets: [46, 222], reserves: [String(200n * E18), String(7228n * E18 / 10n)], amplification: '100', fee: 400, total_issuance: String(1000n * E18) },
            // vDOT has no price here, so 2-Pool-GDOT cannot be stated.
            { pool_id: 690, assets: [15, 1001], reserves: ['10000000000', '10000000000'], amplification: '100', fee: 690, total_issuance: String(2n * E18) },
          ],
        }),
      }],
    })
    await assets.loadExplorerAssets(client as never)
    explorer.initExplorerService(client as never)
    try {
      const prices = await explorer.ensurePrices()
      expect(prices.get(146)?.priceRaw).toBe('1')
      expect(prices.get(146)?.price).toBe(1)
      // Not GDOT's $1.25, and not a partial value from the aDOT leg alone.
      expect(prices.has(690)).toBe(false)
      // aTokens still alias: aDOT at DOT's price.
      expect(prices.get(1001)?.price).toBe(4)
    } finally {
      assets.stopExplorerAssetsRefresh()
    }
  })

  it('pairs a live XYK pool\'s reserves by the snapshot order when one asset is HDX', async () => {
    vi.resetModules()
    const explorer = await import('../src/services/explorerService.ts')
    const pool = `0x${'c3'.repeat(32)}`
    const client = explorerClient({
      'FROM price_data.xyk_pool_registry FINAL WHERE lp_asset_id': [{ lp_asset_id: 1000438, pool_account: pool, asset_a: 1000286, asset_b: 0 }],
      'FROM price_data.raw_block_snapshots': [{ pool, has_ids: 1, aa: 0, ab: 1000286, ra: '0', rb: '203305074956348449' }],
      'xyk_lp_total_shares_history': [{ lp_asset_id: 1000438, total: '1000000' }],
    })
    explorer.initExplorerService(client as never)
    const state = await explorer.loadXykCurrentState([1000438])
    expect(state.get(1000438)).toEqual({ assetA: 0, assetB: 1000286, reserveA: 0n, reserveB: 203_305_074_956_348_449n, totalShares: 1_000_000n })
  })

  it('states a current XYK position in an HDX pool as its two legs, HDX first, never under the LP token', async () => {
    vi.resetModules()
    const assets = await import('../src/services/explorerAssets.ts')
    const explorer = await import('../src/services/explorerService.ts')
    const pool = `0x${'c3'.repeat(32)}`
    const account = `0x${'7a'.repeat(32)}`
    const client = explorerClient({
      'FROM price_data.assets FINAL': [assetRow(0, 'HDX', 12), assetRow(1000286, 'KSM-ISH', 18), assetRow(1000438, 'XYK-LP', 18)],
      'FROM price_data.xyk_pool_registry FINAL WHERE lp_asset_id': [{ lp_asset_id: 1000438, pool_account: pool, asset_a: 1000286, asset_b: 0 }],
      // Registry order (1000286, HDX); the snapshot's own order (HDX, 1000286) with its reserves.
      'FROM price_data.raw_block_snapshots': [{ pool, has_ids: 1, aa: 0, ab: 1000286, ra: '196114599820530258', rb: '203305074956348449' }],
      'xyk_lp_total_shares_history': [{ lp_asset_id: 1000438, total: '276613024804857423' }],
      'FROM price_data.xyk_farm_principal_intervals': [],
    })
    await assets.loadExplorerAssets(client as never)
    explorer.initExplorerService(client as never)
    try {
      // The account holds every LP share of the pool.
      const balance = { asset: assets.assetDescriptor(1000438), total: '276613024804857423' } as never
      const [position] = await explorer.getXykPositions([account], [balance])
      expect(position).toMatchObject({
        positionId: 'xyk:1000438:direct', venue: 'XYK', shares: '276613024804857423',
        asset: { assetId: 0, symbol: 'HDX' }, amount: '196114599820530258',
        assetB: { assetId: 1000286 }, amountB: '203305074956348449',
      })
      // One leg unpriced: the position is not valued on its HDX half alone.
      expect(position.valueUsd).toBeNull()
    } finally {
      assets.stopExplorerAssetsRefresh()
    }
  })
})
