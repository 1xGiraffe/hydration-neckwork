import type { IChartApi, ISeriesApi, Logical, SeriesType, UTCTimestamp } from 'lightweight-charts'

/**
 * Bar-time metadata for mapping anchor times that don't fall on this
 * interval's bar grid (drawn on another interval, or in the whitespace
 * beyond the data). `times` are the loaded bars' times, ascending.
 */
export interface BarMeta {
  times: readonly number[]
  firstTime: number
  lastTime: number
  lastIndex: number
  intervalSec: number
}

/**
 * Minimal time-scale surface the pure helpers need. The real adapter wraps
 * `chart.timeScale()`; tests inject a fake built from a bar-times array.
 * IMPORTANT: `logicalToCoordinate` must only ever be called with INTEGER
 * logicals — lightweight-charts' indexToCoordinate returns 0 (the left edge)
 * for fractional input, which rendered cross-interval drawings as chart-wide
 * phantom lines. Fractional positions are linearly interpolated between two
 * integer coordinates instead (the underlying mapping is linear in index).
 */
export interface CoordScale {
  coordinateToTime(x: number): number | null
  coordinateToLogical(x: number): number | null
  timeToCoordinate(time: number): number | null
  logicalToCoordinate(logical: number): number | null
}

export function barMetaFromTimes(barTimes: readonly number[]): BarMeta | null {
  if (barTimes.length < 2) return null
  const lastIndex = barTimes.length - 1
  const intervalSec = barTimes[lastIndex] - barTimes[lastIndex - 1]
  if (!(intervalSec > 0)) return null
  return { times: barTimes, firstTime: barTimes[0], lastTime: barTimes[lastIndex], lastIndex, intervalSec }
}

/**
 * Time → fractional logical index over the actual bar grid: binary search for
 * the surrounding bars and interpolate within their (possibly gapped) span;
 * beyond either edge, extrapolate with the regular interval spacing.
 */
export function fractionalLogicalForTime(time: number, meta: BarMeta): number {
  if (time <= meta.firstTime) return (time - meta.firstTime) / meta.intervalSec
  if (time >= meta.lastTime) return meta.lastIndex + (time - meta.lastTime) / meta.intervalSec
  const times = meta.times
  let lo = 0
  let hi = meta.lastIndex
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (times[mid] <= time) lo = mid
    else hi = mid
  }
  const span = times[hi] - times[lo]
  return span > 0 ? lo + (time - times[lo]) / span : lo
}

/** Fractional logical → pane x via two integer-logical coordinates. */
export function logicalToX(logical: number, scale: CoordScale): number | null {
  if (Number.isInteger(logical)) return scale.logicalToCoordinate(logical)
  const base = Math.floor(logical)
  const x0 = scale.logicalToCoordinate(base)
  const x1 = scale.logicalToCoordinate(base + 1)
  if (x0 == null || x1 == null) return null
  return x0 + (logical - base) * (x1 - x0)
}

/**
 * Pane x → unix seconds. Inside the data range this is the bar time; beyond
 * either edge the time is extrapolated from the logical index using the last
 * bar spacing, so drawing/measuring works in the whitespace around the data.
 * Returns null when extrapolation is impossible (fewer than 2 bars).
 */
export function xToTime(x: number, scale: CoordScale, meta: BarMeta | null): number | null {
  const barTime = scale.coordinateToTime(x)
  if (barTime != null) return barTime
  if (!meta) return null
  const logical = scale.coordinateToLogical(x)
  if (logical == null) return null
  if (logical > meta.lastIndex) return meta.lastTime + (logical - meta.lastIndex) * meta.intervalSec
  if (logical < 0) return meta.firstTime + logical * meta.intervalSec
  return null
}

/**
 * Unix seconds → pane x. Exact bar times map directly; every other time —
 * between bars (drawn on a finer interval) or beyond the data edges — maps
 * through a fractional logical index with linear interpolation, so drawings
 * keep their true time positions across interval switches.
 */
export function timeToX(time: number, scale: CoordScale, meta: BarMeta | null): number | null {
  const direct = scale.timeToCoordinate(time)
  if (direct != null) return direct
  if (!meta) return null
  return logicalToX(fractionalLogicalForTime(time, meta), scale)
}

/** Adapter over the live chart; keeps the branded-type casts in one place. */
export function makeChartScale(chart: IChartApi): CoordScale {
  const ts = chart.timeScale()
  return {
    coordinateToTime: x => {
      const time = ts.coordinateToTime(x)
      return typeof time === 'number' ? time : null
    },
    coordinateToLogical: x => ts.coordinateToLogical(x),
    timeToCoordinate: time => ts.timeToCoordinate(time as UTCTimestamp),
    logicalToCoordinate: logical => ts.logicalToCoordinate(logical as Logical),
  }
}

/** Bar meta from the series' current data (whitespace items still carry time). */
export function barMetaFromSeries(series: ISeriesApi<SeriesType>): BarMeta | null {
  const data = series.data()
  const len = data.length
  if (len < 2) return null
  const times: number[] = new Array(len)
  for (let i = 0; i < len; i++) {
    const t = data[i].time
    if (typeof t !== 'number') return null
    times[i] = t
  }
  return barMetaFromTimes(times)
}
