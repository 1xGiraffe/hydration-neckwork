import { beforeEach, describe, expect, it, vi } from 'vitest'

// The explorer's pair chart reads the same two leaves as the public pair route: the
// base asset's own USD candles when the quote IS the dollar, the per-block cross rate
// otherwise — after resolving each leg to the series that prices it.
const ohlcv = vi.fn()
const cross = vi.fn()
vi.mock('../src/services/ohlcvService.ts', async () => ({
  ...(await vi.importActual<typeof import('../src/services/ohlcvService.ts')>('../src/services/ohlcvService.ts')),
  queryOHLCV: (...a: unknown[]) => ohlcv(...a),
}))
// The USD-quoted route series is the real shared reader (over the mocked legs), so
// the carry rule it applies across route and USD candles is exercised here too.
vi.mock('../src/services/crossPair.ts', async () => ({
  ...(await vi.importActual<typeof import('../src/services/crossPair.ts')>('../src/services/crossPair.ts')),
  queryPairCandles: (...a: unknown[]) => cross(...a),
}))
const route = vi.fn()
vi.mock('../src/services/pairPriceSource.ts', async () => ({
  ...(await vi.importActual<typeof import('../src/services/pairPriceSource.ts')>('../src/services/pairPriceSource.ts')),
  queryRouteCandles: (...a: unknown[]) => route(...a),
}))
vi.mock('../src/services/assetsService.ts', () => ({ getAssetById: (id: number) => (id === 10 ? { assetId: 10, isUsdPegged: true } : { assetId: id, isUsdPegged: false }) }))
// aUSDC (1003) prices as USDC (22); 2-Pool-HUSDC (110) as HUSDC (1110).
vi.mock('../src/services/explorerAssets.ts', () => ({ priceAssetId: (id: number) => ({ 1003: 22, 110: 1110, 1002: 10 } as Record<number, number>)[id] ?? id, assetDescriptor: () => ({ decimals: 12 }) }))
// The pair's own volume: none unless a test states it.
const pairVolume = vi.fn()
vi.mock('../src/services/pairVolume.ts', () => ({
  AMOUNT_SCALE: 18,
  queryPairVolume: (...a: unknown[]) => pairVolume(...a),
  scaledText: (v: bigint, scale: number) => String(Number(v) / 10 ** scale),
}))
const keys: string[] = []
vi.mock('../src/services/cache.ts', () => ({ cached: (key: string, _ttl: number, fn: () => unknown) => { keys.push(key); return fn() } }))

const { pairChart } = await import('../src/services/pairChartService.ts')
const NO_VOLUME = { v: 0, vb: 0, vq: 0 }
const NOW = 1_790_000_000 // 2026-09-21 14:13:20 UTC
const HOUR = Math.floor(NOW / 3600) * 3600 // 14:00, the bucket in progress

beforeEach(() => { ohlcv.mockReset(); cross.mockReset(); route.mockReset(); pairVolume.mockReset(); pairVolume.mockResolvedValue(new Map()); keys.length = 0 })

