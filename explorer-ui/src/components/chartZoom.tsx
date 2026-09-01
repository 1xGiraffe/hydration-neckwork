/* eslint-disable react-refresh/only-export-components -- hook + pure window math + overlay components */
// Gesture-only zoom for the long-history SVG charts (AreaChart, PriceChart,
// StackedAreaChart, MultiLineChart): drag a range with the mouse to zoom into
// it (repeatable), double-click/double-tap to reset, pinch with two fingers on
// touch. No permanent controls — a small reset chip appears only while zoomed.
//
// THE WINDOW IS A TIME RANGE, not a pair of series indices.
//
// It used to be indices, and that capped the zoom's resolution at the BASE
// series' step no matter how finely the chart was drawn: on a 3-day base series
// a drag across a 3-hour-resolution view could only land on 3-day boundaries, so
// the selection shade jumped in 3-day steps (the "jitter") and the committed
// window missed what was selected by up to a day and a half. Time has no such
// floor, so a selection is exactly what was dragged.
//
// It also removes the mismatch that caused two earlier bugs: the plot's x domain
// IS the window, so a point's screen position and the window's arithmetic are
// the same fact rather than two computations over different spans (the refined
// series' extent used to differ from the window it replaced).
//
// Times are UNIX SECONDS throughout — the unit the windowed endpoints take, and
// what the URL carries, so a shared link is stable even as the base series
// re-buckets underneath it.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { setQuery, useQueryValue } from '../router'

/** An inclusive view window in unix seconds. */
export interface TimeWindow { from: number; to: number }

/** A selection narrower than this fraction of the plot is a click, not a zoom. */
export const DRAG_MIN_FRAC = 0.015
/**
 * The finest window any chart will open. It matches the API's bucket-ladder
 * floor: below an hour there is nothing further to fetch, so zooming in would
 * only stretch the same points.
 */
export const MIN_SPAN_SEC = 3_600
/**
 * A drag ending within this fraction of a plot edge means "to the very
 * start/end" — selecting up to the present must not need a pixel-perfect lift.
 */
const EDGE_SNAP_FRAC = 0.02
/** Hold a finger this long (without wandering) to start a touch selection. */
const LONG_PRESS_MS = 400
/** Finger wander beyond this fraction before the hold elapses = a scrub, not a press. */
const TOUCH_SLOP_FRAC = 0.02

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function snapFrac(f: number): number {
  if (f <= EDGE_SNAP_FRAC) return 0
  if (f >= 1 - EDGE_SNAP_FRAC) return 1
  return f
}

/** Where an instant sits across a view, 0..1. The inverse of `timeAt`. */
export function fracOfTime(view: TimeWindow, t: number): number {
  const span = view.to - view.from
  return span > 0 ? (t - view.from) / span : 0
}

/** The instant at a plot fraction of a view. The inverse of `fracOfTime`. */
export function timeAt(view: TimeWindow, f: number): number {
  return view.from + f * (view.to - view.from)
}

/**
 * Turn a drag selection (plot fractions of the CURRENT view) into the next
 * window. Null = not a zoom: a click-width drag, or a selection of the whole
 * view, which would change nothing but state.
 *
 * Also the preview: charts run the in-flight selection through this every render,
 * so the shade shows exactly what a lift commits — and because both are in time,
 * the shade tracks the cursor continuously instead of snapping to points.
 */
export function commitSelection(view: TimeWindow, a: number, b: number): TimeWindow | null {
  const [fa, fb] = a <= b ? [a, b] : [b, a]
  if (fb - fa < DRAG_MIN_FRAC) return null
  const sa = snapFrac(clamp(fa, 0, 1))
  const sb = snapFrac(clamp(fb, 0, 1))
  if (sa <= 0 && sb >= 1) return null
  let from = timeAt(view, sa)
  let to = timeAt(view, sb)
  // Widen a selection thinner than the floor instead of refusing it — the
  // gesture said "here", so land there at the closest legal width.
  if (to - from < MIN_SPAN_SEC) {
    const mid = (from + to) / 2
    from = mid - MIN_SPAN_SEC / 2
    to = mid + MIN_SPAN_SEC / 2
  }
  return { from: Math.round(from), to: Math.round(to) }
}

