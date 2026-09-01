import type { Bucketing } from '../../src/services/bucketLadder.ts'

/**
 * A Bucketing whose bucket-end heights are exactly the ones the block-count
 * scheme produced for (minb, bucketSize, n) — `minb + (b+1)·bucketSize - 1`,
 * with the tail clamped to maxb.
 *
 * Built explicitly rather than through `makeBucketing`, because the real
 * bucketing resolves boundaries through an HOURLY chain clock: two bucket ends
 * inside the same hour collapse to one height there, which these fixtures'
 * ten-block buckets would do constantly. The principal-history tests are about
 * what the loaders do with bucket-end heights, not about how those heights are
 * resolved — `blockClock.test.ts` and `bucketLadder.test.ts` cover that.
 */
export function testBucketing(minb: number, bucketSize: number, n: number): Bucketing {
  const maxb = minb + bucketSize * n
  const endHeights = Array.from({ length: n + 1 }, (_, b) => Math.min(maxb, minb + (b + 1) * bucketSize - 1))
  const startHeights = [minb, ...endHeights.slice(0, n)]
  const clamp = (b: number) => Math.max(0, Math.min(n, b))
  const step = 3_600
  const t0 = 0
  return {
    t0,
    step,
    N: n,
    floorHeight: minb,
    endSec: b => t0 + (clamp(b) + 1) * step,
    endHeight: b => endHeights[clamp(b)],
    ofTs: tsExpr => `toUInt32(least(intDiv(greatest(toUnixTimestamp(${tsExpr}), ${t0}) - ${t0}, ${step}), ${n}))`,
    ofTsCarry: tsExpr => `toInt32(greatest(-1, least(${n}, intDiv(toInt64(toUnixTimestamp(${tsExpr})) - ${t0}, ${step}))))`,
    ofHeight: heightExpr => `toUInt32(indexOf([${startHeights.join(',')}], roundDown(greatest(${heightExpr}, ${minb}), [${startHeights.join(',')}])) - 1)`,
    ofHeightCarry: heightExpr => `toInt32(if(${heightExpr} < ${minb}, -1, indexOf([${startHeights.join(',')}], roundDown(${heightExpr}, [${startHeights.join(',')}])) - 1))`,
    bucketOfHeight: height => {
      if (height <= startHeights[0]) return 0
      let lo = 0
      let hi = n
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (startHeights[mid] <= height) lo = mid
        else hi = mid - 1
      }
      return lo
    },
  }
}
