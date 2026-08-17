import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { TickerRow } from '../../src/public/services/coingecko.ts'

// Contract + semantics tests for the CoinGecko facade. The feed's shapes are
// fixed by CoinGecko's DEX ticker spec and by what the OLD HydraDX-api feed
// (api.hydradx.io/coingecko/v1/*) emits today, so the rules pinned here are the
// ones a base-URL swap must not change: pair canonicalisation, the base/target
// price orientation, both-direction volume, and the totalsupply body shape.
//
// The per-fill fold runs inside ClickHouse (a 24h window is tens of thousands of
// fills), so the SQL's replay-safety and window rules are pinned as SQL-text
// invariants; everything the service does in TS is pinned end to end.
type Row = Record<string, unknown>

function result(rows: Row[]) {
  return { json: vi.fn(async () => rows) }
}

const ASSET_ROWS: Row[] = [
  { asset_id: 0, symbol: 'HDX', name: 'HDX', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 1, symbol: 'LRNA', name: 'LRNA', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachain_id: 0, origin_ecosystem: 'polkadot', origin_chain_id: '0', origin_asset_id: null },
  { asset_id: 10, symbol: 'USDT', name: 'Tether', decimals: 6, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 22, symbol: 'USDC', name: 'USD Coin', decimals: 6, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 39, symbol: 'PAXG', name: 'PAX Gold', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 67, symbol: 'GIGAHDX', name: 'Giga HDX', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 69, symbol: 'GDOT', name: 'GDOT', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 222, symbol: 'HOLLAR', name: 'Hydrated Dollar', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 420, symbol: 'GETH', name: 'GETH', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 670, symbol: 'stHDX', name: 'Staked HDX', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 690, symbol: '2-Pool-GDOT', name: '2-Pool-GDOT', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 1001, symbol: 'aDOT', name: 'aDOT', decimals: 10, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 1002, symbol: 'aUSDT', name: 'aUSDT', decimals: 6, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 4200, symbol: '2-Pool-GETH', name: '2-Pool-GETH', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  // Pool 146's three legs: its underlying, its own share token, and HOLLAR. The
  // share token aliases to apyUSD (SHARE_TOKEN_UNDERLYING_ID[146] = 46), which is
  // the collision the pool-scoped naming resolves.
  { asset_id: 46, symbol: 'apyUSD', name: 'Apyx apyUSD', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 146, symbol: '2-Pool-apyUSD', name: '2-Pool-apyUSD', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  // A second registry entry for one token: the 3-Pool trades this against aUSDT.
  { asset_id: 1000767, symbol: 'USDT', name: 'Tether (AssetHub)', decimals: 6, parachain_id: 1000, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
]

/** The money-market reserve map, as the aToken supply read looks it up. */
const RESERVE_MAP_ROW: Row = {
  atoken: '0x8a598fe3e3a471ce865332e330d303502a0e2f52',
  vdebt: '0xfb2e66d76d2841443ab41102369ff33df9bc9a93',
}

const ANCHOR_ROW: Row = { legs: '4200', anchor: '2026-08-12 18:22:36', block_height: 9123456 }

// The reserve model behind liquidity_in_usd is the shared pool service — the same
// one the explorer's /liquidity page renders — so it is mocked here: this file
// pins how the facade COMPOSES depth into a ticker, not how a pool is valued.
const POOLS_INDEX = {
  totalTvlUsd: 29_572_407.11,
  pools: [
    {
      kind: 'omnipool', poolId: null, name: 'Omnipool', tvlUsd: 11_088_705.84, sharePct: null, hasPegs: false,
      // The hub leg is not part of the composition, so an X_H2O ticker reports X's
      // own reserve — the depth of that hop, not the whole Omnipool's.
      composition: [{ asset: { assetId: 0 }, amount: '0', usd: 2_500_000.5, sharePct: null }],
    },
    { kind: 'stableswap', poolId: 110, name: '2-Pool-HUSDC', tvlUsd: 18_000_000, sharePct: null, composition: [], hasPegs: false },
    { kind: 'xyk', poolId: 456, name: 'HDX / HOLLAR', tvlUsd: 130_125.33, sharePct: null, composition: [], hasPegs: false },
  ],
}

vi.mock('../../src/services/poolService.ts', () => ({
  initPoolService: vi.fn(),
  getPoolsIndex: vi.fn(async () => POOLS_INDEX),
}))

interface Seen { query: string; params: Record<string, unknown> }

/** Dispatches on the marker comment each built query carries. */
function fakeClient(byMarker: Record<string, Row[]> = {}) {
  const seen: Seen[] = []
  const client = {
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
  return client
}

let stopAssets: () => void

beforeAll(async () => {
  const { loadExplorerAssets, stopExplorerAssetsRefresh } = await import('../../src/services/explorerAssets.ts')
  await loadExplorerAssets(fakeClient() as never)
  stopAssets = stopExplorerAssetsRefresh
})

afterAll(() => { stopAssets?.() })

async function buildApp(client: unknown): Promise<FastifyInstance> {
  const { buildPublicApp } = await import('../../src/public/app.ts')
  const app = await buildPublicApp({ client: client as never, logger: false })
  await app.ready()
  return app
}

// A ticker row as the SQL emits it: the pair is keyed on the LOWER asset id, and
// every quantity is already in token units at 18 decimal places.
function sqlRow(over: Partial<TickerRow> = {}): TickerRow {
  return {
    venue: 'omnipool',
    pool_key: 'omnipool',
    low_asset_id: 1,
    high_asset_id: 39,
    low_volume: '2029.239037323571000000',
    high_volume: '2.358614208080941322',
    last_ratio: '860.300452695416857705',
    max_ratio: '865.477313958079477221',
    min_ratio: '856.308559217380011674',
    ...over,
  }
}

describe('ticker symbols', () => {
  it('reports an aToken and a pool share token under the asset they wrap', async () => {
    const { tickerSymbol } = await import('../../src/public/services/coingecko.ts')
    expect(tickerSymbol(1002)).toBe('USDT')
    expect(tickerSymbol(1001)).toBe('DOT')
    expect(tickerSymbol(690)).toBe('GDOT')
    expect(tickerSymbol(4200)).toBe('GETH')
    expect(tickerSymbol(5)).toBe('DOT')
  })

  it('keeps a branded product token under its own symbol', async () => {
    // GIGAHDX is the gigahdx market's aToken over stHDX, but it is the listed
    // brand — reporting it as stHDX would name a token nobody trades.
    const { tickerSymbol } = await import('../../src/public/services/coingecko.ts')
    expect(tickerSymbol(67)).toBe('GIGAHDX')
  })

  it('has no symbol for an asset the registry does not carry', async () => {
    // External XCM assets (PINK, WIFD, …) are registered on chain with no
    // symbol. The feed drops them rather than publishing "#1000082" as a
    // currency code — explicit incompleteness, not plausible filler.
    const { tickerSymbol } = await import('../../src/public/services/coingecko.ts')
    expect(tickerSymbol(1000082)).toBeNull()
  })
})

describe('pair canonicalisation', () => {
  it('forces H2O, GDOT and GETH onto the target side', async () => {
    const { orientPair } = await import('../../src/public/services/coingecko.ts')
    expect(orientPair({ assetId: 39, symbol: 'PAXG' }, { assetId: 1, symbol: 'H2O' })?.base.symbol).toBe('PAXG')
    expect(orientPair({ assetId: 1, symbol: 'H2O' }, { assetId: 39, symbol: 'PAXG' })?.target.symbol).toBe('H2O')
    expect(orientPair({ assetId: 5, symbol: 'DOT' }, { assetId: 69, symbol: 'GDOT' })?.target.symbol).toBe('GDOT')
    // Alphabetically GETH < USDC, but the forced side wins over the ordering.
    expect(orientPair({ assetId: 420, symbol: 'GETH' }, { assetId: 22, symbol: 'USDC' })?.base.symbol).toBe('USDC')
  })

  it('ranks the forced symbols against each other', async () => {
    const { orientPair } = await import('../../src/public/services/coingecko.ts')
    expect(orientPair({ assetId: 69, symbol: 'GDOT' }, { assetId: 1, symbol: 'H2O' })?.target.symbol).toBe('H2O')
    expect(orientPair({ assetId: 69, symbol: 'GDOT' }, { assetId: 420, symbol: 'GETH' })?.target.symbol).toBe('GDOT')
  })

  it('orders every other pair by ASCII symbol', async () => {
    const { orientPair } = await import('../../src/public/services/coingecko.ts')
    expect(orientPair({ assetId: 22, symbol: 'USDC' }, { assetId: 5, symbol: 'DOT' })?.base.symbol).toBe('DOT')
    // Uppercase sorts before lowercase, which is what puts DOT_vDOT that way round.
    expect(orientPair({ assetId: 15, symbol: 'vDOT' }, { assetId: 5, symbol: 'DOT' })?.target.symbol).toBe('vDOT')
  })

  it('has no pair when both sides carry the same symbol', async () => {
    const { orientPair } = await import('../../src/public/services/coingecko.ts')
    expect(orientPair({ assetId: 21, symbol: 'USDC' }, { assetId: 22, symbol: 'USDC' })).toBeNull()
  })
})

describe('tickers SQL', () => {
  it('collapses the leg replacement key before summing anything', async () => {
    const { buildTickersSql } = await import('../../src/public/services/coingecko.ts')
    const sql = buildTickersSql()
    // pool_swap_legs is ReplacingMergeTree(ingested_at): a replayed range holds a
    // second copy of every leg, so the leg identity is collapsed with argMax
    // BEFORE a quantity is summed. Without this a re-indexed day doubles volume.
    expect(sql).toContain('argMax(amount, ingested_at)')
    expect(sql).toContain('GROUP BY venue, pool_key, block_height, event_index, leg_kind, leg_index')
  })

  it('anchors the window to the indexed head and excludes fee legs', async () => {
    const { buildTickersSql } = await import('../../src/public/services/coingecko.ts')
    const sql = buildTickersSql()
    expect(sql).toContain('{anchor:DateTime}')
    expect(sql).toContain('{hours:UInt32}')
    expect(sql).toContain("leg_kind != 'fee'")
  })

  it('keeps only two-sided fills with a non-zero quantity on both sides', async () => {
    const { buildTickersSql } = await import('../../src/public/services/coingecko.ts')
    const sql = buildTickersSql()
    // A fill with several in or out assets is not one pair, and a zero side has
    // no price at all — dividing by it would throw rather than produce a ticker.
    expect(sql).toContain('length(in_ids) = 1')
    expect(sql).toContain('length(out_ids) = 1')
    expect(sql).toContain('in_qtys[1] > 0')
    expect(sql).toContain('out_qtys[1] > 0')
  })

  it('keys the pair on the lower asset id so both trade directions fold together', async () => {
    const { buildTickersSql } = await import('../../src/public/services/coingecko.ts')
    const sql = buildTickersSql()
    expect(sql).toContain('least(in_ids[1], out_ids[1])')
    expect(sql).toContain('greatest(in_ids[1], out_ids[1])')
    expect(sql).toContain('GROUP BY venue, pool_key, low_asset_id, high_asset_id')
  })

  it('excludes the money market, whose fills are 1:1 deposits rather than trades', async () => {
    // Supplying USDT mints aUSDT at exactly 1, with no reserves and no
    // counterparty. Left in, it would be the feed's second-largest "market".
    const { buildTickersSql } = await import('../../src/public/services/coingecko.ts')
    expect(buildTickersSql()).toContain("venue != 'aave'")
  })
})

describe('buildTickers', () => {
  const noLiquidity = () => null

  it('publishes the pair with the price of the last fill, base over target', async () => {
    const { buildTickers } = await import('../../src/public/services/coingecko.ts')
    const [ticker] = buildTickers([sqlRow()], noLiquidity)
    // Asset 1 is H2O, forced to the target side, so PAXG is the base and the
    // SQL's low/high ratio (H2O per PAXG) is inverted to PAXG per H2O.
    expect(ticker.ticker_id).toBe('PAXG_H2O')
    expect(ticker.base_currency).toBe('PAXG')
    expect(ticker.target_currency).toBe('H2O')
    expect(ticker.last_price).toBe(0.001162384602805786)
    expect(ticker.base_volume).toBe(2.358614208080941322)
    expect(ticker.target_volume).toBe(2029.239037323571)
    expect(ticker.pool_id).toBe('omnipool')
  })

  it('swaps high and low when the pair is inverted', async () => {
    const { buildTickers } = await import('../../src/public/services/coingecko.ts')
    const [ticker] = buildTickers([sqlRow()], noLiquidity)
    // The cheapest PAXG_H2O price is the reciprocal of the DEAREST H2O_PAXG one:
    // inverting without swapping would report high < low.
    expect(ticker.high).toBe(0.001167803345226336)
    expect(ticker.low).toBe(0.001155431787607129)
    expect(ticker.high).toBeGreaterThan(ticker.low)
  })

  it('keeps the SQL orientation when the base is the lower asset id', async () => {
    const { buildTickers } = await import('../../src/public/services/coingecko.ts')
    const [ticker] = buildTickers([sqlRow({
      low_asset_id: 0, high_asset_id: 1,
      low_volume: '4243191.225780822173', high_volume: '7246.614841663616',
      last_ratio: '573.654732529926923076', max_ratio: '599.843229390600772997', min_ratio: '569.651979615818777234',
    })], noLiquidity)
    expect(ticker.ticker_id).toBe('HDX_H2O')
    expect(ticker.last_price).toBe(573.654732529926923076)
    expect(ticker.high).toBe(599.843229390600772997)
    expect(ticker.low).toBe(569.651979615818777234)
    expect(ticker.base_volume).toBe(4243191.225780822173)
    expect(ticker.target_volume).toBe(7246.614841663616)
  })

  it('names the pool a keyed venue filled in, so one pair can appear per pool', async () => {
    const { buildTickers } = await import('../../src/public/services/coingecko.ts')
    const tickers = buildTickers([
      sqlRow({ venue: 'stableswap', pool_key: '110', low_asset_id: 22, high_asset_id: 222, last_ratio: '1', max_ratio: '1', min_ratio: '1' }),
      sqlRow({ venue: 'xyk', pool_key: `0x${'a'.repeat(64)}`, low_asset_id: 22, high_asset_id: 222, last_ratio: '1', max_ratio: '1', min_ratio: '1' }),
    ], noLiquidity)
    expect(tickers.map(t => t.pool_id)).toEqual(['stableswap:110', `xyk:0x${'a'.repeat(64)}`])
    expect(new Set(tickers.map(t => t.ticker_id))).toEqual(new Set(['HOLLAR_USDC']))
  })

  it('falls back to the raw registry symbols for a real market between two entries of one token', async () => {
    const { buildTickers } = await import('../../src/public/services/coingecko.ts')
    // The 3-Pool trades aUSDT against AssetHub USDT: both normalise to USDT, so
    // the raw registry symbols keep this genuine market from being dropped.
    const [ticker] = buildTickers([sqlRow({
      venue: 'stableswap', pool_key: '103', low_asset_id: 1002, high_asset_id: 1000767,
      last_ratio: '0.999', max_ratio: '0.999', min_ratio: '0.999',
    })], noLiquidity)
    expect(ticker.ticker_id).toBe('USDT_aUSDT')
    expect(ticker.base_currency).toBe('USDT')
  })

  it('drops a pair whose asset has no registry symbol, naming both counts', async () => {
    const { buildTickers } = await import('../../src/public/services/coingecko.ts')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(buildTickers([
        sqlRow({ venue: 'xyk', pool_key: 'a', low_asset_id: 5, high_asset_id: 1000082 }),
        sqlRow({ venue: 'xyk', pool_key: 'b', low_asset_id: 0, high_asset_id: 1000082 }),
      ], noLiquidity)).toEqual([])
      // Two pair-groups, one asset — the counts differ and both are reported.
      expect(warn.mock.calls[0][0]).toContain('2 pair-group(s) spanning 1 asset(s)')
      expect(warn.mock.calls[0][0]).toContain('1000082')
    } finally { warn.mockRestore() }
  })

  it('warns when a real market is lost because both sides share one symbol', async () => {
    const { buildTickers } = await import('../../src/public/services/coingecko.ts')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // Both registry entries are literally "USDT": nothing can name this pair,
      // and it is the only path that silently loses a genuine market.
      expect(buildTickers([sqlRow({ low_asset_id: 10, high_asset_id: 1000767 })], noLiquidity)).toEqual([])
      expect(warn.mock.calls.some(call => String(call[0]).includes('share a symbol'))).toBe(true)
    } finally { warn.mockRestore() }
  })

  it('reports real pool liquidity where a reserve model exists', async () => {
    const { buildTickers } = await import('../../src/public/services/coingecko.ts')
    const [ticker] = buildTickers([sqlRow()], (venue, poolKey, assetIds) => {
      expect(venue).toBe('omnipool')
      expect(poolKey).toBe('omnipool')
      expect(assetIds).toEqual([1, 39])
      return 1234.5678
    })
    // The one field the old feed hardcoded to 0, at the surface's USD precision.
    expect(ticker.liquidity_in_usd).toBe(1234.57)
  })

  it('publishes 0 liquidity where the venue holds no reserves', async () => {
    const { buildTickers } = await import('../../src/public/services/coingecko.ts')
    const [ticker] = buildTickers([sqlRow({ venue: 'otc', pool_key: '1532' })], noLiquidity)
    // The incumbent publishes a bare 0 here on every row; so does this.
    expect(ticker.liquidity_in_usd).toBe(0)
  })

  // The row key CoinGecko's spec uses is the (ticker_id, pool_id) composite — one
  // market per pool. It has to be UNIQUE, or an aggregator keyed on it silently keeps
  // whichever of two contradicting rows it saw last.
  describe('the (ticker_id, pool_id) row key', () => {
    // Stableswap pool 146 as it really trades: its underlying apyUSD against HOLLAR,
    // and its OWN share token against HOLLAR. Measured live, those two priced 0.9855
    // and 1.3447 — 36% apart, because a share is a claim on the whole pool and is
    // worth more than one unit of what the pool holds.
    const POOL_146 = [
      sqlRow({ venue: 'stableswap', pool_key: '146', low_asset_id: 46, high_asset_id: 222,
        last_ratio: '0.985486213677168700', max_ratio: '0.985486213677168700', min_ratio: '0.982960947770481300' }),
      sqlRow({ venue: 'stableswap', pool_key: '146', low_asset_id: 146, high_asset_id: 222,
        last_ratio: '1.344665691411411200', max_ratio: '1.344665691411411200', min_ratio: '1.330421654663630500' }),
    ]

    it('names a share token by its OWN symbol when the pool also trades what it aliases to', async () => {
      const { buildTickers } = await import('../../src/public/services/coingecko.ts')
      const tickers = buildTickers(POOL_146, () => null)
      // Both markets survive, under names that tell them apart. Aliasing the share
      // leg to apyUSD is the same mislabelling the incumbent made with DOT_vDOT.
      expect(tickers.map(t => t.ticker_id).sort()).toEqual(['2-Pool-apyUSD_HOLLAR', 'HOLLAR_apyUSD'])
      const keys = tickers.map(t => `${t.ticker_id}@${t.pool_id}`)
      expect(new Set(keys).size).toBe(keys.length)
    })

    it('leaves a share token aliased when nothing else in its pool claims that symbol', async () => {
      const { buildTickers } = await import('../../src/public/services/coingecko.ts')
      // Pool 690 trades its share token against DOT; nothing there is named GDOT, so
      // DOT_GDOT is unambiguous and keeps the alias. Renaming every share token
      // unconditionally would have changed 11 published ticker_ids instead of 1 —
      // including DOT_GDOT and ETH_GETH, whose redefinition is already announced.
      const tickers = buildTickers([
        sqlRow({ venue: 'stableswap', pool_key: '690', low_asset_id: 5, high_asset_id: 690,
          last_ratio: '1', max_ratio: '1', min_ratio: '1' }),
      ], () => null)
      expect(tickers.map(t => t.ticker_id)).toEqual(['DOT_GDOT'])
    })

    it('does not treat one share token appearing in several of its own pairs as a collision', async () => {
      const { buildTickers } = await import('../../src/public/services/coingecko.ts')
      // The ownership test is DISTINCT ASSETS per symbol, not leg occurrences: the
      // share token below is one asset named twice, which is not ambiguous.
      const tickers = buildTickers([
        sqlRow({ venue: 'stableswap', pool_key: '690', low_asset_id: 5, high_asset_id: 690, last_ratio: '1', max_ratio: '1', min_ratio: '1' }),
        sqlRow({ venue: 'stableswap', pool_key: '690', low_asset_id: 222, high_asset_id: 690, last_ratio: '1', max_ratio: '1', min_ratio: '1' }),
      ], () => null)
      expect(tickers.map(t => t.ticker_id).sort()).toEqual(['DOT_GDOT', 'HOLLAR_GDOT'])
    })

    it('keeps the key unique across every pair the fixtures can produce', async () => {
      const { buildTickers } = await import('../../src/public/services/coingecko.ts')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const tickers = buildTickers([
          ...POOL_146,
          sqlRow({ venue: 'omnipool', pool_key: 'omnipool', low_asset_id: 0, high_asset_id: 1, last_ratio: '1', max_ratio: '1', min_ratio: '1' }),
          sqlRow({ venue: 'stableswap', pool_key: '110', low_asset_id: 22, high_asset_id: 222, last_ratio: '1', max_ratio: '1', min_ratio: '1' }),
          sqlRow({ venue: 'stableswap', pool_key: '105', low_asset_id: 22, high_asset_id: 222, last_ratio: '1', max_ratio: '1', min_ratio: '1' }),
          sqlRow({ venue: 'xyk', pool_key: `0x${'a'.repeat(64)}`, low_asset_id: 22, high_asset_id: 222, last_ratio: '1', max_ratio: '1', min_ratio: '1' }),
        ], () => null)
        const keys = tickers.map(t => `${t.ticker_id}@${t.pool_id}`)
        expect(keys).toHaveLength(new Set(keys).size)
        // A pair traded in several pools is still several rows — that is the spec's
        // model, and it is what pool_id is for.
        expect(tickers.filter(t => t.ticker_id === 'HOLLAR_USDC')).toHaveLength(3)
      } finally { warn.mockRestore() }
    })
  })

  it('orders deterministically by ticker then pool', async () => {
    const { buildTickers } = await import('../../src/public/services/coingecko.ts')
    const tickers = buildTickers([
      sqlRow({ venue: 'stableswap', pool_key: '110', low_asset_id: 22, high_asset_id: 222 }),
      sqlRow({ venue: 'omnipool', pool_key: 'omnipool', low_asset_id: 0, high_asset_id: 1 }),
      sqlRow({ venue: 'stableswap', pool_key: '105', low_asset_id: 22, high_asset_id: 222 }),
    ], noLiquidity)
    expect(tickers.map(t => `${t.ticker_id}@${t.pool_id}`))
      .toEqual(['HDX_H2O@omnipool', 'HOLLAR_USDC@stableswap:105', 'HOLLAR_USDC@stableswap:110'])
  })
})

describe('GET /coingecko/v1/tickers', () => {
  it('serves the DEX ticker array with a 60s cache header', async () => {
    const client = fakeClient({
      '-- pub:vol:anchor': [ANCHOR_ROW],
      '-- pub:cg:tickers': [sqlRow({ low_asset_id: 0, high_asset_id: 1 })],
      '-- pub:vol:xyk-pools': [],
    })
    const app = await buildApp(client)
    try {
      const res = await app.inject('/coingecko/v1/tickers')
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(Array.isArray(body)).toBe(true)
      expect(Object.keys(body[0])).toEqual([
        'ticker_id', 'base_currency', 'target_currency', 'last_price',
        'base_volume', 'target_volume', 'pool_id', 'liquidity_in_usd', 'high', 'low',
      ])
      // The Omnipool pair reports the traded asset's own reserve as its depth.
      expect(body[0].ticker_id).toBe('HDX_H2O')
      expect(body[0].liquidity_in_usd).toBe(2500000.5)
      expect(res.headers['cache-control']).toBe('public, max-age=60')
    } finally { await app.close() }
  })

  it('answers an empty feed instead of the old 503-on-cold', async () => {
    // The old feed is job-pushed into Redis and 503s until the job has run once.
    // This one computes on demand, so an unpopulated projection is [] and a 200.
    const client = fakeClient({ '-- pub:vol:anchor': [{ legs: '0', anchor: '1970-01-01 00:00:00', block_height: 0 }] })
    // The feed is one shared cache entry by design; step past its stale window so
    // this case recomputes instead of reading the previous test's value.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000)
    const app = await buildApp(client)
    try {
      const res = await app.inject('/coingecko/v1/tickers')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual([])
    } finally { await app.close(); clock.mockRestore() }
  })

  // The incumbent's live body, probed field by field with python3's type():
  //   ticker_id str, base_currency str, target_currency str, last_price float|int,
  //   base_volume float|int, target_volume float, pool_id str,
  //   liquidity_in_usd int, high float|int, low float|int
  // JSON has one number type, so int/float there is only "did this value have a
  // fraction". What a consumer's parser sees is: four strings and six NUMBERS, in
  // that order. Values differ by design (endorsed corrections); the types must not.
  it('publishes the incumbent\'s four strings and six JSON numbers, in its order', async () => {
    const client = fakeClient({
      '-- pub:vol:anchor': [ANCHOR_ROW],
      '-- pub:cg:tickers': [sqlRow({ low_asset_id: 0, high_asset_id: 1 })],
      '-- pub:vol:xyk-pools': [],
    })
    // One shared cache entry backs this feed, so step past the previous test's
    // stale window rather than reading its value.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 7_200_000)
    const app = await buildApp(client)
    try {
      const res = await app.inject('/coingecko/v1/tickers')
      const [row] = res.json()
      const types = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value]))
      expect(types).toEqual({
        ticker_id: 'string', base_currency: 'string', target_currency: 'string',
        last_price: 'number', base_volume: 'number', target_volume: 'number',
        pool_id: 'string', liquidity_in_usd: 'number', high: 'number', low: 'number',
      })
      // A quoted number would satisfy `typeof value === 'string'` above, so the raw
      // body is what proves the wire form: no numeric field is quoted.
      expect(res.body).toMatch(/"last_price":\d/)
      expect(res.body).toMatch(/"liquidity_in_usd":\d/)
      expect(res.body).not.toMatch(/"(last_price|base_volume|target_volume|liquidity_in_usd|high|low)":"/)
    } finally { await app.close(); clock.mockRestore() }
  })
})

