import { describe, expect, it } from 'vitest'
import { distributionSlices, distributionWindow } from '../src/utils/v3Distribution'

// The pool page's liquidity distribution: the API's segments (liquidity between
// consecutive initialised ticks) sliced into equal-width columns around the price.

const segments = [
  { tickLower: 100, tickUpper: 200, liquidity: '10', amount0: '0', amount1: '5' },
  { tickLower: 200, tickUpper: 300, liquidity: '25', amount0: '3', amount1: '4' },
  { tickLower: 900, tickUpper: 960, liquidity: '2', amount0: '1', amount1: '0' },
]

describe('distributionWindow', () => {
  it('frames the ranges a reader cares about — the vault\'s, padded — and always holds the current tick', () => {
    expect(distributionWindow(segments, 250, [{ tickLower: 120, tickUpper: 320 }])).toEqual({ from: 80, to: 360 })
    // A price outside the vault's range widens the frame to it.
    expect(distributionWindow(segments, 1000, [{ tickLower: 120, tickUpper: 320 }])).toEqual({ from: 80, to: 1000 })
  })
  it('falls back to the segments around the price, then to every segment', () => {
    // No vault: the in-range segment and one width either side.
    expect(distributionWindow(segments, 250, [])).toEqual({ from: 100, to: 400 })
    // No price yet: everything that has liquidity.
    expect(distributionWindow(segments, null, [])).toEqual({ from: 100, to: 960 })
  })
})

describe('distributionSlices', () => {
  it('reads each slice\'s liquidity off the segment under its midpoint and sides it by the price', () => {
    const slices = distributionSlices(segments, 250, { from: 100, to: 300 }, 4)
    expect(slices.map(s => [s.tickFrom, s.tickTo, s.liquidity, s.side, s.current])).toEqual([
      [100, 150, 10, 'token1', false],
      [150, 200, 10, 'token1', false],
      [200, 250, 25, 'token1', false],
      // The slice holding the price: both tokens, marked current.
      [250, 300, 25, 'both', true],
    ])
    // The covering segment travels with the slice, for the tooltip.
    expect(slices[3].segment).toBe(segments[1])
  })
  it('leaves a gap where no liquidity stands and puts everything above the price on the token0 side', () => {
    const slices = distributionSlices(segments, 250, { from: 300, to: 1000 }, 7)
    expect(slices.map(s => [s.liquidity, s.side])).toEqual([
      [0, 'token0'], [0, 'token0'], [0, 'token0'], [0, 'token0'], [0, 'token0'], [0, 'token0'], [2, 'token0'],
    ])
    expect(slices[6].segment).toBe(segments[2])
    expect(slices[0].segment).toBeNull()
  })
})

describe('fmtLiquidity', () => {
  it('keeps a liquidity axis label short enough not to be clipped', async () => {
    const { fmtLiquidity } = await import('../src/pages/UniswapV3Pool')
    expect(fmtLiquidity(4.504017577969432e18)).toBe('4.5e18')
    expect(fmtLiquidity(11)).toBe('11')
    expect(fmtLiquidity(0)).toBe('0')
    expect(fmtLiquidity(2.43e19)).toBe('2.4e19')
  })
})
