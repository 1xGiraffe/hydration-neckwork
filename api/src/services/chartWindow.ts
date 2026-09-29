import type { ClickHouseClient } from '../db/client.ts'
import { blockClock, heightAtOrBefore, heightAtOrBeforeExact, type BlockClock } from './blockClock.ts'
import { chooseBucketStep, FINEST_STEP_SEC, MONDAY_ANCHOR_SEC } from './bucketLadder.ts'
import { cachedSwr } from './cache.ts'
import { grainBucketEndSec, keySeconds, makeGrain, type HistoryGrain } from './historyGrain.ts'
import { BUCKET_HISTORY_CLOSED_TTL_MS, BUCKET_HISTORY_FINALITY_SEC, BUCKET_HISTORY_SETTLING_TTL_MS, bucketWindowIsClosed } from './lpHistory.ts'

// Chart-zoom windows for the dashboard trend charts (/hollar, /hdx): the grid a
// zoomed window is rebuilt on, and the bounds its queries run under.
//
// A dashboard series is built by ONE builder per metric over a ChartGrid. The
// full dashboard hands it the whole-history grid (weekly, monthly, daily); a zoom
// hands it the window's grid on the finest ladder step that fits the point budget
// (never below an hour). So a refined series is the coarse series' own definition
// at a finer grain, and the two agree wherever their bucket ends coincide.
//
// Bucket semantics, on every grain: a key names its bucket's START, and a state
// series (a balance, a running total, a pool reserve) carries the state at the
// bucket's END — rows are keyed by `grain.keySql`, so a row at exactly a bucket
// boundary opens the next bucket. A flow series (volume, trades) is the bucket's
// own sum. Every grid's grain folds the rows before bucket 0 into it (the
// grain's carry-in), so a state series opens at the value already standing
// rather than at zero, from one aggregation of the earlier rows — on a zoom
// window, and on a dashboard grid too: a running total whose rows predate the
// grid's first bucket (a lock placed before a series' start) would otherwise sit
// on off-grid keys and leave a quiet leading bucket null.

export interface ChartGrid {
  grain: HistoryGrain
  /** Bucket keys, ascending — the response's `buckets`. */
  keys: string[]
  /** Start of bucket 0; the grain folds earlier rows into it. */
  fromSec: number
  /** Exclusive end of the last bucket: no row at or after it is read. */
  endSec: number
  /**
   * Conservative block bounds: every block timestamped in [fromSec, endSec) has a
   * height in [fromHeight, toHeight]. For tables whose sort key leads with the
   * block height they prune by primary key; the timestamp predicate stays exact.
   */
  fromHeight: number
  toHeight: number
}

export const MAX_HEIGHT = 0xffff_ffff
const WEEK_SEC = 7 * 86_400

/**
 * The whole-history grid a dashboard's coarse series is built on: no block
 * bounds, and the rows before its first bucket fold into it (`grain.carryIn`).
 */
export function fullChartGrid(grain: HistoryGrain, keys: string[]): ChartGrid {
  if (!keys.length) throw new RangeError('a chart grid needs at least one bucket')
  const fromSec = keySeconds(keys[0])
  return {
    grain: grain.carryIn(fromSec),
    keys,
    fromSec,
    endSec: grainBucketEndSec(grain, keys[keys.length - 1]),
    fromHeight: 0,
    toHeight: MAX_HEIGHT,
  }
}

export interface ChartWindowRequest { fromSec: number; toSec: number; points: number }

export interface ChartWindowOptions {
  /** The series' first instant: the window is clamped to it. */
  startSec: number
  /** The finest ladder step the window may resolve to (default an hour). */
  minStepSec?: number
  /**
   * A fixed step instead of the ladder's budget choice, in whole hours — how a
   * coarsened window is re-resolved (`serveChartWindow`'s `coarsen`): the step
   * need not be a ladder rung, so a source that states only whole weeks can be
   * read on five of them when the budget asked for a 30-day rung.
   */
  stepSec?: number
}

export interface ResolvedChartWindow {
  grid: ChartGrid
  headSec: number
  /** Cache lifetime under the bucketed-history finality rule. */
  ttlMs: number
}

/**
 * The grid a zoom window is rebuilt on. The window is clamped to the series'
 * start (`startSec`, its first bucket) and to the INDEXED head — the chain clock's
 * newest block, not the wall clock — so no bucket past the head is emitted. The
 * last bucket is the one holding the window's end, and like the dashboard's own
 * last bucket it may still be open. Null when nothing of the window is indexed.
 */
