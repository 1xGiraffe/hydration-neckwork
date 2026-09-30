import { beforeEach, describe, expect, it, vi } from 'vitest'

// The explorer's pair chart reads the same two leaves as the public pair route: the
// base asset's own USD candles when the quote IS the dollar, the per-block cross rate
// otherwise — after resolving each leg to the series that prices it.
const ohlcv = vi.fn()
const cross = vi.fn()
vi.mock('../src/services/ohlcvService.ts', () => ({ queryOHLCV: (...a: unknown[]) => ohlcv(...a) }))
vi.mock('../src/services/crossPair.ts', () => ({ queryCrossPairCandles: (...a: unknown[]) => cross(...a) }))
vi.mock('../src/services/assetsService.ts', () => ({ getAssetById: (id: number) => (id === 10 ? { assetId: 10, isUsdPegged: true } : { assetId: id, isUsdPegged: false }) }))
// aUSDC (1003) prices as USDC (22); 2-Pool-HUSDC (110) as HUSDC (1110).
vi.mock('../src/services/explorerAssets.ts', () => ({ priceAssetId: (id: number) => ({ 1003: 22, 110: 1110, 1002: 10 } as Record<number, number>)[id] ?? id }))
vi.mock('../src/services/cache.ts', () => ({ cached: (_key: string, _ttl: number, fn: () => unknown) => fn() }))

const { pairChart } = await import('../src/services/pairChartService.ts')
const NOW = 1_790_000_000 // 2026-09-21 14:13:20 UTC
const HOUR = Math.floor(NOW / 3600) * 3600 // 14:00, the bucket in progress

beforeEach(() => { ohlcv.mockReset(); cross.mockReset() })

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
    expect(chart.candles).toEqual([{ t: HOUR, o: 4.5, h: 4.6, l: 4.4, c: 4.55 }])
  })

  it('reads any other quote as the exact per-block cross rate', async () => {
    cross.mockResolvedValue([{ intervalStart: HOUR, open: '160', high: '165', low: '158', close: '163', volumeBuy: '0', volumeSell: '0', volumeTotal: '0' }])
    const chart = await pairChart({} as never, 5, 0, '1h', 24, NOW)
    expect(cross.mock.calls[0][1]).toMatchObject({ baseId: 5, quoteId: 0, interval: '1h' })
    expect(chart.candles[0]).toEqual({ t: HOUR, o: 160, h: 165, l: 158, c: 163 })
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
})
