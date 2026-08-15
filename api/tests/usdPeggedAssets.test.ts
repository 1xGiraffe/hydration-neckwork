import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The `Hydrated *` money-market wrappers accrue interest, so they are stablecoins
// but NOT dollars. Their classification decides which price path preis takes: a
// USD-pegged quote is answered with the base asset's own USD candles, anything
// else with a real cross-pair ratio. Measured against their own USD candles they
// went 0.9993 → 1.0195 (HUSDT) and 0.9992 → 1.0159 (HUSDC) between 2025-09-22 and
// 2026-08-12 — a ~2 %/yr drift that grows without bound.

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

  it('keeps the genuine pegs, and every other classification, unchanged', async () => {
    const { getAllAssets } = await loadFixture()
    const pegged = getAllAssets().filter(a => a.isUsdPegged).map(a => a.symbol).sort()
    expect(pegged).toEqual(['DAI', 'HOLLAR', 'USDC', 'USDT'])
    // Being a stablecoin is a different question from being worth a dollar: EURC
    // tracks the euro and the Hydrated wrappers track a growing multiple of a
    // dollar. Both stay stablecoins.
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

  it('still substitutes the dollar for a genuine peg', async () => {
    expect(await pathFor(10)).toBe('usd')
    expect(await pathFor(222)).toBe('usd')
  })
})
