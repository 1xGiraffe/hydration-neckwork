import { describe, expect, it } from 'vitest'
import { activeLiquidity, applyRangeDeltas, assembleV3Series, bucketStartSec, chooseV3Grain, fullRangeGrain, liquiditySegments, rangesToTicks, v3Price, SWAP_GRAIN_MAX_POINTS, type V3RangeDelta, type V3RawBucket } from '../src/services/uniswapV3History.ts'

// The pool page's charts and the public history endpoint share these rules; the
// numbers are the aDOT/HOLLAR pool's (aDOT 10 decimals, HOLLAR 18).

describe('v3Price', () => {
  it('turns the Initialize sqrt price into HOLLAR per aDOT', () => {
    // Initialize(sqrtPriceX96 = 0x28cb9010a808d91a8d95db235065) at block 14359650.
    expect(v3Price(BigInt('0x28cb9010a808d91a8d95db235065'), 10, 18)).toBeCloseTo(1.0907, 3)
    expect(v3Price('862203316974439708502410565924684', 10, 18)).toBeCloseTo(1.1843, 3)
  })
})

describe('chooseV3Grain', () => {
  const day = 86_400
  it('serves a whole life at the coarsest ladder step that fits the point budget', () => {
    // 400 days into 180 points: the 3-day step (2-day gives 200 buckets).
    expect(fullRangeGrain(0, 400 * day, 180).stepSec).toBe(3 * day)
    // A one-day-old pool fits hourly.
    expect(fullRangeGrain(0, day, 180).stepSec).toBe(3_600)
  })
  it('drops to the swaps themselves only for a short window with few swaps', () => {
    // Six hours, 40 swaps: hourly would be 6 points for a 180 budget — show the swaps.
    expect(chooseV3Grain(0, 6 * 3_600, 180, 40)).toEqual({ kind: 'swap' })
    // Six hours but a busy pool: stay on the ladder (hourly).
    const busy = chooseV3Grain(0, 6 * 3_600, 180, SWAP_GRAIN_MAX_POINTS + 1)
    expect(busy.kind).toBe('ladder')
    if (busy.kind === 'ladder') expect(busy.grain.stepSec).toBe(3_600)
    // Three days: hourly is 72 points, enough detail — never swap-level.
    const days = chooseV3Grain(0, 3 * day, 180, 10)
    expect(days.kind).toBe('ladder')
  })
})

describe('bucketStartSec', () => {
  it('reads both key shapes as UTC', () => {
    expect(bucketStartSec('2026-09-09')).toBe(Date.UTC(2026, 8, 9) / 1000)
    expect(bucketStartSec('2026-09-09 08:00:00')).toBe(Date.UTC(2026, 8, 9, 8) / 1000)
  })
})

describe('range liquidity', () => {
  const deltas: V3RangeDelta[] = [
    { tickLower: 0, tickUpper: 200, delta: 55n },
    { tickLower: 100, tickUpper: 300, delta: 10n },
    { tickLower: 0, tickUpper: 200, delta: -20n },
  ]
  it('is the sum of the open ranges straddling the tick — nothing before the pool is initialised', () => {
    const ranges = applyRangeDeltas(new Map(), deltas)
    expect(activeLiquidity(ranges, 150)).toBe(45n)
    expect(activeLiquidity(ranges, 250)).toBe(10n)
    // A range is [lower, upper): the upper tick itself is outside.
    expect(activeLiquidity(ranges, 200)).toBe(10n)
    expect(activeLiquidity(ranges, 300)).toBe(0n)
    expect(activeLiquidity(ranges, null)).toBeNull()
  })
  it('turns the open ranges into initialised ticks and the liquidity per segment between them', () => {
    const ranges = applyRangeDeltas(new Map(), deltas)
    expect(rangesToTicks(ranges)).toEqual([
      { tick: 0, liquidityNet: 35n, liquidityGross: 35n },
      { tick: 100, liquidityNet: 10n, liquidityGross: 10n },
      { tick: 200, liquidityNet: -35n, liquidityGross: 35n },
      { tick: 300, liquidityNet: -10n, liquidityGross: 10n },
    ])
    expect(liquiditySegments(rangesToTicks(ranges))).toEqual([
      { tickLower: 0, tickUpper: 100, liquidity: 35n },
      { tickLower: 100, tickUpper: 200, liquidity: 45n },
      { tickLower: 200, tickUpper: 300, liquidity: 10n },
    ])
    // A range burnt to nothing leaves no tick behind.
    expect(rangesToTicks(applyRangeDeltas(new Map(), [{ tickLower: 0, tickUpper: 200, delta: 5n }, { tickLower: 0, tickUpper: 200, delta: -5n }]))).toEqual([])
  })
})