describe('pairChart', () => {
  it('reads a USD-pegged quote as the base asset\'s own candles, aliases resolved', async () => {
    ohlcv.mockResolvedValue([
      { interval_start: '2026-09-21 14:00:00', open: '4.5', high: '4.6', low: '4.4', close: '4.55' },
    ])
    const chart = await pairChart({} as never, 5, 1002, '1h', 24, NOW)
    expect(chart.quoteSeries).toBe(10)
    expect(ohlcv).toHaveBeenCalledTimes(1)
    const [, args] = ohlcv.mock.calls[0]
    expect(args.assetId).toBe(5)
    // 24 hourly buckets ending with the one in progress (14:00): from 15:00 the day before.
    expect(args.startTime.toISOString()).toBe('2026-09-20T15:00:00.000Z')
    expect(chart.candles).toEqual([{ t: HOUR, o: 4.5, h: 4.6, l: 4.4, c: 4.55, ...NO_VOLUME }])
  })

  it('reads any other quote as the exact per-block cross rate', async () => {
    cross.mockResolvedValue([{ intervalStart: HOUR, open: '160', high: '165', low: '158', close: '163', volumeBuy: '0', volumeSell: '0', volumeTotal: '0' }])
    const chart = await pairChart({} as never, 5, 0, '1h', 24, NOW)
    expect(cross.mock.calls[0][1]).toMatchObject({ baseId: 5, quoteId: 0, interval: '1h' })
    // The configured source, today's usd-ratio unless the deployment switched.
    expect(cross.mock.calls[0][2]).toBe('usd-ratio')
    expect(chart.candles[0]).toEqual({ t: HOUR, o: 160, h: 165, l: 158, c: 163, ...NO_VOLUME })
    expect(route).not.toHaveBeenCalled()
  })

  it('in route mode prices a USD-pegged quote along the route where the fold covers it', async () => {
    ohlcv.mockResolvedValue([
      { interval_start: '2026-09-21 13:00:00', open: '4.5', high: '4.6', low: '4.4', close: '4.55' },
      { interval_start: '2026-09-21 14:00:00', open: '4.55', high: '4.6', low: '4.5', close: '4.58' },
    ])
    route.mockResolvedValue(new Map([[HOUR - 3600, { intervalStart: HOUR - 3600, open: '4.52', high: '4.62', low: '4.41', close: '4.56' }]]))
    // Five trades that each paid 0.3 % over the USD ratio.
    const trades = Array.from({ length: 5 }, (_, i) => ({ block_height: 100 + i, asset_in: 10, amount_in: String(4_513_500), amount_out: String(1_000_000), base_usd: '4.5', quote_usd: '1' }))
    const withTrades = { query: async () => ({ json: async () => trades }) }
    const usdRatio = await pairChart(withTrades as never, 5, 10, '1h', 24, NOW, 'usd-ratio')
    expect(usdRatio.tradeFee?.fee).toBeCloseTo(0.003, 6)
    const chart = await pairChart(withTrades as never, 5, 10, '1h', 24, NOW + 1, 'route')
    expect(chart.candles).toEqual([
      { t: HOUR - 3600, o: 4.52, h: 4.62, l: 4.41, c: 4.56, priceSource: 'route', ...NO_VOLUME },
      // One series: the USD candle after a route candle opens at the route close.
      { t: HOUR, o: 4.56, h: 4.6, l: 4.5, c: 4.58, priceSource: 'usd-ratio', ...NO_VOLUME },
    ])
    // The trade fee is measured against the USD ratio: not served beside route candles.
    expect(chart.tradeFee).toBeNull()
  })

  it('draws nothing for two ids that read one series', async () => {
    const chart = await pairChart({} as never, 1003, 22, '1d', 30, NOW)
    expect(chart.candles).toEqual([])
    expect(ohlcv).not.toHaveBeenCalled()
    expect(cross).not.toHaveBeenCalled()
  })

  it('drops a candle outside the window or without a price', async () => {
    cross.mockResolvedValue([
      { intervalStart: 1_000, open: '1', high: '1', low: '1', close: '1' },
      { intervalStart: HOUR, open: '0', high: '1', low: '0', close: '1' },
    ])
    expect((await pairChart({} as never, 110, 0, '1h', 24, NOW)).candles).toEqual([])
    expect(cross.mock.calls[0][1].baseId).toBe(1110)
  })

  // The bucket in progress moves when a block is priced, not on a timer: the chart is
  // keyed on the price head, so a refetch on a pushed price generation is rebuilt
  // for it (and every request at one head shares one build), and the route tail is
  // folded at least to that head.
  it('keys the chart on the price head and folds the route tail up to it', async () => {
    ohlcv.mockResolvedValue([])
    route.mockResolvedValue(new Map())
    await pairChart({} as never, 5, 10, '1h', 24, NOW, 'route', 15_338_000)
    await pairChart({} as never, 5, 10, '1h', 24, NOW, 'route', 15_338_001)
    const charts = keys.filter(k => k.startsWith('explorer:pair-chart:'))
    expect(charts).toHaveLength(2)
    expect(charts[0]).toContain(':h15338000')
    expect(charts[1]).toContain(':h15338001')
    expect(route.mock.calls[1][1]).toMatchObject({ headFloor: 15_338_001 })
  })

  it('carries the pair\'s own volume per bucket, in USD and in base and quote units', async () => {
    cross.mockResolvedValue([{ intervalStart: HOUR, open: '160', high: '165', low: '158', close: '163', volumeBuy: '0', volumeSell: '0', volumeTotal: '0' }])
    pairVolume.mockResolvedValue(new Map([[HOUR, { usd: 1_500_000_000_000_000n, baseBoughtUsd: 0n, base: 2_500_000_000_000_000_000n, quote: 400_000_000_000_000_000_000n }]]))
    const chart = await pairChart({} as never, 5, 0, '1h', 24, NOW)
    expect(pairVolume.mock.calls[0][1]).toMatchObject({ baseId: 5, quoteId: 0, interval: '1h', toSec: HOUR })
    expect(chart.candles[0]).toMatchObject({ t: HOUR, v: 1500, vb: 2.5, vq: 400 })
  })
})