describe('GET /coingecko/v1/totalsupply/:token', () => {
  // Ordered: every unresolvable case throws, so nothing is cached and the
  // success case after it recomputes against its own fake rows.
  it('answers 503, never "0", when the source holds no indexed balances', async () => {
    // An empty read is "supply unknown", not "supply is zero". A zero total
    // supply is a wrong number an aggregator would keep long after the fix.
    const client = fakeClient({ '-- pub:cg:supply:erc20': [{ holders: 0, total: '0' }] })
    const app = await buildApp(client)
    try {
      const res = await app.inject('/coingecko/v1/totalsupply/hollar')
      expect(res.statusCode).toBe(503)
      expect(res.json().error.code).toBe('upstream_error')
      expect(res.headers['cache-control']).toBe('no-store')
    } finally { await app.close() }
  })

  it('serves HOLLAR from the indexed ERC-20 balances, in whole tokens', async () => {
    const client = fakeClient({ '-- pub:cg:supply:erc20': [{ holders: 340, total: '11361299679211952327741644' }] })
    const app = await buildApp(client)
    try {
      const res = await app.inject('/coingecko/v1/totalsupply/hollar')
      expect(res.statusCode).toBe(200)
      // The old endpoint's body shape, to the byte: {"result":"<decimal string>"}.
      expect(res.json()).toEqual({ result: '11361299.679211952327741644' })
      expect(res.headers['cache-control']).toBe('public, max-age=300')
    } finally { await app.close() }
  })

  it('serves GDOT and GETH from the underlying the aToken contract holds', async () => {
    const client = fakeClient({
      '-- pub:cg:reserve-map': [RESERVE_MAP_ROW],
      '-- pub:cg:supply:atoken': [{ debt_rows: 0, custody_rows: 1, total: '1682882517144264590875' }],
    })
    const app = await buildApp(client)
    try {
      const res = await app.inject('/coingecko/v1/totalsupply/gigaeth')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ result: '1682.882517144264590875' })
      // The reserve is addressed by the asset's 20-byte EVM form, and both the
      // receipt and debt contracts come from the indexed map, never a constant.
      const map = client.seen.find(s => s.query.includes('-- pub:cg:reserve-map'))!
      expect(map.params.reserve).toBe('0x0000000000000000000000000000000100001068')
      const supply = client.seen.find(s => s.query.includes('-- pub:cg:supply:atoken'))!
      expect(supply.params.asset).toBe('4200')
      expect(supply.params.account).toBe('0x455448008a598fe3e3a471ce865332e330d303502a0e2f520000000000000000')
      expect(supply.params.vdebt).toBe(RESERVE_MAP_ROW.vdebt)
      // atoken_scaled_deltas_by_contract is ORDER BY (contract_address, …), so
      // the debt probe touches one granule rather than scanning the reserve.
      expect(supply.query).toContain('WHERE contract_address = {vdebt:String} LIMIT 1')
    } finally { await app.close() }
  })

  it('503s rather than understating the supply once a reserve starts lending', async () => {
    // Custody equals supply only while nothing is borrowed out. One debt row and
    // the identity is gone, so the number is withheld instead of shrinking.
    const client = fakeClient({
      '-- pub:cg:reserve-map': [RESERVE_MAP_ROW],
      '-- pub:cg:supply:atoken': [{ debt_rows: 1, custody_rows: 1, total: '4181469000081857209039990' }],
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = await buildApp(client)
    try {
      const res = await app.inject('/coingecko/v1/totalsupply/gigadot')
      expect(res.statusCode).toBe(503)
      expect(res.json().error.message).toContain('custody-backed')
      expect(error.mock.calls.some(call => String(call[0]).includes('variable debt'))).toBe(true)
    } finally { await app.close(); error.mockRestore() }
  })

  it('503s when the money-market reserve map has no entry for the asset', async () => {
    const client = fakeClient({ '-- pub:cg:reserve-map': [{ atoken: '', vdebt: '' }] })
    const app = await buildApp(client)
    try {
      const res = await app.inject('/coingecko/v1/totalsupply/gigadot')
      expect(res.statusCode).toBe(503)
      expect(res.json().error.message).toContain('reserve entry')
    } finally { await app.close() }
  })

  it('503s when the receipt contract holds no indexed balance row', async () => {
    const client = fakeClient({
      '-- pub:cg:reserve-map': [RESERVE_MAP_ROW],
      '-- pub:cg:supply:atoken': [{ debt_rows: 0, custody_rows: 0, total: '0' }],
    })
    const app = await buildApp(client)
    try {
      const res = await app.inject('/coingecko/v1/totalsupply/gigadot')
      expect(res.statusCode).toBe(503)
      expect(res.json().error.message).toContain('no indexed balance')
    } finally { await app.close() }
  })

  it('serves H2O from the indexed substrate issuance', async () => {
    const client = fakeClient({ '-- pub:cg:supply:substrate': [{ holders: 1365, total: '2244658668075578993' }] })
    const app = await buildApp(client)
    try {
      const res = await app.inject('/coingecko/v1/totalsupply/h2o')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ result: '2244658.668075578993' })
    } finally { await app.close() }
  })

  it('404s an unknown token, as the old endpoint does', async () => {
    const app = await buildApp(fakeClient())
    try {
      const res = await app.inject('/coingecko/v1/totalsupply/nope')
      expect(res.statusCode).toBe(404)
      expect(res.json().error.code).toBe('not_found')
    } finally { await app.close() }
  })
})

