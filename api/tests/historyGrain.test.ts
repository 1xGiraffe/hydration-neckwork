import { describe, expect, it } from 'vitest'
import { DAILY_GRAIN, grainForWindow, makeGrain } from '../src/services/historyGrain.ts'

const H = 3_600
const D = 86_400
const at = (iso: string) => Date.parse(`${iso}Z`) / 1000

describe('DAILY_GRAIN', () => {
  it('keys a day exactly as the builders always have', () => {
    expect(DAILY_GRAIN.daily).toBe(true)
    expect(DAILY_GRAIN.keyOf(at('2026-08-31T13:47:00'))).toBe('2026-08-31')
    // toDate() matters: toStartOfInterval alone yields a DateTime, so the key
    // would be `2026-08-31 00:00:00` and would never match the grid's bare date.
    expect(DAILY_GRAIN.keySql('block_timestamp')).toBe('toString(toDate(toStartOfInterval(block_timestamp, INTERVAL 1 DAY)))')
  })

  it('builds the same inclusive day grid dailyGrid did', () => {
    expect(DAILY_GRAIN.grid(at('2026-08-29T00:00:00'), at('2026-09-01T00:00:00')))
      .toEqual(['2026-08-29', '2026-08-30', '2026-08-31', '2026-09-01'])
  })
})

describe('hourly grain', () => {
  const g = makeGrain(H)

  it('produces a key of the same shape as its own grid, at every step', () => {
    for (const step of [H, 6 * H, D, 3 * D]) {
      const gg = makeGrain(step)
      const grid = gg.grid(at('2026-08-20T00:00:00'), at('2026-08-31T00:00:00'))
      const dated = gg.keyOf(at('2026-08-25T00:00:00'))
      // A grid key and a keyOf key must be interchangeable, or every lookup misses.
      expect(grid.some(k => k.length === dated.length)).toBe(true)
      expect(gg.keySql('ts').includes('toDate(')).toBe(gg.daily)
    }
  })

  it('keys to the hour, with a timestamp the charts can parse', () => {
    expect(g.daily).toBe(false)
    expect(g.keyOf(at('2026-08-31T13:47:12'))).toBe('2026-08-31 13:00:00')
    expect(g.keySql('block_timestamp')).toContain('INTERVAL 1 HOUR')
  })

  it('grids an hour at a time', () => {
    expect(g.grid(at('2026-08-31T22:00:00'), at('2026-09-01T01:00:00')))
      .toEqual(['2026-08-31 22:00:00', '2026-08-31 23:00:00', '2026-09-01 00:00:00', '2026-09-01 01:00:00'])
  })
})

describe('grainForWindow', () => {
  it('gives a week-long zoom hourly buckets', () => {
    const g = grainForWindow(0, 6 * D, 180)
    expect(g.stepSec).toBe(H)
  })

  it('never goes finer than an hour', () => {
    expect(grainForWindow(0, 30 * 60, 180).stepSec).toBe(H)
  })

  it('coarsens for a long window rather than blowing the budget', () => {
    const g = grainForWindow(0, 400 * D, 180)
    expect(g.stepSec).toBeGreaterThanOrEqual(D)
    expect(Math.ceil((400 * D) / g.stepSec)).toBeLessThanOrEqual(180)
  })

  it('folds pre-window rows into the first bucket, so a window opens on the standing value', () => {
    const g = grainForWindow(1_000_000, 1_000_000 + 6 * D, 180)
    // The carry-in is what stops a mid-history window starting at null.
    expect(g.keySql('block_timestamp')).toContain('greatest(block_timestamp, toDateTime(1000000))')
  })

  it('leaves the unwindowed grain unclamped', () => {
    expect(DAILY_GRAIN.keySql('block_timestamp')).not.toContain('greatest')
  })
})
