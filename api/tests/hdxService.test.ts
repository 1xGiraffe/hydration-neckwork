import { describe, expect, it } from 'vitest'
import { alignMonthly, backfillAllocationMints, buildHdxStructure, carryForward, correctVestingLocks, decodeCompactBig, gigaUnbondingBlocks, moverAccountFilterSql, nonNegativeUIntDifferenceSql, resolveRotationAnchors, type HdxStructureWeekRow } from '../src/services/hdxService.ts'
import { hexToU8a } from '@polkadot/util'

describe('decodeCompactBig', () => {
  it('decodes all four compact modes', () => {
    expect(decodeCompactBig(hexToU8a('0x04'), 0)).toEqual([1n, 1])
    expect(decodeCompactBig(hexToU8a('0x1501'), 0)).toEqual([69n, 2])          // two-byte
    expect(decodeCompactBig(hexToU8a('0xfeffffff'), 0)).toEqual([0x3fffffffn, 4]) // four-byte
    // big mode: 5-byte payload (mode 3, len = (0x07>>2)+4 = 5): 2^32
    expect(decodeCompactBig(hexToU8a('0x070000000001'), 0)).toEqual([4294967296n, 6])
  })

  it('decodes a real Hydration vesting perPeriod (0xe69d7003 → 14,425,593)', () => {
    // From live Vesting.VestingSchedules: schedule tail bytes
    const [v, next] = decodeCompactBig(hexToU8a('0xe69d7003'), 0)
    expect(next).toBe(4)
    expect(v).toBe(BigInt((0x03709de6) >>> 2))
  })

  it('rejects truncated values in every multi-byte mode', () => {
    expect(() => decodeCompactBig(hexToU8a('0x01'), 0)).toThrow(RangeError)
    expect(() => decodeCompactBig(hexToU8a('0x02ffff'), 0)).toThrow(RangeError)
    expect(() => decodeCompactBig(hexToU8a('0x07ffff'), 0)).toThrow(RangeError)
    expect(() => decodeCompactBig(new Uint8Array(), 0)).toThrow(RangeError)
  })
})

describe('GIGAHDX unbonding', () => {
  it('uses the protocol 28-day parachain-block delay', () => {
    expect(gigaUnbondingBlocks()).toBe(28 * 24 * 600)
  })
})

describe('HDX DCA budget SQL', () => {
  it('keeps guarded UInt256 subtraction on a single signed ClickHouse type', () => {
    expect(nonNegativeUIntDifferenceSql('total', 'spent')).toBe(
      'if(total > spent, toInt256(total) - toInt256(spent), toInt256(0))',
    )
  })
})

// The ormlvest Balances.Locks amount only shrinks on vesting.claim, so for
// accounts that never claim it includes HDX that has already vested. The lock
// figures must count only periods still in the future. Schedule block numbers
// are RELAY chain heights (orml-vesting runs on the relay block provider).
describe('correctVestingLocks — vested-but-unclaimed excluded from lock totals', () => {
  const A = '0x' + 'aa'.repeat(32)
  const B = '0x' + 'bb'.repeat(32)
  const HDX = 10n ** 12n
  const sched = (accountId: string, start: number, periodCount = 10) =>
    ({ accountId, start, period: 10, periodCount, perPeriod: 10n * HDX })

  it('drops a fully matured but unclaimed schedule from the vesting row', () => {
    const locks = new Map([[A, { maxNonVestHdx: 0, vestLockHdx: 100 }]])
    const r = correctVestingLocks(locks, [sched(A, 0)], 1_000) // long past end block
    expect(r.vestingHdx).toBe(0)
    expect(r.vestingAccounts).toBe(0)
    expect(r.vestedUnclaimedHdx).toBe(100)
    expect(r.totalLockedHdx).toBe(0)
  })

  it('keeps only future periods of a partially vested, never-claimed schedule', () => {
    const locks = new Map([[A, { maxNonVestHdx: 0, vestLockHdx: 100 }]])
    const r = correctVestingLocks(locks, [sched(A, 0)], 50) // 5 of 10 periods elapsed
    expect(r.vestingHdx).toBe(50)
    expect(r.vestingAccounts).toBe(1)
    expect(r.vestedUnclaimedHdx).toBe(50)
    expect(r.totalLockedHdx).toBe(50)
  })

  it('reports zero unclaimed for an account that claims promptly', () => {
    const locks = new Map([[A, { maxNonVestHdx: 0, vestLockHdx: 50 }]])
    const r = correctVestingLocks(locks, [sched(A, 0)], 50)
    expect(r.vestingHdx).toBe(50)
    expect(r.vestedUnclaimedHdx).toBe(0)
  })

  it('lets a bigger non-vesting lock set the per-account max and ignores schedules without a lock', () => {
    const locks = new Map([
      [A, { maxNonVestHdx: 80, vestLockHdx: 100 }], // staking 80 > corrected vest 50
      [B, { maxNonVestHdx: 30, vestLockHdx: 0 }],   // plain lock, no vesting
    ])
    const r = correctVestingLocks(locks, [sched(A, 0), sched('0x' + 'cc'.repeat(32), 0)], 50)
    expect(r.vestingHdx).toBe(50)
    expect(r.totalLockedHdx).toBe(80 + 30)
  })

  it('sums schedules per account and counts a not-yet-started schedule in full', () => {
    const locks = new Map([[A, { maxNonVestHdx: 0, vestLockHdx: 1000 }]])
    const r = correctVestingLocks(locks, [sched(A, 0), sched(A, 100, 5)], 50)
    expect(r.vestingHdx).toBe(50 + 50)
    expect(r.vestingAccounts).toBe(1)
  })
})

