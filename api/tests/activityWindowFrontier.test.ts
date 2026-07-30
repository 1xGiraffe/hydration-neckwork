import { describe, expect, it } from 'vitest'
import { activityRowsAboveFrontier, activityWindowFrontier, compareActivityRowsNewestFirst, publishedActivityFrontier } from '../src/services/explorerService.ts'
import type { ActivityRow } from '../src/services/explorerService.ts'

// The account/tag activity feed is assembled from a dozen sources, each read
// newest-first under its own LIMIT. A source that fills its window has more history
// behind it, so the merged rows below that point are missing siblings — they cannot
// be counted and must not be paged. The frontier is where the window stops being the
// feed, and it is the single fact both the pager's total and its pages are derived
// from: the total is the number of rows above it, the pages are those same rows.
const source = (fetched: number, limit: number, oldestBlock: number | null) => ({ fetched, limit, oldestBlock })

describe('activity window frontier', () => {
  it('is absent while no source filled its window', () => {
    expect(activityWindowFrontier([source(12, 1_000, 4_000), source(0, 1_000, null)])).toBeNull()
  })

  it('is the newest of the saturated sources oldest blocks', () => {
    // The shallowest source is the binding one: below its oldest candidate NO source
    // can be trusted, even though the others reach much further back.
    expect(activityWindowFrontier([
      source(1_000, 1_000, 4_000),
      source(1_000, 1_000, 9_500),
      source(1_000, 1_000, 7_000),
    ])).toBe(9_500)
  })

  it('ignores a source that reached the end of its own history', () => {
    // 40 rows out of a 1,000 window means the source is exhausted: its whole history
    // is in hand, so it puts no floor under the feed however recent its oldest row.
    expect(activityWindowFrontier([source(1_000, 1_000, 4_000), source(40, 1_000, 9_900)])).toBe(4_000)
  })

  it('treats a window filled past its limit as filled', () => {
    // Concatenated legs (the three XCM readers) can return more rows than the limit
    // asked for; that is still a filled window.
    expect(activityWindowFrontier([source(3_000, 1_000, 8_800)])).toBe(8_800)
  })
})

// A published total is cached for minutes while the window's frontier keeps
// advancing, so it is counted a margin above the frontier — otherwise the last page
// it numbers would fall past what the window reaches by the time it is fetched. A
// complete feed has no frontier to advance and so is published whole.
describe('published frontier', () => {
  it('stops a published prefix above the window frontier', () => {
    expect(publishedActivityFrontier(9_500)).toBeGreaterThan(9_500)
  })

  it('leaves a complete feed uncut', () => {
    expect(publishedActivityFrontier(null)).toBeNull()
  })
})

const row = (blockHeight: number, eventIndex: number, tag: string): ActivityRow =>
  ({ type: 'transfer', blockHeight, eventIndex, extrinsicIndex: null, timestamp: tag } as ActivityRow)

describe('rows above the frontier', () => {
  it('keeps the whole feed when nothing bounded the window', () => {
    const rows = [row(9, 1, 'a'), row(4, 1, 'b')]

    expect(activityRowsAboveFrontier(rows, null)).toEqual(rows)
  })

  it('drops the frontier block itself, not just what is below it', () => {
    // A LIMIT can cut a block in half, so the frontier block's own rows may be
    // missing siblings — and every cross-source decision the feed makes (transfer
    // suppression, the liquidation and share-routed exclusions, dust pairing) is
    // resolved WITHIN a block. Keeping a partially fetched block would surface a
    // transfer whose suppressing trade was one row past the window.
    const rows = [row(500, 3, 'above'), row(400, 9, 'frontier-late'), row(400, 1, 'frontier-early'), row(399, 1, 'below')]

    expect(activityRowsAboveFrontier(rows, 400).map(r => r.timestamp)).toEqual(['above'])
  })

  it('publishes exactly the rows its pages render', () => {
    // The invariant the pager rests on: the total is the length of the prefix and the
    // pages are slices of that same array, so the last page holds the remainder and
    // the page after it holds nothing. A total from a different expression of the
    // feed is what advertised 49 pages of a 26-page feed.
    const built = [...Array(97).keys()].map(i => row(1_000 - i, 0, `r${i}`))
    const prefix = activityRowsAboveFrontier(built, 950).sort(compareActivityRowsNewestFirst)
    const total = prefix.length
    const limit = 25
    const pages: ActivityRow[][] = []
    for (let offset = 0; offset < total; offset += limit) pages.push(prefix.slice(offset, offset + limit))

    expect(total).toBe(50)
    expect(pages.length).toBe(Math.ceil(total / limit))
    expect(pages.flat()).toEqual(prefix)
    expect(pages.at(-1)).toHaveLength(total % limit || limit)
    expect(prefix.slice(total, total + limit)).toEqual([])
  })
})
