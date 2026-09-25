import { describe, expect, it } from 'vitest'
import { heightAtOrBefore, heightAtOrBeforeExact, type BlockClock } from '../src/services/blockClock.ts'
import { MONDAY_ANCHOR_SEC, makeBucketing } from '../src/services/bucketLadder.ts'
import { omnipoolRemoveLiquidity, OMNI_FIXED, type OmnipoolAssetState } from '../src/services/lpMath.ts'
import {
  LP_HISTORY_POSITION_CAP, assembleLpHistory, bucketClosePrices, bucketPricerFrom, fillSpanTimes, loadLpHistory, loadOmnipoolPrincipalHistory,
  loadShareBalanceHistory, loadStableswapPrincipalHistory, loadXykPrincipalHistory, selectLpHistoryBuckets, v3PositionSpans, xykLegsByBucket,
  type CandleClose, type LpHistoryParts, type OmnipoolPrincipalHistory, type V3PrincipalHistory, type XykPrincipalHistory,
} from '../src/services/lpHistory.ts'
import { resetCacheForTests } from '../src/services/cache.ts'
import { testBucketing } from './support/bucketing.ts'

// The LP-history leaf: integer valuation on closed candles (never back-filled,
// never zero for a missing price), the per-venue legs, and the grid it runs on.
// Registry is empty under test, so every asset is the synthetic 12-decimal
// descriptor: $ = amount / 1e12 × close.

const H = 3_600
const D = 86_400
const USD = 10n ** 12n // one dollar in the valuation module's scale
const ACC = `0x${'aa'.repeat(32)}`

type Row = Record<string, unknown>
function fakeClient(route: (query: string, params: Record<string, unknown>) => Row[] | undefined) {
  const seen: Array<{ query: string; params: Record<string, unknown> }> = []
  return {
    seen,
    query: async (opts: { query: string; query_params?: Record<string, unknown> }) => {
      seen.push({ query: opts.query, params: opts.query_params ?? {} })
      return { json: async () => route(opts.query, opts.query_params ?? {}) ?? [] }
    },
  }
}

// A grid of `n + 1` buckets of `step` from t0, ending at t0 + (b + 1)·step.
const grid = (t0: number, step: number, n: number) => ({ N: n, endSec: (b: number) => t0 + (b + 1) * step })

describe('bucketPricerFrom — closed candles only', () => {
  const t0 = 100 * D
  const bk = grid(t0, D, 3) // ends: t0+1d … t0+4d
  const closes = (list: Array<[number, bigint]>) => new Map<number, CandleClose[]>([[5, list.map(([closedAt, close]) => ({ closedAt, close }))]])

  it('takes a candle closing exactly at the bucket end, not the one still open', () => {
    const pricer = bucketPricerFrom(closes([[t0 + D, 2n * USD], [t0 + D + H, 3n * USD]]), bk)
    expect(pricer.close(5, 0)).toBe(2n * USD)
    // Bucket 1 ends a day later: the later candle is closed by then.
    expect(pricer.close(5, 1)).toBe(3n * USD)
  })

  it('never back-fills a bucket from a later candle', () => {
    const pricer = bucketPricerFrom(closes([[t0 + 2 * D, 2n * USD]]), bk)
    expect(pricer.close(5, 0)).toBeNull()
    expect(pricer.usd(5, 10n ** 12n, 0)).toBeNull()
    expect(pricer.close(5, 1)).toBe(2n * USD)
  })

  it('carries a close forward at most 30 days', () => {
    const at = t0 + D
    const pricer = bucketPricerFrom(closes([[at - 30 * D, 7n * USD]]), bk)
    expect(pricer.close(5, 0)).toBe(7n * USD) // exactly 30 days stale: still in
    expect(pricer.close(5, 1)).toBeNull() // 31 days: out
  })

  it('treats a non-positive close as no price', () => {
    const pricer = bucketPricerFrom(closes([[t0 + D, 0n]]), bk)
    expect(pricer.close(5, 0)).toBeNull()
  })

  it('values raw amounts in integer USD by the asset decimals', () => {
    const pricer = bucketPricerFrom(closes([[t0 + D, 2n * USD]]), bk)
    // 3.5 units of a 12-decimal asset at $2 = $7.
    expect(pricer.usd(5, 3_500_000_000_000n, 0)).toBe(7n * USD)
    // Above 2^53 stays exact.
    const huge = 9_007_199_254_740_993n * 10n ** 12n
    expect(pricer.usd(5, huge, 0)).toBe(huge * 2n)
  })
})

