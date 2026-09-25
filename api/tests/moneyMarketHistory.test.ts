import { beforeEach, describe, expect, it } from 'vitest'
import { RAY, normalizedDebt, normalizedIncome, rayMul } from '../src/services/aaveMath.ts'
import { resetCacheForTests } from '../src/services/cache.ts'
import type { BucketPricer } from '../src/services/lpHistory.ts'
import {
  CARRY_LOOKBACK_BLOCKS, assembleMoneyMarketHistory, chooseObservationHolders, loadCollateralFlagHistory, loadCurrentCollateralFlags, loadCurrentEmode,
  loadEmodeHistory, loadObservationHistory, loadReserveIndexHistory, loadScaledHistoryByHolder, mmEthAccountForm,
  mmHistoryStart, mmMarketCompare, reserveAmountsAt, reserveKey, selectMoneyMarketBuckets, sumScaledByContract,
  type MmHistoryParts, type MmObservation, type ReserveIndexState,
} from '../src/services/moneyMarketHistory.ts'
import { heightAtOrBeforeExact, type BlockClock } from '../src/services/blockClock.ts'
import { makeBucketing } from '../src/services/bucketLadder.ts'
import { testBucketing } from './support/bucketing.ts'

// The money-market history leaf: amounts exact at the bucket's block (Aave's own
// interest arithmetic from the reserve's last update, the Initialization-phase
// parent timestamp), the coverage floor B0 (null, never zero, before it), priced
// legs only in the sums with the rest counted, isolated markets never blended.
// Registry is empty under test, so every asset is the synthetic 12-decimal one.

const USD = 10n ** 12n
const E12 = 10n ** 12n
const H = `0x${'4a'.repeat(20)}`
const CORE = `0x${'1b'.repeat(20)}`
const GIGA = '0x2ce2cfff743cdb6637f4b5d351937a541b8c8923'
const DOT = '0x0000000000000000000000000000000100000005'
const USDT = '0x000000000000000000000000000000010000000a'
const STHDX = '0x000000000000000000000000000000010000029e' // asset 670

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
const tagged = (tag: string) => (q: string) => q.includes(`-- ${tag}\n`)

beforeEach(() => resetCacheForTests())

describe('reserveAmountsAt', () => {
  it('is balanceOf: rayMul(scaled, normalized index at the block time) per side', () => {
    const idx: ReserveIndexState = { liquidityIndex: 1_050_000_000_000_000_000_000_000_000n, variableBorrowIndex: 1_100_000_000_000_000_000_000_000_000n, liquidityRate: 30_000_000_000_000_000_000_000_000n, variableBorrowRate: 60_000_000_000_000_000_000_000_000n, tLast: 1_000n, block: 1, initPhase: false }
    const { supplied, borrowed } = reserveAmountsAt(19_544_999n, 7_777_777n, idx, 4_600n)
    expect(supplied).toBe(rayMul(19_544_999n, normalizedIncome(idx.liquidityIndex, idx.liquidityRate, 1_000n, 4_600n)))
    expect(borrowed).toBe(rayMul(7_777_777n, normalizedDebt(idx.variableBorrowIndex, idx.variableBorrowRate, 1_000n, 4_600n)))
    // Updated in the same second: the stored index itself.
    expect(reserveAmountsAt(10n, 0n, idx, 1_000n).supplied).toBe(rayMul(10n, idx.liquidityIndex))
    // Nothing held on a side: zero, never a negative rounding.
    expect(reserveAmountsAt(0n, -5n, idx, 4_600n)).toEqual({ supplied: 0n, borrowed: 0n })
  })
})

// Bucket ends 200,099 / 200,199 / 200,299 / 200,300; B0 = 200,150 leaves bucket 0 before it.
const bk = testBucketing(200_000, 100, 3)
const B0 = 200_150
const flat = (block: number): ReserveIndexState => ({ liquidityIndex: RAY, variableBorrowIndex: RAY, liquidityRate: 0n, variableBorrowRate: 0n, tLast: 0n, block, initPhase: false })
const obs = (block: number, coll: string, debt: string, hf = '2000000000000000000'): MmObservation =>
  ({ block, totalCollateralBase: coll, totalDebtBase: debt, availableBorrowsBase: '0', liquidationThreshold: '8000', ltv: '7000', healthFactor: hf })

// DOT at $2, stHDX (670) at $1, USDT (10) unpriced.
const pricer: BucketPricer = {
  close: () => null,
  usd: (assetId, amount) => (assetId === 5 ? (amount * 2n * USD) / E12 : assetId === 670 ? (amount * USD) / E12 : null),
}

