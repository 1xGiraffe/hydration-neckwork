import { describe, expect, it } from 'vitest'
import { BUCKET_STEPS_SEC, CANONICAL_GRID_STEPS, canonicalGrid, canonicalPlan, chooseBucketStep, FINEST_STEP_SEC, makeBucketing } from '../src/services/bucketLadder.ts'

const H = 3_600
const D = 86_400

describe('chooseBucketStep', () => {
  it('gives a week-long zoom hourly points', () => {
    // The case that motivated the ladder: a ~6.5 day window used to land on
    // 75-minute buckets stamped at 23:32:24.
    expect(chooseBucketStep(0, 6.5 * D, 180)).toBe(H)
  })

  it('never goes finer than an hour, however small the window', () => {
    expect(chooseBucketStep(0, 90 * 60, 180)).toBe(FINEST_STEP_SEC)
    expect(FINEST_STEP_SEC).toBe(H)
  })

  it('keeps a multi-year account history near the point budget, not far under it', () => {
    // 526 days is this repo's reference account. At 180 points the useful step
    // is 3d (175 points); dropping 3d from the ladder would jump to 7d and halve
    // the base view's detail.
    const step = chooseBucketStep(0, 526 * D, 180)
    expect(step).toBe(3 * D)
    expect(Math.ceil((526 * D) / step)).toBeLessThanOrEqual(180)
    expect(Math.ceil((526 * D) / step)).toBeGreaterThan(90)
  })

  it('halves its resolution for the mobile budget', () => {
    expect(chooseBucketStep(0, 30 * D, 180)).toBe(6 * H)
    expect(chooseBucketStep(0, 30 * D, 90)).toBe(12 * H)
  })

  it('keeps a four-year history close to the budget rather than far under it', () => {
    // 7d overflows 180 points over ~1520 days and 14d would yield only 115;
    // the 10d rung keeps 152. A sparse ladder silently throws away resolution.
    const step = chooseBucketStep(0, 1520 * D, 180)
    expect(step).toBe(10 * D)
    expect(Math.ceil((1520 * D) / step)).toBeLessThanOrEqual(180)
    expect(Math.ceil((1520 * D) / step)).toBeGreaterThan(120)
  })

  it('honours a source that cannot go below a day', () => {
    // The HDX dashboard series are daily at source; asking for an hour would
    // claim a resolution the data does not have.
    expect(chooseBucketStep(0, 6.5 * D, 180, D)).toBe(D)
  })

  it('returns the coarsest step rather than refusing an enormous span', () => {
    expect(chooseBucketStep(0, 100 * 365 * D, 10)).toBe(BUCKET_STEPS_SEC[BUCKET_STEPS_SEC.length - 1])
  })

  it('only ever returns a ladder member', () => {
    for (const days of [0.5, 1, 3, 9, 40, 200, 900]) {
      for (const budget of [90, 180]) {
        expect(BUCKET_STEPS_SEC).toContain(chooseBucketStep(0, days * D, budget))
      }
    }
  })
})


// The interval convention is (start, end], not [start, end). A bucket is LABELLED
// by its end instant, so the observation at exactly that instant is the one the
// label promises and has to fall inside it. Getting this backwards made a point
// read one observation stale — caught against raw at 2026-08-26 19:00:00, where
// the API returned the 18:59:36 balance for a point labelled 19:00:00.
describe('makeBucketing interval convention', () => {
  const H = 3_600
  const clock = {
    hours: [0, H, 2 * H, 3 * H, 4 * H],
    heights: [100, 200, 300, 400, 500],
    builtAt: 0,
  }

  it('puts a height exactly on a bucket end INSIDE that bucket', () => {
    const bk = makeBucketing(clock, 0, 4 * H, 100)
    // Bucket 0 ends at 1h, which the clock resolves to height 200.
    expect(bk.endHeight(0)).toBe(200)
    expect(bk.bucketOfHeight(200)).toBe(0)
    // One past it opens the next bucket.
    expect(bk.bucketOfHeight(201)).toBe(1)
  })

  it('dates every bucket by its end, ascending and inside the range', () => {
    const bk = makeBucketing(clock, 0, 4 * H, 100)
    for (let b = 1; b <= bk.N; b++) expect(bk.endSec(b)).toBeGreaterThan(bk.endSec(b - 1))
    expect(bk.endSec(bk.N)).toBe(4 * H)
  })

  // The defect the `ceil - 1` above was chosen to remove, reintroduced by a
  // `Math.max(1, …)` floor: FINEST_STEP_SEC is an hour, so any span at or under
  // one hour gives ceil(span/3600) - 1 = 0, and clamping that to 1 produced two
  // buckets sharing an end instant AND an end height, with bucket 1's start
  // height past its own end. Reachable from the account portfolio chart for any
  // account whose indexed range — or requested window — is under an hour.
  it('puts a span shorter than one step in ONE bucket, not two sharing an end', () => {
    for (const span of [60, 15 * 60, H, H - 1]) {
      const bk = makeBucketing(clock, 0, span, 100)
      expect(bk.N).toBe(0)
      expect(bk.endSec(0)).toBe(span)
      // One bucket, so there is no second end instant to duplicate.
      expect(bk.endHeight(0)).toBe(bk.endHeight(bk.N))
      // Every height in range folds into bucket 0 rather than a phantom one.
      expect(bk.bucketOfHeight(100)).toBe(0)
      expect(bk.bucketOfHeight(500)).toBe(0)
      // The SQL agrees: both clamps close on N = 0.
      expect(bk.ofTs('ts')).toContain(', 0))')
    }
  })

  it('still gives a multi-step span one bucket per step', () => {
    const bk = makeBucketing(clock, 0, 4 * H, 100)
    expect(bk.N).toBe(3)
    const ends = Array.from({ length: bk.N + 1 }, (_, b) => bk.endSec(b))
    expect(new Set(ends).size).toBe(ends.length)
  })

  it('emits SQL that closes on the right, and a carry bucket that floors', () => {
    const bk = makeBucketing(clock, 0, 4 * H, 100)
    // `- 1` before the divide is what closes the interval on the right.
    expect(bk.ofTs('ts')).toContain('- 1,')
    // floor(), because intDiv truncates toward zero and would lose the -1 carry.
    expect(bk.ofTsCarry('ts')).toContain('floor(')
  })
})