describe('bucketClosePrices — grain and bounds', () => {
  const bk = makeBucketing({ hours: [], heights: [], builtAt: 0 }, 1000 * D, 1003 * D, 0, undefined, undefined, { stepSec: D, heightAt: () => 1 })

  it('reads ohlc_1d for the daily grain and ohlc_1h for the hourly one, bounded to the grid plus 30 days', async () => {
    for (const [grain, table, candle] of [['1d', 'ohlc_1d', D], ['1h', 'ohlc_1h', H]] as const) {
      const client = fakeClient(q => (q.includes('-- lp:bucket-closes') ? [{ asset_id: 5, closed_at: 1001 * D, px: '1.5' }] : undefined))
      const pricer = await bucketClosePrices(client as never, [5], bk, grain)
      const q = client.seen[0]
      expect(q.query).toContain(`price_data.${table}`)
      expect(q.params.minT).toBe(1001 * D - 30 * D - candle)
      expect(q.params.maxT).toBe(1003 * D - candle)
      expect(pricer.close(5, 0)).toBe(1_500_000_000_000n)
    }
  })
})

describe('the grid: fixed grain, Monday weeks, exact heights', () => {
  const W = 7 * D
  // 2026-09-16 (a Wednesday) → 2026-10-01.
  const from = Date.UTC(2026, 8, 16) / 1000
  const to = Date.UTC(2026, 9, 1) / 1000
  const clock: BlockClock = { hours: [], heights: [], builtAt: 0 }

  it('uses exactly the step it is given, whatever the budget would choose', () => {
    const bk = makeBucketing(clock, from, from + 400 * H, 0, 10, undefined, { stepSec: H, heightAt: () => 1 })
    expect(bk.step).toBe(H)
    expect(bk.N).toBe(399)
  })

  it('anchors a 7-day step on Monday 00:00 UTC, not the epoch Thursday', () => {
    const bk = makeBucketing(clock, from, to, 0, undefined, undefined, { stepSec: W, anchorSec: MONDAY_ANCHOR_SEC, heightAt: () => 1 })
    expect(new Date(bk.t0 * 1000).toISOString()).toBe('2026-09-14T00:00:00.000Z')
    expect(new Date(bk.t0 * 1000).getUTCDay()).toBe(1)
    expect(new Date(bk.endSec(0) * 1000).getUTCDay()).toBe(1)
    // The epoch-anchored step lands on a Thursday — the trap the anchor exists for.
    expect(new Date(makeBucketing(clock, from, to, 0, undefined, undefined, { stepSec: W, heightAt: () => 1 }).t0 * 1000).getUTCDay()).toBe(4)
  })

  it('dates bucket ends through the resolver it is given', () => {
    const bk = makeBucketing(clock, 10 * H, 13 * H, 5, undefined, undefined, { stepSec: H, heightAt: sec => sec / H * 100 })
    expect([0, 1, 2].map(b => bk.endHeight(b))).toEqual([1100, 1200, 1300])
  })

  it('rejects a step that is not a whole number of hours', () => {
    expect(() => makeBucketing(clock, 0, 10 * H, 0, undefined, undefined, { stepSec: 1_800 })).toThrow(RangeError)
  })
})

describe('heightAtOrBeforeExact', () => {
  // Hour 10 has blocks 101..250 with 101 stamped exactly on the mark; hour 11 has
  // none on its mark; hour 12 is the newest (still filling).
  const clock: BlockClock = { hours: [10 * H, 11 * H, 12 * H], heights: [250, 400, 480], atMark: [101, 0, 401], builtAt: 0 }

  it('resolves a mark to the blocks stamped on it, not the end of the hour after it', () => {
    expect(heightAtOrBeforeExact(clock, 10 * H)).toBe(101)
    expect(heightAtOrBefore(clock, 10 * H)).toBe(250) // the chart's dating, kept for the chart
  })

  it('falls back to the previous hour when no block sits on the mark', () => {
    expect(heightAtOrBeforeExact(clock, 11 * H)).toBe(250)
  })

  it('answers an instant inside a finished hour with its mark, never a later block', () => {
    expect(heightAtOrBeforeExact(clock, 10 * H + 1_800)).toBe(101)
  })

  it('answers the head for an instant inside the newest hour or past it', () => {
    expect(heightAtOrBeforeExact(clock, 12 * H + 60)).toBe(480)
    expect(heightAtOrBeforeExact(clock, 40 * H)).toBe(480)
  })

  it('resolves marks across hours with no block at all to the last block before the gap', () => {
    // Hours 11 and 12 held no block (a stall); hour 13 resumes, its first block after the mark.
    const gap: BlockClock = { hours: [10 * H, 13 * H, 14 * H], heights: [250, 600, 700], atMark: [101, 0, 601], builtAt: 0 }
    expect(heightAtOrBeforeExact(gap, 11 * H)).toBe(250)
    expect(heightAtOrBeforeExact(gap, 12 * H)).toBe(250)
    expect(heightAtOrBeforeExact(gap, 12 * H + 1_800)).toBe(250)
    // The mark that ends the gap: nothing stamped on it, so the last block before it.
    expect(heightAtOrBeforeExact(gap, 13 * H)).toBe(250)
    expect(heightAtOrBeforeExact(gap, 14 * H)).toBe(601)
    // The chart's dating lands inside the gap's last indexed hour, never past the gap.
    expect(heightAtOrBefore(gap, 12 * H)).toBe(250)
  })

  it('is null before the chain and for a clock without mark data before its second hour', () => {
    expect(heightAtOrBeforeExact(clock, 9 * H)).toBeNull()
    expect(heightAtOrBeforeExact({ hours: [10 * H], heights: [5], builtAt: 0 }, 10 * H)).toBeNull()
  })
})

