import { describe, it, expect } from 'vitest'
import {
  buildValueSparkline,
  sparklineCalendarWindowStart,
  resampleValueSeriesToTrailingYear,
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

describe('resampleValueSeriesToTrailingYear', () => {
  // now anchored mid-week; window start is the Monday 52 weeks earlier (2025-07-07).
  const now = new Date('2026-07-08T12:00:00Z')

  it('always returns SPARK_WEEKS buckets', () => {
    expect(resampleValueSeriesToTrailingYear([100], ['2026-06-15 00:00:00'], now)).toHaveLength(SPARK_WEEKS)
  })

  it('left-pads a young account with zeros to a full year, then forward-fills', () => {
    const out = resampleValueSeriesToTrailingYear([100], ['2026-06-15 00:00:00'], now)
    expect(out[0]).toBe(0)                       // a year ago the account held nothing
    expect(out.some(v => v === 0)).toBe(true)    // left-padded
    expect(out[SPARK_WEEKS - 1]).toBe(100)       // forward-filled to now
  })

  it('clamps an older-than-1Y account: bucket 0 carries the value as of ~1Y ago', () => {
    const out = resampleValueSeriesToTrailingYear([10, 50], ['2024-01-01 00:00:00', '2026-07-01 00:00:00'], now)
    expect(out[0]).toBe(10)                       // pre-window value carried into the first bucket (not 0)
    expect(out[SPARK_WEEKS - 1]).toBe(50)         // latest value at the end
  })

  it('is empty-safe', () => {
    expect(resampleValueSeriesToTrailingYear([], [], now)).toEqual(new Array(SPARK_WEEKS).fill(0))
  })
})

// The accounts directory folds a row's members in ClickHouse: per (account, asset)
// the week's last state CARRIED forward from the baseline, then summed per (row,
// asset, week), and buildValueSparkline runs on those sums under the row's key.
// That is exact only because the carry happens before the sum — a sum of the raw
// weekly states would drop an account's holding in every week it was not observed.
describe('buildValueSparkline over row-folded states', () => {
  const carried = (obs: { account_id: string; asset_id: string; b: number; bal: string }[], baseline: Map<string, string>) => {
    const byKey = new Map<string, Map<number, bigint>>()
    for (const [k, bal] of baseline) byKey.set(k, new Map([[-1, BigInt(bal)]]))
    for (const r of obs) (byKey.get(`${r.account_id}|${r.asset_id}`) ?? byKey.set(`${r.account_id}|${r.asset_id}`, new Map()).get(`${r.account_id}|${r.asset_id}`)!).set(r.b, BigInt(r.bal))
    const sums = new Map<string, bigint>()
    for (const [k, m] of byKey) {
      const asset = k.slice(k.indexOf('|') + 1)
      let bal = m.get(-1) ?? null
      for (let b = -1; b < SPARK_WEEKS; b++) {
        if (m.has(b)) bal = m.get(b)!
        if (bal != null && bal > 0n) sums.set(`${asset}|${b}`, (sums.get(`${asset}|${b}`) ?? 0n) + bal)
      }
    }
    const rows = [...sums].map(([k, v]) => ({ asset_id: k.slice(0, k.indexOf('|')), b: Number(k.slice(k.indexOf('|') + 1)), bal: v.toString() }))
    return {
      obs: rows.filter(r => r.b >= 0).map(r => ({ account_id: 'row', asset_id: r.asset_id, b: r.b, bal: r.bal })),
      baseline: new Map(rows.filter(r => r.b === -1).map(r => [`row|${r.asset_id}`, r.bal])),
    }
  }

  it('equals the per-account assembly when members are observed in different weeks', () => {
    // A: baseline 100, observed at week 10 (300) and 40 (0). B: born at week 5 (50),
    // observed again at week 20 (70). Prices 2 throughout, 12 decimals.
    const obs = [
      { account_id: 'a', asset_id: '5', b: 10, bal: '300000000000000' },
      { account_id: 'a', asset_id: '5', b: 40, bal: '0' },
      { account_id: 'b', asset_id: '5', b: 5, bal: '50000000000000' },
      { account_id: 'b', asset_id: '5', b: 20, bal: '70000000000000' },
    ]
    const baseline = new Map([['a|5', '100000000000000']])
    const prices = px('5', 2)
    const decimals = new Map([['5', 12]])
    const perAccount = buildValueSparkline(obs, baseline, prices, decimals)!
    const folded = carried(obs, baseline)
    expect(buildValueSparkline(folded.obs, folded.baseline, prices, decimals)).toEqual(perAccount)
    expect(perAccount[0]).toBe(200)   // A's baseline alone
    expect(perAccount[5]).toBe(300)   // + B's 50
    expect(perAccount[10]).toBe(700)  // A now 300
    expect(perAccount[20]).toBe(740)  // B now 70
    expect(perAccount[40]).toBe(140)  // A out
  })

  it('a sum of the raw weekly states is not the same series', () => {
    const obs = [
      { account_id: 'a', asset_id: '5', b: 10, bal: '300000000000000' },
      { account_id: 'b', asset_id: '5', b: 5, bal: '50000000000000' },
    ]
    const prices = px('5', 2)
    const decimals = new Map([['5', 12]])
    const perAccount = buildValueSparkline(obs, new Map(), prices, decimals)!
    // Raw states under one key: week 10 overwrites the carry instead of adding to it.
    const raw = buildValueSparkline(obs.map(r => ({ ...r, account_id: 'row' })), new Map(), prices, decimals)!
    expect(raw[10]).toBe(600)
    expect(perAccount[10]).toBe(700)
  })
})