function parts(overrides: Partial<MmHistoryParts> = {}): MmHistoryParts {
  return {
    reserveMap: {
      anchorBlock: B0,
      reserves: [
        { assetAddress: DOT, atoken: 'a5', vdebt: 'd5', poolProxy: CORE, marketKey: 'core' },
        { assetAddress: USDT, atoken: 'a10', vdebt: 'd10', poolProxy: CORE, marketKey: 'core' },
        { assetAddress: STHDX, atoken: 'a670', vdebt: 'd670', poolProxy: GIGA, marketKey: 'gigahdx' },
      ],
    },
    scaled: new Map([
      ['a5', [undefined, 10n * E12, 10n * E12, 0n]],
      ['d5', [undefined, 2n * E12, 2n * E12, 2n * E12]],
      ['a10', [undefined, 5n * E12, 5n * E12, 5n * E12]],
      ['a670', [undefined, 1n * E12, 1n * E12, 1n * E12]],
    ]),
    indices: new Map<string, (ReserveIndexState | null | undefined)[]>([
      // DOT's update at bucket 2 could not be stated (no indexed log, or no rates row).
      [reserveKey(CORE, DOT), [flat(1), flat(1), null, flat(200_250)]],
      [reserveKey(CORE, USDT), [flat(1), flat(1), flat(1), flat(1)]],
      [reserveKey(GIGA, STHDX), [flat(1), flat(1), flat(1), flat(1)]],
    ]),
    endTimes: [0, 0, 0, 0],
    observations: new Map([[CORE, [obs(199_990, '100', '10'), obs(200_150, '100', '10'), obs(200_150, '100', '10'), obs(200_290, '50', '10', '1500000000000000000')]]]),
    collateral: new Map([[reserveKey(CORE, DOT), [undefined, undefined, true, true]]]),
    emode: new Map([[CORE, [undefined, 1, 1, 0]]]),
    ...overrides,
  }
}

