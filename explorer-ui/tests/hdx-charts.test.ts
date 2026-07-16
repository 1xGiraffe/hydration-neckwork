import { describe, expect, it } from 'vitest'
import { stackHeights, stackedColumnMax } from '../src/components/HdxCharts'

describe('stackedColumnMax — high unlock clusters do not flatten the chart', () => {
  it('uses the largest value when the distribution has no separated high tail', () => {
    expect(stackedColumnMax([10, 5, 2])).toBeCloseTo(10.5)
  })

  it('caps one isolated outlier against the representative values', () => {
    expect(stackedColumnMax([100, 10, 5])).toBeCloseTo(12.075)
  })

  it('caps several adjacent outliers above a clear upper-tail gap', () => {
    expect(stackedColumnMax([100, 90, 10, 5, 4, 3])).toBeCloseTo(12.075)
  })

  it('does not treat most of a small distribution as an outlier cluster', () => {
    expect(stackedColumnMax([100, 80, 60, 1, 0.5])).toBeCloseTo(105)
  })
})

// Clamped outlier columns must not shrink their small segments: a segment worth
// the same as in neighbouring columns has to render at the same height — only
// the oversized segment(s) absorb the clamp (the break marker flags the cut).
describe('stackHeights — outlier columns compress only the oversized segments', () => {
  it('returns true-scale heights unchanged when the column fits', () => {
    expect(stackHeights([20, 30], 100)).toEqual([20, 30])
  })

  it('keeps the small segment at true scale and gives the outlier the rest', () => {
    // December case: vesting ~10px everywhere, vote blows past the plot height
    expect(stackHeights([10, 600], 100)).toEqual([10, 90])
  })

  it('preserves input order (segment order is stacking order, not size order)', () => {
    expect(stackHeights([600, 10], 100)).toEqual([90, 10])
  })

  it('splits the leftover proportionally when several segments are oversized', () => {
    const [a, b] = stackHeights([300, 600], 100)
    expect(a).toBeCloseTo(100 / 3, 5)
    expect(b).toBeCloseTo(200 / 3, 5)
  })

  it('never squeezes an oversized segment below the visible minimum', () => {
    const [small, big] = stackHeights([96, 600], 100)
    expect(small).toBe(96)
    expect(big).toBeGreaterThanOrEqual(4)
  })
})
