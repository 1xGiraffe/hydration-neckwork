import { describe, expect, it } from 'vitest'
import { buildBuckets, chooseBucketSize, foldIntoBuckets, liquidationBuckets } from '../src/components/PriceChart'
import type { AssetLiquidationDay } from '../src/types'

// The API's day format (toStartOfDay), which is what the price dates carry too.
function day(date: string, valueUsd: number, amount: string, count = 1): AssetLiquidationDay {
  return { date: `${date} 00:00:00`, valueUsd, amount, count }
}
function dates(...ds: string[]): string[] {
  return ds.map(d => `${d} 00:00:00`)
}

// A liquidation bar claims "this much was seized on the day under this price point".
// The mapping is the whole claim, so these pin it: nothing may be dropped (the card's
// total is folded from the same days), and nothing may land on a day it did not happen.
describe('liquidation bars on the price series', () => {
  const series = dates('2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04')

  it('places a day on its own price point', () => {
    const got = liquidationBuckets([day('2026-01-03', 500, '1000')], series, series.length)
    expect([...got.keys()]).toEqual([2])
    expect(got.get(2)).toEqual({ index: 2, valueUsd: 500, amount: '1000', count: 1 })
  })

  // A gap in the asset's OHLC must not swallow a seizure: the day has no close of its
  // own, so it snaps to the nearest point rather than disappearing from the chart while
  // still counting in the headline total.
  it('snaps a day with no close of its own to the nearest point', () => {
    const gapped = dates('2026-01-01', '2026-01-02', '2026-01-06')
    const got = liquidationBuckets([day('2026-01-05', 90, '7')], gapped, gapped.length)
    expect([...got.keys()]).toEqual([2])
    const before = liquidationBuckets([day('2026-01-03', 90, '7')], gapped, gapped.length)
    expect([...before.keys()]).toEqual([1])
  })

  it('keeps a day beyond either end of the series, clamped to the edge', () => {
    const early = liquidationBuckets([day('2020-06-01', 12, '3')], series, series.length)
    expect([...early.keys()]).toEqual([0])
    const late = liquidationBuckets([day('2030-06-01', 12, '3')], series, series.length)
    expect([...late.keys()]).toEqual([3])
  })

  // Two days landing on one point are one bar, so the bar's height and the hover's
  // figures are the same number. The amount is summed as an integer — raw 18-decimal
  // amounts exceed what a float can add without losing units.
  it('merges days that share a point, summing the amount exactly', () => {
    const gapped = dates('2026-01-01', '2026-01-10')
    const got = liquidationBuckets([
      day('2026-01-08', 100, '999999999999999999', 2),
      day('2026-01-09', 250, '000000000000000001', 3),
    ], gapped, gapped.length)
    expect(got.size).toBe(1)
    expect(got.get(1)).toEqual({ index: 1, valueUsd: 350, amount: '1000000000000000000', count: 5 })
  })

  it('accounts for every day it is given', () => {
    const days = [day('2026-01-01', 1, '1'), day('2026-01-02', 2, '2'), day('2026-01-02', 3, '3'), day('2026-01-04', 4, '4')]
    const got = liquidationBuckets(days, series, series.length)
    const totals = [...got.values()].reduce((s, b) => ({ v: s.v + b.valueUsd, n: s.n + b.count }), { v: 0, n: 0 })
    expect(totals).toEqual({ v: 10, n: 4 })
  })

  // Without dates the chart cannot say which point a day belongs to, and a bar placed
  // by index would be a guess. Better no bars than bars in the wrong place.
  it('draws nothing when the series carries no usable dates', () => {
    expect(liquidationBuckets([day('2026-01-01', 5, '5')], undefined, 4).size).toBe(0)
    expect(liquidationBuckets([day('2026-01-01', 5, '5')], dates('2026-01-01'), 4).size).toBe(0)
    expect(liquidationBuckets([], series, series.length).size).toBe(0)
  })
})

// A bar is a claim about a span of time, and the crosshair has to be able to stop on
// it. Below the addressable limit the chart shows days; above it, coarser buckets —
// otherwise bars overlap their neighbours and the pointer lands on whichever day an
// integer pixel rounded to.
describe('bucket size follows what the plot can address', () => {
  it('keeps days while they fit, then steps to weeks and months', () => {
    expect(chooseBucketSize(180, 180)).toBe('day')
    expect(chooseBucketSize(181, 180)).toBe('week')
    expect(chooseBucketSize(1204, 180)).toBe('week')   // 172 weeks — a 3.3-year history
    expect(chooseBucketSize(1261, 180)).toBe('month')  // 181 weeks, past the limit
    // A phone has a third of the plot width at the same breakpoint the stylesheet uses.
    expect(chooseBucketSize(1204, 80)).toBe('month')
    expect(chooseBucketSize(400, 80)).toBe('week')
  })
})