describe('unit formatting', () => {
  it('renders a raw integer amount at the token\'s own decimals', async () => {
    const { formatUnits } = await import('../../src/public/services/coingecko.ts')
    expect(formatUnits('1682882517144264590875', 18)).toBe('1682.882517144264590875')
    expect(formatUnits('1000000000000', 12)).toBe('1')
    expect(formatUnits('0', 18)).toBe('0')
    expect(formatUnits('1', 18)).toBe('0.000000000000000001')
  })

  it('trims a ClickHouse decimal without touching its significant digits', async () => {
    const { trimDecimal } = await import('../../src/public/services/coingecko.ts')
    expect(trimDecimal('2029.239037323571000000')).toBe('2029.239037323571')
    expect(trimDecimal('1.000000000000000000')).toBe('1')
    expect(trimDecimal('0.000000000000000000')).toBe('0')
  })

  it('inverts a price at full scale', async () => {
    const { invertRatio } = await import('../../src/public/services/coingecko.ts')
    expect(invertRatio('2')).toBe('0.5')
    expect(invertRatio('0')).toBe('0')
  })
})

describe('cache policy', () => {
  it('gives the feed its own anchored TTLs', async () => {
    const { PUBLIC_CACHE_CONTROL } = await import('../../src/public/cacheControl.ts')
    const ttl = (path: string) => PUBLIC_CACHE_CONTROL.find(([p]) => p.test(path))?.[1] ?? null
    expect(ttl('/coingecko/v1/tickers')).toBe(60)
    expect(ttl('/coingecko/v1/totalsupply/hollar')).toBe(300)
    // A neighbouring future route must not inherit either TTL.
    expect(ttl('/coingecko/v1/tickers/extra')).toBeNull()
    expect(ttl('/coingecko/v2/tickers')).toBeNull()
  })
})