describe('assembleV3Series', () => {
  const raw = (over: Partial<V3RawBucket>): V3RawBucket => ({
    open: null, high: null, low: null, close: null, tick: null, swaps: 0, inits: 0,
    volume0: 0n, volume1: 0n, fees0: 0n, fees1: 0n, ranges: [], flow0: 0n, flow1: 0n, lastBlock: 1, ...over,
  })
  const grid = ['2026-09-08', '2026-09-09', '2026-09-10'].map(bucket => ({ bucket, t: bucketStartSec(bucket) }))
  const prices = { p0: new Map([['2026-09-08', 1.0], ['2026-09-09', 1.1], ['2026-09-10', 1.2]]), p1: new Map([['2026-09-08', 1.0], ['2026-09-09', 1.0], ['2026-09-10', 1.0]]) }
  const dec = { d0: 10, d1: 18 }
  const empty = { close: null, tick: null, balance0: 0n, balance1: 0n, ranges: [] }

  it('carries the price forward through buckets without a swap, follows the ranges around the tick, and sums holdings', () => {
    const rows = new Map<string, V3RawBucket>([
      // Day 1: the pool is initialised at tick 100 and a position minted over [0, 200); no swap yet —
      // the liquidity is already active, a swap is not what makes it so.
      ['2026-09-08', raw({ inits: 1, open: 1.09, high: 1.09, low: 1.09, close: 1.09, tick: 100, flow0: 10n ** 10n, flow1: 10n ** 18n, ranges: [{ tickLower: 0, tickUpper: 200, delta: 55n }] })],
      // Day 2: two swaps sell HOLLAR for aDOT — the price rises to tick 150, 0.03 aDOT leaves the pool;
      // a second position is minted above the price and does not count yet.
      ['2026-09-09', raw({ swaps: 2, open: 1.17, high: 1.19, low: 1.17, close: 1.18, tick: 150, volume0: 3n * 10n ** 8n, volume1: 3n * 10n ** 16n, fees1: 9n * 10n ** 13n, flow0: -(3n * 10n ** 8n), flow1: 3n * 10n ** 16n, ranges: [{ tickLower: 300, tickUpper: 400, delta: 10n }] })],
      // Day 3: no swap; part of the first position is burnt.
      ['2026-09-10', raw({ ranges: [{ tickLower: 0, tickUpper: 200, delta: -20n }] })],
    ])
    const out = assembleV3Series(grid, rows, empty, prices, dec)
    expect(out.map(p => [p.bucket, p.open, p.close, p.swaps, p.liquidity])).toEqual([
      ['2026-09-08', 1.09, 1.09, 0, '55'],
      ['2026-09-09', 1.17, 1.18, 2, '55'],
      // No swap on day 3: the price is the standing close; the burn thinned the active range.
      ['2026-09-10', 1.18, 1.18, 0, '35'],
    ])
    expect(out[1].high).toBe(1.19)
    expect(out[2].high).toBe(1.18)
    // Holdings run: 1 aDOT + 1 HOLLAR, then −0.03 aDOT + 0.03 HOLLAR.
    expect(out[0].balance0).toBe('10000000000'); expect(out[0].balance1).toBe('1000000000000000000')
    expect(out[1].balance0).toBe('9700000000'); expect(out[2].balance1).toBe('1030000000000000000')
    // TVL at day 2's closes: 0.97 aDOT × 1.1 + 1.03 HOLLAR × 1.0.
    expect(out[1].tvlUsd).toBeCloseTo(0.97 * 1.1 + 1.03, 9)
    // Volume is one side of the swap, so the mean of the two priced sides; fees are summed.
    expect(out[1].volumeUsd).toBeCloseTo((0.03 * 1.1 + 0.03 * 1.0) / 2, 9)
    expect(out[1].feesUsd).toBeCloseTo(0.00009, 9)
    expect(out[2].volumeUsd).toBe(0)
  })

  it('starts a window from what already stood before it — price, tick and open ranges', () => {
    const carry = { close: 1.5, tick: 120, balance0: 5n, balance1: 7n, ranges: [{ tickLower: 0, tickUpper: 200, delta: 9n }, { tickLower: 500, tickUpper: 600, delta: 4n }] }
    const out = assembleV3Series(grid.slice(1), new Map(), carry, prices, dec)
    expect(out[0]).toMatchObject({ open: 1.5, close: 1.5, liquidity: '9', balance0: '5', balance1: '7', swaps: 0 })
  })

  it('has no liquidity figure before the pool is initialised, even with a position minted', () => {
    const out = assembleV3Series(grid.slice(0, 1), new Map([['2026-09-08', raw({ ranges: [{ tickLower: 0, tickUpper: 200, delta: 5n }] })]]), empty, prices, dec)
    expect(out[0].liquidity).toBeNull()
  })

  it('never reports a negative holding', () => {
    const out = assembleV3Series(grid.slice(0, 1), new Map([['2026-09-08', raw({ flow0: -5n })]]), empty, prices, dec)
    expect(out[0].balance0).toBe('0')
  })
})