describe('assembleMoneyMarketHistory', () => {
  it('states nothing about reserves before B0 — null, never zero — while the observation still shows', () => {
    const h = assembleMoneyMarketHistory(parts(), pricer, bk)
    expect(h.reserveHistoryFrom).toEqual({ blockHeight: B0 })
    expect(h.points[0]).toEqual({ b: 0, suppliedUsd: null, borrowedUsd: null, unpriced: 0, unclaimedRewardsUsd: null, rewardsIncomplete: 0 })
    const core = h.markets.find(m => m.marketKey === 'core')!
    expect(core.points[0]).toMatchObject({ b: 0, suppliedUsd: null, borrowedUsd: null, netUsd: null, unpriced: 0, eModeCategoryId: null })
    expect(core.points[0].observation?.block).toBe(199_990)
    for (const r of core.reserves) expect(r.points.every(p => p.b > 0)).toBe(true)
  })

  it('sums priced legs only and counts every held leg it could not value or state', () => {
    const h = assembleMoneyMarketHistory(parts(), pricer, bk)
    const core = h.markets.find(m => m.marketKey === 'core')!
    // Bucket 1: DOT 10 supplied ($20) and 2 owed ($4); USDT supplied but unpriced.
    expect(core.points[1]).toMatchObject({ suppliedUsd: 20n * USD, borrowedUsd: 4n * USD, unpriced: 1, netUsd: null, eModeCategoryId: 1 })
    // Bucket 2: DOT's index is unresolved, so both its sides are unstated — no
    // point, counted — beside the unpriced USDT leg.
    expect(core.points[2]).toMatchObject({ suppliedUsd: 0n, borrowedUsd: 0n, unpriced: 3 })
    const dot = core.reserves.find(r => r.assetId === 5)!
    expect(dot.points.map(p => p.b)).toEqual([1, 3])
    expect(dot.aTokenAssetId).toBe(1001) // aDOT
    // The account line sums ACROSS the isolated markets (stHDX $1 in gigahdx).
    expect(h.points[1]).toEqual({ b: 1, suppliedUsd: 21n * USD, borrowedUsd: 4n * USD, unpriced: 1, unclaimedRewardsUsd: null, rewardsIncomplete: 0 })
  })

  it('publishes netUsd only when every held leg is priced and stated', () => {
    const h = assembleMoneyMarketHistory(parts({ scaled: new Map([['a5', [undefined, 10n * E12, 10n * E12, 0n]], ['d5', [undefined, 2n * E12, 2n * E12, 2n * E12]]]) }), pricer, bk)
    const core = h.markets.find(m => m.marketKey === 'core')!
    expect(core.points[1].netUsd).toBe(16n * USD)
    expect(core.points[2].netUsd).toBeNull() // DOT unstated there
    expect(core.points[3].netUsd).toBe(-4n * USD)
  })

  it('reads the collateral flag as last observed: null before any observer, false with nothing supplied', () => {
    const h = assembleMoneyMarketHistory(parts(), pricer, bk)
    const dot = h.markets.find(m => m.marketKey === 'core')!.reserves.find(r => r.assetId === 5)!
    expect(dot.points[0]).toMatchObject({ b: 1, supplied: 10n * E12, borrowed: 2n * E12, collateral: null })
    expect(dot.points[1]).toMatchObject({ b: 3, supplied: 0n, borrowed: 2n * E12, suppliedUsd: 0n, borrowedUsd: 4n * USD, collateral: false })
  })

  it('keeps isolated markets apart, in market order, and never lends one market another\'s observation', () => {
    const h = assembleMoneyMarketHistory(parts(), pricer, bk)
    expect(h.markets.map(m => [m.marketKey, m.stakingBacked])).toEqual([['core', false], ['gigahdx', true]])
    const giga = h.markets[1]
    expect(giga.points.every(p => p.observation === null)).toBe(true)
    expect(giga.points.map(p => p.suppliedUsd)).toEqual([USD, USD, USD])
  })

  it('narrows every figure to the markets asked for', () => {
    const h = assembleMoneyMarketHistory(parts({ markets: new Set(['gigahdx']) }), pricer, bk)
    expect(h.markets.map(m => m.marketKey)).toEqual(['gigahdx'])
    expect(h.points[1]).toEqual({ b: 1, suppliedUsd: USD, borrowedUsd: 0n, unpriced: 0, unclaimedRewardsUsd: null, rewardsIncomplete: 0 })
  })

  it('carries a market point only where a reserve is held or the observation shows collateral or debt', () => {
    const closed = parts({ observations: new Map([[CORE, [obs(199_990, '0', '0'), obs(200_150, '0', '0'), undefined, undefined]]]), scaled: new Map() })
    const h = assembleMoneyMarketHistory(closed, pricer, bk)
    expect(h.markets).toEqual([])
    expect(h.points.map(p => p.suppliedUsd)).toEqual([null, 0n, 0n, 0n])
  })

  it('states no reserve figure at all without an anchor', () => {
    const h = assembleMoneyMarketHistory(parts({ reserveMap: { ...parts().reserveMap, anchorBlock: 0 } }), pricer, bk)
    expect(h.reserveHistoryFrom).toBeNull()
    expect(h.points.every(p => p.suppliedUsd === null && p.borrowedUsd === null)).toBe(true)
    expect(h.markets.flatMap(m => m.reserves)).toEqual([])
  })

  it('selects published buckets without renumbering them', () => {
    const h = selectMoneyMarketBuckets(assembleMoneyMarketHistory(parts(), pricer, bk), [1, 3])
    expect(h.points.map(p => p.b)).toEqual([1, 3])
    expect(h.markets[0].reserves.find(r => r.assetId === 5)!.points.map(p => p.b)).toEqual([1, 3])
  })
})

describe('loadScaledHistoryByHolder summed per contract', () => {
  it('adds every post-B0 delta to the B0 anchor per holder, floors a holder at zero, and leaves pre-B0 buckets unknown', async () => {
    const H2 = `0x${'4b'.repeat(20)}`
    const client = fakeClient((q) => {
      if (tagged('mm:scaled-anchor')(q)) return [{ holder: H, contract: '0xC', scaled: '100' }, { holder: H2, contract: '0xC', scaled: '5' }]
      if (tagged('mm:scaled-deltas')(q)) return [
        { holder: H, contract: '0xc', b: -1, delta: '10' },
        { holder: H, contract: '0xc', b: 1, delta: '-30' },
        { holder: H, contract: '0xc', b: 2, delta: '-200' },
      ]
      return undefined
    })
    const out = sumScaledByContract(await loadScaledHistoryByHolder(client as never, [H, H2.toUpperCase().replace('0X', '0x')], B0, bk))
    expect(out.get('0xc')).toEqual([undefined, 85n, 5n, 5n])
    const deltas = client.seen.find(s => tagged('mm:scaled-deltas')(s.query))!
    expect(deltas.params).toMatchObject({ b0: B0, maxb: bk.endHeight(bk.N) })
    expect(deltas.query).toContain('FINAL')
  })

  it('reads nothing without an anchor', async () => {
    const client = fakeClient(() => [])
    expect((await loadScaledHistoryByHolder(client as never, [H], 0, bk)).size).toBe(0)
    expect(client.seen).toHaveLength(0)
  })
})

