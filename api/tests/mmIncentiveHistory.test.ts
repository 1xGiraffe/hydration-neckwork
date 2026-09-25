import { beforeEach, describe, expect, it } from 'vitest'
import { makeBucketing } from '../src/services/bucketLadder.ts'
import { resetCacheForTests } from '../src/services/cache.ts'
import { loadMmIncentiveHistory, mmIncentiveSeries, type MmIncentiveParts } from '../src/services/mmIncentiveHistory.ts'
import { assembleMoneyMarketHistory, type MmHistoryParts } from '../src/services/moneyMarketHistory.ts'
import { testBucketing } from './support/bucketing.ts'

// The SETTLED claimable per bucket end: anchor@B0 + Σ Accrued − Σ claimed, plus
// scaled × (the programme's last stored index − the holder's index) / unit. Verified
// against the chain's own views at 8 historical blocks for 44 holders (630 of 630
// stated (holder, reward, bucket) triples exact on 2026-09-25); these pin the rules.

const B0 = 1_000
const H = '0x4a9ab52a6f688ede97c23d946f7e8ef4f1e47a47'
const GDOT = '0x0000000000000000000000000000000100000045'
const A690 = '0x34d5ffb83d14d82f87aaf2f13be895a3c814c2ad'
const UNIT = 10n ** 18n
const ends = [900, 1_100, 1_200, 1_300]
const bk = { N: ends.length - 1, endHeight: (b: number) => ends[b] }

const parts = (over: Partial<MmIncentiveParts> = {}): MmIncentiveParts => ({
  anchorBlock: B0,
  programmes: [{ asset: A690, reward: GDOT, unit: UNIT, marketKey: 'core' }],
  scaled: new Map([[`${H}|${A690}`, [undefined, 2n * UNIT, 2n * UNIT, 0n]]]),
  accruals: new Map([[`${H}|${A690}|${GDOT}`, new Map([[2, { acc: 30n, idx: 110n }]])]]),
  claims: new Map([[`${H}|${GDOT}`, new Map([[3, 50n]])]]),
  anchorAccrued: new Map([[`${H}|${GDOT}`, 20n]]),
  anchorUserIndex: new Map([[`${H}|${A690}|${GDOT}`, 100n]]),
  anchorProgrammeIndex: new Map([[`${A690}|${GDOT}`, 100n]]),
  programmeIndex: new Map([[`${A690}|${GDOT}`, new Map([[1, { idx: 105n, block: 1_050 }], [2, { idx: 110n, block: 1_150 }], [3, { idx: 120n, block: 1_250 }]])]]),
  unreconciled: new Set(),
  ...over,
})

