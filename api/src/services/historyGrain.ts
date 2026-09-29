import { chooseBucketStep, FINEST_STEP_SEC, MONDAY_ANCHOR_SEC } from './bucketLadder.ts'

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
  /** True for calendar months (MONTHLY_GRAIN and its carry-in twin): not a fixed step, so `stepSec` is nominal. */
  monthly: boolean
  /** SQL expression keying a row to its bucket, matching `keyOf`. */
  keySql(tsExpr: string): string
  /** The bucket key for an instant. */
  keyOf(sec: number): string
  /** Every bucket key from `fromSec` to `toSec` inclusive. */
  grid(fromSec: number, toSec: number): string[]
  /**
   * The same grain with every row before `fromSec` keyed onto the bucket holding
   * `fromSec` — the carry-in a grid needs so a running total opens at the value
   * already standing. `keyOf` and `grid` are unchanged: only `keySql` folds.
   */
  carryIn(fromSec: number): HistoryGrain
}

const pad = (n: number) => String(n).padStart(2, '0')

function keyFor(sec: number, step: number, daily: boolean, anchor = 0): string {
  const t = anchor + Math.floor((sec - anchor) / step) * step
  const d = new Date(t * 1000)
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  return daily ? date : `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

/**
 * `windowFromSec` folds every earlier row into the first bucket — the carry-in,
 * so a window opening mid-history starts at the value that was already standing
 * rather than at null.
 *
 * `anchorSec` aligns the step lattice to an instant other than the epoch — a
 * 7-day step from the epoch ends on Thursdays, one from MONDAY_ANCHOR_SEC is the
 * calendar week `toStartOfWeek(ts, 1)` keys. Without it the lattice (and the SQL)
 * is exactly the epoch-anchored one every existing caller keys on.
 */
export function makeGrain(stepSec: number, windowFromSec?: number, anchorSec?: number): HistoryGrain {
  const daily = stepSec % DAY === 0
  const unit = daily ? `${stepSec / DAY} DAY` : `${stepSec / 3_600} HOUR`
  const anchor = anchorSec ?? 0
  const clampedTs = (tsExpr: string) =>
    windowFromSec == null ? tsExpr : `greatest(${tsExpr}, toDateTime(${windowFromSec}))`
  const startSql = (tsExpr: string) => anchorSec == null
    ? `toStartOfInterval(${clampedTs(tsExpr)}, INTERVAL ${unit})`
    : `toDateTime(${anchor} + intDiv(toInt64(toUnixTimestamp(${clampedTs(tsExpr)})) - ${anchor}, ${stepSec}) * ${stepSec})`
  return {
    stepSec,
    daily,
    monthly: false,
    // toDate() around the day case on purpose: toStartOfInterval returns a
    // DateTime, so a day bucket would stringify as `2023-01-06 00:00:00` while
    // the grid and every existing consumer key on the bare `2023-01-06`. The
    // mismatch is silent — every lookup misses and the series reads all-null.
    keySql: tsExpr => daily ? `toString(toDate(${startSql(tsExpr)}))` : `toString(${startSql(tsExpr)})`,
    keyOf: sec => keyFor(sec, stepSec, daily, anchor),
    grid: (fromSec, toSec) => {
      const out: string[] = []
      const start = anchor + Math.floor((fromSec - anchor) / stepSec) * stepSec
      for (let t = start; t <= toSec; t += stepSec) out.push(keyFor(t, stepSec, daily, anchor))
      return out
    },
    carryIn: fromSec => makeGrain(stepSec, fromSec, anchorSec),
  }
}

/** The daily grain these histories have always used. */
export const DAILY_GRAIN = makeGrain(DAY)

/** Calendar weeks starting Monday UTC — the key `toStartOfWeek(ts, 1)` produces. */
export const WEEKLY_MONDAY_GRAIN = makeGrain(7 * DAY, undefined, MONDAY_ANCHOR_SEC)

const monthStartSec = (sec: number): number => {
  const d = new Date(sec * 1000)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000
}
const nextMonthSec = (sec: number): number => {
  const d = new Date(monthStartSec(sec) * 1000)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000
}

/**
 * Calendar months, keyed `YYYY-MM-01` like `toStartOfMonth`. Not a fixed step, so
 * `stepSec` is nominal (30 days) and a month's end is `grainBucketEndSec`'s to
 * state; no ladder rung is monthly, so no window resolves to it.
 */
function monthlyGrain(windowFromSec?: number): HistoryGrain {
  const clampedTs = (tsExpr: string) =>
    windowFromSec == null ? tsExpr : `greatest(${tsExpr}, toDateTime(${windowFromSec}))`
  return {
    stepSec: 30 * DAY,
    daily: true,
    monthly: true,
    keySql: tsExpr => `toString(toStartOfMonth(${clampedTs(tsExpr)}))`,
    keyOf: sec => new Date(monthStartSec(sec) * 1000).toISOString().slice(0, 10),
    grid: (fromSec, toSec) => {
      const out: string[] = []
      for (let t = monthStartSec(fromSec); t <= toSec; t = nextMonthSec(t)) out.push(new Date(t * 1000).toISOString().slice(0, 10))
      return out
    },
    carryIn: fromSec => monthlyGrain(fromSec),
  }
}
export const MONTHLY_GRAIN: HistoryGrain = monthlyGrain()

/** The exclusive end of the bucket a key opens, on the grain that produced it. */
export function grainBucketEndSec(grain: HistoryGrain, key: string): number {
  const start = keySeconds(key)
  return grain.monthly ? nextMonthSec(start) : start + grain.stepSec
}

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