describe('loadReserveIndexHistory', () => {
  const R2 = '0x0000000000000000000000000000000100000016'
  it('accrues an Initialization-phase update from the PARENT block\'s timestamp and leaves an unresolved one unstated', async () => {
    const client = fakeClient((q, p) => {
      if (tagged('mm:reserve-indices')(q)) return [
        { pool: CORE, reserve: DOT, b: -1, liq: String(RAY), vbi: String(RAY), blk: 199_950, ev: 3, ts: 5_000 },
        { pool: CORE, reserve: DOT, b: 1, liq: String(2n * RAY), vbi: String(3n * RAY), blk: 200_150, ev: 7, ts: 6_000 },
        // A pair outside the wanted reserves (the pool × reserve cross product) is dropped.
        { pool: GIGA, reserve: DOT, b: 0, liq: '1', vbi: '1', blk: 1, ev: 1, ts: 1 },
      ]
      if (tagged('mm:reserve-rates')(q)) return [
        { pool: CORE, reserve: DOT, b: -1, liq_rate: '11', vb_rate: '22', blk: 199_950, ev: 3 },
        { pool: CORE, reserve: DOT, b: 1, liq_rate: '33', vb_rate: '44', blk: 200_150, ev: 7 },
      ]
      if (tagged('mm:reserve-update-phase')(q)) {
        // The whole primary key, zipped server-side (never an Array(Tuple) parameter).
        expect(q).toContain('(block_height, event_index) IN arrayZip({b:Array(UInt32)}, {e:Array(UInt32)})')
        expect(p).toEqual({ b: [199_950, 200_150], e: [3, 7] })
        return [{ block_height: 199_950, event_index: 3, init: 1 }] // (200150, 7) has no indexed log
      }
      if (tagged('mm:block-times')(q)) return (p.hs as number[]).map(h => ({ block_height: h, t: h === 199_949 ? 4_994 : 0 }))
      return undefined
    })
    const out = await loadReserveIndexHistory(client as never, [{ pool: CORE, reserve: DOT }], bk)
    const series = out.get(reserveKey(CORE, DOT))!
    expect(series[0]).toEqual({ liquidityIndex: RAY, variableBorrowIndex: RAY, liquidityRate: 11n, variableBorrowRate: 22n, tLast: 4_994n, block: 199_950, initPhase: true })
    expect(series[1]).toBeNull()
    expect(series[3]).toBeNull() // forward-filled: still the unresolved update
    expect(out.has(reserveKey(GIGA, DOT))).toBe(false)
    // The carry into the window is looked for within the lookback first.
    const idx = client.seen.find(s => tagged('mm:reserve-indices')(s.query))!
    expect(idx.params.lo).toBe(Math.max(0, bk.floorHeight - CARRY_LOOKBACK_BLOCKS))
    expect(client.seen.some(s => tagged('mm:reserve-indices-carry')(s.query))).toBe(false)
  })

  it('reads a quiet reserve\'s carry on its own below the lookback, and nothing unwanted', async () => {
    const far = testBucketing(500_000, 100, 3)
    const client = fakeClient((q, p) => {
      if (tagged('mm:reserve-indices')(q)) return [{ pool: CORE, reserve: DOT, b: -1, liq: String(RAY), vbi: String(RAY), blk: 499_000, ev: 1, ts: 9_000 }]
      if (tagged('mm:reserve-rates')(q)) return [{ pool: CORE, reserve: DOT, b: -1, liq_rate: '0', vb_rate: '0', blk: 499_000, ev: 1 }]
      if (tagged('mm:reserve-indices-carry')(q)) {
        expect(p).toMatchObject({ reserves: [R2], lo: 0, hi: 500_000 - CARRY_LOOKBACK_BLOCKS - 1 })
        return [{ pool: CORE, reserve: R2, b: -1, liq: String(RAY), vbi: String(RAY), blk: 10, ev: 2, ts: 60 }]
      }
      if (tagged('mm:reserve-rates-carry')(q)) return [{ pool: CORE, reserve: R2, b: -1, liq_rate: '0', vb_rate: '0', blk: 10, ev: 2 }]
      if (tagged('mm:reserve-update-phase')(q)) return [{ block_height: 499_000, event_index: 1, init: 0 }, { block_height: 10, event_index: 2, init: 0 }]
      return undefined
    })
    const out = await loadReserveIndexHistory(client as never, [{ pool: CORE, reserve: DOT }, { pool: CORE, reserve: R2 }], far)
    expect(out.get(reserveKey(CORE, R2))![0]).toMatchObject({ tLast: 60n, block: 10, initPhase: false })
    expect(out.get(reserveKey(CORE, DOT))![3]).toMatchObject({ tLast: 9_000n, block: 499_000 })
  })
})