describe('moverAccountFilterSql — module accounts in top movers', () => {
  it('excludes modl pallet pots but re-admits tagged module accounts (Treasury)', () => {
    const sql = moverAccountFilterSql(['0x6d6f646c70792f74727372790000000000000000000000000000000000000000'])
    expect(sql).toContain("NOT startsWith(account, '0x6d6f646c')")
    expect(sql).toContain("'0x6d6f646c70792f74727372790000000000000000000000000000000000000000'")
    expect(sql).toMatch(/OR account IN/)
  })

  it('falls back to the plain exclusion when no tagged module accounts exist', () => {
    expect(moverAccountFilterSql([])).toBe("NOT startsWith(account, '0x6d6f646c')")
  })
})

// The structure payload's arithmetic: effective holders inverts the HHI, and
// the "rest" tranche is the user total the top tranches leave behind (floored
// at zero against float dust).
describe('buildHdxStructure — weekly holder-structure payload', () => {
  const row = (over: Partial<HdxStructureWeekRow> = {}): HdxStructureWeekRow => ({
    week: '2022-07-04',
    treasury: 100, protocol: 10, kraken: 20,
    user_total: 1000,
    top10: 400, top100: 300, top1000: 200,
    hhi: 0.02,
    age_0_3m: 100, age_3_12m: 200, age_1_2y: 300, age_2y: 400,
    ...over,
  })

  it('derives the rest tranche from the user total and never lets float dust push it negative', () => {
    const s = buildHdxStructure([
      row(),
      row({ week: '2022-07-11', user_total: 900 - 1e-9 }),
    ])
    expect(s.ownership.rest).toEqual([100, 0])
  })

  it('inverts HHI into effective holders and maps the age bands', () => {
    const s = buildHdxStructure([row()])
    expect(s.effectiveHolders).toEqual([50])
    expect(s.weeks).toEqual(['2022-07-04'])
    expect(s.hodl).toEqual({ under3m: [100], m3to12: [200], y1to2: [300], over2y: [400] })
  })
})

// Allocation-realization mints are counted in their recipient class's band
// from the series start (the allocation existed before it was on-chain);
// mints to user-class wallets and pre-series mints are left untouched.
describe('backfillAllocationMints — no supply cliff at realization', () => {
  const weeks = ['2025-06-02', '2025-06-09', '2025-06-16', '2025-06-23']
  const own = () => ({
    treasury: [100, 100, 100, 2000], protocol: [10, 10, 10, 10], kraken: [0, 0, 0, 0],
    top10: [0, 0, 0, 0], top11to100: [0, 0, 0, 0], top101to1000: [0, 0, 0, 0], rest: [0, 0, 0, 0],
  })
  it('adds each treasury/protocol mint to every week before its realization', () => {
    const o = own()
    const total = backfillAllocationMints(o, weeks, [
      { week: '2025-06-23', cls: 'treasury', hdx: 1900 },
      { week: '2025-06-16', cls: 'protocol', hdx: 50 },
    ])
    expect(total).toBe(1950)
    expect(o.treasury).toEqual([2000, 2000, 2000, 2000]) // cliff gone
    expect(o.protocol).toEqual([60, 60, 10, 10])
  })
  it('ignores user-class mints and mints at or before the series start', () => {
    const o = own()
    const total = backfillAllocationMints(o, weeks, [
      { week: '2025-06-23', cls: 'user', hdx: 500 },
      { week: '2025-06-02', cls: 'treasury', hdx: 500 }, // = weeks[0], already observed
    ])
    expect(total).toBe(0)
    expect(o.treasury).toEqual([100, 100, 100, 2000])
  })
})

// Rotation chains resolve to the ORIGINAL wallet's first-nonzero week, so a
// serial rotator's current wallet carries the oldest age; cycles fall back to
// the direct parent instead of recursing forever.
describe('resolveRotationAnchors — serial rotations keep the original age', () => {
  it('follows a → b → c to the root anchor', () => {
    const r = resolveRotationAnchors([
      { b: 'c', a: 'b', aFirstnz: '2024-01-01' },
      { b: 'b', a: 'a', aFirstnz: '2022-05-02' },
    ])
    expect(Object.fromEntries(r.accounts.map((x, i) => [x, r.anchors[i]])))
      .toEqual({ b: '2022-05-02', c: '2022-05-02' })
  })
  it('survives a defensive cycle by using the direct parent anchor', () => {
    const r = resolveRotationAnchors([
      { b: 'x', a: 'y', aFirstnz: '2023-01-02' },
      { b: 'y', a: 'x', aFirstnz: '2023-02-06' },
    ])
    expect(r.accounts.sort()).toEqual(['x', 'y'])
    expect(r.anchors.length).toBe(2)
  })
})

// Trend-grid assembly: series align by month key with nulls where a series
// hasn't started, and cumulative series carry their running total across
// months that emitted no rows (no activity ≠ back to zero).
describe('trend grid helpers — alignMonthly / carryForward', () => {
  const months = ['2024-01-01', '2024-02-01', '2024-03-01', '2024-04-01']

  it('aligns by month key and leaves absent months null', () => {
    expect(alignMonthly(months, [{ m: '2024-02-01', v: 5 }, { m: '2024-04-01', v: 7 }]))
      .toEqual([null, 5, null, 7])
  })

  it('carries a cumulative total across silent months but not before the series starts', () => {
    expect(carryForward([null, 10, null, null])).toEqual([null, 10, 10, 10])
    expect(carryForward([null, null, 3, 4])).toEqual([null, null, 3, 4])
  })
})