// ---------------------------------------------------------------------------

const pool = (o: Partial<OmnipoolAssetState> = {}): OmnipoolAssetState => ({ reserve: 1_000_000n, hub: 500_000n, shares: 2_000_000n, ...o })

describe('loadOmnipoolPrincipalHistory — ownership, carry-in and spans', () => {
  // floor 1000, ten-block buckets: ends 1009, 1019, …, 1050.
  const bk = testBucketing(1000, 10, 5)
  const created = (pid: string, block: number) => ({ position_id: pid, block_height: block, event_kind: 'created', asset_id: 10, amount_raw: '1000', shares_raw: '1000', price_raw: OMNI_FIXED.toString(), active: 1 })

  it('carries in a position opened before the window and flips bare → farmed as one position', async () => {
    const client = fakeClient(q => {
      if (q.includes('-- lp:omnipool-owner-intervals')) return [
        { position_id: '7', ownership_kind: 'bare', deposit_id: '', valid_from_block: 900, from_ts: 1_700_000_000, valid_to_block: 1025 },
        { position_id: '7', ownership_kind: 'farmed', deposit_id: '44', valid_from_block: 1025, from_ts: 1_700_000_900, valid_to_block: 0 },
      ]
      if (q.includes('-- lp:omnipool-position-states')) return [created('7', 890)]
      if (q.includes('-- lp:omnipool-pool-states')) return [{ asset_id: 10, b: -1, reserve: '1000000', hub_reserve: '500000', shares: '2000000' }]
      return undefined
    })
    const hist = await loadOmnipoolPrincipalHistory(client as never, [ACC], bk)
    // Present in bucket 0 from the pre-window open, exactly once per bucket.
    expect(hist.legsByBucket.map(l => l.length)).toEqual([1, 1, 1, 1, 1, 1])
    expect(hist.legsByBucket[1][0]).toMatchObject({ positionId: '7', farmed: false, depositId: null, shares: 1000n })
    expect(hist.legsByBucket[2][0]).toMatchObject({ positionId: '7', farmed: true, depositId: '44' })
    expect(hist.spans.get('7')).toEqual([
      { fromBlock: 900, fromTime: 1_700_000_000, toBlock: 1025, toTime: null, kind: 'direct' },
      { fromBlock: 1025, fromTime: 1_700_000_900, toBlock: null, toTime: null, kind: 'farmed' },
    ])
  })

  it('counts an owned position it cannot state — no pool state, or no position state yet — and not a destroyed one', async () => {
    const client = fakeClient(q => {
      if (q.includes('-- lp:omnipool-owner-intervals')) return [
        { position_id: '7', ownership_kind: 'bare', deposit_id: '', valid_from_block: 900, from_ts: 0, valid_to_block: 0 },
        // Asset 11 has no pool state sampled before bucket 3.
        { position_id: '8', ownership_kind: 'bare', deposit_id: '', valid_from_block: 900, from_ts: 0, valid_to_block: 0 },
        // Owned from 1005 but its first state event is only indexed at 1022.
        { position_id: '9', ownership_kind: 'bare', deposit_id: '', valid_from_block: 1005, from_ts: 0, valid_to_block: 0 },
      ]
      if (q.includes('-- lp:omnipool-position-states')) return [
        created('7', 890),
        { ...created('8', 890), asset_id: 11 },
        created('9', 1022),
        // Destroyed at 1041 while its interval is still open: gone, not unvalued.
        { ...created('7', 1041), event_kind: 'destroyed', active: 0 },
      ]
      if (q.includes('-- lp:omnipool-pool-states')) return [
        { asset_id: 10, b: -1, reserve: '1000000', hub_reserve: '500000', shares: '2000000' },
        { asset_id: 11, b: 3, reserve: '1000000', hub_reserve: '500000', shares: '2000000' },
      ]
      return undefined
    })
    const hist = await loadOmnipoolPrincipalHistory(client as never, [ACC], bk)
    expect(hist.legsByBucket.map(l => l.map(x => x.positionId))).toEqual([['7'], ['7'], ['7', '9'], ['7', '8', '9'], ['8', '9'], ['8', '9']])
    // Bucket 0/1: 8 (no pool state) and 9 (no state yet, from bucket 0's end 1009); bucket 2: 8.
    expect(hist.unvaluedByBucket).toEqual([2, 2, 1, 0, 0, 0])
  })

  it('bounds the interval read to the window, so a position closed before it is never read', async () => {
    const client = fakeClient(() => undefined)
    await loadOmnipoolPrincipalHistory(client as never, [ACC], bk)
    const q = client.seen[0].query
    expect(q).toContain('valid_to_block >= 1000')
    expect(q).toContain('valid_from_block <= 1050')
  })
})