describe('observation and collateral history', () => {
  it('forward-fills the newest observation per market, reading a quiet market\'s carry below the lookback', async () => {
    const far = testBucketing(500_000, 100, 3)
    const client = fakeClient((q, p) => {
      if (tagged('mm:observations')(q)) {
        expect(p.accs).toEqual([mmEthAccountForm(H)])
        return [{ pool: CORE, b: -1, obs_block: 499_990, coll: '100', debt: '10', avail: '5', lt: '8000', max_ltv: '7000', hf: '9' }, { pool: CORE, b: 2, obs_block: 500_250, coll: '90', debt: '10', avail: '1', lt: '8000', max_ltv: '7000', hf: '8' }]
      }
      if (tagged('mm:observations-carry')(q)) {
        expect(p.pools).toEqual([GIGA])
        return [{ pool: GIGA, b: -1, obs_block: 12, coll: '1', debt: '0', avail: '0', lt: '0', max_ltv: '0', hf: '115792089237316195423570985008687907853269984665640564039457584007913129639935' }]
      }
      return undefined
    })
    const out = await loadObservationHistory(client as never, [H], [CORE, GIGA], far)
    expect(out.get(CORE)!.map(o => o?.block)).toEqual([499_990, 499_990, 500_250, 500_250])
    expect(out.get(GIGA)![3]).toMatchObject({ block: 12, totalCollateralBase: '1' })
  })

  it('folds events and sweep reads into the flag as last observed per bucket', async () => {
    const client = fakeClient(q => (tagged('mm:collateral-flags')(q)
      ? [{ pool: CORE, reserve: DOT, b: 1, enabled_last: 1 }, { pool: CORE, reserve: DOT, b: 3, enabled_last: 0 }]
      : undefined))
    const out = await loadCollateralFlagHistory(client as never, [H], bk)
    expect(out.get(reserveKey(CORE, DOT))).toEqual([undefined, true, true, false])
    const sql = client.seen[0].query
    expect(sql).toContain('money_market_collateral_flags')
    expect(sql).toContain('money_market_collateral_anchor')
  })
})

describe('E-mode', () => {
  it('forward-fills the last UserEModeSet per pool and bucket, undefined before any', async () => {
    const client = fakeClient(q => (tagged('mm:emode')(q)
      ? [{ pool: CORE.toUpperCase().replace('0X', '0x'), b: -1, category: 2 }, { pool: CORE, b: 2, category: 0 }, { pool: GIGA, b: 1, category: 1 }]
      : undefined))
    const out = await loadEmodeHistory(client as never, [H], bk)
    expect(out.get(CORE)).toEqual([2, 2, 0, 0])
    expect(out.get(GIGA)).toEqual([undefined, 1, 1, 1])
    expect(client.seen[0].params).toEqual({ hs: [H], maxb: bk.endHeight(bk.N) })
    expect(client.seen[0].query).toContain('argMax(category_id, tuple(block_height, event_index))')
  })

  it('states the current category per pool (0 = none) and reads nothing without a holder', async () => {
    const client = fakeClient(q => (tagged('mm:emode-current')(q) ? [{ pool: CORE, category: 0 }, { pool: GIGA, category: 3 }] : undefined))
    const out = await loadCurrentEmode(client as never, [H.toUpperCase().replace('0X', '0x'), 'nope'])
    expect([...out]).toEqual([[CORE, 0], [GIGA, 3]])
    expect(client.seen[0].params).toEqual({ hs: [H] })
    const none = fakeClient(() => [])
    expect((await loadCurrentEmode(none as never, ['not-an-address'])).size).toBe(0)
    expect(none.seen).toHaveLength(0)
  })
})

