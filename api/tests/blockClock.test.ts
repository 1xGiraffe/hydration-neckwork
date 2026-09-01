import { describe, expect, it } from 'vitest'
import { heightAtOrBefore, heightsForBoundaries, type BlockClock } from '../src/services/blockClock.ts'

const H = 3_600
// Three hours of chain, with the last height reached inside each hour.
const clock: BlockClock = {
  hours: [10 * H, 11 * H, 12 * H],
  heights: [100, 250, 400],
  builtAt: 0,
}

describe('heightAtOrBefore', () => {
  it('resolves an hour mark to that hour last block', () => {
    expect(heightAtOrBefore(clock, 11 * H)).toBe(250)
  })

  it('resolves an instant inside an hour to the same hour, not the next', () => {
    // A bucket ENDING at 11:59 is dated by the last block of hour 11.
    expect(heightAtOrBefore(clock, 11 * H + 3_599)).toBe(250)
  })

  it('resolves past the head to the newest height', () => {
    expect(heightAtOrBefore(clock, 99 * H)).toBe(400)
  })

  it('returns null before the chain existed, rather than a bogus first height', () => {
    expect(heightAtOrBefore(clock, 9 * H)).toBeNull()
    expect(heightAtOrBefore({ hours: [], heights: [], builtAt: 0 }, 10 * H)).toBeNull()
  })

  it('binary search agrees with a scan across the whole index', () => {
    const hours = Array.from({ length: 500 }, (_, i) => (i + 1) * H)
    const heights = hours.map((_, i) => i * 7 + 3)
    const c: BlockClock = { hours, heights, builtAt: 0 }
    for (let i = 0; i < hours.length; i++) {
      expect(heightAtOrBefore(c, hours[i] + 12)).toBe(heights[i])
    }
  })
})

describe('heightsForBoundaries', () => {
  it('keeps boundary order and falls back below the chain start', () => {
    expect(heightsForBoundaries(clock, [9 * H, 10 * H, 12 * H], 1)).toEqual([1, 100, 400])
  })
})
