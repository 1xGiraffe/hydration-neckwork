import { afterEach, describe, expect, it, vi } from 'vitest'

// The explorer's current price map follows the PRICE HEAD (the newest block
// whose prices are written), not a wall-clock TTL: each asset's price is read
// from asset_price_latest per head, the 24h change from a scan on its own timer,
// and the generation id only advances when the composed map changed.

type Row = Record<string, unknown>
const result = (rows: Row[]) => ({ json: async () => rows })
const assetRow = (asset_id: number, symbol: string, decimals: number): Row => ({
  asset_id, symbol, name: symbol, decimals, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null, evm_address: null,
})

afterEach(() => { vi.resetModules() })

describe('composeCurrentPrices', () => {
  it('brings each scanned asset forward to its newest tick, keeping the scan\'s 24h-ago price', async () => {
    const { composeCurrentPrices } = await import('../src/services/explorerService.ts')
    const base = new Map([
      [5, { priceRaw: '4.000000000000', priceThenRaw: '5.000000000000', latestBlock: 990 }],
      // Held only through the 7d fallback: its newest tick is before the 24h window.
      [7, { priceRaw: '2.000000000000', priceThenRaw: '1.000000000000', latestBlock: 500 }],
      [9, { priceRaw: '3.000000000000', priceThenRaw: '3.000000000000', latestBlock: 995 }],
    ])
    const m = composeCurrentPrices(base, [
      { asset_id: 5, price_raw: '4.500000000000', latest_block: 1000 },
      // A fallback asset ticking inside the window: its only in-window price is that tick.
      { asset_id: 7, price_raw: '2.500000000000', latest_block: 1001 },
      // A non-positive tick is never a price: the scan's last positive one stands.
      { asset_id: 9, price_raw: '0.000000000000', latest_block: 1000 },
      // Not in the scan, ticking inside the window.
      { asset_id: 11, price_raw: '7.000000000000', latest_block: 999 },
      // Not in the scan and older than the window: the scan's rule leaves it unpriced.
      { asset_id: 12, price_raw: '7.000000000000', latest_block: 100 },
    ], 900)

    expect(m.get(5)).toEqual({ price: 4.5, priceRaw: '4.500000000000', change24h: (4.5 - 5) / 5 })
    expect(m.get(7)).toEqual({ price: 2.5, priceRaw: '2.500000000000', change24h: 0 })
    expect(m.get(9)).toEqual({ price: 3, priceRaw: '3.000000000000', change24h: 0 })
    expect(m.get(11)).toEqual({ price: 7, priceRaw: '7.000000000000', change24h: 0 })
    expect(m.has(12)).toBe(false)
  })

  it('is the scan itself when no asset ticked since it', async () => {
    const { composeCurrentPrices } = await import('../src/services/explorerService.ts')
    const base = new Map([[5, { priceRaw: '4.000000000000', priceThenRaw: '5.000000000000', latestBlock: 990 }]])
    const m = composeCurrentPrices(base, [{ asset_id: 5, price_raw: '4.000000000000', latest_block: 990 }], 900)
    expect(m.get(5)).toEqual({ price: 4, priceRaw: '4.000000000000', change24h: -0.2 })
  })
})

describe('ensurePriceState', () => {
  it('serves a new price as soon as the price head moves, and keeps the generation while nothing changed', async () => {
    vi.resetModules()
    const assets = await import('../src/services/explorerAssets.ts')
    const explorer = await import('../src/services/explorerService.ts')
    let latest: Row[] = [{ asset_id: 5, price_raw: '4.000000000000', latest_block: 1000 }]
    const scans = vi.fn()
    const client = {
      query: vi.fn(async ({ query }: { query: string }) => {
        if (query.includes('FROM price_data.assets FINAL')) return result([assetRow(5, 'DOT', 10)])
        if (query.includes('max(block_height) AS head FROM price_data.blocks')) return result([{ head: 1000 }])
        if (query.includes('min(block_height) AS h FROM price_data.blocks')) return result([{ h: 900 }])
        if (query.includes('AS price_then_raw\n        FROM price_data.prices')) {
          scans()
          return result([{ asset_id: 5, latest_block: 1000, price_raw: '4.000000000000', price_then_raw: '5.000000000000' }])
        }
        if (query.includes('-- explorer:current-prices')) return result(latest)
        return result([])
      }),
    }
    await assets.loadExplorerAssets(client as never)
    explorer.initExplorerService(client as never)
    try {
      const first = await explorer.ensurePriceState()
      expect(first.map.get(5)?.price).toBe(4)
      expect(first.head).toBe(1000)

      // Same head: the same generation object, no re-read.
      expect(await explorer.ensurePriceState()).toBe(first)

      // The head moves with no price change: same generation id, newer head.
      explorer.publishPriceHead(1001)
      const quiet = await explorer.ensurePriceState()
      expect(quiet.gen).toBe(first.gen)
      expect(quiet.map).toBe(first.map)
      expect(quiet.head).toBe(1001)

      // A new tick at the next head is served at once, with the scan's 24h-ago price.
      latest = [{ asset_id: 5, price_raw: '4.400000000000', latest_block: 1002 }]
      explorer.publishPriceHead(1002)
      const moved = await explorer.ensurePriceState()
      expect(moved.gen).not.toBe(first.gen)
      expect(moved.map.get(5)).toEqual({ price: 4.4, priceRaw: '4.400000000000', change24h: (4.4 - 5) / 5 })
      // The 24h scan ran once: it is on its own timer, not on the head.
      expect(scans).toHaveBeenCalledTimes(1)

      // Account values are pinned to one generation for a whole request.
      let pinned: Map<number, unknown> | null = null
      await explorer.withAccountValuePrices(async state => {
        latest = [{ asset_id: 5, price_raw: '9.000000000000', latest_block: 1003 }]
        explorer.publishPriceHead(1003)
        // The head moved and the general map follows it…
        expect((await explorer.ensurePrices()).get(5)?.price).toBe(9)
        // …while the pinned generation stays the one the request started from.
        pinned = state.map
        expect(state.map.get(5)).toEqual(moved.map.get(5))
      })
      expect(pinned).toBe(moved.map)
    } finally {
      assets.stopExplorerAssetsRefresh()
    }
  })
})