describe('where an EVM identity\'s history starts', () => {
  it('mmHistoryStart: the earliest of observation, scaled delta and anchor row — an aToken-only holder included', async () => {
    const at = (row: Record<string, number>) => fakeClient((q, p) => {
      if (tagged('mm:history-start')(q)) return [row]
      if (tagged('mm:block-times')(q)) return (p.hs as number[]).map(h => ({ block_height: h, t: h * 6 }))
      return undefined
    })
    expect(await mmHistoryStart(at({ obs: 0, delta: 9_000, anchor: 0 }) as never, [H])).toEqual({ minb: 9_000, mint: 54_000 })
    expect(await mmHistoryStart(at({ obs: 9_500, delta: 9_000, anchor: 8_200 }) as never, [H])).toEqual({ minb: 8_200, mint: 49_200 })
    expect(await mmHistoryStart(at({ obs: 0, delta: 0, anchor: 0 }) as never, [H])).toBeNull()
  })
})

describe('current collateral flags', () => {
  it('takes whichever observer saw the flag last, per holder and reserve, across all history', async () => {
    const H2 = `0x${'4b'.repeat(20)}`
    const client = fakeClient(q => (tagged('mm:collateral-flags-current')(q)
      ? [
          { user_address: H, pool_address: CORE, reserve_address: DOT, enabled_last: 1 },
          { user_address: H.toUpperCase().replace('0X', '0x'), pool_address: CORE, reserve_address: USDT, enabled_last: 0 },
          { user_address: H2, pool_address: GIGA, reserve_address: STHDX, enabled_last: 1 },
        ]
      : undefined))
    const out = await loadCurrentCollateralFlags(client as never, [H, H2])
    expect([...out.get(H)!]).toEqual([[reserveKey(CORE, DOT), true], [reserveKey(CORE, USDT), false]])
    expect(out.get(H2)!.get(reserveKey(GIGA, STHDX))).toBe(true)
    // Unbounded above: the current flag.
    expect(client.seen[0].params.maxb).toBe(0xffff_ffff)
    expect(client.seen[0].query).toContain('argMax(enabled, observed)')
  })
})

describe('selectMoneyMarketBuckets', () => {
  it('drops a market whose every point falls between the kept buckets (held intra-day only)', () => {
    const h = assembleMoneyMarketHistory(parts({
      scaled: new Map([['a5', [undefined, 0n, 0n, 0n]], ['a670', [undefined, 0n, 1n * E12, 0n]]]),
      observations: new Map(), emode: new Map(),
    }), pricer, bk)
    expect(h.markets.map(m => m.marketKey)).toEqual(['gigahdx'])
    const kept = selectMoneyMarketBuckets(h, [1, 3])
    expect(kept.markets).toEqual([])
    expect(kept.points.map(p => p.b)).toEqual([1, 3])
    // Kept where it has a point.
    expect(selectMoneyMarketBuckets(h, [2, 3]).markets.map(m => m.marketKey)).toEqual(['gigahdx'])
  })
})

describe('market order', () => {
  it('lists the declared markets first in declaration order, then unknown keys by name', () => {
    expect(['zeta', 'gigahdx', 'alpha', 'core'].sort(mmMarketCompare)).toEqual(['core', 'gigahdx', 'alpha', 'zeta'])
  })
})

describe('timestamp bucketing equals height bucketing under exact dating', () => {
  // Blocks every 6 s from T0, except that TWO blocks (600, 601) carry the same
  // timestamp: exactly the hour mark T0 + 1 h, which is bucket 0's end.
  const HOUR = 3_600
  const T0 = 500 * HOUR
  const ts = (h: number) => (h < 600 ? T0 + h * 6 : h <= 601 ? T0 + HOUR : T0 + (h - 1) * 6)
  const heights = Array.from({ length: 2_400 }, (_, h) => h)
  const marks = [...new Set(heights.map(h => Math.floor(ts(h) / HOUR) * HOUR))].sort((a, b) => a - b)
  const clock: BlockClock = {
    hours: marks,
    heights: marks.map(m => Math.max(...heights.filter(h => ts(h) >= m && ts(h) < m + HOUR))),
    atMark: marks.map(m => Math.max(0, ...heights.filter(h => ts(h) === m))),
    lastTime: ts(heights.length - 1),
    builtAt: 0,
  }
  const heightAt = (sec: number) => heightAtOrBeforeExact(clock, sec)
  const grid = makeBucketing(clock, T0, T0 + 3 * HOUR, 1, undefined, undefined, { stepSec: HOUR, heightAt, dating: { key: 'exact', heightAt } })
  // ofTsCarry, evaluated: floor((ts − t0 − 1) / step), clamped to [−1, N].
  const byTs = (t: number) => Math.max(-1, Math.min(grid.N, Math.floor((t - grid.t0 - 1) / grid.step)))

  it('puts both blocks stamped on the mark in the bucket that mark ends, by either key', () => {
    expect(grid.endHeight(0)).toBe(601)
    expect(grid.ofTsCarry('x')).toBe(`toInt32(greatest(-1, least(${grid.N}, toInt64(floor((toInt64(toUnixTimestamp(x)) - ${grid.t0} - 1) / ${grid.step})))))`)
    for (const h of [599, 600, 601, 602]) expect([h, byTs(ts(h))]).toEqual([h, grid.bucketOfHeight(h)])
    expect(grid.bucketOfHeight(600)).toBe(0)
    expect(grid.bucketOfHeight(601)).toBe(0)
    expect(grid.bucketOfHeight(602)).toBe(1)
  })

  it('agrees for every block in the range', () => {
    for (const h of heights.slice(1, grid.endHeight(grid.N) + 1)) expect(byTs(ts(h))).toBe(grid.bucketOfHeight(h))
  })
})

