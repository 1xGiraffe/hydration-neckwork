import { describe, expect, it } from 'vitest'
import { alignMonthly, backfillAllocationMints, buildHdxStructure, carryForward, correctVestingLocks, decodeCompactBig, gigaUnbondingBlocks, moverAccountFilterSql, nonNegativeUIntDifferenceSql, resolveRotationAnchors, cooldownExpiresAt, unlockKeyForCause, unlockSeriesFromTimelines, withCooldownExpiries, type HdxStructureWeekRow } from '../src/services/hdxService.ts'
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
  // Only the LAST-RESORT default, used when neither GIGA_UNBONDING_BLOCKS nor
  // runtime metadata answers. Per-position expiries no longer come from this at
  // all — see withIndexedExpiries — so it is reached only for a position whose
  // GigaHdx.Unstaked event is not indexed yet. 28 nominal days of 2s blocks,
  // matching gigaHdx.cooldownPeriod since runtime 440.
  it('defaults to 28 days of 2s parachain blocks when nothing else answers', () => {
    expect(gigaUnbondingBlocks()).toBe(28 * 24 * 1800)
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

// GigaHdx.PendingUnstakes storage carries only (account, startBlock) → amount:
// the maturity block is NOT stored, the runtime RECOMPUTES it on every unlock
// via pallet_gigahdx::cooldown_expires_at. It is not startBlock + the current
// cooldown, and it is not the expiresAt recorded in the GigaHdx.Unstaked event
// either — runtime 440 switched 6s → 2s blocks and tripled CooldownPeriod
// (403,200 → 1,209,600), and a position that straddles the switch keeps its
// remaining WALL-CLOCK cooldown by having the leftover blocks tripled. The
// event's expiresAt was computed under the old rule and is stale for exactly
// those positions.
//
// Verified three ways: the pallet source; 65 historical unlocks with zero
// violations and a 5-block minimum overshoot on a straddling position; and the
// Hydration app's own countdown.
describe('cooldownExpiresAt — port of pallet_gigahdx::cooldown_expires_at', () => {
  const SWITCH = 13_762_620   // parameters.twoSecBlocksSince, live
  const COOLDOWN = 1_209_600  // gigaHdx.cooldownPeriod, live

  it('adds the full cooldown to a position opened at or after the switch', () => {
    expect(cooldownExpiresAt(14_102_268, SWITCH, COOLDOWN)).toBe(14_102_268 + 1_209_600)
    expect(cooldownExpiresAt(SWITCH, SWITCH, COOLDOWN)).toBe(SWITCH + 1_209_600)
  })

  it('keeps the old 6s cooldown for a position that matured before the switch', () => {
    // start + 403,200 = 13,749,927, still short of the switch
    expect(cooldownExpiresAt(13_346_727, SWITCH, COOLDOWN)).toBe(13_749_927)
  })

  it('triples the blocks left at the switch, preserving wall-clock', () => {
    // start 13,369,693: old expiry 13,772,893 is 10,273 blocks past the switch,
    // so those become 30,819 two-second blocks. Confirmed on chain: this
    // position unlocked 5 blocks after 13,793,439.
    expect(cooldownExpiresAt(13_369_693, SWITCH, COOLDOWN)).toBe(13_793_439)
    // The account whose page prompted this: matches the app's ~4 days, not the
    // event's stale 13,934,973 (which had already passed).
    expect(cooldownExpiresAt(13_531_773, SWITCH, COOLDOWN)).toBe(14_279_679)
  })

  it('treats the unset u32::MAX sentinel as "no switch happened"', () => {
    expect(cooldownExpiresAt(13_531_773, 0xFFFFFFFF, COOLDOWN)).toBe(13_531_773 + 1_209_600)
  })
})

describe('withCooldownExpiries', () => {
  const A = '0x' + 'aa'.repeat(32)
  const pos = (startBlock: number) =>
    ({ accountId: A, startBlock, expiryBlock: 0, payoutHdx: 1, payoutRaw: 10n ** 12n })

  it('stamps each position with its recomputed expiry', () => {
    const out = withCooldownExpiries([pos(13_531_773)], 13_762_620, 1_209_600)
    expect(out[0].expiryBlock).toBe(14_279_679)
  })

  it('re-sorts by the recomputed expiry so the earliest unlock is first', () => {
    // Straddling positions get tripled remainders, so start order does not
    // imply maturity order once a post-switch position is in the mix.
    const out = withCooldownExpiries([pos(13_760_000), pos(13_346_727)], 13_762_620, 1_209_600)
    expect(out.map(p => p.startBlock)).toEqual([13_346_727, 13_760_000])
  })
})

// Locks overlap: they all bite the same free balance, so the binding amount is
// the MAX across lock sources, not the sum. buildBindingTimeline already
// resolves that per account and attributes each envelope drop to a cause; the
// dashboard must aggregate THOSE slices rather than re-summing raw per-source
// amounts (which double-counted an account whose ghdxlock and pyconvot cover
// the same tokens).
describe('unlockSeriesFromTimelines — overlap-corrected unlock buckets', () => {
  const HDX = 10n ** 12n
  const now = Date.UTC(2026, 8, 2)
  const day = 86_400_000
  const buckets = [
    { from: now, to: now + 7 * day },
    { from: now + 7 * day, to: now + 14 * day },
  ]
  const slices = (...s: { state: string; cause: string; amount: bigint; until?: number; conditional?: boolean; linear?: boolean }[]) =>
    s.map(x => ({
      state: x.state, cause: x.cause, amount: x.amount.toString(),
      ...(x.until ? { until: new Date(x.until).toISOString() } : {}),
      ...(x.conditional ? { conditional: true } : {}),
      ...(x.linear ? { linear: true } : {}),
    }))

  it('counts an overlapping gigahdx+vote account once, not twice', () => {
    // One account, 2.65M frozen, covered by BOTH a matured ghdxlock and an equal
    // conviction prior. The timeline emits a single slice for the real release.
    const r = unlockSeriesFromTimelines(
      [slices({ state: 'scheduled', cause: 'gigahdx+vote', amount: 2_646_564n * HDX, until: now + 3 * day })],
      buckets, now,
    )
    expect(r.buckets[0].gigahdx).toBeCloseTo(2_646_564, 0)
    expect(r.buckets[0].vote).toBe(0)
    expect(r.buckets[0].gigahdx + r.buckets[0].vote + r.buckets[0].vesting).toBeCloseTo(2_646_564, 0)
  })

  it('puts already-releasable balance in the now column, attributed by cause', () => {
    const r = unlockSeriesFromTimelines(
      [slices({ state: 'releasable', cause: 'gigahdx', amount: 11_236_878n * HDX })],
      buckets, now,
    )
    expect(r.now.gigahdx).toBeCloseTo(11_236_878, 0)
    expect(r.buckets[0].gigahdx).toBe(0)
  })

  it('routes a scheduled slice past the horizon to later, and open-ended to active', () => {
    const r = unlockSeriesFromTimelines(
      [slices(
        { state: 'scheduled', cause: 'vesting', amount: 500n * HDX, until: now + 90 * day },
        { state: 'active', cause: 'vote', amount: 300n * HDX },
      )],
      buckets, now,
    )
    expect(r.later.vesting).toBeCloseTo(500, 0)
    expect(r.active.vote).toBeCloseTo(300, 0)
    expect(r.buckets.every(b => b.vesting === 0)).toBe(true)
  })

  // The ghdxlock source emits a CONDITIONAL step for the still-staked portion:
  // "if this holder unstaked right now, it would free one cooldown from now".
  // Nobody has requested it, so it is not an upcoming unlock — live, 573 such
  // slices carried 502M HDX, 23x the entire pending pool, and would have
  // dwarfed the real series.
  it('excludes a conditional step, which is a hypothetical not a pending unlock', () => {
    const r = unlockSeriesFromTimelines(
      [slices({ state: 'scheduled', cause: 'gigahdx', amount: 502_062_216n * HDX, until: now + 3 * day, conditional: true })],
      buckets, now,
    )
    expect(r.buckets[0].gigahdx).toBe(0)
    expect(r.now.gigahdx).toBe(0)
    expect(r.later.gigahdx).toBe(0)
    expect(r.active.gigahdx).toBe(0)
  })

  // A vesting schedule releases continuously; its timeline slice sits at the
  // schedule END (overlap attribution needs one step), flagged linear. The
  // chart must spread it over its span — a point mass at the end date piled a
  // whole multi-month schedule into one bucket (live: 7.03M HDX all in the
  // month of the schedule end, nothing in the months it actually vests over).
  it('spreads a linear slice evenly over its span', () => {
    const r = unlockSeriesFromTimelines(
      [slices({ state: 'scheduled', cause: 'vesting', amount: 1_400n * HDX, until: now + 14 * day, linear: true })],
      buckets, now,
    )
    expect(r.buckets[0].vesting).toBeCloseTo(700, 6)
    expect(r.buckets[1].vesting).toBeCloseTo(700, 6)
    expect(r.later.vesting).toBeCloseTo(0, 6)
  })

  it('sends the linear tail past the horizon to later, pro-rata', () => {
    const r = unlockSeriesFromTimelines(
      [slices({ state: 'scheduled', cause: 'vesting', amount: 2_800n * HDX, until: now + 28 * day, linear: true })],
      buckets, now,
    )
    expect(r.buckets[0].vesting).toBeCloseTo(700, 6)
    expect(r.buckets[1].vesting).toBeCloseTo(700, 6)
    expect(r.later.vesting).toBeCloseTo(1_400, 6)
  })

  it('starts a linear spread at the previous dated step, not at now', () => {
    const r = unlockSeriesFromTimelines(
      [slices(
        { state: 'scheduled', cause: 'vote', amount: 100n * HDX, until: now + 7 * day },
        { state: 'scheduled', cause: 'vesting', amount: 1_400n * HDX, until: now + 21 * day, linear: true },
      )],
      buckets, now,
    )
    // Buckets are half-open [from, to): a step at exactly +7d opens bucket 2.
    expect(r.buckets[1].vote).toBeCloseTo(100, 6)
    expect(r.buckets[0].vesting).toBeCloseTo(0, 6)
    // The vesting drop accrued over [+7d, +21d]: half inside bucket 2, half past the horizon.
    expect(r.buckets[1].vesting).toBeCloseTo(700, 6)
    expect(r.later.vesting).toBeCloseTo(700, 6)
  })

  it('sums across accounts into the bucket holding each slice date', () => {
    const r = unlockSeriesFromTimelines(
      [
        slices({ state: 'scheduled', cause: 'gigahdx', amount: 10n * HDX, until: now + 1 * day }),
        slices({ state: 'scheduled', cause: 'gigahdx', amount: 25n * HDX, until: now + 9 * day }),
      ],
      buckets, now,
    )
    expect(r.buckets[0].gigahdx).toBeCloseTo(10, 0)
    expect(r.buckets[1].gigahdx).toBeCloseTo(25, 0)
  })
})

describe('unlockKeyForCause', () => {
  it('maps a single cause to its series key', () => {
    expect(unlockKeyForCause('gigahdx')).toBe('gigahdx')
    expect(unlockKeyForCause('vesting')).toBe('vesting')
    expect(unlockKeyForCause('vote')).toBe('vote')
  })

  it('attributes a tie to the dated lock that gates the release, not the vote', () => {
    expect(unlockKeyForCause('gigahdx+vote')).toBe('gigahdx')
    expect(unlockKeyForCause('vote+vesting')).toBe('vesting')
  })

  it('ignores causes with no series of their own', () => {
    expect(unlockKeyForCause('staking')).toBe(null)
    expect(unlockKeyForCause('')).toBe(null)
  })
})
