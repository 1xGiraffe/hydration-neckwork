import { describe, expect, it } from 'vitest'
import { crossChainCandles } from '../../src/public/routes/prices.ts'
import { ONE_CLICK_PLATFORMS, KRAKEN_INTERVALS, foreignCandleTtlMs, platformForOneClickAsset } from '../../src/public/services/foreignCandles.ts'

// A cross-chain swap's destination does not trade on Hydration, so the pair is
// composed from two independent USD series — the asset's own candles and the
// destination's from Kraken. These pin the rules that make that honest: no future
// price, no invented history before the Hydration series starts, and an envelope
// that widens rather than narrows.

const SCALE = 18
const hour = 3600
// $0.01 per HDX at t=0, $0.02 at t=2h.
const HYDRATION = [
  { time: 0 * hour, close: '0.01' },
  { time: 2 * hour, close: '0.02' },
]
const foreign = (time: number, o: string, h: string, l: string, c: string) => ({ time, open: o, high: h, low: l, close: c })

describe('crossChainCandles', () => {
  it('quotes assetIn in the destination — usd(base) / usd(destination)', () => {
    // NEAR at $2; HDX at $0.01 => one HDX buys 0.005 NEAR.
    const [candle] = crossChainCandles([foreign(0, '2', '2', '2', '2')], HYDRATION, SCALE, false)
    expect(candle?.close).toBe('0.005')
    expect(candle?.open).toBe('0.005')
    expect(candle?.timestamp).toBe('1970-01-01T00:00:00.000Z')
  })

  it('prices each bucket with the close that had already happened, never a later one', () => {
    // The 1h candle sits between the two Hydration closes: it must use the
    // t=0 close ($0.01), not the t=2h one that had not happened yet.
    const rows = crossChainCandles(
      [foreign(1 * hour, '2', '2', '2', '2'), foreign(2 * hour, '2', '2', '2', '2')],
      HYDRATION, SCALE, false,
    )
    expect(rows.map(r => r.close)).toEqual(['0.005', '0.01'])
  })

  it('drops a foreign candle older than the first Hydration close rather than back-filling it', () => {
    const rows = crossChainCandles(
      [foreign(-2 * hour, '2', '2', '2', '2'), foreign(0, '2', '2', '2', '2')],
      HYDRATION, SCALE, false,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.timestamp).toBe('1970-01-01T00:00:00.000Z')
  })

  it('inverts high and low, so the pair’s high is the destination’s low', () => {
    // Destination ranged $1–$4 while the base held $0.01: one base unit buys
    // between 0.0025 (at $4) and 0.01 (at $1) of it.
    const [candle] = crossChainCandles([foreign(0, '2', '4', '1', '2')], HYDRATION, SCALE, false)
    expect(candle?.high).toBe('0.01')
    expect(candle?.low).toBe('0.0025')
    // The envelope must contain both exact ends.
    expect(Number(candle!.low)).toBeLessThanOrEqual(Number(candle!.open))
    expect(Number(candle!.high)).toBeGreaterThanOrEqual(Number(candle!.close))
  })

  it('treats a dollar-pegged base as 1 and needs no Hydration series for it', () => {
    // $1 base, $2 destination => one base unit buys 0.5 destination units.
    const [candle] = crossChainCandles([foreign(5 * hour, '2', '2', '2', '2')], [], SCALE, true)
    expect(candle?.close).toBe('0.5')
  })

  it('has nothing to say without one of the two series', () => {
    expect(crossChainCandles([], HYDRATION, SCALE, false)).toEqual([])
    expect(crossChainCandles([foreign(0, '2', '2', '2', '2')], [], SCALE, false)).toEqual([])
  })

  it('skips a bucket whose destination price is zero rather than dividing by it', () => {
    expect(crossChainCandles([foreign(0, '0', '0', '0', '0')], HYDRATION, SCALE, false)).toEqual([])
  })

  it('keeps full precision on a rate that is not a round decimal', () => {
    // $0.01 / $3 recurs; the quotient is integer arithmetic at 18 dp, not a float.
    const [candle] = crossChainCandles([foreign(0, '3', '3', '3', '3')], HYDRATION, SCALE, false)
    expect(candle?.close).toBe('0.003333333333333333')
  })
})

describe('foreign candle plumbing', () => {
  it('prices only the destinations the swap SDK actually offers', () => {
    expect(platformForOneClickAsset('nep141:wrap.near')).toBe('near')
    expect(platformForOneClickAsset('nep141:zec.omft.near')).toBe('zec')
    // An unpriced destination resolves to nothing, so the route 400s instead of
    // pricing it off an adjacent market.
    expect(platformForOneClickAsset('nep141:usdt.tether-token.near')).toBeUndefined()
    expect(Object.keys(ONE_CLICK_PLATFORMS)).toHaveLength(2)
  })

  it('has a Kraken interval for every bucket the price routes serve', () => {
    for (const bucket of ['5m', '15m', '30m', '1h', '4h', '1d', '1w']) {
      expect(KRAKEN_INTERVALS[bucket]).toBeGreaterThan(0)
    }
    // 1m is excluded from the price buckets and has no interval here either.
    expect(KRAKEN_INTERVALS['1m']).toBeUndefined()
  })

  it('scales the upstream TTL to the bucket, with a floor and a ceiling', () => {
    expect(foreignCandleTtlMs(300)).toBe(60_000)      // 5m bucket -> 1 min
    expect(foreignCandleTtlMs(60)).toBe(30_000)       // floored
    expect(foreignCandleTtlMs(604_800)).toBe(300_000) // capped at 5 min
  })
})
