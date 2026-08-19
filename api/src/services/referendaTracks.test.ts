import { describe, expect, it } from 'vitest'
import { curveThresholdPerbill, perbillOfRational, PERBILL, referendaTracks, trackById, undecidingTimeoutBlocks } from './referendaTracks.ts'

// The pinned tracks (no RPC in unit tests, so referendaTracks() serves the
// fallback copy) must reproduce hydration-node's tracks.rs. The curve shape
// checks below pin the CONSTRUCTION anchors of the runtime's `make_linear` /
// `make_reciprocal` calls — the points the Rust const-eval solved for — so a
// mistranscribed parameter cannot pass.

const day = (n: number) => Math.round((n / 7) * PERBILL) // decision periods are 7 days

describe('referendaTracks (pinned fallback)', () => {
  it('carries the tracks.rs periods', () => {
    const treasurer = trackById(5)!
    expect(treasurer.name).toBe('treasurer')
    expect(treasurer.preparePeriod).toBe(600)       // 60 minutes of 6s blocks
    expect(treasurer.decisionPeriod).toBe(100_800)  // 7 days
    expect(treasurer.confirmPeriod).toBe(7_200)     // 12 hours
    expect(treasurer.decisionDeposit).toBe('750000000000000000') // 750k HDX
    expect(trackById(1)!.decisionPeriod).toBe(43_200) // whitelisted_caller: 3 days
    expect(referendaTracks()).toHaveLength(10)
    expect(trackById(99)).toBeNull()
  })

  it('undeciding timeout pins to 2 days of 6s blocks without a node', () => {
    expect(undecidingTimeoutBlocks()).toBe(28_800)
  })
})

describe('curveThresholdPerbill', () => {
  it('APP_RECIP = make_reciprocal(1, 7, 80%, 50%, 100%): near 100% at open, 80% after day 1, 50% at close', () => {
    const curve = trackById(5)!.minApproval
    expect(curveThresholdPerbill(curve, 0)).toBeGreaterThan(PERBILL - 10)
    expect(Math.abs(curveThresholdPerbill(curve, day(1)) - 0.8 * PERBILL)).toBeLessThan(10)
    expect(Math.abs(curveThresholdPerbill(curve, PERBILL) - 0.5 * PERBILL)).toBeLessThan(10)
  })

  it('SUP_FAST_LINEAR = make_linear(7, 7, 0%, 18%): 18% at open, halved mid-period, 0 at close', () => {
    const curve = trackById(5)!.minSupport
    expect(curveThresholdPerbill(curve, 0)).toBe(0.18 * PERBILL)
    expect(curveThresholdPerbill(curve, PERBILL / 2)).toBe(0.09 * PERBILL)
    expect(curveThresholdPerbill(curve, PERBILL)).toBe(0)
  })

  it('APP_LINEAR_FLAT = make_linear(4, 7, 50%, 100%): flat 50% from day 4', () => {
    const curve = trackById(7)!.minApproval // tipper
    expect(curveThresholdPerbill(curve, 0)).toBe(PERBILL)
    expect(Math.abs(curveThresholdPerbill(curve, day(2)) - 0.75 * PERBILL)).toBeLessThan(5)
    expect(Math.abs(curveThresholdPerbill(curve, day(4)) - 0.5 * PERBILL)).toBeLessThan(5)
    expect(curveThresholdPerbill(curve, day(6))).toBe(0.5 * PERBILL)
    expect(curveThresholdPerbill(curve, PERBILL)).toBe(0.5 * PERBILL)
  })

  it('SUP_RECIP = make_reciprocal(5, 7, 1%, 0%, 36%): 36% at open, 1% after day 5, clamps at 0', () => {
    const curve = trackById(6)!.minSupport // spender
    expect(Math.abs(curveThresholdPerbill(curve, 0) - 0.36 * PERBILL)).toBeLessThan(10)
    expect(Math.abs(curveThresholdPerbill(curve, day(5)) - 0.01 * PERBILL)).toBeLessThan(10)
    // Negative yOffset region: the raw curve dips below zero near the close and
    // the pallet clamps.
    expect(curveThresholdPerbill(curve, PERBILL)).toBe(0)
  })

  it('clamps x outside [0, 1]', () => {
    const curve = trackById(5)!.minSupport
    expect(curveThresholdPerbill(curve, -50)).toBe(0.18 * PERBILL)
    expect(curveThresholdPerbill(curve, 2 * PERBILL)).toBe(0)
  })
})

describe('perbillOfRational', () => {
  it('floors 21-digit planck ratios in BigInt', () => {
    // Real figures from OpenGov 383's Confirmed tally.
    const ayes = 2825554561793640949598n, nays = 8066804111818188671n
    // 2825554561793640949598 * 1e9 / 2833621365905459138269, floored.
    expect(perbillOfRational(ayes, ayes + nays)).toBe(997153182)
  })
  it('caps at 100% and rejects undefined ratios', () => {
    expect(perbillOfRational(5n, 2n)).toBe(PERBILL)
    expect(perbillOfRational(1n, 0n)).toBeNull()
  })
})