describe('loadShareBalanceHistory — per account, then summed', () => {
  it('forward-fills each account independently before summing, with the pre-window balance as bucket 0', async () => {
    const other = `0x${'bb'.repeat(32)}`
    const bk = testBucketing(1000, 10, 3)
    const client = fakeClient(q => (q.includes('-- lp:share-balance-history')
      ? [
          { account_id: ACC, asset_id: '100', b: 0, bal: '10' },
          { account_id: ACC, asset_id: '100', b: 2, bal: '0' },
          { account_id: other, asset_id: '100', b: 1, bal: '5' },
          { account_id: other, asset_id: '200', b: 0, bal: '0' },
        ]
      : undefined))
    const out = await loadShareBalanceHistory(client as never, [ACC, other], [100, 200], bk)
    expect(out.get(100)).toEqual([10n, 15n, 5n, 5n])
    expect(out.has(200)).toBe(false) // never held: absent, not a zero series
  })
})

describe('loadXykPrincipalHistory — farm principal and its spans', () => {
  const bk = testBucketing(1000, 10, 3) // ends 1009, 1019, 1029, 1030
  const farm = (o: Row) => ({ lp_asset_id: 42, deposit_id: '1', principal_shares_raw: '30', valid_from_block: 1005, from_ts: 1_700_000_000, valid_to_block: 1025, ...o })

  it('sums active deposits per bucket end and keeps one farmed span per deposit', async () => {
    const client = fakeClient(q => {
      if (q.includes('-- lp:xyk-farm-intervals')) return [
        farm({}),
        // A second deposit on the same LP, still open.
        farm({ deposit_id: '2', principal_shares_raw: '12', valid_from_block: 1015, from_ts: 0, valid_to_block: 0 }),
      ]
      if (q.includes('-- lp:xyk-registry')) return [{ lp_asset_id: 42, pool_account: '0xpool', asset_a: 10, asset_b: 20 }]
      if (q.includes('-- lp:xyk-reserves')) return [{ pool_account: '0xpool', b: -1, aa: 10, ab: 20, ra: '1000', rb: '2000' }]
      if (q.includes('-- lp:xyk-total-shares')) return [{ lp_asset_id: 42, b: -1, total: '100' }]
      return undefined
    })
    const hist = await loadXykPrincipalHistory(client as never, [ACC], [], bk)
    // [from, to): the first deposit is out at 1025, before bucket 2's end (1029).
    expect(hist.farmSharesByLp.get(42)).toEqual([30n, 42n, 12n, 12n])
    expect(hist.farmSpansByLp.get(42)).toEqual([
      { fromBlock: 1005, fromTime: 1_700_000_000, toBlock: 1025, toTime: null, kind: 'farmed' },
      { fromBlock: 1015, fromTime: null, toBlock: null, toTime: null, kind: 'farmed' },
    ])
    expect(hist.poolByLp.get(42)).toBe('0xpool')
    expect(client.seen[0].query).toContain('valid_to_block >= 1000')
    expect(client.seen[0].query).toContain('valid_from_block <= 1030')
  })

  it('keeps farm principal on an LP the registry does not list, so it is counted rather than dropped', async () => {
    const client = fakeClient(q => {
      if (q.includes('-- lp:xyk-farm-intervals')) return [farm({ valid_to_block: 0 })]
      if (q.includes('-- lp:xyk-registry')) return []
      return undefined
    })
    const hist = await loadXykPrincipalHistory(client as never, [ACC], [], bk)
    expect(hist.lpAssetIds.size).toBe(0)
    expect(hist.farmSharesByLp.get(42)).toEqual([30n, 30n, 30n, 30n])
    const pricer = bucketPricerFrom(new Map(), { endSec: b => b })
    const out = assembleLpHistory({ xyk: { hist, directSharesByLp: new Map() } }, pricer, { N: 3 })
    expect(out.positions).toEqual([])
    expect(out.points.map(p => p.unpriced)).toEqual([1, 1, 1, 1])
  })
})

