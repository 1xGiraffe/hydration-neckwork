import { describe, expect, it } from 'vitest'
import { PAGE_SIZE, offeredPages, servablePageCount } from '../src/utils/activityPaging'

// The chain-wide lists are bounded twice: by how many rows they hold and by how deep
// the API will serve them. The Activity pager used to know neither — its › arrow was
// "this page came back full" — so it walked readers past the point where the merged
// feed refuses (HTTP 503) and past the offset the route rejects (HTTP 400). The
// reported case was /activity?tab=vote&page=490.
describe('servable page count', () => {
  it('is the pages the API will actually serve, page zero included', () => {
    expect(servablePageCount(2_500)).toBe(101)
    expect(servablePageCount(250_000)).toBe(10_001)
    expect(servablePageCount(0)).toBe(1)
  })

  it('is unknown until the API publishes its bound', () => {
    expect(servablePageCount(undefined)).toBeUndefined()
  })

  it('follows the list’s own page size', () => {
    expect(servablePageCount(20_000_000, 50)).toBe(400_001)
  })
})

describe('offered pages', () => {
  it('numbers a counted feed and stops the arrow on its last page', () => {
    // The vote feed: 3,187 rows -> 128 pages, the last holding 12.
    const last = offeredPages({ page: 127, rowsOnPage: 12, rowCount: 3_187, maxOffset: 250_000 })

    expect(last.totalPages).toBe(128)
    expect(last.hasNext).toBe(false)
    expect(last.note).toBeUndefined()
    expect(offeredPages({ page: 126, rowsOnPage: 25, rowCount: 3_187, maxOffset: 250_000 }).hasNext).toBe(true)
  })

  it('never numbers a page past the servable depth, and says the rest are there', () => {
    // The events feed: 302.9M rows is 12.1M pages, of which the API serves the first
    // 800,001 — skipping N rows reads N rows, so depth costs real time.
    const capped = offeredPages({ page: 0, rowsOnPage: 25, rowCount: 302_863_213, maxOffset: 20_000_000 })

    expect(capped.totalPages).toBe(800_001)
    expect(capped.totalPages).toBe(servablePageCount(20_000_000))
    expect(capped.note).toBe('older history beyond the pages this list can serve')
    expect(offeredPages({ page: 800_000, rowsOnPage: 25, rowCount: 302_863_213, maxOffset: 20_000_000 }).hasNext).toBe(false)
  })

  it('offers no page numbers at all for an uncounted feed', () => {
    // Numbering the servable depth would claim 101 pages of a filtered feed that may
    // hold twelve rows. The arrow walks one full page at a time instead.
    const uncounted = offeredPages({ page: 3, rowsOnPage: 25, rowCount: null, maxOffset: 2_500 })

    expect(uncounted.totalPages).toBeUndefined()
    expect(uncounted.hasNext).toBe(true)
    expect(uncounted.note).toBeUndefined()
    expect(offeredPages({ page: 3, rowsOnPage: 11, rowCount: null, maxOffset: 2_500 }).hasNext).toBe(false)
  })

  it('stops an uncounted feed at the servable depth and says why', () => {
    // Page 101 of the merged feed is offset 2,500 — the deepest the API answers. The
    // page after it used to be offered because this one came back full.
    const deepest = offeredPages({ page: 100, rowsOnPage: PAGE_SIZE, rowCount: null, maxOffset: 2_500 })

    expect(deepest.hasNext).toBe(false)
    expect(deepest.note).toBe('as deep as this list pages — narrow the date range for older rows')
    expect(offeredPages({ page: 99, rowsOnPage: PAGE_SIZE, rowCount: null, maxOffset: 2_500 }).hasNext).toBe(true)
  })

  it('offers nothing while the bounds are still loading', () => {
    const loading = offeredPages({ page: 0, rowsOnPage: 25, rowCount: undefined, maxOffset: undefined })

    expect(loading.totalPages).toBeUndefined()
    expect(loading.note).toBeUndefined()
    // A full page is the only signal left, and it is still honest: the request the
    // reader would make next is the one that just succeeded, one page deeper.
    expect(loading.hasNext).toBe(true)
  })
})
