import { describe, expect, it } from 'vitest'
import {
  apportionByShare,
  assetVolumeIds,
  assetVolumeOwner,
  carryStateOnGrid,
  changePct,
  dailyCloses,
  kpisOf,
  listEntryPoolKey,
  meanOfLast,
  pickStackIds,
  rangeRequest,
  ratio,
  stateAgo,
  windowSumsSql,
  ZERO_SUMS,
} from '../src/services/volumeHistory.ts'
import type { PoolListEntry } from '../src/services/poolService.ts'

// The explorer's volume surfaces (services/volumeHistory.ts): the window
// arithmetic, the asset fold, the Omnipool's per-asset split and the list keys.
// The SQL folds themselves are the hourly models' (tests/volumeHourly.test.ts).

describe('rolling windows', () => {
  it('sums the current span below the cut and the span before it, never past the cut', () => {
    const sql = windowSumsSql('volume_usd')
    expect(sql).toContain('sumIf(volume_usd, hour >= {cut:DateTime} - INTERVAL 24 HOUR)) AS d1')
    expect(sql).toContain('sumIf(volume_usd, hour >= {cut:DateTime} - INTERVAL 48 HOUR AND hour < {cut:DateTime} - INTERVAL 24 HOUR)) AS p1')
    expect(sql).toContain('INTERVAL 168 HOUR)) AS d7')
    expect(sql).toContain('INTERVAL 1440 HOUR AND hour < {cut:DateTime} - INTERVAL 720 HOUR)) AS p30')
    expect(sql).toContain('sumIf(volume_usd, hour >= {cut:DateTime} - INTERVAL 8760 HOUR)) AS d365')
    expect(sql).toContain('INTERVAL 17520 HOUR AND hour < {cut:DateTime} - INTERVAL 8760 HOUR)) AS p365')
  })

  it('states a change against the previous period, and none without one', () => {
    expect(changePct(150, 100)).toBe(50)
    expect(changePct(50, 100)).toBe(-50)
    expect(changePct(10, 0)).toBeNull()
    const k = kpisOf({ ...ZERO_SUMS, d1: 2, p1: 1 })
    expect(k.d1).toEqual({ volumeUsd: 2, prevUsd: 1, changePct: 100 })
    expect(k.d7.changePct).toBeNull()
  })

  it('opens the range tabs at their span below the cut, clamped to the first hour', () => {
    const cut = { cut: '2026-10-02 02:00:00', cutSec: Date.UTC(2026, 9, 2, 2) / 1000 }
    expect(rangeRequest('30d', cut, 0)).toEqual({ fromSec: cut.cutSec - 30 * 86_400, toSec: cut.cutSec - 1, points: 400 })
    expect(rangeRequest('all', cut, 1_700_000_000).fromSec).toBe(1_700_000_000)
    expect(rangeRequest('1y', cut, cut.cutSec - 86_400).fromSec).toBe(cut.cutSec - 86_400)
  })
})

describe('volume / TVL', () => {
  const points = [
    { key: '2026-09-28', v: 100 }, { key: '2026-09-29', v: null }, { key: '2026-09-30', v: 200 }, { key: '2026-10-01', v: 300 },
    { key: '2026-10-02', v: 9_999 },
  ]

  it('divides by the mean of the last N daily points before the cut, skipping unpriced days', () => {
    const cutSec = Date.UTC(2026, 9, 2, 2) / 1000
    // 2026-10-02 opens before the cut but is the live day; it is the newest point and counts.
    expect(meanOfLast(points.slice(0, 4), 2, cutSec)).toBe(250)
    expect(meanOfLast(points.slice(0, 4), 7, cutSec)).toBe(200)
    expect(meanOfLast([], 7, cutSec)).toBeNull()
  })

  it('has no ratio without a positive denominator', () => {
    expect(ratio(50, 200)).toBe(0.25)
    expect(ratio(50, 0)).toBeNull()
    expect(ratio(50, null)).toBeNull()
  })

  it('reads "TVL N ago" as the daily close ending nearest the instant, never one past the cut', () => {
    const D = 86_400
    // Cut 2026-10-02 10:00: 24 h before is 10-01 10:00, nearest close is the end of 09-30.
    const cutSec = Date.UTC(2026, 9, 2, 10) / 1000
    expect(stateAgo(points, D, cutSec, D)).toEqual({ usd: 200, at: '2026-10-01T00:00:00.000Z' })
    // At 20:00 the end of 10-01 (midnight ahead) is nearer, and it has ended before the cut.
    const late = Date.UTC(2026, 9, 2, 20) / 1000
    expect(stateAgo(points, D, late, D)).toEqual({ usd: 300, at: '2026-10-02T00:00:00.000Z' })
    // The live day 10-02 ends after the cut and is never the answer; an unpriced close is none.
    expect(stateAgo(points, D, Date.UTC(2026, 9, 2, 23) / 1000, 0).usd).toBe(300)
    expect(stateAgo(points, D, Date.UTC(2026, 9, 1, 0) / 1000, D).usd).toBeNull()
    // Before the series opens there was no pool.
    expect(stateAgo(points, D, cutSec, 365 * D)).toEqual({ usd: null, at: null })
  })

  it('folds a finer series to each day\'s last point', () => {
    expect(dailyCloses([
      { key: '2026-09-30 06:00:00', v: 1 }, { key: '2026-09-30 18:00:00', v: 2 }, { key: '2026-10-01 00:00:00', v: 3 },
    ])).toEqual([{ key: '2026-09-30', v: 2 }, { key: '2026-10-01', v: 3 }])
  })

  it('carries TVL onto the grid as the state at each bucket end', () => {
    const grid = { keys: ['2026-09-27', '2026-09-29', '2026-10-01'], stepSec: 2 * 86_400 }
    expect(carryStateOnGrid(grid, points.slice(0, 4))).toEqual([100, 200, 300])
    expect(carryStateOnGrid({ keys: ['2026-09-20', '2026-09-22'], stepSec: 2 * 86_400 }, points)).toEqual([null, null])
  })
})