describe('loadStableswapPrincipalHistory', () => {
  it('parses asset_ids/reserves_raw and carries the pre-window state in', async () => {
    const bk = testBucketing(1000, 10, 2)
    const client = fakeClient(q => (q.includes('-- lp:stableswap-states')
      ? [
          { pool_id: 100, b: -1, aids: [10, 22], reserves: ['1000', '2000'], issuance: '100' },
          { pool_id: 100, b: 2, aids: [10, 22], reserves: ['1100', '2100'], issuance: '110' },
        ]
      : undefined))
    const states = (await loadStableswapPrincipalHistory(client as never, [100], bk)).get(100)!
    expect(states[0]).toEqual({ assetIds: [10, 22], reserves: [1000n, 2000n], totalIssuance: 100n })
    expect(states[1]).toEqual(states[0])
    expect(states[2]?.totalIssuance).toBe(110n)
  })

  it('treats a sample whose assets and reserves do not pair as no state, not a carried or zero-filled one', async () => {
    const bk = testBucketing(1000, 10, 3)
    const client = fakeClient(q => (q.includes('-- lp:stableswap-states')
      ? [
          { pool_id: 100, b: -1, aids: [10, 22], reserves: ['1000', '2000'], issuance: '100' },
          { pool_id: 100, b: 1, aids: [10, 22, 30], reserves: ['1000', '2000'], issuance: '100' },
          { pool_id: 100, b: 3, aids: [10, 22], reserves: ['1200', '2200'], issuance: '100' },
        ]
      : undefined))
    const states = (await loadStableswapPrincipalHistory(client as never, [100], bk)).get(100)!
    expect(states[0]?.reserves).toEqual([1000n, 2000n])
    expect(states[1]).toBeUndefined()
    expect(states[2]).toBeUndefined() // the bad sample is the newest at bucket 2's end
    expect(states[3]?.reserves).toEqual([1200n, 2200n])
  })
})

// ---------------------------------------------------------------------------