describe('one observation holder per market', () => {
  const H2 = `0x${'4b'.repeat(20)}`
  const acc = mmEthAccountForm(H)
  const acc2 = mmEthAccountForm(H2)

  it('chooses the primary wherever it has an observation, else the identity observed last', () => {
    const rows = [
      { pool: CORE, acc, last: 100 }, { pool: CORE, acc: acc2, last: 900 },
      { pool: GIGA, acc: acc2, last: 50 },
      { pool: 'p3', acc: acc2, last: 70 }, { pool: 'p3', acc: `0x45544800${'4c'.repeat(20)}0000000000000000`, last: 70 },
    ]
    const chosen = chooseObservationHolders(rows, acc)
    expect(chosen.get(CORE)).toBe(acc) // the primary, though the other identity was observed later
    expect(chosen.get(GIGA)).toBe(acc2) // the primary has no position there
    expect(chosen.get('p3')).toBe(acc2) // a tie goes to the lower address
    expect(chooseObservationHolders(rows, null).get(CORE)).toBe(acc2)
  })

  it('reads each market from its one holder only — never the newest of several positions per bucket', async () => {
    const client = fakeClient((q, p) => {
      if (tagged('mm:observation-holders')(q)) {
        expect(p.accs).toEqual([acc, acc2])
        return [{ pool: CORE, acc, last: 200_100 }, { pool: CORE, acc: acc2, last: 200_250 }, { pool: GIGA, acc: acc2, last: 200_010 }]
      }
      if (tagged('mm:observations')(q)) {
        expect(q).toContain("AND account_id = transform(pool_address, {hp:Array(String)}, {ha:Array(String)}, '')")
        expect(p).toMatchObject({ accs: [acc, acc2], hp: [CORE, GIGA], ha: [acc, acc2] })
        return [{ pool: CORE, b: 1, obs_block: 200_100, coll: '1', debt: '0', avail: '0', lt: '0', max_ltv: '0', hf: '7' }]
      }
      return undefined
    })
    const out = await loadObservationHistory(client as never, [H, H2], [CORE, GIGA], bk, H)
    expect(out.get(CORE)!.map(o => o?.healthFactor)).toEqual([undefined, '7', '7', '7'])
    // A single identity needs no holder read.
    const single = fakeClient(q => (tagged('mm:observations')(q) ? [] : undefined))
    await loadObservationHistory(single as never, [H], [CORE], bk, H)
    expect(single.seen.some(s => tagged('mm:observation-holders')(s.query))).toBe(false)
  })

})

describe('scaled history per holder', () => {
  it('keeps each holder\'s series (the incentive arithmetic\'s input) and sums them per contract', async () => {
    const H2 = `0x${'4b'.repeat(20)}`
    const client = fakeClient(q => {
      if (tagged('mm:scaled-anchor')(q)) return [{ holder: H, contract: '0xC', scaled: '100' }, { holder: H2, contract: '0xc', scaled: '5' }]
      if (tagged('mm:scaled-deltas')(q)) return [{ holder: H, contract: '0xc', b: 1, delta: '-150' }]
      return undefined
    })
    const byHolder = await loadScaledHistoryByHolder(client as never, [H, H2], B0, bk)
    expect(byHolder.get(`${H}|0xc`)).toEqual([undefined, 0n, 0n, 0n])
    expect(byHolder.get(`${H2}|0xc`)).toEqual([undefined, 5n, 5n, 5n])
    expect(sumScaledByContract(byHolder).get('0xc')).toEqual([undefined, 5n, 5n, 5n])
  })
})