describe('the asset fold', () => {
  it("counts an asset's money-market aToken with it, never the hub", () => {
    expect(assetVolumeIds(5).sort((a, b) => a - b)).toEqual([5, 1001])
    expect(assetVolumeIds(1001)).toEqual([1001])
    expect(assetVolumeIds(1)).toEqual([])
  })

  it('ranks an aToken under its reserve, so a list and the page agree', () => {
    expect(assetVolumeOwner(1001)).toBe(5)
    expect(assetVolumeOwner(5)).toBe(5)
    expect(assetVolumeOwner(0)).toBe(0)
  })
})

describe("the Omnipool's per-asset bands", () => {
  it("splits each bucket's venue volume by the assets' share, so the bands sum to it", () => {
    const out = apportionByShare([100, 50, 30], new Map([['a:0', [30, 0, 0]], ['a:5', [10, 20, 0]]]))
    expect(out['a:0']).toEqual([75, 0, 0])
    expect(out['a:5']).toEqual([25, 50, 0])
    // Volume with no asset rows stays whole, in the remainder band.
    expect(out.other).toEqual([0, 0, 30])
    for (let i = 0; i < 3; i++) expect(out['a:0'][i] + out['a:5'][i] + out.other[i]).toBeCloseTo([100, 50, 30][i])
  })

  it('stacks HDX, the last year\'s leaders and the era leaders, at most ten, by all-time volume', () => {
    const rows = [
      { id: 0, month: '2023-01-01', usd: 1, recentUsd: 0 }, { id: 0, month: '2026-09-01', usd: 5, recentUsd: 5 },
      { id: 5, month: '2023-01-01', usd: 100, recentUsd: 0 },
      ...Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, month: '2026-09-01', usd: 10 + i, recentUsd: 10 + i })),
    ]
    const ids = pickStackIds(rows)
    // HDX + six recent leaders + the four peak-share leaders, overlapping: 5 is new, three are recent ones.
    expect(ids.length).toBe(8)
    expect(ids).not.toContain(100)
    expect(ids).toContain(0)
    expect(ids).toContain(5)
    expect(ids).toContain(111)
    expect(ids[0]).toBe(5)
  })
})

describe('pools list keys', () => {
  const entry = (e: Partial<PoolListEntry>): PoolListEntry => ({ kind: 'stableswap', poolId: null, name: '', tvlUsd: null, sharePct: null, composition: [], hasPegs: false, ...e })
  const xyk = new Map([[1_000_042, '0xabc']])

  it('keys each venue the way pool_volume_hourly does', () => {
    expect(listEntryPoolKey(entry({ kind: 'omnipool' }), xyk)).toBe('omnipool:omnipool')
    expect(listEntryPoolKey(entry({ kind: 'stableswap', poolId: 111 }), xyk)).toBe('stableswap:111')
    expect(listEntryPoolKey(entry({ kind: 'xyk', poolId: 1_000_042 }), xyk)).toBe('xyk:0xabc')
    expect(listEntryPoolKey(entry({ kind: 'xyk', poolId: 7 }), xyk)).toBeNull()
    expect(listEntryPoolKey(entry({ kind: 'uniswapv3', address: '0xAbC' }), xyk)).toBe('uniswapv3:0xabc')
  })
})
