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

import { heightAtOrBefore, heightsForBoundaries, type BlockClock } from './blockClock.ts'

/**
 * 1970-01-05 00:00 UTC, the first Monday of the epoch. An epoch-anchored 7-day
 * step ends on Thursdays; anchoring it here makes it the calendar week starting
 * Monday UTC (`toMonday`), the week every other weekly surface uses.
 */
export const MONDAY_ANCHOR_SEC = 4 * 86_400

export interface BucketingOptions {
  /**
   * A fixed step instead of the ladder's budget choice: a surface whose caller
   * names its grain (hour/day/week) must get exactly that grain. Whole hours.
   */
  stepSec?: number
  /** The instant the step grid is aligned to (default the epoch). */
  anchorSec?: number
  /**
   * How a boundary instant resolves to a block height (default the chart's
   * heightAtOrBefore via heightsForBoundaries). Null falls back to floorHeight.
   */
  heightAt?: (sec: number) => number | null
  /**
   * The rule `heightAt` applies to an arbitrary instant, named: what lets a
   * canonical grid (canonicalGrid) date its own boundaries the way this grid does.
   * `heightAt` itself may special-case an instant (the explorer pins its range end
   * to the head's height), so it cannot serve for other instants. Without
   * `heightAt` the chart's heightAtOrBefore is implied ('chart'); a grid with a
   * `heightAt` but no `dating` has no canonical twin.
   */
  dating?: BucketDating
}

/** A named instant → height rule (see BucketingOptions.dating). */
export interface BucketDating { key: string; heightAt: (sec: number) => number | null }

export interface Bucketing {
  /** Bucket epoch (unix seconds), aligned to `step` from the anchor (the epoch unless `anchorSec`). */
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
  /** How the boundaries were dated, when that rule is a named one (see BucketingOptions.dating). */
  dating?: BucketDating
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
  opts: BucketingOptions = {},
): Bucketing {
  const step = opts.stepSec ?? chooseBucketStep(fromSec, toSec, budget, minStepSec)
  if (!Number.isInteger(step) || step <= 0 || step % 3_600 !== 0) throw new RangeError(`bucket step must be a whole number of hours: ${step}`)
  const anchor = opts.anchorSec ?? 0
  const t0 = anchor + Math.floor((fromSec - anchor) / step) * step
  // ceil - 1, not floor: buckets are (start, end], so covering the range takes
  // ceil(span / step) of them. floor() produced one bucket too many whenever the
  // span divided exactly, and its last two shared an end instant — a duplicate
  // final point on every such series. The clamp floors at 0, not 1: a span
  // shorter than one step fits in a SINGLE bucket, and forcing a second one back
  // recreates that duplicate end instant (and a bucket whose start height sits
  // past its end). N = 0 is a valid bucketing — one bucket, index 0.
  const N = Math.max(0, Math.ceil((toSec - t0) / step) - 1)
  const endSec = (b: number) => Math.min(t0 + (b + 1) * step, toSec)
  const ends = Array.from({ length: N + 1 }, (_, b) => endSec(b))
  const heightAt = opts.heightAt
  const dating: BucketDating | undefined = opts.dating ?? (heightAt ? undefined : { key: 'chart', heightAt: sec => heightAtOrBefore(clock, sec) })
  const endHeights = heightAt ? ends.map(t => heightAt(t) ?? floorHeight) : heightsForBoundaries(clock, ends, floorHeight)
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
    ...(dating ? { dating } : {}),
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

// ─── Canonical grids ──────────────────────────────────────────────────────────
//
// A global (not per-account) fold over a bucket grid — the reserve indices, the
// incentive programme indices — is the same for every account whose grid shares
// its boundaries. Two account grids on one step share every boundary but their
// first and last: t0 is the step lattice point at or below the account's start,
// and the range ends at the head instant, which is no lattice point. So the fold
// runs once on a CANONICAL grid — the step lattice's newest CANONICAL_GRID_STEPS
// boundaries up to the account grid's last lattice point, dated by the same rule —
// and an account's bucket takes the canonical bucket ending at the same instant
// AND height. A budget-180 ladder grid always fits inside it; anything that does
// not map (a longer custom window, a clock that has moved) falls back to its own
// per-grid fold, so the canonical path is an optimisation with an exact fallback.

/** How many lattice steps back from its last boundary a canonical grid reaches. */
export const CANONICAL_GRID_STEPS = 200

const STUB_CLOCK: BlockClock = { hours: [], heights: [], builtAt: 0 }

export interface CanonicalGrid {
  /** Cache-key fragment naming the grid: step, lattice phase, dating rule, last boundary, reach. */
  key: string
  bk: Bucketing
  /** Per bucket of the source grid: the canonical bucket ending at the same instant and height, or null. */
  map: (number | null)[]
}

/** The canonical grid a bucketing's buckets can be looked up on; null when its dating rule is not a named one. */
export function canonicalGrid(bk: Bucketing, steps: number = CANONICAL_GRID_STEPS): CanonicalGrid | null {
  const dating = bk.dating
  if (!dating || steps < 1) return null
  const step = bk.step
  const phase = ((bk.t0 % step) + step) % step
  const last = bk.t0 + Math.floor((bk.endSec(bk.N) - bk.t0) / step) * step
  if (last <= bk.t0 - step * steps) return null
  const from = last - steps * step
  // Bucket 0 opens at the first block after its start instant (buckets are (start, end]).
  const floor = (dating.heightAt(from) ?? 0) + 1
  const cb = makeBucketing(STUB_CLOCK, from, last, floor, undefined, undefined, { stepSec: step, anchorSec: phase, heightAt: dating.heightAt, dating })
  const map: (number | null)[] = new Array(bk.N + 1).fill(null)
  for (let b = 0; b <= bk.N; b++) {
    const t = bk.endSec(b)
    if (t <= from || t > last || (t - from) % step !== 0) continue
    const i = (t - from) / step - 1
    if (cb.endHeight(i) === bk.endHeight(b)) map[b] = i
  }
  return { key: `${step}:${phase}:${dating.key}:${last}:${steps}`, bk: cb, map }
}

/**
 * How a bucketing reads a canonical fold: every bucket mapped, or every bucket
 * but the last — the range end at the head, which is no lattice point — whose
 * state is then the canonical state at the lattice boundary below it plus the
 * rows in (that boundary's height, its own end height]. Null when any other
 * bucket does not map: the caller folds on its own grid instead.
 */
export interface CanonicalPlan {
  grid: CanonicalGrid
  tail: { b: number; prev: number; fromHeight: number; toHeight: number } | null
}

export function canonicalPlan(bk: Bucketing, steps: number = CANONICAL_GRID_STEPS): CanonicalPlan | null {
  const grid = canonicalGrid(bk, steps)
  if (!grid) return null
  for (let b = 0; b < bk.N; b++) if (grid.map[b] == null) return null
  if (grid.map[bk.N] != null) return { grid, tail: null }
  const end = bk.endSec(bk.N)
  const lattice = grid.bk.t0 + Math.floor((end - grid.bk.t0) / bk.step) * bk.step
  const prev = (lattice - grid.bk.t0) / bk.step - 1
  if (prev < 0 || prev > grid.bk.N) return null
  // The boundary below must be the previous bucket's own end where there is one.
  if (bk.N > 0 && grid.map[bk.N - 1] !== prev) return null
  const fromHeight = grid.bk.endHeight(prev) + 1
  const toHeight = bk.endHeight(bk.N)
  if (toHeight < fromHeight - 1) return null
  return { grid, tail: { b: bk.N, prev, fromHeight, toHeight } }
}