describe('assembleLpHistory', () => {
  const N = 2
  const t0 = 200 * D
  const bk = grid(t0, D, N)
  // Closes valid at every bucket: asset 10 at $2, 20 at $1, H2O (1) at $10, 30 unpriced.
  const everyBucket = (px: bigint): CandleClose[] => [{ closedAt: t0, close: px }]
  const pricer = bucketPricerFrom(new Map([[10, everyBucket(2n * USD)], [20, everyBucket(USD)], [1, everyBucket(10n * USD)]]), bk)
  const empty = () => Array.from({ length: N + 1 }, () => [] as never[])

  const omni = (legs: OmnipoolPrincipalHistory['legsByBucket']): OmnipoolPrincipalHistory => ({ legsByBucket: legs, assetIds: [10], fromBucket: 0, spans: new Map() })
  const leg = (o: Partial<OmnipoolPrincipalHistory['legsByBucket'][number][number]> = {}) =>
    ({ positionId: '1', assetId: 10, liquidity: 1_000_000_000_000n, hub: 0n, shares: 5n, farmed: false, depositId: null, ...o })

  it('adds an H2O leg only when the hub leg is non-zero, and values both', () => {
    const out = assembleLpHistory({ omnipool: omni([[leg()], [leg({ hub: 100_000_000_000n })], []]) }, pricer, { N })
    const [p] = out.positions
    expect(p.points[0].legs.map(l => l.assetId)).toEqual([10])
    expect(p.points[1].legs.map(l => l.assetId)).toEqual([10, 1])
    // $2 + 0.1 H2O × $10 = $3.
    expect(p.points[1].usd).toBe(3n * USD)
    expect(out.points.map(x => x.usd)).toEqual([2n * USD, 3n * USD, 0n])
    // Not held at bucket 2: no point, rather than a zero one.
    expect(p.points.map(x => x.b)).toEqual([0, 1])
  })

  it('never values an unpriced position at zero: null, left out of the total, counted', () => {
    const out = assembleLpHistory({ omnipool: omni([[leg(), leg({ positionId: '2', assetId: 30 })], [], []]) }, pricer, { N })
    expect(out.points[0]).toEqual({ b: 0, usd: 2n * USD, unpriced: 1, rewardsUsd: 0n, rewardsIncomplete: 0 })
    const unpriced = out.positions.find(p => p.positionId === '2')!
    expect(unpriced.points[0].usd).toBeNull()
    expect(unpriced.points[0].legs[0].usd).toBeNull()
    // Unpriced ranks last.
    expect(out.positions.map(p => p.positionId)).toEqual(['1', '2'])
  })

  it('makes a bare→farmed position one series, farmed as at its last held bucket', () => {
    const spans = new Map([['1', [{ fromBlock: 1, fromTime: null, toBlock: 5, toTime: null, kind: 'direct' as const }, { fromBlock: 5, fromTime: null, toBlock: null, toTime: null, kind: 'farmed' as const }]]])
    const out = assembleLpHistory({ omnipool: { ...omni([[leg()], [leg({ farmed: true, depositId: '9' })], []]), spans } }, pricer, { N })
    expect(out.positions).toHaveLength(1)
    expect(out.positions[0].farmed).toBe(true)
    expect(out.positions[0].spans).toHaveLength(2)
  })

  it('splits XYK into a direct and a farmed position over the same pool', () => {
    const hist: XykPrincipalHistory = {
      lpAssetIds: new Set([42]), underlyingAssetIds: [10, 20],
      stateByLp: new Map([[42, Array.from({ length: N + 1 }, () => ({ assetA: 10, assetB: 20, reserveA: 1_000_000_000_000_000n, reserveB: 2_000_000_000_000_000n, totalShares: 1000n }))]]),
      farmSharesByLp: new Map([[42, [0n, 3n, 3n]]]),
      poolByLp: new Map([[42, '0xpool']]),
      farmSpansByLp: new Map([[42, [{ fromBlock: 7, fromTime: null, toBlock: null, toTime: null, kind: 'farmed' as const }]]]),
    }
    const out = assembleLpHistory({ xyk: { hist, directSharesByLp: new Map([[42, [1n, 1n, 0n]]]) } }, pricer, { N })
    const direct = out.positions.find(p => !p.farmed)!
    const farmed = out.positions.find(p => p.farmed)!
    expect(direct).toMatchObject({ venue: 'xyk', poolKey: '0xpool', shareAssetId: '42', positionId: null, spans: [] })
    expect(direct.points.map(p => p.b)).toEqual([0, 1])
    // 1 of 1000 shares: 1e12 of asset 10 ($2) + 2e12 of asset 20 ($2) = $4.
    expect(direct.points[0].usd).toBe(4n * USD)
    expect(farmed.points.map(p => [p.b, p.shares])).toEqual([[1, 3n], [2, 3n]])
    expect(farmed.spans).toHaveLength(1)
    expect(out.points.map(p => p.usd)).toEqual([4n * USD, 16n * USD, 12n * USD])
    // The chart's form sums first and redeems once.
    expect(xykLegsByBucket(hist, new Map([[42, [1n, 1n, 0n]]]), N)[1]).toEqual([
      { lp: 42, kind: 'combined', shares: 4n, assetA: 10, assetB: 20, amountA: 4_000_000_000_000n, amountB: 8_000_000_000_000n },
    ])
  })

  it('redeems stableswap shares pro-rata over the bucket\'s reserves', () => {
    const state = { assetIds: [10, 20], reserves: [1_000_000_000_000_000n, 3_000_000_000_000_000n], totalIssuance: 1000n }
    const out = assembleLpHistory({
      stableswap: { states: new Map([[100, [state, state, undefined]]]), sharesByPool: new Map([[100, [10n, 0n, 10n]]]) },
    }, pricer, { N })
    const [p] = out.positions
    expect(p).toMatchObject({ venue: 'stableswap', poolKey: '100', shareAssetId: '100', positionId: null })
    // Held at bucket 2 but no pool state there: no point, never a fabricated one —
    // and counted, so the held value is not silently missing from the line.
    expect(p.points.map(x => x.b)).toEqual([0])
    expect(out.points.map(x => x.unpriced)).toEqual([0, 0, 1])
    expect(p.points[0].legs.map(l => [l.assetId, l.amount])).toEqual([[10, 10_000_000_000_000n], [20, 30_000_000_000_000n]])
    expect(p.points[0].usd).toBe(50n * USD)
  })

  it('counts a stableswap sample whose assets and reserves do not pair instead of zero-filling a leg', () => {
    const bad = { assetIds: [10, 20, 30], reserves: [1_000_000_000_000_000n, 3_000_000_000_000_000n], totalIssuance: 1000n }
    const out = assembleLpHistory({ stableswap: { states: new Map([[100, [bad, bad, bad]]]), sharesByPool: new Map([[100, [10n, 10n, 0n]]]) } }, pricer, { N })
    expect(out.positions).toEqual([])
    expect(out.points.map(x => x.unpriced)).toEqual([1, 1, 0])
  })

  it('counts XYK shares held where the pool has no state, direct and farmed separately', () => {
    const st = { assetA: 10, assetB: 20, reserveA: 1_000_000_000_000_000n, reserveB: 2_000_000_000_000_000n, totalShares: 1000n }
    const hist: XykPrincipalHistory = {
      lpAssetIds: new Set([42]), underlyingAssetIds: [10, 20],
      stateByLp: new Map([[42, [undefined, st, st]]]),
      farmSharesByLp: new Map([[42, [3n, 3n, 0n]]]),
      poolByLp: new Map([[42, '0xpool']]), farmSpansByLp: new Map(),
    }
    const out = assembleLpHistory({ xyk: { hist, directSharesByLp: new Map([[42, [1n, 1n, 1n]]]) } }, pricer, { N })
    expect(out.points.map(x => x.unpriced)).toEqual([2, 0, 0])
    expect(out.positions.every(p => p.points.every(pt => pt.b > 0))).toBe(true)
  })

  it('adds the Omnipool and v3 unvalued counts of the venues asked for', () => {
    const v3: V3PrincipalHistory = {
      legsByBucket: [[], [], []], assetIds: [], spans: new Map(),
      unvaluedByBucket: [{ uniswapv3: 1, gamma: 2 }, { uniswapv3: 0, gamma: 0 }, { uniswapv3: 0, gamma: 1 }],
    }
    const omnipool = { ...omni([[], [], []]), unvaluedByBucket: [0, 3, 0] }
    expect(assembleLpHistory({ omnipool, v3 }, pricer, { N }).points.map(x => x.unpriced)).toEqual([3, 3, 1])
    expect(assembleLpHistory({ omnipool, v3, venues: new Set(['uniswapv3']) }, pricer, { N }).points.map(x => x.unpriced)).toEqual([1, 0, 0])
  })

  it('names v3 NFTs by token id and pool, Gamma holdings by vault, and filters venues', () => {
    const v3: V3PrincipalHistory = {
      legsByBucket: [[
        { kind: 'position', key: '0xmgr:77', tokenId: '77', manager: '0xmgr', pool: '0xpool', vault: null, shares: 9n, asset0: 10, asset1: 20, amount0: USD, amount1: USD },
        { kind: 'vault', key: '0xvault', tokenId: null, manager: null, pool: '0xpool', vault: '0xvault', shares: 4n, asset0: 10, asset1: 20, amount0: USD, amount1: 0n },
      ], [], []],
      assetIds: [10, 20],
      spans: new Map([['0xmgr:77', [{ fromBlock: 3, fromTime: null, toBlock: null, toTime: null, kind: 'direct' as const }]]]),
    }
    const all = assembleLpHistory({ v3 }, pricer, { N })
    expect(all.positions.map(p => [p.venue, p.positionId, p.poolKey, p.spans.length])).toEqual([['uniswapv3', '77', '0xpool', 1], ['gamma', null, '0xvault', 0]])
    const parts: LpHistoryParts = { v3, venues: new Set(['gamma']) }
    expect(assembleLpHistory(parts, pricer, { N }).positions.map(p => p.venue)).toEqual(['gamma'])
  })

  it('agrees with the Omnipool removal math bit for bit', () => {
    const st = pool({ reserve: 48_263_702_471_630_511_420_724_993n, hub: 46_968_735_321_535_740n, shares: 35_086_411_155_782_830_652_965_829n })
    const pos = { assetId: 10, amount: 9_007_199_254_740_993_000n, shares: 9_007_199_254_740_993_000n, priceNum: OMNI_FIXED * 2n, priceDen: OMNI_FIXED }
    const { liquidity, hub } = omnipoolRemoveLiquidity(st, pos)
    const out = assembleLpHistory({ omnipool: omni([[leg({ liquidity, hub })], [], []]) }, pricer, { N })
    expect(out.positions[0].points[0].legs[0].amount).toBe(liquidity)
    expect(out.positions[0].points[0].usd).toBe(liquidity * 2n + (hub > 0n ? hub * 10n : 0n))
  })

  it('returns an empty history for no positions', () => {
    const out = assembleLpHistory({ omnipool: omni(empty()) }, pricer, { N })
    expect(out.positions).toEqual([])
    expect(out.points.every(p => p.usd === 0n && p.unpriced === 0)).toBe(true)
  })
})