export function chartWindowGrid(clock: BlockClock, req: ChartWindowRequest, opts: ChartWindowOptions): ResolvedChartWindow | null {
  if (opts.stepSec != null && (!Number.isInteger(opts.stepSec) || opts.stepSec <= 0 || opts.stepSec % 3_600 !== 0)) {
    throw new RangeError(`a chart window's fixed step must be a whole number of hours: ${opts.stepSec}`)
  }
  const headSec = clock.lastTime ?? (clock.hours.length ? clock.hours[clock.hours.length - 1] + 3_599 : Number.NaN)
  if (!Number.isFinite(headSec)) return null
  const from = Math.max(req.fromSec, opts.startSec)
  const to = Math.min(req.toSec, headSec)
  if (!(to > from)) return null
  const step = opts.stepSec ?? chooseBucketStep(from, to, req.points, Math.max(FINEST_STEP_SEC, opts.minStepSec ?? FINEST_STEP_SEC))
  // A step of a week or more is laid on Monday weeks (MONDAY_ANCHOR_SEC), the
  // lattice the dashboards' own weekly series use: epoch-anchored, a 7-day step
  // would end its buckets on Thursdays and share no instant with a weekly chart.
  const anchor = step >= WEEK_SEC && step % 86_400 === 0 ? MONDAY_ANCHOR_SEC : 0
  const start = anchor + Math.floor((from - anchor) / step) * step
  const grain = makeGrain(step, start, anchor ? anchor : undefined)
  const keys = grain.grid(start, to)
  const endSec = keySeconds(keys[keys.length - 1]) + step
  // The at-or-before height of the first instant is at or below every block in
  // the window. heightAtOrBefore resolves an hour mark to the LAST block of the
  // hour starting there, so at endSec (a mark) it is at or above every block
  // before endSec — but only once the clock has seen a block at or past endSec;
  // before that the newest hour is still filling and the bound is lifted.
  const fromHeight = heightAtOrBeforeExact(clock, start) ?? 0
  const toHeight = (clock.lastTime ?? 0) >= endSec ? (heightAtOrBefore(clock, endSec) ?? MAX_HEIGHT) : MAX_HEIGHT
  const closed = bucketWindowIsClosed(endSec, headSec, BUCKET_HISTORY_FINALITY_SEC)
  return {
    grid: { grain, keys, fromSec: start, endSec, fromHeight, toHeight },
    headSec,
    ttlMs: closed ? BUCKET_HISTORY_CLOSED_TTL_MS : BUCKET_HISTORY_SETTLING_TTL_MS,
  }
}

export interface ChartWindowResponse {
  /** The ladder step the window resolved to, in seconds. */
  stepSec: number
  buckets: string[]
  series: Record<string, (number | null)[]>
}

/**
 * Serve one chart's zoom window. Keyed by the resolved grid (step and bucket
 * range), never the head: a window that can still gain rows is the settling
 * case of the finality rule (60 s), one the head is an hour past is closed (600 s).
 * Two requests resolving to the same grid share one entry.
 */
export async function serveChartWindow(
  client: ClickHouseClient,
  namespace: string,
  chart: string,
  req: ChartWindowRequest,
  opts: ChartWindowOptions & {
    /**
     * A chart whose cost depends on more than its bucket count (the rows its
     * source holds over the window) can name the coarser step a resolved grid
     * must be rebuilt on; the window is then re-resolved on exactly that step
     * (`stepSec`, so a step the ladder lacks is honoured, and the budget — which
     * `chooseBucketStep` would re-apply — cannot pull it back onto a rung the
     * chart's source cannot state). Null keeps the grid.
     */
    coarsen?: (grid: ChartGrid) => Promise<number | null>
  },
  build: (grid: ChartGrid) => Promise<Record<string, (number | null)[]>>,
): Promise<ChartWindowResponse> {
  const clock = await blockClock(client)
  let resolved = chartWindowGrid(clock, req, opts)
  if (!resolved) return { stepSec: 0, buckets: [], series: {} }
  const coarser = opts.coarsen ? await opts.coarsen(resolved.grid) : null
  if (coarser != null && coarser > resolved.grid.grain.stepSec) {
    resolved = chartWindowGrid(clock, req, { ...opts, stepSec: coarser }) ?? resolved
  }
  const { grid, ttlMs } = resolved
  const key = `explorer:${namespace}:window:${chart}:${grid.grain.stepSec}:${grid.fromSec}:${grid.endSec}`
  return cachedSwr(key, ttlMs, ttlMs, async () => ({ stepSec: grid.grain.stepSec, buckets: grid.keys, series: await build(grid) }))
}

// Aligning query rows onto a grid.

/** Values by key onto the grid, null where no row landed. */
export function alignToGrid(keys: string[], rows: { k: string; v: number }[]): (number | null)[] {
  const byKey = new Map(rows.map(r => [r.k, r.v]))
  return keys.map(k => byKey.get(k) ?? null)
}

/** Forward-fill a state series: a bucket without a row keeps the standing value. Leading nulls stay null. */
export function carryForwardValues<T>(values: (T | null)[]): (T | null)[] {
  let prev: T | null = null
  return values.map(v => (v != null ? (prev = v) : prev))
}

/**
 * Per-entity state on a grid, carried forward, then summed per bucket — for a
 * state kept per pool/facilitator/reserve where a quiet entity emits no row in a
 * bucket but its state still stands. Integer throughout; null until any entity
 * has a state.
 */
export function sumCarriedStates(keys: string[], rows: { entity: string; k: string; raw: bigint }[]): (bigint | null)[] {
  const index = new Map(keys.map((k, i) => [k, i]))
  const byEntity = new Map<string, (bigint | null)[]>()
  for (const r of rows) {
    const i = index.get(r.k)
    if (i == null) continue
    let arr = byEntity.get(r.entity)
    if (!arr) { arr = new Array<bigint | null>(keys.length).fill(null); byEntity.set(r.entity, arr) }
    arr[i] = r.raw
  }
  const out: (bigint | null)[] = new Array(keys.length).fill(null)
  for (const arr of byEntity.values()) {
    carryForwardValues(arr).forEach((v, i) => { if (v != null) out[i] = (out[i] ?? 0n) + v })
  }
  return out
}
