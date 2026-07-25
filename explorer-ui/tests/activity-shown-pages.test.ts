import { describe, expect, it } from 'vitest'
import { PAGE_SIZE, pageCount, shownPageCount } from '../src/utils/activityPaging'

// The pager sized itself from an activity count that is a sum of per-category counts,
// so it exceeded the classified feed it pages. One live account reported 1,209 rows
// while the feed ends at 646: the pager offered 49 pages (apage 0-48) when only 26
// exist, and every page past 25 loaded empty with no way to tell which were real.
describe('shownPageCount', () => {
  const counted = pageCount(1209)   // 49 pages advertised by the count

  it('keeps the counted pages while a page is still loading', () => {
    expect(shownPageCount(counted, 0, 30, true)).toBe(counted)
  })

  it('keeps the counted pages while pages come back full', () => {
    expect(shownPageCount(counted, PAGE_SIZE, 10, false)).toBe(counted)
  })

  // The real feed: offset 625 (page 25) returned 21 rows, offset 650 returned 0.
  it('ends on the page that settled short', () => {
    expect(shownPageCount(counted, 21, 25, false)).toBe(26)
  })

  it('ends on the previous page when this one settled empty', () => {
    expect(shownPageCount(counted, 0, 26, false)).toBe(26)
  })

  it('never advertises more than the count', () => {
    expect(shownPageCount(3, 21, 25, false)).toBe(3)
  })

  it('works with no count at all', () => {
    expect(shownPageCount(undefined, 21, 25, false)).toBe(26)
    expect(shownPageCount(undefined, PAGE_SIZE, 4, false)).toBeUndefined()
  })

  // A short first page with rows is a one-page feed; a short empty first page is none.
  it('handles a feed that fits on one page', () => {
    expect(shownPageCount(undefined, 7, 0, false)).toBe(1)
    expect(shownPageCount(undefined, 0, 0, false)).toBeUndefined()
  })
})
