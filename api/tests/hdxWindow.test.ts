import { beforeEach, describe, expect, it } from 'vitest'
import { resetCacheForTests } from '../src/services/cache.ts'
import type { BlockClock } from '../src/services/blockClock.ts'
import { chartWindowGrid, fullChartGrid } from '../src/services/chartWindow.ts'
import { DAILY_GRAIN, MONTHLY_GRAIN, WEEKLY_MONDAY_GRAIN } from '../src/services/historyGrain.ts'
import {
  HDX_STRUCTURE_HOURLY_ROW_BUDGET, backfillAllocationMints, backfillAllocationMintsAt, getHdxChartWindow, hdxBuybackSql, hdxChurnSql,
  hdxFlowsSql, hdxPriceSql, hdxStakedSql, hdxStructureSql, initHdxService, isWeeklyAligned, mergeHdxStructureRows, monthWeekIndex,
  realizedAtEnds, structureBuckets, structureRefs, wholeWeekStepAtLeast, type HdxStructureSqlRow,
} from '../src/services/hdxService.ts'

const H = 3_600
const D = 86_400
const at = (iso: string) => Date.parse(`${iso}Z`) / 1000

// An hourly clock, one block every 6 s from height 1000.
function clockOver(fromSec: number, hours: number): BlockClock {
  const marks = Array.from({ length: hours }, (_, i) => fromSec + i * H)
  return {
    hours: marks,
    heights: marks.map((_, i) => 1000 + (i + 1) * 600 - 1),
    atMark: marks.map((_, i) => 1000 + i * 600),
    lastTime: marks[marks.length - 1] + H - 6,
    builtAt: 0,
  }
}

describe('zoom grids of a week or more sit on Monday weeks', () => {
  it('anchors a 7-day step to Mondays, the lattice of the weekly dashboards', () => {
    const clock = clockOver(at('2023-01-01T00:00:00'), 24 * 1300)
    // ~1,030 days: too long for 5-day buckets in 180 points, short enough for 7.
    const w = chartWindowGrid(clock, { fromSec: at('2023-02-08T10:00:00'), toSec: at('2025-12-01T00:00:00'), points: 180 }, { startSec: 0 })!
    expect(w.grid.grain.stepSec).toBe(7 * D)
    // 2023-02-08 is a Wednesday; its bucket is the Monday week holding it.
    expect(w.grid.keys[0]).toBe('2023-02-06')
    expect(w.grid.keys.every(k => new Date(`${k}T00:00:00Z`).getUTCDay() === 1)).toBe(true)
    expect(w.grid.grain.keySql('ts')).toContain('345600 + intDiv(')
    expect(isWeeklyAligned(w.grid)).toBe(true)
  })

  it('leaves sub-week steps on the epoch lattice', () => {
    const clock = clockOver(at('2026-09-18T00:00:00'), 240)
    const w = chartWindowGrid(clock, { fromSec: at('2026-09-20T00:30:00'), toSec: at('2026-09-23T00:00:00'), points: 180 }, { startSec: 0 })!
    expect(w.grid.grain.stepSec).toBe(H)
    expect(w.grid.grain.keySql('ts')).toContain('toStartOfInterval(')
    expect(isWeeklyAligned(w.grid)).toBe(false)
  })
})

