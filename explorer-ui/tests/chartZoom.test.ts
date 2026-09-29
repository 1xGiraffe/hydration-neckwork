import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ZoomSelection, commitSelection, fracOfTime, parseZoomParam, pinchWindow, seriesBucketEnd, seriesExtentEnd, timeAt,
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

  // The plot's right edge is the last bucket's END, not the last point: on a
  // monthly chart the last point sits on the 1st and the whole current month
  // lies past it. A drag reaching the edge lands there, so the current month
  // is selectable at all; an interior lift keeps the drawn domain's time.
  describe('with the right edge standing for the extent\'s end', () => {
    const end = view.to + 20 * D
    it('lands a snapped right edge on the extent, not the last point', () => {
      const w = commitSelection(view, 0.5, 0.995, end)!
      expect(w.from).toBe(T0 + 15 * D)
      expect(w.to).toBe(end)
    })
    it('keeps an interior lift on the drawn domain', () => {
      expect(commitSelection(view, 0.5, 0.9, end)).toEqual(commitSelection(view, 0.5, 0.9))
    })
    it('a nick at the very edge selects exactly the last bucket', () => {
      // Both ends snap to 1: from = the last point, to = its bucket's end.
      const w = commitSelection(view, 0.984, 1, end)!
      expect(w).toEqual({ from: view.to, to: end })
    })
    it('never reaches before the drawn end when the extent is not past it', () => {
      expect(commitSelection(view, 0.5, 1, view.to - D)!.to).toBe(view.to)
    })
    it('still refuses the whole view', () => {
      expect(commitSelection(view, 0, 1, end)).toBeNull()
    })
  })

  it('widens a floor-thin selection away from a snapped edge, keeping the edge in place', () => {
    // A half-hour-old open bucket: the right edge is the present, and widening
    // around the midpoint would push the window into the future.
    const narrow = { from: T0, to: T0 + 4 * H }
    const atEnd = commitSelection(narrow, 0.9, 1, narrow.to + 1_800)!
    expect(atEnd.to).toBe(narrow.to + 1_800)
    expect(atEnd.from).toBe(atEnd.to - MIN_SPAN_SEC)
    const atStart = commitSelection(narrow, 0, 0.1)!
    expect(atStart.from).toBe(narrow.from)
    expect(atStart.to).toBe(narrow.from + MIN_SPAN_SEC)
  })
})

// A series' points are bucket STARTS; the zoomable domain must reach the last
// bucket's end, or the current month/week can never be zoomed into.
describe('seriesBucketEnd / seriesExtentEnd', () => {
  const utc = (s: string) => Date.parse(s) / 1000
  const months = ['2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01'].map(m => utc(`${m}T00:00:00Z`))
  const mondays = ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'].map(m => utc(`${m}T00:00:00Z`))

  it('ends a monthly series at the next calendar month, not a fixed 30 days', () => {
    expect(seriesBucketEnd(months)).toBe(utc('2026-10-01T00:00:00Z'))
    // Across a February the smallest gap is 28 days; still a calendar month.
    const winter = ['2026-01-01', '2026-02-01', '2026-03-01'].map(m => utc(`${m}T00:00:00Z`))
    expect(seriesBucketEnd(winter)).toBe(utc('2026-04-01T00:00:00Z'))
  })

  it('ends a fixed-step series one grain past its last point', () => {
    expect(seriesBucketEnd(mondays)).toBe(utc('2026-10-05T00:00:00Z'))
    const hours = [0, 1, 2, 3].map(i => T0 + i * H)
    expect(seriesBucketEnd(hours)).toBe(T0 + 4 * H)
  })

  it('does not mistake a weekly series that happens to land on a 1st for months', () => {
    // 2026-06-01 is a Monday; the grain says weeks.
    const weeks = ['2026-05-25', '2026-06-01'].map(m => utc(`${m}T00:00:00Z`))
    expect(seriesBucketEnd(weeks)).toBe(utc('2026-06-08T00:00:00Z'))
  })

  it('a lone point or no points has nowhere to extend', () => {
    expect(seriesBucketEnd([T0])).toBe(T0)
    expect(seriesBucketEnd([])).toBe(0)
  })

  it('caps an open bucket at the present, and never before the last point', () => {
    const now = utc('2026-09-28T19:30:00Z')
    expect(seriesExtentEnd(months, now)).toBe(now)
    expect(seriesExtentEnd(mondays, now)).toBe(now)
    // A closed series ends at its bucket end, whatever the clock says.
    expect(seriesExtentEnd(months, utc('2027-01-01T00:00:00Z'))).toBe(utc('2026-10-01T00:00:00Z'))
    // A live-pinned last point a few seconds ahead of the client clock stays reachable.
    expect(seriesExtentEnd([T0, T0 + H], T0 + H - 5)).toBe(T0 + H)
  })
})

describe('ZoomSelection', () => {
  it('clamps a shade past the drawn domain to the plot edge instead of spilling out', () => {
    const html = renderToStaticMarkup(createElement(ZoomSelection, { aPct: 60, bPct: 130 }))
    expect(html).toContain('left:60%')
    expect(html).toContain('width:40%')
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
