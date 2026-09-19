import { describe, expect, it } from 'vitest'
import { distributeUsd1e12, internalShareOf } from '../src/services/borrowAttribution.ts'

// A MintedToTreasury lump names no payer: the attribution splits it over the
// interest each borrower accrued in the window. The protocol's own share is the
// same split, taken once, so that what is booked as revenue and what is booked
// against payers are carved from one ratio and can never disagree.
describe('the protocol’s own share of a lump', () => {
  it('is the weighted fraction', () => {
    expect(internalShareOf(1_000n, 250n, 1_000n)).toBe(250n)
  })

  it('floors, leaving the dust on the external side', () => {
    // 1/3 of 100 — the internal side takes 33, external keeps 67, never 34/66.
    expect(internalShareOf(100n, 1n, 3n)).toBe(33n)
  })

  it('is nothing when no internal account borrowed', () => {
    expect(internalShareOf(1_000n, 0n, 1_000n)).toBe(0n)
  })

  it('is nothing when nobody borrowed at all, rather than the whole lump', () => {
    // A weightless window must not read as "all of it was the protocol's".
    expect(internalShareOf(1_000n, 0n, 0n)).toBe(0n)
    expect(internalShareOf(1_000n, 5n, 0n)).toBe(0n)
  })

  it('is the whole lump when every borrower was internal', () => {
    expect(internalShareOf(1_000n, 1_000n, 1_000n)).toBe(1_000n)
  })

  it('never exceeds the lump, even if the weights say it should', () => {
    expect(internalShareOf(1_000n, 4_000n, 1_000n)).toBe(1_000n)
  })

  it('leaves an external remainder the attribution can still split exactly', () => {
    // The pair the job books: external = gross − internal, then the external
    // half is split over external weights alone. The two must re-sum to gross.
    const gross = 1_000_000n
    const internal = internalShareOf(gross, 3n, 7n)
    const external = gross - internal
    const shares = distributeUsd1e12(external, [
      { account: '0xa', weight: 2n },
      { account: '0xb', weight: 2n },
    ])
    expect([...shares.values()].reduce((a, b) => a + b, 0n)).toBe(external)
    expect(external + internal).toBe(gross)
    expect(shares.has('')).toBe(false)
  })
})
