import { describe, expect, it } from 'vitest'
import { stackHeights, stackedColumnMax, niceAxisMax, fmtHdxTick } from '../src/components/HdxCharts'

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

describe('stackedColumnMax — caps a tall cluster so smaller bars stay visible', () => {
  // Representative live shape: five tall buckets (65M–148M, incl. a near-term
  // weekly spike) then a drop to the ~25M-and-below bulk. 7-day weekly buckets
  // followed by 30-day monthly buckets, all on one axis.
  const weekly = [25, 4, 5, 148, 0.3, 0.6, 10, 4]
  const monthly = [4, 17, 126, 65, 119, 102, 0, 0, 0, 0, 0]
  const totals = [...weekly, ...monthly]

  it('caps just above the smaller bars, well below the tall cluster', () => {
    const cap = stackedColumnMax(totals)
    expect(cap).toBeLessThan(66)      // every 65M+ bucket clamps
    expect(cap).toBeGreaterThan(25)   // the 25M bar still fits, at a readable height
  })

  it('recognises a five-of-fourteen cluster (window is ceil(n/3), not floor)', () => {
    // floor(14/3) = 4 would miss the 65M→25M break at index 4 and leave the cap
    // pinned near the 148M max; ceil(14/3) = 5 catches it.
    expect(stackedColumnMax(totals)).toBeLessThan(66)
  })

  it('rounds to a 35M axis where the small bars read clearly', () => {
    // `totals` are expressed in millions, so the cap and axis are too.
    const axis = niceAxisMax(stackedColumnMax(totals))
    expect(axis).toBe(35)            // 35M top, 17.5M midpoint
    expect(10 / axis).toBeGreaterThan(0.28) // a 10M bar clears ~29% height
  })
})

describe('niceAxisMax — rounds the ceiling so the top and midpoint read cleanly', () => {
  it('rounds the live shape to a 150M ceiling with a 75M midpoint', () => {
    const top = niceAxisMax(132.07e6)
    expect(top).toBe(150e6)      // no truncated ".32.07M" label
    expect(top / 2).toBe(75e6)   // exact, round midpoint
  })

  it('always covers the value and never rounds below it', () => {
    for (const v of [1, 8.6e6, 25e6, 90e6, 110e6, 132e6, 260e6, 1.61e9]) {
      expect(niceAxisMax(v)).toBeGreaterThanOrEqual(v)
    }
  })

  it('steps evenly with no gaps — 250M / 350M are reachable, not skipped', () => {
    // The earlier fixed ladder jumped 200M → 300M; the calculated rule fills in.
    expect(niceAxisMax(210e6)).toBe(250e6)
    expect(niceAxisMax(320e6)).toBe(350e6)
    expect(niceAxisMax(260e6)).toBe(300e6)
  })

  it('keeps top a multiple of decade/2 and the midpoint a multiple of decade/4', () => {
    for (const v of [110e6, 132e6, 210e6, 260e6, 470e6]) {
      const top = niceAxisMax(v)
      const decade = 10 ** Math.floor(Math.log10(v) + 1e-9)
      expect(top % (decade / 2)).toBeCloseTo(0)        // top is a clean round number
      expect((top / 2) % (decade / 4)).toBeCloseTo(0)  // so is the midpoint
    }
  })

  it('scales to any magnitude', () => {
    expect(niceAxisMax(3.3e6)).toBe(3.5e6)   // 3.5M / 1.75M
    expect(niceAxisMax(47e6)).toBe(50e6)     // 50M / 25M
    expect(niceAxisMax(1.61e9)).toBe(2e9)    // 2B / 1B
  })

  it('is no-op-safe for non-positive input', () => {
    expect(niceAxisMax(0)).toBe(1)
    expect(niceAxisMax(-5)).toBe(1)
  })
})

describe('fmtHdxTick — compact clamp labels keep adjacent columns legible', () => {
  it('rounds to whole millions past ~10M (no crowded decimals)', () => {
    expect(fmtHdxTick(147.94e6)).toBe('148M')
    expect(fmtHdxTick(125.78e6)).toBe('126M')
    expect(fmtHdxTick(65.11e6)).toBe('65M')
    expect(fmtHdxTick(102.07e6)).toBe('102M')
  })

  it('still collapses billions and keeps small values precise', () => {
    expect(fmtHdxTick(1.61e9)).toBe('1.61B')
    expect(fmtHdxTick(4.4e6)).toBe('4.4M')
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