/** Parse a `from-to` zoom query param (unix seconds) into a window. */
export function parseZoomParam(raw: string): TimeWindow | null {
  const m = /^(\d{9,11})-(\d{9,11})$/.exec(raw)
  if (!m) return null
  const from = Number(m[1])
  const to = Number(m[2])
  if (!(to - from >= MIN_SPAN_SEC)) return null
  return { from, to }
}

/**
 * Solve the window a two-finger pinch asks for: the instants that were under the
 * fingers when the gesture began must stay under them. `p1/p2` are the fingers'
 * plot fractions at gesture start, `q1/q2` where they are now, `start` the window
 * the gesture began on. Null for a degenerate gesture (fingers together, or
 * crossed to a negative span).
 */
export function pinchWindow(start: TimeWindow, p1: number, p2: number, q1: number, q2: number): TimeWindow | null {
  if (q1 > q2) { [q1, q2] = [q2, q1]; [p1, p2] = [p2, p1] }
  if (q2 - q1 < 0.02 || p2 - p1 <= 0) return null
  const t1 = timeAt(start, p1)
  const t2 = timeAt(start, p2)
  const span = Math.max(MIN_SPAN_SEC, (t2 - t1) / (q2 - q1))
  const from = t1 - q1 * span
  return { from: Math.round(from), to: Math.round(from + span) }
}

export interface ChartZoomApi {
  /** The view's time domain — the window when zoomed, the data's extent when not. */
  view: TimeWindow
  /** Inclusive index range of the points inside the view, for slicing. */
  lo: number
  hi: number
  zoomed: boolean
  /** A mouse drag-selection is in progress — charts pause their crosshair. */
  selecting: boolean
  /** A two-finger pinch is in progress — charts pause their touch scrub. */
  pinching: boolean
  /** In-progress selection, as plot fractions of the current view. */
  sel: { a: number; b: number } | null
  /** The window a lift would commit, for the shade and its label. */
  preview: TimeWindow | null
  reset: () => void
  onPointerDown: (e: ReactPointerEvent) => void
  onPointerMove: (e: ReactPointerEvent) => void
  onPointerUp: (e: ReactPointerEvent) => void
  onPointerCancel: (e: ReactPointerEvent) => void
  onDoubleClick: () => void
}

/**
 * `times` are the FULL series' point times in unix seconds, ascending — the only
 * thing the hook needs about the data, since the window itself is absolute.
 * `plotFrac` maps a pointer event to a 0..1 fraction across the plot area
 * (charts with a y-axis gutter subtract it); `onWindowChange` fires on every
 * window change so the chart can drop hover state indexing the old slice.
 */
