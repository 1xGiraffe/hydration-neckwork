import { describe, expect, it } from 'vitest'
import {
  commitSelection, fracOfTime, parseZoomParam, pinchWindow, timeAt,
  DRAG_MIN_FRAC, MIN_SPAN_SEC,
} from '../src/components/chartZoom'

// The window is a TIME range, not a pair of series indices. That is the whole
// point: an index window's resolution is the BASE series' step, so on a 3-day
// base series a drag across a 3-hour-resolution view could only land on 3-day
// boundaries — the shade jumped in 3-day steps and the committed window missed
// the selection by up to a day and a half. Time has no such floor.

const H = 3_600
const D = 86_400
const T0 = 1_756_000_000
const view = { from: T0, to: T0 + 30 * D }

describe('commitSelection', () => {
  it('commits exactly the span that was dragged', () => {
    const w = commitSelection(view, 0.25, 0.75)!
    expect(w.from).toBe(T0 + 7.5 * D)
    expect(w.to).toBe(T0 + 22.5 * D)
  })

  it('resolves a sub-bucket drag instead of snapping to the base step', () => {
    // A one-day view, selecting the three hours from 06:00 to 09:00. An index
    // window over a 3-day base series could not express this at all: both ends
    // would collapse onto the same base point.
    const day = { from: T0, to: T0 + D }
    const w = commitSelection(day, 6 / 24, 9 / 24)!
    expect(w.to - w.from).toBe(3 * H)
    expect(w.from).toBe(T0 + 6 * H)
  })

  it('accepts the drag in either direction', () => {
    expect(commitSelection(view, 0.75, 0.25)).toEqual(commitSelection(view, 0.25, 0.75))
  })

  it('composes: a selection inside a window nests within it', () => {
    const first = commitSelection(view, 0.5, 1)!
    expect(first.from).toBe(T0 + 15 * D)
    const second = commitSelection(first, 0, 0.5)!
    expect(second.from).toBe(first.from)
    expect(second.to).toBe(T0 + 22.5 * D)
  })

  it('treats a click-width drag as no zoom', () => {
    expect(commitSelection(view, 0.5, 0.5 + DRAG_MIN_FRAC / 2)).toBeNull()
  })

  it('refuses a selection of the whole view', () => {
    expect(commitSelection(view, -0.2, 1.2)).toBeNull()
  })

  it('widens a selection thinner than the floor around its midpoint', () => {
    const narrow = { from: T0, to: T0 + 4 * H }
    const w = commitSelection(narrow, 0.5, 0.53)!
    expect(w.to - w.from).toBe(MIN_SPAN_SEC)
    expect((w.from + w.to) / 2).toBeCloseTo(timeAt(narrow, 0.515), -1)
  })

  it('edge-snaps so selecting up to the present needs no pixel-perfect lift', () => {
    const w = commitSelection(view, 0.5, 0.995)!
    expect(w.to).toBe(view.to)
  })
})

describe('parseZoomParam', () => {
  it('round-trips a committed window', () => {
    const w = commitSelection(view, 0.25, 0.75)!
    expect(parseZoomParam(`${w.from}-${w.to}`)).toEqual(w)
  })

  it('rejects a window below the one-hour floor, and anything not two stamps', () => {
    expect(parseZoomParam(`${T0}-${T0 + 60}`)).toBeNull()
    expect(parseZoomParam('124-130')).toBeNull() // the old index form
    expect(parseZoomParam('nonsense')).toBeNull()
  })
})

describe('fracOfTime / timeAt', () => {
  it('are inverses, which is what keeps the shade under the cursor', () => {
    for (const f of [0, 0.13, 0.5, 0.87, 1]) {
      expect(fracOfTime(view, timeAt(view, f))).toBeCloseTo(f, 10)
    }
  })

  it('degenerate view does not divide by zero', () => {
    expect(fracOfTime({ from: T0, to: T0 }, T0)).toBe(0)
  })
})

describe('pinchWindow', () => {
  it('keeps the instants under the fingers under them', () => {
    const start = { from: T0, to: T0 + 10 * D }
    const w = pinchWindow(start, 0.25, 0.75, 0.1, 0.9)!
    expect(fracOfTime(w, timeAt(start, 0.25))).toBeCloseTo(0.1, 5)
    expect(fracOfTime(w, timeAt(start, 0.75))).toBeCloseTo(0.9, 5)
  })

  it('never opens below the floor, and refuses a degenerate gesture', () => {
    const start = { from: T0, to: T0 + 2 * H }
    const w = pinchWindow(start, 0.4, 0.6, 0.01, 0.99)!
    expect(w.to - w.from).toBeGreaterThanOrEqual(MIN_SPAN_SEC)
    expect(pinchWindow(start, 0.5, 0.5, 0.2, 0.8)).toBeNull()
  })
})
