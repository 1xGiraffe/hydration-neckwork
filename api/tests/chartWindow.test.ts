import { beforeEach, describe, expect, it } from 'vitest'
import { resetCacheForTests } from '../src/services/cache.ts'
import type { BlockClock } from '../src/services/blockClock.ts'
import { alignToGrid, carryForwardValues, chartWindowGrid, fullChartGrid, MAX_HEIGHT, sumCarriedStates } from '../src/services/chartWindow.ts'
import { MONDAY_ANCHOR_SEC } from '../src/services/bucketLadder.ts'
import { grainBucketEndSec, makeGrain, MONTHLY_GRAIN, WEEKLY_MONDAY_GRAIN } from '../src/services/historyGrain.ts'
import {
  getHollarChartWindow, hollarBorrowersSql, hollarCompositionSql, hollarDebtSql, hollarDepthSql, hollarFacilitatorLevelsSql,
  hollarHoldersSql, hollarPegSql, hollarRevenueSql, hollarStableShareSql, hsmArbitrageSql, initHollarService,
} from '../src/services/hollarService.ts'

const H = 3_600
const D = 86_400
const at = (iso: string) => Date.parse(`${iso}Z`) / 1000

describe('calendar grains', () => {
  it('keys Monday weeks exactly as toStartOfWeek(ts, 1) does', () => {
    // 2026-09-24 is a Thursday — the epoch-anchored 7-day lattice would start there.
    expect(WEEKLY_MONDAY_GRAIN.keyOf(at('2026-09-24T13:00:00'))).toBe('2026-09-21')
    expect(WEEKLY_MONDAY_GRAIN.keyOf(at('2026-09-21T00:00:00'))).toBe('2026-09-21')
    expect(WEEKLY_MONDAY_GRAIN.grid(at('2025-09-22T00:00:00'), at('2025-10-08T00:00:00'))).toEqual(['2025-09-22', '2025-09-29', '2025-10-06'])
    // Anchored arithmetic, not toStartOfInterval (epoch-anchored), in the SQL too.
    expect(WEEKLY_MONDAY_GRAIN.keySql('ts')).toBe(`toString(toDate(toDateTime(345600 + intDiv(toInt64(toUnixTimestamp(ts)) - 345600, 604800) * 604800)))`)
  })

  it('leaves the epoch-anchored grains byte-for-byte as they were', () => {
    expect(makeGrain(7 * D).keySql('ts')).toBe('toString(toDate(toStartOfInterval(ts, INTERVAL 7 DAY)))')
    expect(makeGrain(H, 1000).keySql('ts')).toBe('toString(toStartOfInterval(greatest(ts, toDateTime(1000)), INTERVAL 1 HOUR))')
  })

  it('grids calendar months and ends each at the next month start', () => {
    expect(MONTHLY_GRAIN.grid(at('2025-09-22T00:00:00'), at('2026-01-03T00:00:00'))).toEqual(['2025-09-01', '2025-10-01', '2025-11-01', '2025-12-01', '2026-01-01'])
    expect(grainBucketEndSec(MONTHLY_GRAIN, '2026-02-01')).toBe(at('2026-03-01T00:00:00'))
    expect(grainBucketEndSec(WEEKLY_MONDAY_GRAIN, '2026-09-21')).toBe(at('2026-09-28T00:00:00'))
    expect(MONTHLY_GRAIN.keySql('ts')).toBe('toString(toStartOfMonth(ts))')
  })
})

// An hourly clock over ten days, one block every 6 s from height 1000.
function clockOver(fromSec: number, hours: number, lastTime?: number): BlockClock {
  const marks = Array.from({ length: hours }, (_, i) => fromSec + i * H)
  return {
    hours: marks,
    heights: marks.map((_, i) => 1000 + (i + 1) * 600 - 1),
    atMark: marks.map((_, i) => 1000 + i * 600),
    lastTime: lastTime ?? marks[marks.length - 1] + H - 6,
    builtAt: 0,
  }
}