export function useChartZoom(
  times: number[],
  plotFrac: (e: ReactPointerEvent) => number,
  onWindowChange?: () => void,
  urlKey?: string,
): ChartZoomApi {
  const [rawWin, setWin] = useState<TimeWindow | null>(null)
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null)
  const [pinching, setPinching] = useState(false)
  const drag = useRef<{ start: number; active: boolean } | null>(null)
  const touchSel = useRef<{ id: number; start: number; timer: ReturnType<typeof setTimeout> | null; active: boolean } | null>(null)
  const touches = useRef(new Map<number, number>())
  const pinch = useRef<{ win: TimeWindow; id1: number; id2: number; p1: number; p2: number } | null>(null)
  const changed = useRef(onWindowChange)
  useEffect(() => { changed.current = onWindowChange })
  useEffect(() => () => { if (touchSel.current?.timer) clearTimeout(touchSel.current.timer) }, [])

  // URL mode (`urlKey` set): the window lives in the query string, so every
  // committed zoom is a history entry — back re-opens the previous window, and
  // a shared link lands zoomed. A pinch writes only its FINAL window (one entry
  // per gesture); the live gesture rides transient local state.
  const urlRaw = useQueryValue(urlKey ?? '', '')
  const urlWin = urlKey ? parseZoomParam(urlRaw) : null
  const [transient, setTransient] = useState<TimeWindow | null>(null)
  const transientRef = useRef<TimeWindow | null>(null)
  const gestureDirty = useRef(false)

  const full: TimeWindow = times.length > 1
    ? { from: times[0], to: times[times.length - 1] }
    : { from: 0, to: 0 }
  const candidate = urlKey ? (transient ?? urlWin) : rawWin
  // A window that no longer overlaps the data (an account switch, a series that
  // shrank) is dropped rather than left addressing nothing.
  const win = candidate && candidate.to > full.from && candidate.from < full.to ? candidate : null
  const view = win ?? full

  // Indices of the points inside the view. Charts slice with these, so their
  // geometry code is unchanged; the window itself stays continuous.
  let lo = 0
  let hi = Math.max(0, times.length - 1)
  if (win && times.length) {
    lo = times.findIndex(t => t >= win.from)
    if (lo < 0) lo = Math.max(0, times.length - 1)
    hi = lo
    for (let i = lo; i < times.length && times[i] <= win.to; i++) hi = i
  }

  const apply = useCallback((next: TimeWindow | null, liveGesture = false) => {
    const w = next
    if (urlKey) {
      changed.current?.()
      if (liveGesture) {
        gestureDirty.current = true
        transientRef.current = w
        setTransient(w)
      } else {
        transientRef.current = null
        setTransient(null)
        setQuery({ [urlKey]: w ? `${w.from}-${w.to}` : null })
      }
      return
    }
    setWin(cur => {
      if ((w?.from ?? -1) !== (cur?.from ?? -1) || (w?.to ?? -1) !== (cur?.to ?? -1)) changed.current?.()
      return w
    })
  }, [urlKey])

  const reset = useCallback(() => apply(null), [apply])

  // Latest-ref for the view: the gesture handlers must commit against the view
  // that was on screen when the gesture started, and it is a plain value, so a
  // ref keeps it out of every handler's dependency list.
  const viewRef = useRef(view)
  useEffect(() => { viewRef.current = view })

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    if (e.pointerType === 'mouse') {
      if (e.button !== 0) return
      drag.current = { start: plotFrac(e), active: false }
    } else {
      touches.current.set(e.pointerId, plotFrac(e))
      if (touches.current.size === 2) {
        // A second finger turns the gesture into a pinch — abandon any pending
        // or active long-press selection.
        const ts = touchSel.current
        if (ts) {
          if (ts.timer) clearTimeout(ts.timer)
          if (ts.active) setSel(null)
          touchSel.current = null
        }
        const [[id1, p1], [id2, p2]] = [...touches.current]
        pinch.current = { win: viewRef.current, id1, id2, p1, p2 }
        setPinching(true)
      } else if (touches.current.size === 1) {
        // Long-press arms a touch selection: hold still past the delay and the
        // drag selects a range exactly like the mouse drag (a quick swipe
        // cancels the timer and stays a crosshair scrub).
        const entry = { id: e.pointerId, start: plotFrac(e), timer: null as ReturnType<typeof setTimeout> | null, active: false }
        entry.timer = setTimeout(() => {
          entry.timer = null
          entry.active = true
          try { navigator.vibrate?.(15) } catch { /* not supported */ }
          setSel({ a: entry.start, b: entry.start })
        }, LONG_PRESS_MS)
        touchSel.current = entry
      }
    }
  }, [plotFrac])

  const onPointerMove = useCallback((e: ReactPointerEvent) => {
    if (e.pointerType === 'mouse') {
      const d = drag.current
      if (!d) return
      const f = plotFrac(e)
      if (!d.active && Math.abs(f - d.start) > DRAG_MIN_FRAC) {
        d.active = true
        e.currentTarget.setPointerCapture(e.pointerId)
      }
      if (d.active) setSel({ a: d.start, b: f })
    } else if (touches.current.has(e.pointerId)) {
      const f = plotFrac(e)
      touches.current.set(e.pointerId, f)
      const ts = touchSel.current
      if (ts && e.pointerId === ts.id) {
        if (ts.active) { setSel({ a: ts.start, b: f }); return }
        if (ts.timer && Math.abs(f - ts.start) > TOUCH_SLOP_FRAC) {
          clearTimeout(ts.timer)
          touchSel.current = null
        }
      }
      const p = pinch.current
      if (p && touches.current.has(p.id1) && touches.current.has(p.id2)) {
        const next = pinchWindow(p.win, p.p1, p.p2, touches.current.get(p.id1)!, touches.current.get(p.id2)!)
        if (next) apply(next, true)
      }
    }
  }, [plotFrac, apply])

  const endPointer = useCallback((e: ReactPointerEvent) => {
    if (e.pointerType === 'mouse') {
      const d = drag.current
      drag.current = null
      if (d?.active) {
        setSel(cur => {
          if (cur) {
            const next = commitSelection(viewRef.current, cur.a, cur.b)
            if (next) apply(next)
          }
          return null
        })
      }
    } else {
      touches.current.delete(e.pointerId)
      const ts = touchSel.current
      if (ts && e.pointerId === ts.id) {
        if (ts.timer) clearTimeout(ts.timer)
        touchSel.current = null
        if (ts.active) {
          // pointercancel (the browser took the gesture, e.g. a vertical
          // scroll) abandons the selection; a lift commits it like the mouse.
          const cancelled = e.type === 'pointercancel'
          setSel(cur => {
            if (cur && !cancelled) {
              const next = commitSelection(viewRef.current, cur.a, cur.b)
              if (next) apply(next)
            }
            return null
          })
          return
        }
      }
      const p = pinch.current
      if (p && (e.pointerId === p.id1 || e.pointerId === p.id2)) {
        pinch.current = null
        setPinching(false)
        // URL mode: the gesture's final window becomes exactly one history entry.
        if (urlKey && gestureDirty.current) {
          const t = transientRef.current
          gestureDirty.current = false
          transientRef.current = null
          setTransient(null)
          setQuery({ [urlKey]: t ? `${t.from}-${t.to}` : null })
        }
      }
    }
  }, [apply, urlKey])

  return {
    view,
    lo,
    hi,
    zoomed: win != null,
    selecting: sel != null,
    pinching,
    sel,
    preview: sel ? commitSelection(view, sel.a, sel.b) : null,
    reset,
    onPointerDown,
    onPointerMove,
    onPointerUp: endPointer,
    onPointerCancel: endPointer,
    onDoubleClick: reset,
  }
}