describe('canonical grids', () => {
  const H = 3_600
  const T0 = 1_000 * H
  // One block every 6 s from T0, so every instant has an exact height.
  const heightAt = (sec: number) => (sec < T0 ? null : Math.floor((sec - T0) / 6))
  const exact = { key: 'exact', heightAt }
  const stub = { hours: [], heights: [], builtAt: 0 }
  // An account grid as the explorer builds one: lattice-aligned start, range end at the head instant.
  const accountGrid = (fromSec: number, toSec: number) =>
    makeBucketing(stub, fromSec, toSec, heightAt(fromSec) ?? 0, undefined, undefined, { stepSec: H, heightAt: s => (s === toSec ? heightAt(toSec)! : heightAt(s)), dating: exact })

  it('maps every lattice bucket of an account grid onto one shared grid, and two accounts onto the same one', () => {
    const a = accountGrid(T0 + 300 * H + 17, T0 + 400 * H + 1_234)
    const b = accountGrid(T0 + 350 * H, T0 + 400 * H + 1_234)
    const ca = canonicalGrid(a)!
    const cb = canonicalGrid(b)!
    expect(ca.key).toBe(cb.key)
    expect(ca.bk.step).toBe(H)
    expect(ca.bk.N + 1).toBe(CANONICAL_GRID_STEPS)
    expect(ca.bk.endSec(ca.bk.N)).toBe(T0 + 400 * H)
    for (let i = 0; i < a.N; i++) {
      const c = ca.map[i]!
      expect(ca.bk.endSec(c)).toBe(a.endSec(i))
      expect(ca.bk.endHeight(c)).toBe(a.endHeight(i))
    }
    // The last bucket ends at the head instant, no lattice point.
    expect(ca.map[a.N]).toBeNull()
  })

  it('plans the head bucket as a tail after the lattice boundary below it', () => {
    const a = accountGrid(T0 + 300 * H, T0 + 400 * H + 1_234)
    const plan = canonicalPlan(a)!
    expect(plan.tail).toEqual({ b: a.N, prev: plan.grid.map[a.N - 1], fromHeight: heightAt(T0 + 400 * H)! + 1, toHeight: heightAt(T0 + 400 * H + 1_234) })
    // A grid ending on a lattice point has no tail.
    expect(canonicalPlan(accountGrid(T0 + 300 * H, T0 + 400 * H))!.tail).toBeNull()
  })

  it('has no canonical twin without a named dating rule, or when a boundary does not fit it', () => {
    const custom = makeBucketing(stub, T0, T0 + 10 * H, 0, undefined, undefined, { stepSec: H, heightAt })
    expect(canonicalGrid(custom)).toBeNull()
    expect(canonicalPlan(custom)).toBeNull()
    // Wider than the canonical reach: an early bucket does not map, so the caller folds on its own grid.
    expect(canonicalPlan(accountGrid(T0 + 10 * H, T0 + 400 * H + 5))).toBeNull()
    // A boundary dated differently (a moved clock) does not map either.
    const moved = makeBucketing(stub, T0 + 300 * H, T0 + 400 * H, 0, undefined, undefined, { stepSec: H, heightAt: s => heightAt(s)! + (s === T0 + 350 * H ? 1 : 0), dating: exact })
    expect(canonicalGrid(moved)!.map.filter(i => i == null)).toHaveLength(1)
  })

  it('names the chart\'s own dating when a grid has no heightAt', () => {
    const clock = { hours: [T0, T0 + H], heights: [599, 1_199], builtAt: 0 }
    expect(makeBucketing(clock, T0, T0 + 2 * H, 0).dating?.key).toBe('chart')
  })
})
