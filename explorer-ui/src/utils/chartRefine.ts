import { parseUtcTimestamp } from './time'
import type { RefinedSeries } from '../components/chartZoom'
import type { AreaSeries, RefinedGrid } from '../components/HdxCharts'

/**
 * Turn a windowed endpoint into an AreaChart `refine` loader.
 *
 * The zoom window is absolute time, so it is handed straight to the endpoint —
 * no index translation, and the fetched span is exactly what was dragged. The
 * endpoint rebuilds its history on the finest ladder grain that fits the point
 * budget, so a zoom into a few days comes back hourly instead of daily.
 *
 * Returns null unless the refined series is genuinely finer than the slice it
 * would replace — substituting an equal-or-coarser series would only make the
 * chart flicker between two versions of the same shape.
 */
export function windowRefine<T>(
  fetchWindow: (fromTs: number, toTs: number, points: number) => Promise<T>,
  pick: (response: T) => { b: string; v: number | null }[],
): (fromTs: number, toTs: number, points: number) => Promise<RefinedSeries | null> {
  return async (fromTs, toTs, points) => {
    if (!(toTs > fromTs)) return null
    const rows = pick(await fetchWindow(fromTs, toTs, points)).filter(p => p.v != null)
    if (rows.length < 2) return null
    return { data: rows.map(p => p.v as number), dates: rows.map(p => p.b) }
  }
}

/**
 * Map a time window onto the block range that covers it, using a series' own
 * parallel (date, block) arrays.
 *
 * The account/tag history endpoints window in BLOCK space, but the zoom window
 * is absolute time. Widen outward to the bracketing points rather than inward,
 * so the fetched range covers the whole selection; the endpoint's carry-in fills
 * the opening value.
 */
export function blockRangeForWindow(
  dates: string[],
  blocks: number[],
  fromSec: number,
  toSec: number,
): { fromBlock: number; toBlock: number } | null {
  if (dates.length !== blocks.length || dates.length < 2) return null
  const sec = (d: string) => Math.floor(parseUtcTimestamp(d) / 1000)
  let lo = 0
  for (let i = 0; i < dates.length; i++) if (sec(dates[i]) <= fromSec) lo = i
  let hi = dates.length - 1
  for (let i = dates.length - 1; i >= 0; i--) if (sec(dates[i]) >= toSec) hi = i
  if (hi <= lo) return null
  const fromBlock = blocks[lo]
  const toBlock = blocks[hi]
  return toBlock > fromBlock ? { fromBlock, toBlock } : null
}

/** A windowed chart endpoint's payload: one bucket grid, every series on it (api chartWindow.ts). */
export interface WindowPayload { buckets: string[]; series: Record<string, (number | null)[]> }

/**
 * Turn a chart-window endpoint into a loader of whatever the chart draws: `build`
 * maps the payload (the window's buckets, every series on them) into the chart's
 * own refined shape, with the same mapping the page applies to the coarse series
 * — so a refined chart keeps its bands, labels, colours and tooltips. Null when
 * the window came back empty or `build` declines it.
 */
export function payloadRefine<P extends WindowPayload, T>(
  fetchWindow: (fromTs: number, toTs: number, points: number) => Promise<P>,
  build: (payload: P) => T | null,
): (fromTs: number, toTs: number, points: number) => Promise<T | null> {
  return async (fromTs, toTs, points) => {
    if (!(toTs > fromTs)) return null
    const payload = await fetchWindow(fromTs, toTs, points)
    return payload.buckets.length >= 2 ? build(payload) : null
  }
}

/**
 * The common case for StackedAreaChart / MultiLineChart / StackedBarChart: the
 * chart's `bands` (their keys naming the payload's series; `values` ignored)
 * refilled from the window, each value through `value` — the same transform the
 * coarse series took. A band the payload lacks refines the whole grid away.
 */
export function gridRefine<P extends WindowPayload>(
  fetchWindow: (fromTs: number, toTs: number, points: number) => Promise<P>,
  bands: AreaSeries[],
  value: (v: number | null) => number | null = v => v,
): (fromTs: number, toTs: number, points: number) => Promise<RefinedGrid | null> {
  return payloadRefine(fetchWindow, p => {
    if (!bands.every(b => Array.isArray(p.series[b.key]))) return null
    return { buckets: p.buckets, series: bands.map(b => ({ ...b, values: p.series[b.key].map(value) })) }
  })
}
