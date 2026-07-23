import { describe, expect, it } from 'vitest'
import { barMetaFromTimes, fractionalLogicalForTime, logicalToX, timeToX, xToTime } from '../src/chart-tools/coords'
import type { CoordScale } from '../src/chart-tools/coords'

// Fake time scale over an injected bar-times array: bar i sits at x = i * spacing.
// Mirrors the lightweight-charts contract the helpers rely on — including the
// footgun that logicalToCoordinate returns 0 (NOT an interpolated coordinate)
// for fractional logicals, so the fake exercises the constraint the helpers
// must respect for cross-interval drawings.
function makeScale(barTimes: number[], spacing = 10): CoordScale {
  return {
    coordinateToTime: x => {
      const logical = Math.round(x / spacing)
      return logical >= 0 && logical < barTimes.length ? barTimes[logical] : null
    },
    coordinateToLogical: x => x / spacing,
    timeToCoordinate: time => {
      const index = barTimes.indexOf(time)
      return index >= 0 ? index * spacing : null
    },
    logicalToCoordinate: logical => (Number.isInteger(logical) ? logical * spacing : 0),
  }
}

// Hourly bars: times 1000, 4600, 8200, 11800 (intervalSec 3600).
const BARS = [1_000, 4_600, 8_200, 11_800]
// Same grid with a missing bucket (gap between 4600 and 11800).
const GAPPED = [1_000, 4_600, 11_800, 15_400]

describe('barMetaFromTimes', () => {
  it('derives times/first/last/interval from the bar times', () => {
    expect(barMetaFromTimes(BARS)).toEqual({
      times: BARS,
      firstTime: 1_000,
      lastTime: 11_800,
      lastIndex: 3,
      intervalSec: 3_600,
    })
  })

  it('rejects fewer than 2 bars and non-increasing spacing', () => {
    expect(barMetaFromTimes([])).toBeNull()
    expect(barMetaFromTimes([1_000])).toBeNull()
    expect(barMetaFromTimes([1_000, 1_000])).toBeNull()
  })
})

describe('fractionalLogicalForTime', () => {
  const meta = barMetaFromTimes(BARS)!

  it('is exact on bar times and interpolates between them', () => {
    expect(fractionalLogicalForTime(4_600, meta)).toBe(1)
    expect(fractionalLogicalForTime(6_400, meta)).toBeCloseTo(1.5, 9)
  })

  it('extrapolates beyond both edges with the interval spacing', () => {
    expect(fractionalLogicalForTime(11_800 + 1.5 * 3_600, meta)).toBeCloseTo(4.5, 9)
    expect(fractionalLogicalForTime(1_000 - 7_200, meta)).toBeCloseTo(-2, 9)
  })

  it('interpolates within a gapped span by real time distance', () => {
    const gapped = barMetaFromTimes(GAPPED)!
    // 8200 lies halfway through the 4600→11800 gap span (indices 1→2).
    expect(fractionalLogicalForTime(8_200, gapped)).toBeCloseTo(1.5, 9)
  })
})

describe('logicalToX', () => {
  const scale = makeScale(BARS)

  it('passes integers straight through', () => {
    expect(logicalToX(2, scale)).toBe(20)
    expect(logicalToX(-3, scale)).toBe(-30)
  })

  it('interpolates fractional logicals between integer coordinates', () => {
    // The fake (like the library) would return 0 for a fractional input.
    expect(logicalToX(2.5, scale)).toBe(25)
    expect(logicalToX(3.8333, scale)).toBeCloseTo(38.333, 3)
    expect(logicalToX(-1.25, scale)).toBeCloseTo(-12.5, 9)
  })
})

describe('xToTime', () => {
  const scale = makeScale(BARS)
  const meta = barMetaFromTimes(BARS)

  it('returns the bar time inside the data range', () => {
    expect(xToTime(0, scale, meta)).toBe(1_000)
    expect(xToTime(20, scale, meta)).toBe(8_200)
  })

  it('extrapolates future times beyond the right edge', () => {
    // x=50 → logical 5, two bars past the last (index 3): 11800 + 2*3600.
    expect(xToTime(50, scale, meta)).toBe(19_000)
    // Fractional logical keeps sub-bar precision.
    expect(xToTime(45, scale, meta)).toBe(11_800 + 1.5 * 3_600)
  })

  it('extrapolates times before the left edge', () => {
    // x=-20 → logical -2: 1000 - 2*3600.
    expect(xToTime(-20, scale, meta)).toBe(-6_200)
  })

  it('rejects out-of-range coordinates when fewer than 2 bars exist', () => {
    const one = [1_000]
    expect(xToTime(50, makeScale(one), barMetaFromTimes(one))).toBeNull()
  })
})

describe('timeToX', () => {
  const scale = makeScale(BARS)
  const meta = barMetaFromTimes(BARS)

  it('uses the exact bar coordinate when the time is a bar time', () => {
    expect(timeToX(4_600, scale, meta)).toBe(10)
  })

  it('interpolates non-bar times inside the range to sub-bar positions', () => {
    // Times drawn on a finer interval keep their true position instead of
    // snapping a full bar (4700 is 1/36 into the 4600→8200 span).
    expect(timeToX(4_700, scale, meta)).toBeCloseTo(10 + 10 / 36, 6)
    expect(timeToX(6_400, scale, meta)).toBe(15)
  })

  it('extrapolates coordinates beyond the edges, including fractional positions', () => {
    expect(timeToX(19_000, scale, meta)).toBe(50)
    expect(timeToX(-6_200, scale, meta)).toBe(-20)
    // The regression case: a beyond-last time at a fractional bar offset must
    // land right of the last bar — never at x=0 (the library's fractional
    // logicalToCoordinate footgun).
    expect(timeToX(11_800 + 0.8333 * 3_600, scale, meta)).toBeCloseTo(38.333, 3)
  })

  it('rejects out-of-range times when fewer than 2 bars exist', () => {
    const one = [1_000]
    expect(timeToX(5_000, makeScale(one), barMetaFromTimes(one))).toBeNull()
  })

  it('round-trips with xToTime outside the data range', () => {
    for (const x of [45, 50, 120, -20, -35]) {
      const time = xToTime(x, scale, meta)
      expect(time).not.toBeNull()
      expect(timeToX(time!, scale, meta)).toBeCloseTo(x, 6)
    }
  })
})
