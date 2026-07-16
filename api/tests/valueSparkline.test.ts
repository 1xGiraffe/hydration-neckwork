import { describe, it, expect } from 'vitest'
import {
  buildValueSparkline,
  sparklineCalendarWindowStart,
  SPARK_WEEKS,
} from '../src/services/explorerService.ts'

// 1Y account-list sparkline: weekly buckets over the trailing year, assembled from
// in-window balance observations (forward-filled per account+asset), an exact
// pre-window baseline (so dormant accounts show their real flat value, not 0),
// and weekly close prices per asset. Young accounts get leading zeros — the
// series is always SPARK_WEEKS points so every row spans the same 1Y range.
const px = (assetId: string, closes: number) => ({ [assetId]: new Map(Array.from({ length: SPARK_WEEKS }, (_, b) => [b, closes])) })

describe('sparklineCalendarWindowStart', () => {
  it('anchors the 53 buckets to Monday UTC even mid-week', () => {
    expect(sparklineCalendarWindowStart(new Date('2026-07-08T18:45:00Z')).toISOString())
      .toBe('2025-07-07T00:00:00.000Z')
  })

  it('uses the previous Monday for Sunday across a year boundary', () => {
    expect(sparklineCalendarWindowStart(new Date('2026-01-04T23:59:59Z')).toISOString())
      .toBe('2024-12-30T00:00:00.000Z')
  })

  it('keeps an exact Monday boundary stable', () => {
    expect(sparklineCalendarWindowStart(new Date('2026-07-06T00:00:00Z')).toISOString())
      .toBe('2025-07-07T00:00:00.000Z')
  })
})

describe('buildValueSparkline', () => {
  it('always returns SPARK_WEEKS points', () => {
    const s = buildValueSparkline([], new Map(), { '5': new Map() }, new Map([['5', 10]]))
    expect(s).not.toBeNull()
    expect(s).toHaveLength(SPARK_WEEKS)
    expect(s?.every(v => v === 0)).toBe(true)
  })

  it('dormant account: baseline only → flat line at its value', () => {
    // 2 DOT (10 decimals) held since before the window, price $5 every week.
    const base = new Map([['0xa|5', '20000000000']])
    const s = buildValueSparkline([], base, px('5', 5), new Map([['5', 10]]))!
    expect(s[0]).toBeCloseTo(10)
    expect(s[SPARK_WEEKS - 1]).toBeCloseTo(10)
    expect(new Set(s).size).toBe(1)
  })

  it('young account: zeros until the first observation, forward-filled after', () => {
    const obs = [{ account_id: '0xa', asset_id: '5', b: 10, bal: '20000000000' }]
    const s = buildValueSparkline(obs, new Map(), px('5', 5), new Map([['5', 10]]))!
    expect(s[0]).toBe(0)
    expect(s[9]).toBe(0)
    expect(s[10]).toBeCloseTo(10)
    expect(s[SPARK_WEEKS - 1]).toBeCloseTo(10)
  })

  it('sums accounts independently (tag groups) and values per-bucket price', () => {
    const obs = [
      { account_id: '0xa', asset_id: '5', b: 0, bal: '10000000000' },  // 1 DOT from week 0
      { account_id: '0xb', asset_id: '5', b: 26, bal: '10000000000' }, // +1 DOT from week 26
    ]
    const prices = { '5': new Map([[0, 4], [26, 8]]) }  // price forward-fills 4 → 8
    const s = buildValueSparkline(obs, new Map(), prices, new Map([['5', 10]]))!
    expect(s[0]).toBeCloseTo(4)    // 1 DOT × $4
    expect(s[25]).toBeCloseTo(4)   // price forward-filled
    expect(s[26]).toBeCloseTo(16)  // 2 DOT × $8
  })

  it('returns explicit incompleteness when an asset has no weekly closes', () => {
    const base = new Map([['0xa|5', '10000000000']])
    expect(buildValueSparkline([], base, { '5': new Map() }, new Map([['5', 10]]))).toBeNull()
  })
})
