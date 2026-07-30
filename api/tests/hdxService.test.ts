import { describe, expect, it } from 'vitest'
import { correctVestingLocks, decodeCompactBig, GIGA_UNBONDING_BLOCKS, moverAccountFilterSql, nonNegativeUIntDifferenceSql } from '../src/services/hdxService.ts'
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
    expect(GIGA_UNBONDING_BLOCKS).toBe(28 * 24 * 600)
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