describe('mmIncentiveSeries', () => {
  it('states nothing before B0 and the settled claimable after it', () => {
    const h = mmIncentiveSeries(parts(), bk)
    expect(h.itemsByBucket[0]).toEqual([])
    expect(h.incompleteByBucket[0]).toBe(0)
    // b1: anchor 20 + pending 2·(105 − 100) = 30, settled at the index update of block 1,050.
    expect(h.itemsByBucket[1]).toEqual([{ holder: H, marketKey: 'core', rewardAssetId: 69, amount: 30n, settledAtBlock: 1_050 }])
    // b2: an Accrued moved the pending into the accrual (20 + 30) and set the holder's index to 110: nothing pending.
    expect(h.itemsByBucket[2][0].amount).toBe(50n)
    // b3: claimed 50, and no balance any more — nothing left, so no item.
    expect(h.itemsByBucket[3]).toEqual([])
    expect(h.rewardAssetIds).toEqual([69])
  })

  it('takes the holder\'s index from its anchor before any post-B0 accrual, and 0 for one the programme never touched', () => {
    const noAnchor = mmIncentiveSeries(parts({ anchorUserIndex: new Map(), accruals: new Map(), claims: new Map(), anchorAccrued: new Map() }), bk)
    // 2 · (105 − 0): a programme configured on a balance it had never indexed.
    expect(noAnchor.itemsByBucket[1][0].amount).toBe(210n)
  })

  it('carries the pre-window events and the programme index into the window', () => {
    const h = mmIncentiveSeries(parts({
      accruals: new Map([[`${H}|${A690}|${GDOT}`, new Map([[-1, { acc: 7n, idx: 105n }]])]]),
      claims: new Map([[`${H}|${GDOT}`, new Map([[-1, 2n]])]]),
      programmeIndex: new Map([[`${A690}|${GDOT}`, new Map([[-1, { idx: 105n, block: 990 }]])]]),
    }), bk)
    // 20 + 7 − 2, index 105 = the holder's: nothing pending.
    expect(h.itemsByBucket[1][0]).toMatchObject({ amount: 25n, settledAtBlock: 990 })
  })

  it('counts, never values, a pair the current snapshot did not reconcile', () => {
    const h = mmIncentiveSeries(parts({ unreconciled: new Set([`${H}|${GDOT}`]) }), bk)
    expect(h.itemsByBucket.flat()).toEqual([])
    expect(h.incompleteByBucket).toEqual([0, 1, 1, 0])
  })

  it('counts a pair it cannot state: a negative accrual, an index that went backwards, an unknown unit', () => {
    expect(mmIncentiveSeries(parts({ anchorAccrued: new Map([[`${H}|${GDOT}`, -1n]]), accruals: new Map() }), bk).incompleteByBucket[1]).toBe(1)
    expect(mmIncentiveSeries(parts({ anchorUserIndex: new Map([[`${H}|${A690}|${GDOT}`, 200n]]) }), bk).incompleteByBucket[1]).toBe(1)
    expect(mmIncentiveSeries(parts({ programmes: [{ asset: A690, reward: GDOT, unit: null, marketKey: 'core' }] }), bk).incompleteByBucket[1]).toBe(1)
  })

  // A reward incentivizing aTokens of two isolated markets: each pending part under
  // its own aToken's market, the stored accrual (one figure per holder and reward —
  // RewardsClaimed names no aToken) under the primary market; the markets sum to
  // the one-market figure.
  it('splits a reward spanning markets per market by its pending legs', () => {
    const A_BIL = '0x52e1311e26610e6662a1e5b5bd113130b6815213'
    const h = mmIncentiveSeries(parts({
      programmes: [{ asset: A690, reward: GDOT, unit: UNIT, marketKey: 'core' }, { asset: A_BIL, reward: GDOT, unit: UNIT, marketKey: 'bil' }],
      scaled: new Map([[`${H}|${A690}`, [undefined, 2n * UNIT, 2n * UNIT, 0n]], [`${H}|${A_BIL}`, [undefined, UNIT, 0n, 0n]]]),
      anchorUserIndex: new Map([[`${H}|${A690}|${GDOT}`, 100n], [`${H}|${A_BIL}|${GDOT}`, 100n]]),
      anchorProgrammeIndex: new Map([[`${A690}|${GDOT}`, 100n], [`${A_BIL}|${GDOT}`, 100n]]),
      programmeIndex: new Map([
        [`${A690}|${GDOT}`, new Map([[1, { idx: 105n, block: 1_050 }]])],
        [`${A_BIL}|${GDOT}`, new Map([[1, { idx: 103n, block: 1_040 }]])],
      ]),
    }), bk)
    // b1: core = anchor 20 + 2·(105 − 100) = 30; bil = 1·(103 − 100) = 3.
    expect(h.itemsByBucket[1]).toEqual([
      { holder: H, marketKey: 'bil', rewardAssetId: 69, amount: 3n, settledAtBlock: 1_040 },
      { holder: H, marketKey: 'core', rewardAssetId: 69, amount: 30n, settledAtBlock: 1_050 },
    ])
  })

  it('states nothing without an anchor', () => {
    const h = mmIncentiveSeries(parts({ anchorBlock: 0 }), bk)
    expect(h.anchorBlock).toBe(0)
    expect(h.itemsByBucket.flat()).toEqual([])
  })
})

