import { describe, expect, it } from 'vitest'
import { curveCrossingX, curveThresholdPerbill, PERBILL, trackById } from '../src/services/referendaTracks.ts'

// OpenGov's bars decay across the decision period, so a tally below today's bar
// is not failing — the projection asks WHEN the bar meets it. The crossing is
// the exact inverse of the threshold curve.
describe('curveCrossingX', () => {
  const treasurer = trackById(5)!

  it('inverts the approval curve: an 80% tally crosses at the constructed day-1 anchor', () => {
    const x = curveCrossingX(treasurer.minApproval, 0.8 * PERBILL)!
    expect(Math.abs(x - PERBILL / 7)).toBeLessThan(PERBILL / 1000)
    // The crossing is exact: one step earlier the bar is still above the tally.
    expect(curveThresholdPerbill(treasurer.minApproval, x)).toBeLessThanOrEqual(0.8 * PERBILL)
    expect(curveThresholdPerbill(treasurer.minApproval, Math.max(0, x - 2))).toBeGreaterThan(0.8 * PERBILL)
  })

  it('a tally already above the opening bar crosses at zero', () => {
    expect(curveCrossingX(treasurer.minSupport, 0.5 * PERBILL)).toBe(0)
  })

  it('approval below the 50% floor never crosses — the referendum is short as voted', () => {
    expect(curveCrossingX(treasurer.minApproval, 0.49 * PERBILL)).toBeNull()
  })

  it('any positive support crosses a linear-to-zero support curve eventually', () => {
    const x = curveCrossingX(treasurer.minSupport, 0.005 * PERBILL)!
    expect(x).toBeGreaterThan(0.9 * PERBILL)
    expect(x).toBeLessThanOrEqual(PERBILL)
  })
})
