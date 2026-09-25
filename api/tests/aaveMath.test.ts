import { describe, expect, it } from 'vitest'
import {
  RAY,
  SECONDS_PER_YEAR,
  compoundedInterest,
  incentivePending,
  linearInterest,
  normalizedDebt,
  normalizedIncome,
  rayDiv,
  rayMul,
} from '../src/services/aaveMath.ts'

// Vectors are chain state read with eth_call against the archive node (block 14,980,000,
// core pool 0x1b02e051…, holder 0x4a9ab52a6f688ede97c23d946f7e8ef4f1e47a47) and the
// indexed ReserveDataUpdated the reserve last emitted at or below that block.
const T_BLOCK = 1790245998n // block 14,980,000's timestamp — what an eth_call at it sees

describe('ray operations', () => {
  it('rounds rayMul half-up', () => {
    expect(rayMul(1n, RAY / 2n)).toBe(1n)          // 0.5 → 1
    expect(rayMul(1n, RAY / 2n - 1n)).toBe(0n)     // just under 0.5 → 0
    expect(rayMul(3n, RAY)).toBe(3n)
    expect(rayMul(0n, RAY)).toBe(0n)
  })

  it('rounds rayDiv half-up — the scaled amount _mintScaled/_burnScaled move', () => {
    expect(rayDiv(1n, 2n * RAY)).toBe(1n)          // 0.5 → 1
    expect(rayDiv(1n, 2n * RAY + 1n)).toBe(0n)     // just under 0.5 → 0
    expect(rayDiv(5n, RAY)).toBe(5n)
    // Truncation would give 0 here; the half-up term is what the scaled-delta MVs add.
    expect(rayDiv(2n, 3n * RAY)).toBe(1n)
  })

  it('refuses negative operands instead of rounding them the wrong way', () => {
    expect(() => rayMul(-1n, RAY)).toThrow(RangeError)
    expect(() => rayDiv(-1n, RAY)).toThrow(RangeError)
    expect(() => rayDiv(1n, 0n)).toThrow(RangeError)
  })
})

describe('interest accrual', () => {
  it('accrues nothing over zero time', () => {
    expect(linearInterest(10n ** 25n, 100n, 100n)).toBe(RAY)
    expect(compoundedInterest(10n ** 25n, 100n, 100n)).toBe(RAY)
    expect(linearInterest(10n ** 25n, 100n, 50n)).toBe(RAY)
  })

  it('is linear on the supply side', () => {
    // 10% a year for a whole year is exactly 1.1 RAY.
    expect(linearInterest(RAY / 10n, 0n, SECONDS_PER_YEAR)).toBe(RAY + RAY / 10n)
  })

  it('compounds the debt side with the three-term binomial', () => {
    // 1 + r·n/Y + n(n−1)b²/2 + n(n−1)(n−2)b³/6 at 10%/year for a year sits just below e^0.1.
    const f = compoundedInterest(RAY / 10n, 0n, SECONDS_PER_YEAR)
    expect(f > RAY + RAY / 10n).toBe(true)
    expect(f < 1105170918075647624811707826n).toBe(true) // e^0.1 in ray
    expect(f).toBe(1105162042821782412575504000n) // independent Python port of MathUtils
  })

  it('reproduces an aDOT balanceOf exactly (linear)', () => {
    // DOT reserve last updated at block 14,979,554 (event 38, in an extrinsic, so the EVM
    // saw that block's own timestamp 1790245056).
    const income = normalizedIncome(1054188710145561855058036743n, 13411106094423670400708834n, 1790245056n, T_BLOCK)
    const scaled = 19544999n // scaledBalanceOf
    expect(rayMul(scaled, income)).toBe(20604126n) // balanceOf
    // The settled index (no accrual since the update) is 9 units short.
    expect(rayMul(scaled, 1054188710145561855058036743n)).toBe(20604117n)
  })

  it('reproduces a vHOLLAR debt balanceOf exactly (compounded)', () => {
    // HOLLAR reserve last updated at block 14,978,693 (timestamp 1790243154).
    const debt = normalizedDebt(1047439400922492368755753466n, 44016888917752794000000000n, 1790243154n, T_BLOCK)
    const scaled = 33987939536683174982241n // scaledBalanceOf
    expect(rayMul(scaled, debt)).toBe(35600448344714830680121n) // debt balanceOf
  })

  it('returns the stored index when the reserve was updated at that very time', () => {
    expect(normalizedIncome(5n * RAY, RAY, 42n, 42n)).toBe(5n * RAY)
    expect(normalizedDebt(7n * RAY, RAY, 42n, 42n)).toBe(7n * RAY)
  })
})

describe('incentives', () => {
  const unit = 10n ** 18n

  it('accrues scaled × Δindex / unit, truncating', () => {
    expect(incentivePending(3n * unit, 14216n, 14208n, unit)).toBe(24n)
    expect(incentivePending(unit - 1n, 1n, 0n, unit)).toBe(0n)
    expect(incentivePending(5n, 3n, 3n, unit)).toBe(0n)
    expect(() => incentivePending(5n, 2n, 3n, unit)).toThrow(RangeError)
  })
})