describe('incentives in the money-market history assembly', () => {
  const CORE = '0x1b02e051683b5cfac5929c25e84adb26ecf87b38'
  const base: MmHistoryParts = {
    reserveMap: { anchorBlock: B0, reserves: [{ assetAddress: '0x0000000000000000000000000000000100000005', atoken: A690, vdebt: '', poolProxy: CORE, marketKey: 'core' }] },
    scaled: new Map(), indices: new Map(), endTimes: ends.map(() => 0), observations: new Map(), collateral: new Map(), emode: new Map(),
  }
  const rewards = {
    anchorBlock: B0,
    itemsByBucket: [[], [
      { holder: H, marketKey: 'core', rewardAssetId: 69, amount: 2n * 10n ** 18n, settledAtBlock: 1_050 },
      { holder: `0x${'11'.repeat(20)}`, marketKey: 'core', rewardAssetId: 69, amount: 10n ** 18n, settledAtBlock: 1_060 },
      { holder: H, marketKey: 'core', rewardAssetId: 0, amount: 5n, settledAtBlock: null },
    ], [], []],
    incompleteByBucket: [0, 1, 0, 0],
    rewardAssetIds: [0, 69],
  }
  // GDOT at $3 (1e-12 USD units per raw unit scaled by decimals), HDX unpriced.
  const pricer = { usd: (id: number, amount: bigint) => (id === 69 ? (amount * 3n * 10n ** 12n) / 10n ** 18n : null) }

  it('lists them per market and reward asset beside the legs, sums the priced ones and counts the rest', () => {
    const h = assembleMoneyMarketHistory({ ...base, rewards }, pricer as never, bk)
    const core = h.markets.find(m => m.marketKey === 'core')!
    // A market with no reserve and no observation still carries a point where incentives were owed.
    expect(core.points.map(p => p.b)).toEqual([1])
    expect(core.points[0].unclaimedRewards).toEqual([
      { rewardAssetId: 0, amount: 5n, valueUsd: null, settledAtBlock: null },
      { rewardAssetId: 69, amount: 3n * 10n ** 18n, valueUsd: 9n * 10n ** 12n, settledAtBlock: 1_060 },
    ])
    // Never inside the supplied sum.
    expect(core.points[0].suppliedUsd).toBe(0n)
    expect(h.points[1]).toMatchObject({ unclaimedRewardsUsd: 9n * 10n ** 12n, rewardsIncomplete: 2 })
    // Unstated before B0, zero after it where nothing was owed.
    expect(h.points[0]).toMatchObject({ unclaimedRewardsUsd: null, rewardsIncomplete: 0 })
    expect(h.points[2]).toMatchObject({ unclaimedRewardsUsd: 0n, rewardsIncomplete: 0 })
  })

  it('follows the market filter', () => {
    const h = assembleMoneyMarketHistory({ ...base, rewards, markets: new Set(['bil']) }, pricer as never, bk)
    expect(h.points[1].unclaimedRewardsUsd).toBe(0n)
    expect(h.markets).toEqual([])
  })
})

describe('a programme with no stored index yet', () => {
  it('reads index 0 — the controller\'s value for an asset it never updated — and stays stated', () => {
    // A balance on a programme that has neither an anchor index nor any update by bucket 1.
    const h = mmIncentiveSeries(parts({
      anchorUserIndex: new Map(), anchorProgrammeIndex: new Map(), accruals: new Map(), claims: new Map(),
      programmeIndex: new Map([[`${A690}|${GDOT}`, new Map([[3, { idx: 7n, block: 1_250 }]])]]),
    }), bk)
    // b1, b2: accrued 20, pending 2 · (0 − 0) = 0 — stated, not incomplete, and not settled on any update.
    expect(h.incompleteByBucket).toEqual([0, 0, 0, 0])
    expect(h.itemsByBucket[1]).toEqual([{ holder: H, marketKey: 'core', rewardAssetId: 69, amount: 20n, settledAtBlock: null }])
    expect(h.itemsByBucket[2][0].amount).toBe(20n)
  })
})

