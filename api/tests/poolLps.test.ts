import { describe, expect, it } from 'vitest'
import {
  foldPoolLpEntries,
  groupOmnipoolLps,
  shareFraction,
  type OmnipoolLpPositionInput,
} from '../src/services/poolService.ts'

// The LP rankings rest on two integer folds whose invariants must hold under
// replay and races: attributed farm custody REPLACES the pot's balance (the
// total is conserved, never scaled or double-counted), and the omnipool
// grouping conserves Σ position shares + protocol_shares = total shares —
// both verified exact against the live data when this was built.

const POT = '0xpot'

describe('foldPoolLpEntries', () => {
  it('replaces the pot custody with the attributed owners and conserves the total', () => {
    const direct = [
      { accountId: '0xaaa', balance: 100n },
      { accountId: POT, balance: 30n },
      { accountId: '0xbbb', balance: 5n },
    ]
    const farmed = [
      { accountId: '0xbbb', shares: 20n },
      { accountId: '0xccc', shares: 10n },
    ]
    const out = foldPoolLpEntries(direct, farmed, POT)
    // The pot's 30 was fully attributed, so it disappears; nothing is scaled.
    expect(out.map(e => [e.accountId, e.shares, e.farmedShares])).toEqual([
      ['0xaaa', 100n, 0n],
      ['0xbbb', 25n, 20n],
      ['0xccc', 10n, 10n],
    ])
    const total = out.reduce((s, e) => s + e.shares, 0n)
    expect(total).toBe(100n + 30n + 5n)
  })

  it('keeps an uncovered pot remainder visible instead of scaling it away', () => {
    const out = foldPoolLpEntries(
      [{ accountId: POT, balance: 50n }],
      [{ accountId: '0xaaa', shares: 30n }],
      POT,
    )
    expect(out).toEqual([
      { accountId: '0xaaa', shares: 30n, farmedShares: 30n },
      { accountId: POT, shares: 20n, farmedShares: 0n },
    ])
    expect(out.reduce((s, e) => s + e.shares, 0n)).toBe(50n)
  })

  it('never lets attribution exceed the pot custody (no fabricated shares)', () => {
    // The pot holds less than the intervals attribute (a mid-block race):
    // the pot clamps to zero, the owners keep their attributed principal.
    const out = foldPoolLpEntries(
      [{ accountId: POT, balance: 10n }],
      [{ accountId: '0xaaa', shares: 30n }],
      POT,
    )
    expect(out).toEqual([{ accountId: '0xaaa', shares: 30n, farmedShares: 30n }])
  })

  it('folds through the account resolver and drops zero balances', () => {
    const out = foldPoolLpEntries(
      [
        { accountId: '0xETHPOT', balance: 7n },
        { accountId: '0xreal', balance: 3n },
        { accountId: '0xzero', balance: 0n },
      ],
      [],
      POT,
      id => (id === '0xETHPOT' ? '0xreal' : id),
    )
    expect(out).toEqual([{ accountId: '0xreal', shares: 10n, farmedShares: 0n }])
  })

  it('orders by shares descending with a deterministic tie-break', () => {
    const out = foldPoolLpEntries(
      [
        { accountId: '0xbbb', balance: 5n },
        { accountId: '0xaaa', balance: 5n },
        { accountId: '0xccc', balance: 9n },
      ],
      [], POT,
    )
    expect(out.map(e => e.accountId)).toEqual(['0xccc', '0xaaa', '0xbbb'])
  })
})

describe('shareFraction', () => {
  it('is exact for magnitudes beyond float precision', () => {
    // A quarter of a 24-digit total — Number(shares)/Number(total) would drift.
    const total = 4130532643919634582019372n
    expect(shareFraction(total / 4n, total)).toBe(0.25)
  })
  it('returns null for a zero or negative total (destroyed pool), never NaN', () => {
    expect(shareFraction(5n, 0n)).toBeNull()
  })
  it('sums to at most 1 across a full holder set', () => {
    const total = 1000000000000000000n
    const parts = [total / 2n, total / 3n, total - total / 2n - total / 3n]
    const sum = parts.reduce((s, p) => s + (shareFraction(p, total) ?? 0), 0)
    expect(sum).toBeLessThanOrEqual(1)
    expect(sum).toBeGreaterThan(0.999999)
  })
})

describe('groupOmnipoolLps', () => {
  const pos = (accountId: string, shares: bigint, farmed = false): OmnipoolLpPositionInput =>
    ({ accountId, shares, liquidity: shares / 2n, hub: farmed ? 1n : 0n, farmed })

  it('groups an owner across bare and farmed positions and conserves shares', () => {
    const totalShares = 100n
    const groups = groupOmnipoolLps(
      [pos('0xaaa', 10n), pos('0xaaa', 20n, true), pos('0xbbb', 40n)],
      30n, 1000n, totalShares,
    )
    expect(groups.map(g => [g.accountId, g.shares, g.positions, g.farmedPositions])).toEqual([
      ['0xbbb', 40n, 1, 0],
      [null, 30n, 0, 0],
      ['0xaaa', 30n, 2, 1],
    ])
    // Σ LP shares + protocol shares = the pool's total (the live gap is 0).
    expect(groups.reduce((s, g) => s + g.shares, 0n)).toBe(totalShares)
  })

  it('values the protocol row as the proportional reserve claim with no hub leg', () => {
    const groups = groupOmnipoolLps([], 25n, 1000n, 100n)
    expect(groups).toEqual([
      { accountId: null, positions: 0, farmedPositions: 0, shares: 25n, liquidity: 250n, hub: 0n },
    ])
  })

  it('omits the protocol row when there are no protocol shares', () => {
    expect(groupOmnipoolLps([pos('0xaaa', 1n)], 0n, 1000n, 1n)).toHaveLength(1)
  })

  it('ties break deterministically with the accountless protocol row first', () => {
    const groups = groupOmnipoolLps([pos('0xaaa', 5n), pos('0xbbb', 5n)], 5n, 100n, 15n)
    expect(groups.map(g => g.accountId)).toEqual([null, '0xaaa', '0xbbb'])
  })
})