describe('holder structure: static accounts plus movers', () => {
  // Two buckets. Static: a user holding 50 since 2022 and one holding 5 since
  // two weeks before the first ref; the treasury. Movers carry their own top
  // lists and ages per bucket.
  const refs = ['2026-09-14', '2026-09-21']
  const st: HdxStructureSqlRow = {
    i: 0, treasury: '1000', protocol: '10', kraken: '7', user_total: '55', sq: String(50n * 50n + 5n * 5n),
    top: ['50', '5'], a0: '0', a1: '0', a2: '0', a3: '0',
    st_anchor: ['2022-01-03', '2026-08-31'], st_sum: ['50', '5'],
  }
  const mv = (i: number, top: string[]): HdxStructureSqlRow => ({
    i, treasury: '0', protocol: '0', kraken: '0', user_total: String(top.reduce((s, x) => s + BigInt(x), 0n)),
    sq: String(top.reduce((s, x) => s + BigInt(x) ** 2n, 0n)), top, a0: top.length ? top[0] : '0', a1: '0', a2: '0', a3: '0',
    st_anchor: [], st_sum: [],
  })

  it('adds the static part into every bucket and ranks the top-N over the union', () => {
    const b = mergeHdxStructureRows(refs, [st, mv(1, ['60']), mv(2, ['3'])])
    expect(b[0].treasury).toBe(1000n)
    expect(b[0].user).toBe(115n)
    // 60 (mover) outranks the static 50; both inside the top 10.
    expect(b[0].top10).toBe(115n)
    expect(b[1].user).toBe(58n)
    expect(b[1].sq).toBe(2500n + 25n + 9n)
  })

  it('states a bucket without movers from the static part alone', () => {
    const b = mergeHdxStructureRows(refs, [st])
    expect(b.map(x => x.user)).toEqual([55n, 55n])
    expect(b[1].kraken).toBe(7n)
  })

  it('ages static holdings at each bucket\'s own Monday', () => {
    const [b0, b1] = mergeHdxStructureRows(refs, [st])
    // 2026-08-31 → 2026-09-14: 14 days, under 3 months; 2022 → over 2 years.
    expect(b0.ages).toEqual([5n, 0n, 0n, 50n])
    expect(b1.ages).toEqual([5n, 0n, 0n, 50n])
  })

  it('keeps only the top 1,000 of the union', () => {
    const many = Array.from({ length: 1200 }, (_, i) => String(2000 - i))
    const b = mergeHdxStructureRows(['2026-09-14'], [{ ...st, top: many.slice(0, 1000) }, mv(1, ['5000'])])
    // 5000, then 2000…1002 (999 of the static list): 10 + 90 + 900 ranks.
    const union = ['5000', ...many].map(BigInt).slice(0, 1000)
    expect(b[0].top10 + b[0].top11to100 + b[0].top101to1000).toBe(union.reduce((s, v) => s + v, 0n))
  })
})