describe('loadMmIncentiveHistory', () => {
  beforeEach(() => resetCacheForTests())
  const A110 = `0x${'11'.repeat(20)}`
  const PRIME = '0x000000000000000000000000000000010000002b'
  type Row = Record<string, unknown>
  const tagged = (tag: string) => (q: string) => q.includes(`-- ${tag}\n`)
  function fakeClient(route: (q: string, p: Record<string, unknown>) => Row[] | undefined, opts: { ageSeconds?: number; reconciled?: number } = {}) {
    const seen: Array<{ query: string; params: Record<string, unknown> }> = []
    const base = (q: string, p: Record<string, unknown>): Row[] => {
      if (tagged('mm:incentive-anchor-blocks')(q)) return [{ b0: 200_150, s0: 200_150 }]
      if (tagged('mm:incentive-programmes')(q)) return [{ asset: A690, reward: GDOT }, { asset: A110, reward: PRIME }]
      if (tagged('mm:incentive-anchor')(q)) return [{ u: H, asset: '', reward: GDOT, value: '40' }]
      if (tagged('mm:incentive-snapshot-state')(q)) return [{ snapshot_id: '1', block_height: 200_300, age_seconds: opts.ageSeconds ?? 60 }]
      if (tagged('mm:incentive-snapshot-rows')(q)) return [{
        account_id: `0x45544800${H.slice(2)}0000000000000000`, holder: H, reward_asset_id: 69, reward_address: GDOT, asset_address: '', market_key: 'core',
        claimable_s: '40', model_s: '40', accrued_s: '40', pending_s: '0', scaled_s: '0', user_index_s: '0', asset_index_s: '0',
        reconciled: opts.reconciled ?? 1, below_ed: 0, snapshot_block: 200_300,
      }]
      return route(q, p) ?? []
    }
    return {
      seen,
      query: async (o: { query: string; query_params?: Record<string, unknown> }) => {
        seen.push({ query: o.query, params: o.query_params ?? {} })
        return { json: async () => base(o.query, o.query_params ?? {}) }
      },
    }
  }
  const lbk = testBucketing(200_000, 100, 3)
  const reserves = [{ atoken: A690, assetAddress: '0x00000000000000000000000000000001000002b2', marketKey: 'core' }]

  it('reads no programme index for a holder with no balance on any programme aToken', async () => {
    const client = fakeClient(() => undefined)
    const h = await loadMmIncentiveHistory(client as never, [H], lbk, reserves)
    expect(client.seen.some(s => /-- mm:incentive-index/.test(s.query))).toBe(false)
    // The stored accrual alone is stated: 40 from B0 on.
    expect(h.itemsByBucket.map(items => items.map(i => i.amount))).toEqual([[], [40n], [40n], [40n]])
  })

  it('reads the index only for the programmes a holder has a balance on, and takes the caller\'s scaled series', async () => {
    const client = fakeClient(() => undefined)
    const scaled = new Map([[`${H}|${A690}`, [undefined, 5n, 5n, 0n]], [`${H}|0xnotaprogramme`, [undefined, 9n, 9n, 9n]]])
    await loadMmIncentiveHistory(client as never, [H], lbk, reserves, { scaled, scaledAnchorBlock: 200_150 })
    expect(client.seen.some(s => /-- mm:incentive-scaled/.test(s.query))).toBe(false)
    const idx = client.seen.find(s => tagged('mm:incentive-index')(s.query))!
    expect(idx.params.assets).toEqual([A690])
    // A scaled series on another anchor block is not the arithmetic's: it reads its own.
    const other = fakeClient(() => undefined)
    await loadMmIncentiveHistory(other as never, [H], lbk, reserves, { scaled, scaledAnchorBlock: 1 })
    expect(other.seen.some(s => tagged('mm:incentive-scaled-deltas')(s.query))).toBe(true)
  })

  it('flags a pair the NEWEST generation did not reconcile even when that generation is stale', async () => {
    const stale = fakeClient(() => undefined, { ageSeconds: 100_000, reconciled: 0 })
    const h = await loadMmIncentiveHistory(stale as never, [H], lbk, reserves)
    expect(h.itemsByBucket.flat()).toEqual([])
    expect(h.incompleteByBucket).toEqual([0, 1, 1, 1])
  })

  it('folds the programme index once per canonical grid for every programme, shared by accounts on it', async () => {
    const HOUR = 3_600
    const T0 = 1_000 * HOUR
    const heightAt = (sec: number) => (sec < T0 ? null : 200_000 + Math.floor((sec - T0) / 6))
    const grid = (from: number) => makeBucketing({ hours: [], heights: [], builtAt: 0 }, from, T0 + 400 * HOUR + 500, heightAt(from)!, undefined, undefined,
      { stepSec: HOUR, heightAt, dating: { key: 'exact', heightAt } })
    const client = fakeClient(() => undefined)
    for (const from of [T0 + 300 * HOUR, T0 + 350 * HOUR]) {
      const g = grid(from)
      const scaled = new Map([[`${H}|${A690}`, new Array<bigint | undefined>(g.N + 1).fill(5n)]])
      await loadMmIncentiveHistory(client as never, [H], g, reserves, { scaled, scaledAnchorBlock: 200_150 })
    }
    const folds = client.seen.filter(s => tagged('mm:incentive-index')(s.query))
    expect(folds).toHaveLength(1)
    expect(folds[0].params.assets).toEqual([A110, A690])
    expect(client.seen.filter(s => tagged('mm:incentive-index-tail')(s.query)).map(s => s.params.assets)).toEqual([[A690], [A690]])
  })
})