describe('reserve indices on a canonical grid', () => {
  const HOUR = 3_600
  const T0 = 1_000 * HOUR
  const heightAt = (sec: number) => (sec < T0 ? null : Math.floor((sec - T0) / 6))
  const stub = { hours: [], heights: [], builtAt: 0 }
  const grid = (from: number, to: number) =>
    makeBucketing(stub, from, to, heightAt(from) ?? 0, undefined, undefined, { stepSec: HOUR, heightAt, dating: { key: 'exact', heightAt } })
  const R2 = '0x0000000000000000000000000000000100000016'

  it('folds once per grid for the whole reserve map and serves each account its buckets plus its head tail', async () => {
    const lastLattice = T0 + 400 * HOUR
    const updateAt = heightAt(T0 + 390 * HOUR)! + 5
    const tailAt = heightAt(lastLattice)! + 10
    const client = fakeClient((q, p) => {
      if (tagged('mm:reserve-indices')(q)) {
        expect(p.reserves).toEqual([DOT, R2])
        return [
          { pool: CORE, reserve: DOT, b: -1, liq: String(RAY), vbi: String(RAY), blk: 5, ev: 1, ts: T0 },
          { pool: CORE, reserve: DOT, b: 190, liq: String(2n * RAY), vbi: String(RAY), blk: updateAt, ev: 2, ts: T0 + 390 * HOUR + 30 },
        ]
      }
      if (tagged('mm:reserve-rates')(q)) return [
        { pool: CORE, reserve: DOT, b: -1, liq_rate: '0', vb_rate: '0', blk: 5, ev: 1 },
        { pool: CORE, reserve: DOT, b: 190, liq_rate: '0', vb_rate: '0', blk: updateAt, ev: 2 },
      ]
      if (tagged('mm:reserve-indices-tail')(q)) {
        expect(p).toMatchObject({ lo: heightAt(lastLattice)! + 1, reserves: [DOT] })
        return [{ pool: CORE, reserve: DOT, b: 0, liq: String(3n * RAY), vbi: String(RAY), blk: tailAt, ev: 4, ts: lastLattice + 60 }]
      }
      if (tagged('mm:reserve-rates-tail')(q)) return [{ pool: CORE, reserve: DOT, b: 0, liq_rate: '0', vb_rate: '0', blk: tailAt, ev: 4 }]
      if (tagged('mm:reserve-update-phase')(q)) return (p.b as number[]).map((b, i) => ({ block_height: b, event_index: (p.e as number[])[i], init: 0 }))
      return undefined
    })
    const universe = [{ pool: CORE, reserve: DOT }, { pool: CORE, reserve: R2 }]
    const a = grid(T0 + 300 * HOUR, lastLattice + 1_000)
    const b = grid(T0 + 380 * HOUR, lastLattice + 1_000)
    const outA = await loadReserveIndexHistory(client as never, [{ pool: CORE, reserve: DOT }], a, universe)
    const outB = await loadReserveIndexHistory(client as never, [{ pool: CORE, reserve: DOT }], b, universe)
    expect(client.seen.filter(s => tagged('mm:reserve-indices')(s.query))).toHaveLength(1)
    const sa = outA.get(reserveKey(CORE, DOT))!
    const sb = outB.get(reserveKey(CORE, DOT))!
    // Bucket ending T0 + 390 h + 1 h holds the update; the head bucket takes the tail's.
    expect(sa[a.N - 11]!.liquidityIndex).toBe(RAY)
    expect(sa[a.N - 10]!.liquidityIndex).toBe(2n * RAY)
    expect(sa[a.N]!.liquidityIndex).toBe(3n * RAY)
    expect(sb[b.N - 10]).toEqual(sa[a.N - 10])
    expect(sb[b.N]).toEqual(sa[a.N])
  })

  it('folds on its own grid when the grid has no canonical twin', async () => {
    const client = fakeClient(() => [])
    await loadReserveIndexHistory(client as never, [{ pool: CORE, reserve: DOT }], bk, [{ pool: CORE, reserve: DOT }, { pool: CORE, reserve: R2 }])
    const fold = client.seen.find(s => tagged('mm:reserve-indices')(s.query))!
    expect(fold.params.reserves).toEqual([DOT])
  })
})