describe('holder structure SQL', () => {
  it('reads only weekly closes on a whole-week grid, and hourly rows from the window\'s Monday otherwise', () => {
    const weekly = hdxStructureSql('weekly')
    expect(weekly).toContain('price_data.account_balance_weekly')
    expect(weekly).not.toContain('account_balance_hourly')
    const hourly = hdxStructureSql('hourly')
    expect(hourly).toContain('interval_start >= toDateTime({w0:UInt32}) AND interval_start < toDateTime({end:UInt32})')
    // Replayable AggregatingMergeTree inputs are merged per key before use.
    expect(hourly).toContain('GROUP BY account_id, interval_start')
    expect(hourly).toContain('GROUP BY account_id, week_start')
  })

  it('restricts a Kraken-scoped read to the tagged wallets by primary key', () => {
    expect(hdxStructureSql('hourly', 'kraken').match(/account_id IN \(SELECT account_id FROM price_data.account_tags FINAL/g)).toHaveLength(2)
  })

  it('measures ages at the Monday holding each bucket\'s last instant', () => {
    const g = fullChartGrid(WEEKLY_MONDAY_GRAIN, ['2026-09-14', '2026-09-21'])
    expect(structureRefs(g)).toEqual(['2026-09-14', '2026-09-21'])
    const h = { ...fullChartGrid(DAILY_GRAIN, ['2026-09-20', '2026-09-21']) }
    // Sunday's bucket ends Monday 00:00: its last instant is still the previous week.
    expect(structureRefs(h)).toEqual(['2026-09-14', '2026-09-21'])
  })
})

describe('trend builders over a zoom window', () => {
  const clock = clockOver(at('2026-09-18T00:00:00'), 240)
  const g = chartWindowGrid(clock, { fromSec: at('2026-09-20T00:00:00'), toSec: at('2026-09-23T00:00:00'), points: 180 }, { startSec: 0 })!.grid

  // A running total opens a window at the value already standing.
  it.each([
    ['staked', hdxStakedSql(g)],
    ['buyback', hdxBuybackSql(g)],
  ])('%s carries in the pre-window total', (_, sql) => {
    expect(sql).toContain('greatest(')
    expect(sql).not.toContain('>= toDateTime({from:UInt32})')
    expect(sql).toContain('< toDateTime({end:UInt32})')
  })

  it.each([
    ['flows', hdxFlowsSql(g)],
    ['churn', hdxChurnSql(g)],
    ['price', hdxPriceSql(g)],
  ])('%s reads only the window', (_, sql) => {
    expect(sql).toContain('>= toDateTime({from:UInt32})')
    expect(sql).toContain('< toDateTime({end:UInt32})')
  })

  it('reads prices from hour candles below a day, day candles at a day or more', () => {
    expect(hdxPriceSql(g)).toContain('price_data.ohlc_1h')
    expect(hdxPriceSql(fullChartGrid(MONTHLY_GRAIN, ['2026-08-01']))).toContain('price_data.ohlc_1d')
  })

  it('keeps flows replay-safe and on the principal side', () => {
    expect(hdxFlowsSql(g)).toContain('trade_volume_by_account AS t FINAL')
    expect(hdxFlowsSql(g)).toContain('sumIf(t.native_volume_buy, t.counterparty = 0)')
  })
})

describe('booking-grain and sampling helpers', () => {
  it('carries the realized price forward from the newest closed week', () => {
    const weekly = new Map([['2026-09-07', 0.01], ['2026-09-14', 0.02]])
    const ends = [at('2026-09-14T00:00:00'), at('2026-09-20T13:00:00'), at('2026-09-21T00:00:00'), at('2026-09-13T00:00:00')]
    expect(realizedAtEnds(weekly, ends.slice(0, 3))).toEqual([0.01, 0.01, 0.02])
    expect(realizedAtEnds(weekly, [at('2026-09-13T23:00:00')])).toEqual([null])
  })

  it('samples each month at the close of the week holding its last day', () => {
    const weeks = ['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']
    // Aug 31 is a Monday: its week. September's last day lies past the newest week.
    expect(monthWeekIndex(['2026-08-01', '2026-09-01'], weeks)).toEqual([1, 5])
  })

  it('counts a mint in every bucket ending at or before it', () => {
    const own = () => ({ treasury: [0, 0, 0], protocol: [0, 0, 0], kraken: [0, 0, 0], top10: [0, 0, 0], top11to100: [0, 0, 0], top101to1000: [0, 0, 0], rest: [0, 0, 0] })
    const o = own()
    const ends = [at('2026-06-17T00:00:00'), at('2026-06-17T01:00:00'), at('2026-06-17T02:00:00')]
    backfillAllocationMintsAt(o, ends, [{ week: '2026-06-15', ts: at('2026-06-17T01:00:00'), cls: 'treasury', hdx: 10 }])
    expect(o.treasury).toEqual([10, 10, 0])
    // Without a timestamp a weekly grid keeps the old week rule.
    const w = own()
    backfillAllocationMints(w, ['2026-06-01', '2026-06-08', '2026-06-15'], [{ week: '2026-06-15', cls: 'protocol', hdx: 4 }])
    expect(w.protocol).toEqual([4, 4, 0])
  })
})

// The window route end to end over a fake client: the blocks table feeds the
// clock, each builder's rows arrive keyed by bucket.
describe('getHdxChartWindow', () => {
  const t0 = at('2026-09-18T00:00:00')
  const hours = Array.from({ length: 240 }, (_, i) => t0 + i * H)
  const blocks = hours.map((h, i) => ({ h, top: 1000 + (i + 1) * 600 - 1, at_mark: 1000 + i * 600, top_ts: h + H - 6 }))
  let stakedRows: unknown[] = []
  let hourlyRows = 0
  const seen: string[] = []
  const client = {
    query: async ({ query }: { query: string }) => {
      seen.push(query)
      return {
        json: async () => {
          if (query.includes('FROM price_data.blocks')) return blocks
          if (query.includes('staking_activity')) return stakedRows
          if (query.includes('SELECT count() AS n FROM price_data.account_balance_hourly')) return [{ n: hourlyRows }]
          if (query.includes('kraken_forwarders')) return []
          return []
        },
      }
    },
  }
  beforeEach(() => { resetCacheForTests(); initHdxService(client as never); seen.length = 0 })

  const from = at('2026-09-20T00:00:00')
  const to = at('2026-09-20T05:00:00')

  it('carries the staked totals through quiet buckets', async () => {
    stakedRows = [
      { k: '2026-09-20 00:00:00', classic: '5000000000000000', giga: '0' },
      { k: '2026-09-20 03:00:00', classic: '4000000000000000', giga: '2000000000000000' },
    ]
    const w = await getHdxChartWindow('staked', { fromSec: from, toSec: to, points: 180 })
    expect(w.stepSec).toBe(H)
    expect(w.series.classic).toEqual([5000, 5000, 5000, 4000, 4000, 4000])
    expect(w.series.giga).toEqual([0, 0, 0, 2000, 2000, 2000])
  })

  it('serves a structure window hourly while its rows fit, else on the weekly closes', async () => {
    hourlyRows = 10
    const fine = await getHdxChartWindow('ownership', { fromSec: from, toSec: to, points: 180 })
    expect(fine.stepSec).toBe(H)
    expect(seen.some(q => q.includes('interval_start >= toDateTime({w0:UInt32})') && q.includes('groupArraySortedIf'))).toBe(true)

    resetCacheForTests(); seen.length = 0
    hourlyRows = HDX_STRUCTURE_HOURLY_ROW_BUDGET + 1
    const coarse = await getHdxChartWindow('ownership', { fromSec: from, toSec: to, points: 180 })
    expect(coarse.stepSec).toBe(7 * D)
    expect(coarse.buckets).toEqual(['2026-09-14'])
    const structure = seen.filter(q => q.includes('groupArraySortedIf'))
    expect(structure).toHaveLength(1)
    expect(structure[0]).not.toContain('account_balance_hourly')
  })

  it('answers an empty grid for a window past the indexed head', async () => {
    const w = await getHdxChartWindow('flows', { fromSec: t0 + 30 * D, toSec: t0 + 31 * D, points: 180 })
    expect(w).toEqual({ stepSec: 0, buckets: [], series: {} })
  })
})

// A structure window is only ever asked for a bucket of a week or more over a
// span the hourly source could not hold within budget, so every such window
// must land on whole weeks on the weekly closes — including the 30-day-and-up
// rungs a small point budget resolves to, which the ladder has no whole-week
// rung above.
describe('structure windows of a week or more land on whole weeks', () => {
  it('maps every rung of a week or more onto the whole-week step at or above it', () => {
    expect(wholeWeekStepAtLeast(7 * D)).toBe(7 * D)
    expect(wholeWeekStepAtLeast(10 * D)).toBe(14 * D)
    expect(wholeWeekStepAtLeast(14 * D)).toBe(14 * D)
    expect(wholeWeekStepAtLeast(30 * D)).toBe(35 * D)
    expect(wholeWeekStepAtLeast(45 * D)).toBe(49 * D)
    expect(wholeWeekStepAtLeast(60 * D)).toBe(63 * D)
    expect(wholeWeekStepAtLeast(90 * D)).toBe(91 * D)
    expect(wholeWeekStepAtLeast(180 * D)).toBe(182 * D)
  })

  // A clock over the whole balance era: one block every 6 s from the series start.
  const t0 = at('2022-07-04T00:00:00')
  const hours = Array.from({ length: 24 * 1600 }, (_, i) => t0 + i * H)
  const blocks = hours.map((h, i) => ({ h, top: 1000 + (i + 1) * 600 - 1, at_mark: 1000 + i * 600, top_ts: h + H - 6 }))
  const seen: string[] = []
  const client = {
    query: async ({ query }: { query: string }) => {
      seen.push(query)
      return { json: async () => (query.includes('FROM price_data.blocks') ? blocks : []) }
    },
  }
  beforeEach(() => { resetCacheForTests(); initHdxService(client as never); seen.length = 0 })

  const isMonday = (k: string) => k.length === 10 && new Date(`${k}T00:00:00Z`).getUTCDay() === 1

  it.each([
    // span in days → the rung ten points resolve to → the whole-week step served
    ['a year at ten points (the 45-day rung)', 364, 49],
    ['the 30-day rung', 250, 35],
    ['the 60-day rung', 500, 63],
    ['the 90-day rung', 800, 91],
    ['the 180-day rung', 1500, 182],
  ])('serves %s on the weekly closes in whole weeks', async (_, spanDays, weeksDays) => {
    const from = at('2023-01-02T00:00:00')
    const w = await getHdxChartWindow('ownership', { fromSec: from, toSec: from + spanDays * D, points: 10 })
    expect(w.stepSec).toBe(weeksDays * D)
    expect(w.buckets.length).toBeGreaterThanOrEqual(2)
    expect(w.buckets.length).toBeLessThanOrEqual(10)
    expect(w.buckets.every(isMonday)).toBe(true)
    const structure = seen.filter(q => q.includes('groupArraySortedIf'))
    expect(structure).toHaveLength(1)
    expect(structure[0]).toContain('price_data.account_balance_weekly')
    expect(structure[0]).not.toContain('account_balance_hourly')
    // The hourly source was never even sized: a week-or-more step is coarsened outright.
    expect(seen.some(q => q.includes('SELECT count() AS n FROM price_data.account_balance_hourly'))).toBe(false)
  })

  it('keeps a window that resolves to whole weeks on its own grid', async () => {
    // ~1,030 days: 7-day buckets fit 180 points, and 7 days is already whole weeks.
    const w = await getHdxChartWindow('ownership', { fromSec: at('2023-02-08T10:00:00'), toSec: at('2025-12-01T00:00:00'), points: 180 })
    expect(w.stepSec).toBe(7 * D)
    expect(w.buckets[0]).toBe('2023-02-06')
    expect(seen.filter(q => q.includes('groupArraySortedIf'))[0]).not.toContain('account_balance_hourly')
  })

  it('refuses an hourly-source structure of a week or more per bucket before any query', async () => {
    // A ten-day grid is not whole weeks, so it would read the hourly source.
    const clock = clockOver(t0, 24 * 40)
    const g = chartWindowGrid(clock, { fromSec: t0, toSec: t0 + 30 * D, points: 3 }, { startSec: 0 })!.grid
    expect(g.grain.stepSec).toBe(10 * D)
    expect(isWeeklyAligned(g)).toBe(false)
    await expect(structureBuckets(g)).rejects.toThrow(/whole weeks/)
    expect(seen.some(q => q.includes('groupArraySortedIf'))).toBe(false)
    // The Kraken scope is a primary-key read over a few wallets and is not refused.
    await expect(structureBuckets(g, 'kraken')).resolves.toHaveLength(g.keys.length)
  })
})

// Distinct window grids share no cache entry, and a full-scope structure query
// is the heaviest request-time read there is, so at most two run at once.
describe('structure window concurrency', () => {
  const t0 = at('2026-09-18T00:00:00')
  const hours = Array.from({ length: 240 }, (_, i) => t0 + i * H)
  const blocks = hours.map((h, i) => ({ h, top: 1000 + (i + 1) * 600 - 1, at_mark: 1000 + i * 600, top_ts: h + H - 6 }))
  const held: ((rows: unknown[]) => void)[] = []
  const client = {
    query: async ({ query }: { query: string }) => ({
      json: async () => {
        if (query.includes('FROM price_data.blocks')) return blocks
        if (query.includes('SELECT count() AS n FROM price_data.account_balance_hourly')) return [{ n: 10 }]
        if (query.includes('groupArraySortedIf')) return new Promise<unknown[]>(resolve => held.push(resolve))
        return []
      },
    }),
  }
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)) }
  beforeEach(() => { resetCacheForTests(); initHdxService(client as never); held.length = 0 })

  it('runs at most two full-scope structure windows at once and queues the rest in order', async () => {
    const from = at('2026-09-20T00:00:00')
    const windows = [0, 1, 2].map(i => getHdxChartWindow('ownership', { fromSec: from + i * H, toSec: from + 5 * H, points: 180 }))
    await settle()
    expect(held).toHaveLength(2)
    held[0]([])
    await settle()
    expect(held).toHaveLength(3)
    held[1]([]); held[2]([])
    const done = await Promise.all(windows)
    expect(done.map(w => w.buckets.length)).toEqual([6, 5, 4])
  })

  it('lets a Kraken-scoped window through while both slots are taken', async () => {
    const from = at('2026-09-20T00:00:00')
    const busy = [0, 1].map(i => getHdxChartWindow('ownership', { fromSec: from + i * H, toSec: from + 5 * H, points: 180 }))
    await settle()
    expect(held).toHaveLength(2)
    const kraken = getHdxChartWindow('kraken', { fromSec: from, toSec: from + 5 * H, points: 180 })
    await settle()
    expect(held).toHaveLength(3)
    held.forEach(resolve => resolve([]))
    await Promise.all([...busy, kraken])
  })
})
