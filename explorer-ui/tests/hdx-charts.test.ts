import { describe, expect, it } from 'vitest'
import { stackHeights, stackedColumnMax, niceAxisMax, fmtHdxTick, readableBarMax } from '../src/components/HdxCharts'

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

// The mirrored day-bar chart (HSM trades/arbitrage, HDX buys/sells, churn) sizes
// itself with readableBarMax. Its job is to keep as many bars comparable as
// possible; the unlock-schedule gap rule cannot, because a daily activity series
// puts its widest ratio gap BELOW the bars that matter.
describe('readableBarMax — daily activity keeps its loud days distinguishable', () => {
  // Live 60-day HOLLAR HSM trades (2026-06-06 … 2026-08-04), non-zero values
  // only: 15 mint days from 0.016 to 500k HOLLAR plus 15 burn days of 3–276.
  const mints = [0.015773, 0.029803, 500000, 0.031464, 0.02741, 427.485, 4956.19, 5818.17, 11610.81, 7101.37, 30285.36, 9429.91, 46433.45, 13153.84, 90000]
  const burns = [208.06, 157.69, 276.13, 155, 8.96, 164.33, 178.04, 3.4, 130.83, 60.89, 19.54, 18.09, 27.29, 22.93, 40.07]
  const trades = [...mints, ...burns]
  const frac = (v: number, cap: number) => Math.min(v, cap) / cap

  it('clamps only the isolated spike, not the whole trading cluster', () => {
    const cap = readableBarMax(trades)
    expect(trades.filter(v => v > cap)).toEqual([500000]) // one break mark, not ten
    // The gap rule capped at ~516, so every day from 4.9k up rendered identical.
    expect(stackedColumnMax(trades)).toBeLessThan(600)
    expect(cap).toBeGreaterThan(9e4)
  })

  it('spreads the mint days across the plot instead of saturating them', () => {
    const cap = readableBarMax(trades)
    expect(frac(90000, cap)).toBeGreaterThan(0.9)
    expect(frac(46433.45, cap)).toBeCloseTo(0.49, 2)
    expect(frac(13153.84, cap)).toBeCloseTo(0.14, 2)
    expect(frac(4956.19, cap)).toBeGreaterThan(1 / 20) // smallest mint day still readable
  })

  it('picks the same cap for the phone window (last 30 bars) as for 60 days', () => {
    // The reported bug: the phone view dropped the low-volume June prefix, which
    // moved the widest gap and so gave the gap rule a completely different cap —
    // mobile read fine while desktop saturated. A cap chosen by readability is
    // stable under that window change.
    const recent = [...mints.slice(6), ...burns.slice(12)]
    expect(readableBarMax(recent)).toBeCloseTo(readableBarMax(trades), 6)
    expect(stackedColumnMax(recent) / stackedColumnMax(trades)).toBeGreaterThan(100)
  })

  it('is insensitive to the exact readability threshold', () => {
    for (const denom of [14, 16, 20, 32]) expect(readableBarMax(trades, 1 / denom)).toBeCloseTo(94500, 0)
  })

  it('scales to the true max when clamping would not buy any readable bar', () => {
    expect(readableBarMax([10, 8, 6, 4, 2])).toBeCloseTo(10.5)
    expect(readableBarMax([1, 1e9])).toBeCloseTo(1.05e9) // one dust bar is not worth clamping the max
  })

  it('clamps a lone outlier once the bulk gains from it', () => {
    expect(readableBarMax([1, 1, 1, 1e9])).toBeCloseTo(1.05)
  })

  it('prefers the taller cap on a tie, so nothing clamps without a strict gain', () => {
    // 3 tiny + 3 huge: capping low would make 3 readable and clamp 3 — a wash.
    expect(readableBarMax([1, 1, 1, 1e6, 1e6, 1e6])).toBeCloseTo(1.05e6)
  })

  it('ignores zero and non-finite entries, and is safe when there is nothing to scale', () => {
    expect(readableBarMax([0, 0, 5, NaN, Infinity, -3])).toBeCloseTo(5.25)
    expect(readableBarMax([])).toBe(1)
    expect(readableBarMax([0, 0, 0])).toBe(1)
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