describe('chartWindowGrid', () => {
  const t0 = at('2026-09-18T00:00:00')
  const clock = clockOver(t0, 240) // head 2026-09-27 23:59:54

  it('refines a three-day window to hourly buckets, keyed by bucket start', () => {
    const w = chartWindowGrid(clock, { fromSec: at('2026-09-20T00:30:00'), toSec: at('2026-09-23T00:00:00'), points: 180 }, { startSec: t0 })!
    expect(w.grid.grain.stepSec).toBe(H)
    expect(w.grid.keys[0]).toBe('2026-09-20 00:00:00')
    expect(w.grid.keys.at(-1)).toBe('2026-09-23 00:00:00')
    expect(w.grid.fromSec).toBe(at('2026-09-20T00:00:00'))
    expect(w.grid.endSec).toBe(at('2026-09-23T01:00:00'))
    // The first bucket's rows start at or above fromHeight; the grain folds earlier ones into it.
    expect(w.grid.fromHeight).toBe(1000 + 48 * 600)
    expect(w.grid.grain.keySql('ts')).toContain(`greatest(ts, toDateTime(${w.grid.fromSec}))`)
    // The clock has seen blocks past the end, so the upper bound is the last block of the end's hour.
    expect(w.grid.toHeight).toBe(1000 + (73 + 48 + 1) * 600 - 1)
    // Closed: the head is more than the finality margin past the end.
    expect(w.ttlMs).toBe(600_000)
  })

  it('coarsens a two-month window, and never emits a bucket past the indexed head', () => {
    const long = clockOver(at('2026-07-01T00:00:00'), 24 * 88)
    const head = long.lastTime!
    const w = chartWindowGrid(long, { fromSec: head - 60 * D, toSec: head + 30 * D, points: 180 }, { startSec: 0 })!
    expect(w.grid.grain.stepSec).toBe(12 * H)
    expect(w.grid.endSec).toBeGreaterThan(head)
    expect(w.grid.endSec - w.grid.grain.stepSec).toBeLessThanOrEqual(head)
    // A window reaching the head lifts the height bound and stays short-lived.
    expect(w.grid.toHeight).toBe(MAX_HEIGHT)
    expect(w.ttlMs).toBe(60_000)
  })

  it('clamps to the series start and answers null for a window wholly past the head', () => {
    const w = chartWindowGrid(clock, { fromSec: t0 - 30 * D, toSec: t0 + 2 * D, points: 180 }, { startSec: t0 + D })!
    expect(w.grid.keys[0]).toBe('2026-09-19 00:00:00')
    expect(chartWindowGrid(clock, { fromSec: t0 + 20 * D, toSec: t0 + 21 * D, points: 180 }, { startSec: t0 })).toBeNull()
  })

  it('lays a fixed step the ladder lacks on Monday weeks, whole hours only', () => {
    const long = clockOver(at('2023-01-01T00:00:00'), 24 * 400)
    const req = { fromSec: at('2023-01-02T00:00:00'), toSec: at('2024-01-01T00:00:00'), points: 10 }
    // Ten points over a year resolve to the 45-day rung on their own.
    expect(chartWindowGrid(long, req, { startSec: 0 })!.grid.grain.stepSec).toBe(45 * D)
    const w = chartWindowGrid(long, req, { startSec: 0, stepSec: 49 * D })!
    expect(w.grid.grain.stepSec).toBe(49 * D)
    expect(w.grid.keys.every(k => new Date(`${k}T00:00:00Z`).getUTCDay() === 1)).toBe(true)
    expect(w.grid.keys.length).toBeLessThanOrEqual(10)
    expect((w.grid.fromSec - MONDAY_ANCHOR_SEC) % (7 * D)).toBe(0)
    expect(() => chartWindowGrid(long, req, { startSec: 0, stepSec: 90 })).toThrow(RangeError)
  })
})

describe('fullChartGrid', () => {
  it('folds the rows before its first bucket into it, on fixed and calendar grains alike', () => {
    const w = fullChartGrid(WEEKLY_MONDAY_GRAIN, ['2026-09-14', '2026-09-21'])
    expect(w.fromSec).toBe(at('2026-09-14T00:00:00'))
    expect(w.endSec).toBe(at('2026-09-28T00:00:00'))
    expect(w.grain.keySql('ts')).toBe(`toString(toDate(toDateTime(345600 + intDiv(toInt64(toUnixTimestamp(greatest(ts, toDateTime(${w.fromSec})))) - 345600, 604800) * 604800)))`)
    // The grain's own keys and grid are untouched: only the SQL folds.
    expect(w.grain.keyOf(at('2026-09-10T00:00:00'))).toBe('2026-09-07')
    expect(w.grain.stepSec).toBe(7 * D)

    const m = fullChartGrid(MONTHLY_GRAIN, ['2026-08-01', '2026-09-01'])
    expect(m.grain.monthly).toBe(true)
    expect(m.grain.keySql('ts')).toBe(`toString(toStartOfMonth(greatest(ts, toDateTime(${at('2026-08-01T00:00:00')}))))`)
    expect(grainBucketEndSec(m.grain, '2026-09-01')).toBe(at('2026-10-01T00:00:00'))
    expect(m.endSec).toBe(at('2026-10-01T00:00:00'))
    expect(m.grain.keyOf(at('2026-09-13T00:00:00'))).toBe('2026-09-01')
  })
})

describe('grid alignment', () => {
  const keys = ['a', 'b', 'c', 'd']

  it('carries a state forward through quiet buckets, leaving leading nulls', () => {
    expect(carryForwardValues(alignToGrid(keys, [{ k: 'b', v: 5 }, { k: 'd', v: 7 }]))).toEqual([null, 5, 5, 7])
  })

  it('sums per-entity states with each entity carried on its own', () => {
    const out = sumCarriedStates(keys, [
      { entity: 'x', k: 'a', raw: 10n },
      { entity: 'y', k: 'b', raw: 1n },
      { entity: 'x', k: 'c', raw: 0n },
      { entity: 'y', k: 'z', raw: 99n }, // off-grid: dropped, never clamped
    ])
    expect(out).toEqual([10n, 11n, 1n, 1n])
  })
})

