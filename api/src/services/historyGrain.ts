import { chooseBucketStep, FINEST_STEP_SEC } from './bucketLadder.ts'

// The bucket grain a pool/liquidity history is built on.
//
// These series were always daily: the source state-history tables sit on a
// 600-block grid (~20 minutes at 2s blocks), and the builders collapsed that to
// `toDate(block_timestamp)`. That is the right default for a multi-year chart,
// but it means zooming reveals nothing — the finest thing the response can
// express is a day, however narrow the window.
//
// A grain carries the step, the SQL that keys a row to its bucket, and the grid
// those keys land on, so one builder serves both the full daily view and a
// windowed hourly one.

const DAY = 86_400

export interface HistoryGrain {
  stepSec: number
  /** True when buckets are whole days and keys are `YYYY-MM-DD`. */
  daily: boolean
  /** SQL expression keying a row to its bucket, matching `keyOf`. */
  keySql(tsExpr: string): string
  /** The bucket key for an instant. */
  keyOf(sec: number): string
  /** Every bucket key from `fromSec` to `toSec` inclusive. */
  grid(fromSec: number, toSec: number): string[]
}

const pad = (n: number) => String(n).padStart(2, '0')

function keyFor(sec: number, step: number, daily: boolean): string {
  const t = Math.floor(sec / step) * step
  const d = new Date(t * 1000)
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  return daily ? date : `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

/**
 * `windowFromSec` folds every earlier row into the first bucket — the carry-in,
 * so a window opening mid-history starts at the value that was already standing
 * rather than at null.
 */
export function makeGrain(stepSec: number, windowFromSec?: number): HistoryGrain {
  const daily = stepSec % DAY === 0
  const unit = daily ? `${stepSec / DAY} DAY` : `${stepSec / 3_600} HOUR`
  const clampedTs = (tsExpr: string) =>
    windowFromSec == null ? tsExpr : `greatest(${tsExpr}, toDateTime(${windowFromSec}))`
  return {
    stepSec,
    daily,
    // toDate() around the day case on purpose: toStartOfInterval returns a
    // DateTime, so a day bucket would stringify as `2023-01-06 00:00:00` while
    // the grid and every existing consumer key on the bare `2023-01-06`. The
    // mismatch is silent — every lookup misses and the series reads all-null.
    keySql: tsExpr => daily
      ? `toString(toDate(toStartOfInterval(${clampedTs(tsExpr)}, INTERVAL ${unit})))`
      : `toString(toStartOfInterval(${clampedTs(tsExpr)}, INTERVAL ${unit}))`,
    keyOf: sec => keyFor(sec, stepSec, daily),
    grid: (fromSec, toSec) => {
      const out: string[] = []
      const start = Math.floor(fromSec / stepSec) * stepSec
      for (let t = start; t <= toSec; t += stepSec) out.push(keyFor(t, stepSec, daily))
      return out
    },
  }
}

/** The daily grain these histories have always used. */
export const DAILY_GRAIN = makeGrain(DAY)

/**
 * The grain for a requested window: the finest ladder step that fits the point
 * budget, never below an hour. Unwindowed callers keep the daily grain, so the
 * full-history response is byte-for-byte what it was.
 */
export function grainForWindow(fromSec: number, toSec: number, points: number): HistoryGrain {
  return makeGrain(chooseBucketStep(fromSec, toSec, points, FINEST_STEP_SEC), fromSec)
}

/** Seconds for a bucket key, whichever grain produced it. */
export function keySeconds(key: string): number {
  return Date.parse(key.includes(' ') ? `${key.replace(' ', 'T')}Z` : `${key}T00:00:00Z`) / 1000
}