describe('buckets cover the series exactly once', () => {
  // 2026-01-01 is a Thursday, so a Monday-anchored week splits after the 4th day.
  const jan = Array.from({ length: 14 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')} 00:00:00`)

  it('groups calendar weeks from Monday, not from the first day of history', () => {
    const got = buildBuckets(jan, jan.length, 'week')
    expect(got.map(b => [b.i0, b.i1])).toEqual([[0, 3], [4, 10], [11, 13]])
    expect(got.map(b => b.label)).toEqual(['2026-01-01 – 01-04', '2026-01-05 – 01-11', '2026-01-12 – 01-14'])
  })

  it('labels a month bucket by its month and a single point by its date', () => {
    expect(buildBuckets(jan, jan.length, 'month').map(b => b.label)).toEqual(['2026-01'])
    expect(buildBuckets(jan, jan.length, 'day')[5].label).toBe('2026-01-06')
  })

  it('partitions every point, so no day is dropped or shared', () => {
    for (const size of ['day', 'week', 'month'] as const) {
      const got = buildBuckets(jan, jan.length, size)
      expect(got[0].i0).toBe(0)
      expect(got[got.length - 1].i1).toBe(jan.length - 1)
      got.forEach((b, i) => { if (i) expect(b.i0).toBe(got[i - 1].i1 + 1) })
    }
  })

  // The crosshair pins its dot to `mid` so the marker sits over the middle of the bar
  // covering the same span. Reporting the bucket's close instead put the dot on the
  // bar's right edge, which read as pointing at the next bucket.
  it('reports the middle of each span, not its edge', () => {
    expect(buildBuckets(jan, jan.length, 'week').map(b => b.mid)).toEqual([1, 7, 12])
    expect(buildBuckets(jan, jan.length, 'month').map(b => b.mid)).toEqual([6])
    // A day bucket is its own middle.
    expect(buildBuckets(jan, jan.length, 'day').every(b => b.mid === b.i0 && b.mid === b.i1)).toBe(true)
    for (const size of ['week', 'month'] as const) {
      for (const b of buildBuckets(jan, jan.length, size)) {
        expect(b.mid).toBeGreaterThanOrEqual(b.i0)
        expect(b.mid).toBeLessThanOrEqual(b.i1)
      }
    }
  })

  // Undated series fall back to index spacing, where a calendar bucket has no meaning.
  it('falls back to one bucket per point without usable dates', () => {
    expect(buildBuckets(undefined, 3, 'week').map(b => b.i0)).toEqual([0, 1, 2])
    expect(buildBuckets(dates('2026-01-01'), 3, 'month').map(b => b.i0)).toEqual([0, 1, 2])
  })
})

// The bar, the crosshair stop and the tooltip all read one map, so a bar can never
// show a week's height over a single day's numbers.
describe('daily totals fold onto the buckets they belong to', () => {
  it('sums each bucket exactly, keeping the amount integral', () => {
    const byDay = liquidationBuckets([
      day('2026-01-02', 10, '100', 2),
      day('2026-01-03', 5, '50'),
      day('2026-01-09', 7, '999999999999999999', 3),
    ], dates('2026-01-01', '2026-01-02', '2026-01-03', '2026-01-09'), 4)
    // Points 0..2 in one bucket, point 3 in another.
    const folded = foldIntoBuckets(byDay, Int32Array.from([0, 0, 0, 1]))
    expect(folded.get(0)).toEqual({ index: 0, valueUsd: 15, amount: '150', count: 3 })
    expect(folded.get(1)).toEqual({ index: 1, valueUsd: 7, amount: '999999999999999999', count: 3 })
  })

  it('preserves the totals it was given', () => {
    const byDay = liquidationBuckets([day('2026-01-01', 1, '1'), day('2026-01-02', 2, '2'), day('2026-01-03', 4, '4')],
      dates('2026-01-01', '2026-01-02', '2026-01-03'), 3)
    const folded = foldIntoBuckets(byDay, Int32Array.from([0, 0, 0]))
    expect([...folded.values()]).toEqual([{ index: 0, valueUsd: 7, amount: '7', count: 3 }])
  })
})
