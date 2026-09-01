// Wall-clock bucket steps for every zoomable history series.
//
// History used to be bucketed by BLOCK count — `(maxb - minb) / 180` — so a
// bucket's duration was whatever 1/180th of the range happened to be in wall
// time. Block time went 12s -> 6s -> 2s over the chain's life, so a single
// series carried 2.6-day points early and 0.95-day points at the head, a zoomed
// window landed on sizes like 75 minutes, and points were stamped at instants
// like 23:32:24. Worse, unequal wall time per bucket is what forced the charts
// to place points by TIME while the zoom window addressed them by INDEX; every
// conversion between the two was a chance to be wrong, and twice it was.
//
// A step from this ladder is a round unit a person can name, identical in
// duration across the whole series, so index and time finally mean the same
// thing.

// The rungs are deliberately close at the long end: a step is chosen only if its
// bucket count FITS the budget, so a sparse ladder wastes it. Over a four-year
// treasury history, 7d overflows 180 points and 14d yields only 115 — the 10d
// rung recovers that to 152 while staying a round unit.
/** Steps in seconds, finest first. */
export const BUCKET_STEPS_SEC = [
  3_600, // 1h — the floor, see below
  3 * 3_600,
  6 * 3_600,
  12 * 3_600,
  86_400, // 1d
  2 * 86_400,
  3 * 86_400,
  5 * 86_400,
  7 * 86_400,
  10 * 86_400,
  14 * 86_400,
  21 * 86_400,
  30 * 86_400,
  45 * 86_400,
  60 * 86_400,
  90 * 86_400,
  180 * 86_400,
] as const

/**
 * One hour is the floor deliberately. It is the finest granularity the
 * compacted sources can express (`account_balance_hourly`, `pool_swap_hourly`),
 * so every pipeline can reach it and none can be asked for a resolution it
 * cannot serve. Charts whose source is coarser than this raise their own floor
 * via `minStepSec`; they never claim a resolution their data lacks.
 */
export const FINEST_STEP_SEC: number = BUCKET_STEPS_SEC[0]

/**
 * The finest ladder step whose bucket count over [fromSec, toSec] fits `budget`
 * points, never finer than `minStepSec`. Falls back to the coarsest step when
 * even that overflows the budget — a span that long is better shown coarse than
 * refused.
 */
export function chooseBucketStep(fromSec: number, toSec: number, budget: number, minStepSec: number = FINEST_STEP_SEC): number {
  const span = Math.max(0, toSec - fromSec)
  const cap = Math.max(1, Math.floor(budget))
  for (const step of BUCKET_STEPS_SEC) {
    if (step < minStepSec) continue
    if (span / step <= cap) return step
  }
  return BUCKET_STEPS_SEC[BUCKET_STEPS_SEC.length - 1]
}

// ─── The bucketing a reconstruction runs on ───────────────────────────────────

import { heightsForBoundaries, type BlockClock } from './blockClock.ts'

export interface Bucketing {
  /** Bucket epoch (unix seconds), aligned to `step`. */
  t0: number
  /** Bucket duration in seconds — always a ladder member. */
  step: number
  /** Index of the last bucket; buckets run 0..N. */
  N: number
  /** The instant a bucket is dated by: its END. */
  endSec(b: number): number
  /** Greatest block height at or before `endSec(b)`. */
  endHeight(b: number): number
  /** SQL bucket index from a DateTime column; rows before the range fold into 0. */
  ofTs(tsExpr: string): string
  /** SQL bucket index that keeps a pre-range row in the -1 CARRY bucket instead. */
  ofTsCarry(tsExpr: string): string
  /** SQL bucket index for a source that carries no timestamp at all. */
  ofHeight(heightExpr: string): string
  /** Same, keeping a pre-range height in the -1 CARRY bucket. */
  ofHeightCarry(heightExpr: string): string
  /** The lowest height this bucketing covers; bucket 0 opens here. */
  floorHeight: number
  /** The bucket a block height falls in, in TS. */
  bucketOfHeight(height: number): number
}

/**
 * Build the bucketing for a wall-clock range. `floorHeight` is the height a
 * boundary older than the chain's first block resolves to, so a window opening
 * before the entity existed still has a lower bound to carry in from.
 */
export function makeBucketing(
  clock: BlockClock,
  fromSec: number,
  toSec: number,
  floorHeight: number,
  budget = 180,
  minStepSec: number = FINEST_STEP_SEC,
): Bucketing {
  const step = chooseBucketStep(fromSec, toSec, budget, minStepSec)
  const t0 = Math.floor(fromSec / step) * step
  // ceil - 1, not floor: buckets are (start, end], so covering the range takes
  // ceil(span / step) of them. floor() produced one bucket too many whenever the
  // span divided exactly, and its last two shared an end instant — a duplicate
  // final point on every such series.
  const N = Math.max(1, Math.ceil((toSec - t0) / step) - 1)
  const endSec = (b: number) => Math.min(t0 + (b + 1) * step, toSec)
  const endHeights = heightsForBoundaries(clock, Array.from({ length: N + 1 }, (_, b) => endSec(b)), floorHeight)
  // The first height IN each bucket, so a height landing exactly on a bucket-end
  // resolves to that bucket rather than the next — the (start, end] rule above.
  const startHeights = [floorHeight, ...endHeights.slice(0, N).map(h => h + 1)]
  const clamp = (b: number) => Math.max(0, Math.min(N, b))
  return {
    t0,
    step,
    N,
    endSec,
    endHeight: b => endHeights[clamp(b)],
    // Buckets are (start, end], NOT [start, end): a bucket is LABELLED by its end,
    // so the observation at exactly that instant is the one the label promises and
    // must fall inside it. Half-open the other way silently dropped the boundary
    // observation into the next bucket, which reads as the point being stale.
    ofTs: tsExpr => `toUInt32(least(greatest(intDiv(toInt64(toUnixTimestamp(${tsExpr})) - ${t0} - 1, ${step}), 0), ${N}))`,
    // floor(), not intDiv(): intDiv truncates toward zero, so a row up to one step
    // before the range would land in bucket 0 instead of the -1 carry.
    ofTsCarry: tsExpr => `toInt32(greatest(-1, least(${N}, toInt64(floor((toInt64(toUnixTimestamp(${tsExpr})) - ${t0} - 1) / ${step})))))`,
    floorHeight,
    // Height-keyed sources resolve through the same boundaries, so they agree
    // with the timestamped ones bucket for bucket. roundDown lands on the
    // bucket's start height; indexOf turns that into its index.
    ofHeight: heightExpr =>
      `toUInt32(indexOf([${startHeights.join(',')}], roundDown(greatest(${heightExpr}, ${floorHeight}), [${startHeights.join(',')}])) - 1)`,
    ofHeightCarry: heightExpr =>
      `toInt32(if(${heightExpr} < ${floorHeight}, -1, indexOf([${startHeights.join(',')}], roundDown(${heightExpr}, [${startHeights.join(',')}])) - 1))`,
    bucketOfHeight: height => {
      if (height <= startHeights[0]) return 0
      let lo = 0
      let hi = N
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (startHeights[mid] <= height) lo = mid
        else hi = mid - 1
      }
      return lo
    },
  }
}
