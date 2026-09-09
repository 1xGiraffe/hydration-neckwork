// The pool page's liquidity distribution: how the API's `segments` (liquidity standing
// between consecutive initialised ticks) become the equal-width columns of a chart.
//
// A Uniswap v3 pool's liquidity is a step function over ticks with wildly unequal
// steps — a vault's 2,000-tick band next to a 60-tick limit order — so the chart
// frames a window and slices it evenly; each column reads its liquidity off the
// segment under its midpoint. Columns below the price hold token1 (the pool would
// sell it as the price falls), columns above hold token0, the column holding the
// price both.

export interface V3Segment { tickLower: number; tickUpper: number; liquidity: string; amount0: string; amount1: string }
export interface V3Slice {
  tickFrom: number
  tickTo: number
  liquidity: number
  side: 'token0' | 'token1' | 'both'
  current: boolean
  /** The segment the slice reads, for the tooltip; null over a gap. */
  segment: V3Segment | null
}

/**
 * The tick window worth showing: the focus ranges (a vault's) padded by a fifth of
 * their span, else the in-range segment and one width either side, else every
 * segment — and always including the current tick.
 */
export function distributionWindow(segments: V3Segment[], tick: number | null, focus: { tickLower: number; tickUpper: number }[]): { from: number; to: number } {
  let from: number, to: number
  if (focus.length) {
    const lo = Math.min(...focus.map(r => r.tickLower)), hi = Math.max(...focus.map(r => r.tickUpper))
    const pad = (hi - lo) * 0.2
    from = lo - pad; to = hi + pad
  } else {
    const inRange = tick != null ? segments.find(s => s.tickLower <= tick && tick < s.tickUpper) : undefined
    if (inRange) {
      const width = inRange.tickUpper - inRange.tickLower
      from = inRange.tickLower - width; to = inRange.tickUpper + width
    } else if (segments.length) {
      from = Math.min(...segments.map(s => s.tickLower)); to = Math.max(...segments.map(s => s.tickUpper))
    } else {
      from = (tick ?? 0) - 3000; to = (tick ?? 0) + 3000
    }
  }
  if (tick != null) { from = Math.min(from, tick); to = Math.max(to, tick) }
  return { from, to }
}

/** `n` equal slices of the window, each with the liquidity of the segment under its midpoint. */
export function distributionSlices(segments: V3Segment[], tick: number | null, window: { from: number; to: number }, n: number): V3Slice[] {
  const step = (window.to - window.from) / n
  const out: V3Slice[] = []
  for (let i = 0; i < n; i++) {
    const a = window.from + i * step, b = i === n - 1 ? window.to : window.from + (i + 1) * step
    const mid = (a + b) / 2
    const segment = segments.find(s => s.tickLower <= mid && mid < s.tickUpper) ?? null
    const current = tick != null && a <= tick && tick < b
    const side: V3Slice['side'] = current ? 'both' : tick == null || a > tick ? 'token0' : 'token1'
    out.push({ tickFrom: a, tickTo: b, liquidity: segment ? Number(segment.liquidity) : 0, side, current, segment })
  }
  return out
}