export interface RefinedSeries { data: number[]; dates: string[] }

/**
 * Refetch-on-zoom: when a chart is zoomed and its owner supplied a `refine`
 * loader, fetch a finer-resolution series for the window and substitute it for
 * the coarse slice. The window is absolute time, so the loader is handed exactly
 * the span the user selected and the substitution needs no index translation.
 * While a fetch is in flight (debounced past gesture jitter) the coarse slice
 * shows; a failed or not-finer fetch simply leaves it in place.
 */
export function useZoomRefine(
  zoom: Pick<ChartZoomApi, 'zoomed' | 'view' | 'lo' | 'hi' | 'pinching'>,
  refine: ((fromSec: number, toSec: number, points: number) => Promise<RefinedSeries | null>) | undefined,
  points: number,
): RefinedSeries | null {
  return useZoomRefineValue(zoom, refine, points, (s, span) => s.data.length === s.dates.length && s.data.length > span)
}

/**
 * The same refetch-on-zoom for charts whose payload is not a single series —
 * a stacked composition or a multi-line peg chart refines its whole bucket grid
 * and every band at once, so one fetch replaces them together and they cannot
 * end up drawn on different grids.
 *
 * `accept` decides whether a fetched payload actually adds resolution over the
 * `span` (the coarse slice's point count) it would replace; anything else is
 * dropped, so the chart never flickers between two versions of one shape.
 */
