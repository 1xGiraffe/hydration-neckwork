import { describe, expect, it } from 'vitest'
import { distToSegment, formatDuration, measureStats, newDrawingId } from '../src/chart-tools/geometry'

describe('distToSegment', () => {
  it('measures perpendicular distance to a point projected onto the segment', () => {
    // Horizontal segment y=0 from x=0..10; point above the middle.
    expect(distToSegment(5, 3, 0, 0, 10, 0)).toBeCloseTo(3)
    // Diagonal segment (0,0)->(10,10); point (10,0) is sqrt(50) from midpoint (5,5).
    expect(distToSegment(10, 0, 0, 0, 10, 10)).toBeCloseTo(Math.sqrt(50))
  })

  it('clamps to the nearest endpoint beyond the segment ends', () => {
    expect(distToSegment(-3, 4, 0, 0, 10, 0)).toBeCloseTo(5)
    expect(distToSegment(13, -4, 0, 0, 10, 0)).toBeCloseTo(5)
  })

  it('handles a degenerate zero-length segment as point distance', () => {
    expect(distToSegment(3, 4, 0, 0, 0, 0)).toBeCloseTo(5)
    expect(distToSegment(2, 2, 2, 2, 2, 2)).toBe(0)
  })
})

describe('measureStats', () => {
  it('reports positive deltas for an upward measurement', () => {
    const stats = measureStats({ time: 1_000, price: 100 }, { time: 4_600, price: 125 }, 6)
    expect(stats.deltaPrice).toBeCloseTo(25)
    expect(stats.deltaPct).toBeCloseTo(25)
    expect(stats.bars).toBe(6)
    expect(stats.seconds).toBe(3_600)
  })

  it('reports signed negative deltas for a downward measurement', () => {
    const stats = measureStats({ time: 4_600, price: 200 }, { time: 1_000, price: 150 }, 6)
    expect(stats.deltaPrice).toBeCloseTo(-50)
    expect(stats.deltaPct).toBeCloseTo(-25)
    expect(stats.seconds).toBe(3_600)
  })

  it('guards the percentage against a zero base price', () => {
    const stats = measureStats({ time: 0, price: 0 }, { time: 60, price: 5 }, 1)
    expect(stats.deltaPrice).toBe(5)
    expect(stats.deltaPct).toBe(0)
  })
})

describe('formatDuration', () => {
  it('keeps sub-hour durations in minutes', () => {
    expect(formatDuration(45 * 60)).toBe('45m')
    expect(formatDuration(59 * 60)).toBe('59m')
  })

  it('uses the largest two units', () => {
    expect(formatDuration(90 * 60)).toBe('1h 30m')
    expect(formatDuration(25 * 3600)).toBe('1d 1h')
    expect(formatDuration((3 * 7 + 2) * 86400)).toBe('3w 2d')
  })

  it('omits a zero remainder unit', () => {
    expect(formatDuration(5 * 3600)).toBe('5h')
    expect(formatDuration(2 * 86400 + 4 * 3600)).toBe('2d 4h')
  })
})

describe('newDrawingId', () => {
  it('produces distinct non-empty ids', () => {
    const a = newDrawingId()
    const b = newDrawingId()
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    expect(a).not.toBe(b)
  })
})