describe('v3PositionSpans', () => {
  it('opens a span on a transfer in and closes it on the first transfer away', () => {
    const me = '0x' + '11'.repeat(20)
    const them = '0x' + '22'.repeat(20)
    const t = (block: number, holder: string) => ({ manager: '0xm', tokenId: '1', block, index: 0, event: 'Transfer' as const, holder, liquidity: '0', amount0: '0', amount1: '0' })
    const spans = v3PositionSpans({
      accounts: [me], ranges: [], shareEvents: [], vaultFlows: [], vaults: [], tokenAssets: new Map(),
      managerEvents: [t(10, me), { ...t(11, ''), event: 'IncreaseLiquidity' }, t(20, them), t(30, me)],
    })
    expect(spans.get('0xm:1')).toEqual([
      { fromBlock: 10, fromTime: null, toBlock: 20, toTime: null, kind: 'direct' },
      { fromBlock: 30, fromTime: null, toBlock: null, toTime: null, kind: 'direct' },
    ])
  })
})

describe('selectLpHistoryBuckets', () => {
  const N = 3
  const bk = grid(0, D, N)
  const pricer = bucketPricerFrom(new Map([[10, [{ closedAt: 0, close: USD }]]]), bk)
  const leg = (positionId: string, liquidity: bigint) => ({ positionId, assetId: 10, liquidity, hub: 0n, shares: 1n, farmed: false, depositId: null })

  it('keeps the named buckets only, drops a position held at none of them, and re-ranks by the last kept point', () => {
    const omnipool: OmnipoolPrincipalHistory = {
      legsByBucket: [[leg('a', USD), leg('b', 5n * USD)], [leg('a', 9n * USD), leg('c', USD)], [leg('a', USD)], [leg('b', 2n * USD), leg('a', USD)]],
      assetIds: [10], fromBucket: 0, spans: new Map(), unvaluedByBucket: [0, 4, 0, 1],
    }
    const all = assembleLpHistory({ omnipool }, pricer, bk)
    const out = selectLpHistoryBuckets(all, [0, 3])
    expect(out.points.map(p => [p.b, p.usd, p.unpriced])).toEqual([[0, 6n * USD, 0], [3, 3n * USD, 1]])
    // c was held only at bucket 1; b's last kept point ($2) outranks a's ($1).
    expect(out.positions.map(p => [p.positionId, p.points.map(x => x.b)])).toEqual([['b', [0, 3]], ['a', [0, 3]]])
  })
})

