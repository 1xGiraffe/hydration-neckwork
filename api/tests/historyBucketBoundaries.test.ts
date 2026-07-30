import { describe, expect, it } from 'vitest'
import { bucketEndHeightsForRange, bucketOfHeight } from '../src/services/explorerService.ts'

const LAST_BUCKET = 180

// Simulates the query the boundary read replaces: bucket every height in the
// account's range and keep the greatest one per bucket. block_timestamp is monotone
// in block_height, so "greatest height per bucket" is exactly the row the old
// `max(block_timestamp)` over the full range returned.
function bucketEndsByFullScan(minBlock: number, maxBlock: number, bucketSize: number): Map<number, number> {
  const ends = new Map<number, number>()
  for (let height = minBlock; height <= maxBlock; height++) {
    const bucket = bucketOfHeight(height, minBlock, bucketSize, LAST_BUCKET)
    const seen = ends.get(bucket)
    if (seen == null || height > seen) ends.set(bucket, height)
  }
  return ends
}

const bucketSizeFor = (minBlock: number, maxBlock: number) =>
  Math.max(1, Math.floor((maxBlock - minBlock) / LAST_BUCKET))

// Real spans: two chain-lifetime accounts, mid-age ones, and the degenerate few-block
// accounts where the bucket size floors to 1 and the upper buckets never exist.
const ranges: [number, number][] = [
  [693383, 13320029], [693672, 13320029], [4229247, 13320029], [10052751, 13320029],
  [12872088, 13320029], [4748740, 4918201], [4380324, 4637845], [12556176, 12556227],
  [4406168, 4406299], [4666552, 4666922], [9390538, 9390543], [0, 1], [0, 180], [0, 181],
]

describe('account-history bucket-end heights', () => {
  it('asks for exactly the heights the full-range scan would have won with', () => {
    for (const [minBlock, maxBlock] of ranges) {
      const bucketSize = bucketSizeFor(minBlock, maxBlock)
      const expected = bucketEndsByFullScan(minBlock, maxBlock, bucketSize)
      const heights = bucketEndHeightsForRange(minBlock, maxBlock, bucketSize, LAST_BUCKET)

      expect(new Set(heights), `${minBlock}-${maxBlock}`).toEqual(new Set(expected.values()))
    }
  })

  it('maps one height to every bucket the range reaches, and none beyond it', () => {
    for (const [minBlock, maxBlock] of ranges) {
      const bucketSize = bucketSizeFor(minBlock, maxBlock)
      const heights = bucketEndHeightsForRange(minBlock, maxBlock, bucketSize, LAST_BUCKET)
      const buckets = heights.map(height => bucketOfHeight(height, minBlock, bucketSize, LAST_BUCKET))

      // One height per bucket, so the query's `max(block_timestamp)` aggregates a
      // single row and the emptiness check below can count buckets against heights.
      expect(new Set(buckets).size, `${minBlock}-${maxBlock}`).toBe(heights.length)
      expect(new Set(buckets), `${minBlock}-${maxBlock}`)
        .toEqual(new Set(bucketEndsByFullScan(minBlock, maxBlock, bucketSize).keys()))
      for (const height of heights) {
        expect(height, `${minBlock}-${maxBlock}`).toBeGreaterThanOrEqual(minBlock)
        expect(height, `${minBlock}-${maxBlock}`).toBeLessThanOrEqual(maxBlock)
      }
    }
  })

  it('covers all 181 buckets once the span exceeds the bucket count', () => {
    const heights = bucketEndHeightsForRange(693383, 13320029, bucketSizeFor(693383, 13320029), LAST_BUCKET)

    expect(heights.length).toBe(LAST_BUCKET + 1)
    expect(heights.at(-1)).toBe(13320029)
  })
})