export function useZoomRefineValue<T>(
  zoom: Pick<ChartZoomApi, 'zoomed' | 'view' | 'lo' | 'hi' | 'pinching'>,
  refine: ((fromSec: number, toSec: number, points: number) => Promise<T | null>) | undefined,
  points: number,
  accept: (value: T, span: number) => boolean,
): T | null {
  const [state, setState] = useState<{ key: string; series: T } | null>(null)
  const cache = useRef(new Map<string, T>())
  const seq = useRef(0)
  // Pages build `refine` inline and re-render on the shared clock, so its
  // identity churns once a second; going through a latest-ref keeps that churn
  // out of the effect deps — otherwise every tick re-armed the debounce and an
  // in-flight window fetched twice.
  const refineRef = useRef(refine)
  useEffect(() => { refineRef.current = refine })
  const { from, to } = zoom.view
  const span = zoom.hi - zoom.lo + 1
  const key = zoom.zoomed && refine ? `${from}:${to}:${points}` : null
  const { pinching } = zoom
  useEffect(() => {
    if (!key || pinching) return
    const hit = cache.current.get(key)
    if (hit !== undefined) {
      setState(cur => (cur?.key === key ? cur : { key, series: hit }))
      return
    }
    const id = ++seq.current
    const t = setTimeout(() => {
      void refineRef.current?.(from, to, points).then(series => {
        if (!series || seq.current !== id) return
        if (!accept(series, span)) return
        cache.current.set(key, series)
        if (cache.current.size > 24) cache.current.delete(cache.current.keys().next().value as string)
        setState({ key, series })
      }).catch(() => { /* keep the coarse slice */ })
    }, 260)
    return () => clearTimeout(t)
  }, [key, from, to, points, span, pinching, accept])
  return key && state?.key === key ? state.series : null
}

/**
 * The live drag-selection shade, placed by the caller at the window a lift would
 * commit; `label` names that window. `aPct`/`bPct` are WRAPPER percentages.
 */
export function ZoomSelection({ aPct, bPct, label }: { aPct: number; bPct: number; label?: string }) {
  const left = Math.min(aPct, bPct)
  const width = Math.abs(bPct - aPct)
  return (
    <div className="chart-zoom-sel" style={{ left: `${left}%`, width: `${width}%` }} aria-hidden="true">
      {label && <span className="chart-zoom-sel-label">{label}</span>}
    </div>
  )
}

/** The only visible control, and only while zoomed. Double-click resets too. */
export function ZoomReset({ onReset }: { onReset: () => void }) {
  return (
    <button
      type="button" className="chart-zoom-reset" aria-label="Reset zoom" title="Reset zoom (or double-click)"
      onPointerDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} onClick={onReset}
    >
      ⟲ reset
    </button>
  )
}

/**
 * The slice that covers the view: every point inside it, plus the one point on
 * each side that brackets it.
 *
 * The bracketing points keep their REAL times. Clamping them onto the window's
 * edges would draw a point at an instant that never had an observation — a
 * balance chart would show a reading at 14:17 because that is where the window
 * happens to start. Instead the caller clips the drawing to the plot, so the line
 * still reaches both edges (the bracketing segment crosses them) while every
 * point the tooltip can name is real.
 *
 * Including the brackets is also what stops the coarse slice rendering at part
 * width while a finer series is still loading.
 */
export function bracketToView(
  times: number[],
  view: TimeWindow,
  series: (number | null)[][],
): { times: number[]; series: (number | null)[][] } {
  const n = times.length
  if (!n) return { times: [], series: series.map(() => []) }
  let lo = 0
  while (lo + 1 < n && times[lo + 1] <= view.from) lo++
  let hi = n - 1
  while (hi > 0 && times[hi - 1] >= view.to) hi--
  if (hi < lo) hi = lo
  const keep: number[] = []
  for (let i = lo; i <= hi; i++) keep.push(i)
  return { times: keep.map(i => times[i]), series: series.map(s => keep.map(i => s[i] ?? null)) }
}