describe('fillSpanTimes and the position cap', () => {
  it('resolves only the span ends the sources left without a time', async () => {
    const client = fakeClient(q => (q.includes('-- lp:span-times') ? [{ block_height: 10, t: 1000 }, { block_height: 20, t: 2000 }] : undefined))
    const positions = [{
      venue: 'omnipool' as const, farmed: false, positionId: '1', poolKey: 'omnipool', shareAssetId: null, points: [],
      spans: [
        { fromBlock: 10, fromTime: null, toBlock: 20, toTime: null, kind: 'direct' as const },
        { fromBlock: 20, fromTime: 1999, toBlock: null, toTime: null, kind: 'farmed' as const },
      ],
    }]
    await fillSpanTimes(client as never, positions)
    expect(client.seen[0].params.hs).toEqual([10, 20])
    expect(positions[0].spans).toEqual([
      { fromBlock: 10, fromTime: 1000, toBlock: 20, toTime: 2000, kind: 'direct' },
      { fromBlock: 20, fromTime: 1999, toBlock: null, toTime: null, kind: 'farmed' },
    ])
    const idle = fakeClient(() => undefined)
    await fillSpanTimes(idle as never, [{ ...positions[0] }])
    expect(idle.seen).toHaveLength(0) // nothing missing: no read
  })

  it('caps the published positions, counts the rest, and resolves span times for the published ones only', async () => {
    resetCacheForTests()
    const count = LP_HISTORY_POSITION_CAP + 1
    const bk = makeBucketing({ hours: [], heights: [], builtAt: 0 }, 1000 * D, 1001 * D, 0, undefined, undefined, { stepSec: D, heightAt: () => 5_000 })
    // Position i holds i units of asset 10, so position 1 is the smallest.
    const pids = Array.from({ length: count }, (_, i) => String(i + 1))
    const client = fakeClient(q => {
      if (q.includes('-- lp:omnipool-owner-intervals')) return pids.map(pid => ({ position_id: pid, ownership_kind: 'bare', deposit_id: '', valid_from_block: 100 + Number(pid), valid_to_block: 0 }))
      if (q.includes('-- lp:omnipool-position-states')) return pids.map(pid => ({ position_id: pid, block_height: 100, event_kind: 'created', asset_id: 10, amount_raw: `${pid}000000000000`, shares_raw: `${pid}000000000000`, price_raw: OMNI_FIXED.toString(), active: 1 }))
      if (q.includes('-- lp:omnipool-pool-states')) return [{ asset_id: 10, b: -1, reserve: '1000000000000000000', hub_reserve: '1000000000000000000', shares: '1000000000000000000' }]
      if (q.includes('-- lp:bucket-closes')) return [{ asset_id: 10, closed_at: 999 * D, px: '1' }]
      return undefined
    })
    const page = await loadLpHistory(client as never, { accounts: [ACC], h160s: [] }, bk, { grain: '1d', venues: new Set(['omnipool']) })
    expect(page.positions).toHaveLength(LP_HISTORY_POSITION_CAP)
    expect(page.positionsOmitted).toBe(1)
    expect(page.positions.some(p => p.positionId === '1')).toBe(false)
    // The omitted position's value is still in the line: 1 + … + 51 units at $1.
    expect(page.points[0].usd).toBe(BigInt(count * (count + 1) / 2) * USD)
    const spanRead = client.seen.find(x => x.query.includes('-- lp:span-times'))!
    expect((spanRead.params.hs as number[]).sort((a, b) => a - b)).toEqual(pids.slice(1).map(pid => 100 + Number(pid)))
    // An account-only caller skips the read entirely.
    const before = client.seen.length
    await loadLpHistory(client as never, { accounts: [ACC], h160s: [] }, bk, { grain: '1d', venues: new Set(['omnipool']), spanTimes: false })
    expect(client.seen.slice(before).some(x => x.query.includes('-- lp:span-times'))).toBe(false)
  })
})
