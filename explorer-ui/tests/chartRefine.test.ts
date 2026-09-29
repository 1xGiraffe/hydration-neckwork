import { describe, expect, it } from 'vitest'
import { gridRefine, payloadRefine } from '../src/utils/chartRefine'

const payload = {
  stepSec: 3_600,
  buckets: ['2026-09-20 00:00:00', '2026-09-20 01:00:00', '2026-09-20 02:00:00'],
  series: { borrowed: [5, 0, 7], other: [1, 2, null] },
}

describe('gridRefine — a window payload onto the chart\'s own bands', () => {
  const bands = [
    { key: 'borrowed', label: 'Borrowed', color: 'red', values: [9] },
    { key: 'other', label: 'HSM', color: 'grey', values: [9] },
  ]

  it('keeps every band\'s identity and passes each value through the coarse transform', async () => {
    const refine = gridRefine(async () => payload, bands, v => (v != null && v > 0 ? v : null))
    const grid = await refine(1, 2, 180)
    expect(grid?.buckets).toEqual(payload.buckets)
    expect(grid?.series.map(s => [s.key, s.label, s.color])).toEqual([['borrowed', 'Borrowed', 'red'], ['other', 'HSM', 'grey']])
    expect(grid?.series[0].values).toEqual([5, null, 7])
    expect(grid?.series[1].values).toEqual([1, 2, null])
  })

  it('declines a payload missing a band rather than drawing half a chart', async () => {
    const refine = gridRefine(async () => payload, [...bands, { key: 'debt', label: 'Debt', color: 'x', values: [] }])
    expect(await refine(1, 2, 180)).toBeNull()
  })

  it('declines an empty or inverted window without asking twice', async () => {
    let calls = 0
    const refine = payloadRefine(async () => { calls++; return { ...payload, buckets: ['x'] } }, p => p.buckets)
    expect(await refine(5, 5, 180)).toBeNull()
    expect(calls).toBe(0)
    expect(await refine(1, 5, 180)).toBeNull() // a single bucket refines nothing
  })
})
