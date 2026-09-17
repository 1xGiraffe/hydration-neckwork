import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Which assets count as dollars decides which price path preis and the public API
// take: a USD-pegged quote is answered with the base asset's own USD candles,
// anything else with a real cross-pair ratio. Substituting the dollar publishes the
// quote's entire deviation from $1 as a silent, one-directional error in every rate
// it quotes, so the list holds only assets whose deviation sits below the series'
// own noise — USDT and USDC (0.0039 %-0.0345 % across their listed ids, 2026-09-17).
//
// HOLLAR floats on its own stablepools (0.9983 on 2026-09-17, a 0.172 % error that
// drifted 0.05 % in 26 h), DAI is an outside peg, and the `Hydrated *` money-market
// wrappers accrue interest away from par without bound (0.9993 → 1.0195 for HUSDT,
// 0.9992 → 1.0159 for HUSDC, 2025-09-22 to 2026-08-12, ~2 %/yr). None of them is a
// dollar, and all of them trade against what they quote, so the cross path has a
// real market rate to use instead of an assumption.

interface AssetRow {
  asset_id: number
  symbol: string
  name: string
  decimals: number
  parachain_id: number | null
  origin_ecosystem: string | null
  origin_chain_id: string | null
  origin_asset_id: string | null
}

const row = (asset_id: number, symbol: string, name = symbol): AssetRow => ({
  asset_id, symbol, name, decimals: symbol === 'HDX' ? 12 : 6,
  parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null,
})

const ASSET_ROWS: AssetRow[] = [
  row(0, 'HDX', 'Hydration'),
  row(5, 'DOT', 'Polkadot'),
  row(2, 'DAI', 'Dai'),
  row(10, 'USDT', 'Tether'),
  row(22, 'USDC', 'USD Coin'),
  row(42, 'EURC', 'Euro Coin'),
  row(222, 'HOLLAR', 'HOLLAR'),
  row(1110, 'HUSDC', 'Hydrated USDC'),
  row(1111, 'HUSDT', 'Hydrated USDT'),
  row(1112, 'HUSDS', 'Hydrated USDS'),
  row(1113, 'HUSDe', 'Hydrated USDe'),
]

async function loadFixture() {
  vi.resetModules()
  const assets = await import('../src/services/assetsService.ts')
  const client = { query: vi.fn(async () => ({ json: async () => ASSET_ROWS })) }
  await assets.loadAssets(client as never)
  return assets
}

afterEach(() => { vi.restoreAllMocks() })

describe('USD-pegged asset classification', () => {
  it('does not treat the interest-bearing Hydrated wrappers as dollars', async () => {
    const { getAssetById } = await loadFixture()
    for (const id of [1110, 1111, 1112, 1113]) {
      expect(getAssetById(id)?.isUsdPegged, `asset ${id}`).toBe(false)
    }
  })

  // A floating peg is not a dollar either. Both still read as stablecoins, which is
  // what keeps them grouped in the UI without being substituted for USD.
  it('does not treat HOLLAR or DAI as dollars, but keeps them stablecoins', async () => {
    const { getAssetById } = await loadFixture()
    for (const id of [222, 2]) {
      expect(getAssetById(id)?.isUsdPegged, `asset ${id}`).toBe(false)
      expect(getAssetById(id)?.isStablecoin, `asset ${id}`).toBe(true)
    }
  })

  it('keeps the genuine pegs, and every other classification, unchanged', async () => {
    const { getAllAssets } = await loadFixture()
    const pegged = getAllAssets().filter(a => a.isUsdPegged).map(a => a.symbol).sort()
    expect(pegged).toEqual(['USDC', 'USDT'])
    // Being a stablecoin is a different question from being worth a dollar: EURC
    // tracks the euro, HOLLAR and DAI hold their own pegs loosely, and the Hydrated
    // wrappers track a growing multiple of a dollar. All stay stablecoins.
    const stable = getAllAssets().filter(a => a.isStablecoin).map(a => a.symbol).sort()
    expect(stable).toEqual(['DAI', 'EURC', 'HOLLAR', 'HUSDC', 'HUSDT', 'USDC', 'USDT'])
  })
})

describe('GET /candles price path for a Hydrated quote', () => {
  let app: Awaited<ReturnType<typeof makeApp>>['app'] | null = null

  async function makeApp() {
    const { getAssetById } = await loadFixture()
    expect(getAssetById(1110)).toBeDefined()
    const { default: Fastify } = await import('fastify')
    const { candlesRoutes } = await import('../src/routes/candles.ts')
    const seen: string[] = []
    const client = {
      query: vi.fn(async ({ query }: { query: string }) => {
        seen.push(query)
        return { json: async () => [] }
      }),
    }
    const instance = Fastify()
    await instance.register(candlesRoutes, { client: client as never })
    return { app: instance, seen }
  }

  beforeEach(async () => { app = null })
  afterEach(async () => { await app?.close() })

  async function pathFor(quoteId: number): Promise<'usd' | 'cross'> {
    const made = await makeApp()
    app = made.app
    const res = await made.app.inject({
      url: `/candles?baseId=5&quoteId=${quoteId}&interval=1h&from=1754870400&to=1754956800`,
    })
    expect(res.statusCode).toBe(200)
    // The cross path joins the two assets' per-block prices and aggregates the
    // ratio; the USD path reads the base asset's own OHLC view.
    return made.seen.some(q => q.includes('sub.ratio')) ? 'cross' : 'usd'
  }

  it('prices a HUSDC/HUSDT-quoted pair as a real cross rate, like its HUSDS sibling', async () => {
    expect(await pathFor(1110)).toBe('cross')
    expect(await pathFor(1111)).toBe('cross')
    expect(await pathFor(1112)).toBe('cross')
  })

  it('prices a HOLLAR- or DAI-quoted pair as a real cross rate too', async () => {
    expect(await pathFor(222)).toBe('cross')
    expect(await pathFor(2)).toBe('cross')
  })

  it('still substitutes the dollar for a genuine peg', async () => {
    expect(await pathFor(10)).toBe('usd')
    expect(await pathFor(22)).toBe('usd')
  })
})