describe('/hollar trend builders over a zoom window', () => {
  const clock = clockOver(at('2026-09-18T00:00:00'), 240)
  const g = chartWindowGrid(clock, { fromSec: at('2026-09-20T00:00:00'), toSec: at('2026-09-23T00:00:00'), points: 180 }, { startSec: 0 })!.grid
  const carryIn = `greatest(`

  // A state series opens a window at the value already standing: it must read
  // the rows before the window (no lower time bound) and fold them into bucket 0.
  it.each([
    ['composition', hollarCompositionSql(g)],
    ['holders', hollarHoldersSql(g)],
    ['debt', hollarDebtSql(g)],
    ['borrowers', hollarBorrowersSql(g)],
    ['facilitator levels', hollarFacilitatorLevelsSql(g)],
    ['revenue', hollarRevenueSql(g)],
    ['depth', hollarDepthSql(g)],
  ])('%s carries in the pre-window state', (_, sql) => {
    expect(sql).toContain(carryIn)
    expect(sql).not.toContain('>= toDateTime({from:UInt32})')
    expect(sql).toContain('< toDateTime({end:UInt32})')
    expect(sql).toContain('<= {hi:UInt32}')
  })

  // A flow series holds only its bucket's own rows.
  it.each([
    ['peg', hollarPegSql(g)],
    ['stable share', hollarStableShareSql(g)],
    ['HSM arbitrage', hsmArbitrageSql(g)],
  ])('%s reads only the window', (_, sql) => {
    expect(sql).toContain('>= toDateTime({from:UInt32})')
    expect(sql).toContain('< toDateTime({end:UInt32})')
  })

  it('reads the peg from hour candles below a day and day candles at a day or more', () => {
    expect(hollarPegSql(g)).toContain('price_data.ohlc_1h')
    expect(hollarPegSql(fullChartGrid(WEEKLY_MONDAY_GRAIN, ['2026-09-21']))).toContain('price_data.ohlc_1d')
  })
})

// The window route end to end over a fake client: the blocks table feeds the
// clock, and each builder's rows arrive keyed by bucket.
describe('getHollarChartWindow', () => {
  const t0 = at('2026-09-18T00:00:00')
  const hours = Array.from({ length: 240 }, (_, i) => t0 + i * H)
  const blocks = hours.map((h, i) => ({ h, top: 1000 + (i + 1) * 600 - 1, at_mark: 1000 + i * 600, top_ts: h + H - 6 }))
  let facilitatorRows: unknown[] = []
  let arbRows: unknown[] = []
  const client = {
    query: async ({ query }: { query: string }) => ({
      json: async () => {
        if (query.includes('FROM price_data.blocks')) return blocks
        if (query.includes('FacilitatorBucketLevelUpdated')) return facilitatorRows
        if (query.includes('HSM.ArbitrageExecuted')) return arbRows
        return []
      },
    }),
  }
  beforeEach(() => { resetCacheForTests(); initHollarService(client as never) })

  const from = at('2026-09-20T00:00:00')
  const to = at('2026-09-20T05:00:00')

  it('splits supply into borrowed and HSM-minted, carrying each facilitator level through quiet buckets', async () => {
    facilitatorRows = [
      // bucket 0 holds the folded pre-window level of every facilitator
      { f: '0xatoken', mm: 1, k: '2026-09-20 00:00:00', lvl: '5000000000000000000000' },
      { f: '0xhsm', mm: 0, k: '2026-09-20 00:00:00', lvl: '2000000000000000000000' },
      { f: '0xatoken', mm: 1, k: '2026-09-20 02:00:00', lvl: '6000000000000000000000' },
      { f: '0xhsm', mm: 0, k: '2026-09-20 04:00:00', lvl: '1000000000000000000000' },
    ]
    const w = await getHollarChartWindow('supplyByMinter', { fromSec: from, toSec: to, points: 180 })
    expect(w.stepSec).toBe(H)
    expect(w.buckets).toEqual(['2026-09-20 00:00:00', '2026-09-20 01:00:00', '2026-09-20 02:00:00', '2026-09-20 03:00:00', '2026-09-20 04:00:00', '2026-09-20 05:00:00'])
    expect(w.series.borrowed).toEqual([5000, 5000, 6000, 6000, 6000, 6000])
    expect(w.series.other).toEqual([2000, 2000, 2000, 2000, 1000, 1000])
  })

  it('zero-fills a flow inside the indexed range', async () => {
    arbRows = [{ k: '2026-09-20 03:00:00', dir: 2, raw: '1500000000000000000000' }]
    const w = await getHollarChartWindow('hsmArbitrage', { fromSec: from, toSec: to, points: 180 })
    expect(w.series.hollarIn).toEqual([0, 0, 0, 1500, 0, 0])
    expect(w.series.hollarOut).toEqual([0, 0, 0, 0, 0, 0])
  })

  it('answers an empty grid for a window past the indexed head', async () => {
    const w = await getHollarChartWindow('hsmArbitrage', { fromSec: t0 + 30 * D, toSec: t0 + 31 * D, points: 180 })
    expect(w).toEqual({ stepSec: 0, buckets: [], series: {} })
  })
})
